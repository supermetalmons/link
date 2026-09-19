import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBrowserViteServer } from "./browserViteServer.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));

async function fixture(run) {
  const server = await createBrowserViteServer({
    root: repository,
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      watch: null,
      hmr: false,
    },
    logLevel: "error",
  });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MONS_BROWSER_EXECUTABLE
        ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
    });
    const context = await browser.newContext();
    const open = async () => {
      const page = await context.newPage();
      await page.route(`${origin}/session-store-test`, (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      await page.goto(`${origin}/session-store-test`);
      await page.evaluate(async () => {
        const { createIndexedDbSessionStore, SESSION_DATABASE_NAME } =
          await import("/src/session/sessionStore.ts");
        globalThis.storageCounts = { opens: 0, writes: 0, transactions: 0 };
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.transaction.db.name === SESSION_DATABASE_NAME)
            globalThis.storageCounts.writes++;
          return put.apply(this, args);
        };
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args) {
          if (this.name === SESSION_DATABASE_NAME)
            globalThis.storageCounts.transactions++;
          return transaction.apply(this, args);
        };
        globalThis.sessionStore = createIndexedDbSessionStore(() => ({
          open: (...args) => {
            globalThis.storageCounts.opens++;
            return indexedDB.open(...args);
          },
        }));
      });
      return page;
    };
    await run({ open });
  } finally {
    await browser?.close();
    await server.close();
  }
}

test(
  "native IndexedDB shares one connection, serializes updates, and skips unchanged writes",
  { timeout: 60_000 },
  async () => {
    await fixture(async ({ open }) => {
      const page = await open();
      const result = await page.evaluate(async () => {
        const initial = await globalThis.sessionStore.update((state) => state);
        const increments = await Promise.all(
          Array.from({ length: 12 }, () =>
            globalThis.sessionStore.update((state) => {
              state.revision++;
              return state;
            }),
          ),
        );
        const beforeReads = { ...globalThis.storageCounts };
        const reads = await Promise.all([
          globalThis.sessionStore.update((state) => state),
          globalThis.sessionStore.update((state) => structuredClone(state)),
        ]);
        return {
          initial,
          revisions: increments.map((state) => state.revision),
          reads,
          beforeReads,
          counts: globalThis.storageCounts,
        };
      });
      assert.deepEqual(
        result.revisions,
        Array.from({ length: 12 }, (_, index) => index + 1),
      );
      assert.equal(result.counts.opens, 1);
      assert.equal(result.counts.writes, 13);
      assert.equal(result.counts.writes, result.beforeReads.writes);
      assert.equal(result.counts.transactions, 15);
      for (const state of result.reads) {
        assert.equal(state.generation, result.initial.generation);
        assert.equal(state.revision, 12);
      }
    });
  },
);

test(
  "native connections in separate tabs read each other's changes and unblock deletion",
  { timeout: 60_000 },
  async () => {
    await fixture(async ({ open }) => {
      const first = await open();
      const second = await open();
      const original = await first.evaluate(() =>
        globalThis.sessionStore.update((state) => ({
          ...state,
          initialized: true,
        })),
      );
      const changes = await Promise.all(
        [first, second].map((page) =>
          page.evaluate(() =>
            Promise.all(
              Array.from({ length: 10 }, () =>
                globalThis.sessionStore.update((state) => ({
                  ...state,
                  revision: state.revision + 1,
                })),
              ),
            ),
          ),
        ),
      );
      assert.deepEqual(
        changes
          .flat()
          .map((state) => state.revision)
          .sort((a, b) => a - b),
        Array.from({ length: 20 }, (_, index) => index + 1),
      );
      for (const page of [first, second]) {
        const current = await page.evaluate(() =>
          globalThis.sessionStore.update((state) => state),
        );
        assert.equal(current.generation, original.generation);
        assert.equal(current.revision, 20);
      }
      await first.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase("mons-link-sessions-v1");
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("deletion-blocked"));
          }),
      );
      const replacement = await first.evaluate(() =>
        globalThis.sessionStore.update((state) => state),
      );
      const observed = await second.evaluate(() =>
        globalThis.sessionStore.update((state) => state),
      );
      assert.notEqual(replacement.generation, original.generation);
      assert.equal(replacement.initialized, false);
      assert.deepEqual(observed, replacement);
      for (const page of [first, second]) {
        assert.equal(
          await page.evaluate(() => globalThis.storageCounts.opens),
          2,
        );
      }
    });
  },
);
