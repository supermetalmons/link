import { required } from "./fixtures/canonicalData.mjs";
import { browserServerOrigin } from "./browserViteServer.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBrowserViteServer } from "./browserViteServer.mjs";

const require = createRequire(import.meta.url);
/** @type {typeof import("playwright")} */
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));

/** @param {(page: import("playwright").Page) => Promise<void>} run */
async function fixture(run) {
  const server = await createBrowserViteServer({
    root: repository,
    cacheDir: `node_modules/.vite-event-create-${process.pid}`,
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      hmr: false,
      watch: null,
    },
    logLevel: "error",
    plugins: [
      {
        name: "event-create-browser-fixture",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__event-create") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="root"></div><script type="module" src="/test/fixtures/eventCreateFormHarness.tsx"></script>',
            );
          });
        },
      },
    ],
  });
  /** @type {import("playwright").Browser | undefined} */
  let browser;
  try {
    await server.listen();
    const origin = browserServerOrigin(server);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MONS_BROWSER_EXECUTABLE
        ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/__event-create`);
    await page.waitForFunction(() => !!window.eventCreateHarness);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

/** @param {import("playwright").Page} page */
const snapshot = (page) =>
  page.evaluate(() => window.eventCreateHarness.snapshot());

test(
  "event form values survive conditional visibility and retain the existing experimental-open defaults",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      assert.equal(
        await page.locator('input[type="number"]').inputValue(),
        "5",
      );
      assert.equal(
        await page.locator('input[type="number"]').getAttribute("max"),
        "72000",
      );
      await page.locator('input[type="number"]').fill("17");
      await page
        .getByRole("button", { name: "Date & time", exact: true })
        .click();
      await page.locator('input[type="date"]').fill("2028-06-19");
      await page.locator('input[type="time"]').fill("16:45");
      await page.locator("select").selectOption({ index: 1 });
      await page.getByLabel("Sunday Mons", { exact: true }).check();
      await page.getByLabel("Invite when created", { exact: true }).check();
      const beforeHide = await snapshot(page);
      await page
        .getByRole("button", { name: "Hide form", exact: true })
        .click();
      assert.equal(await page.locator("#form button").count(), 0);
      await page
        .getByRole("button", { name: "Show form", exact: true })
        .click();
      assert.deepEqual(await snapshot(page), beforeHide);
      assert.equal(
        await page.locator('input[type="date"]').inputValue(),
        "2028-06-19",
      );
      await page
        .getByRole("button", {
          name: "Open experimental controls",
          exact: true,
        })
        .click();
      const reopened = await snapshot(page);
      assert.equal(reopened.schedule.mode, "minutes");
      assert.equal(reopened.schedule.startsInMinutes, "17");
      assert.equal(reopened.schedule.scheduledTimezone, "local");
      assert.notEqual(reopened.schedule.scheduledDate, "2028-06-19");
      assert.equal(reopened.isSundayMons, false);
      assert.deepEqual(reopened.telegramAnnouncements, {
        invite: false,
        matches: false,
        results: false,
      });
    });
  },
);

test(
  "event form preserves validation and admin visibility, then hands creation to the pending modal once",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.locator('input[type="number"]').fill("0");
      await page
        .getByRole("button", { name: "Create Event", exact: true })
        .click();
      assert.equal((await snapshot(page)).error, "Enter at least 1 minute.");
      assert.equal((await snapshot(page)).requests.length, 0);
      await page.evaluate(() => window.eventCreateHarness.setAllowed(false));
      assert.equal(await page.locator("#form button").count(), 0);
      assert.match(
        required(await page.locator("#form").textContent()),
        /Enter at least 1 minute/,
      );
      await page.evaluate(() => window.eventCreateHarness.setAllowed(true));
      await page.locator('input[type="number"]').fill("7.9");
      assert.equal((await snapshot(page)).error, "");
      await page.getByLabel("Sunday Mons", { exact: true }).check();
      await page.getByLabel("Invite when created", { exact: true }).check();
      await page.getByLabel("Final results", { exact: true }).check();
      await page.evaluate(() => window.eventCreateHarness.submitTwice());
      const pending = await snapshot(page);
      assert.equal(pending.starts, 1);
      assert.deepEqual(pending.requests, [
        {
          schedule: 7,
          options: {
            isSundayMons: true,
            telegramAnnouncements: {
              invite: true,
              matches: false,
              results: true,
            },
          },
        },
      ]);
      assert.equal(pending.isCreatingEvent, true);
      assert.equal(pending.modal.isPendingCreate, true);
      assert.equal(await page.locator("#form button").count(), 0);
      await page
        .getByRole("button", { name: "Show form", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "Creating Event...", exact: true })
          .isDisabled(),
        true,
      );
      await page.evaluate(() =>
        window.eventCreateHarness.settle(0, {
          ok: true,
          eventId: "created-event",
        }),
      );
      const completed = await snapshot(page);
      assert.equal(completed.isCreatingEvent, false);
      assert.equal(completed.modal.eventId, "created-event");
      assert.equal(completed.modal.isPendingCreate, false);
    });
  },
);

test(
  "event creation cannot reopen a dismissed modal or replace a newly selected event",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page
        .getByRole("button", { name: "Create Event", exact: true })
        .click();
      await page.evaluate(async () => {
        await window.eventCreateHarness.dismiss();
        await window.eventCreateHarness.settle(0, {
          ok: true,
          eventId: "dismissed-event",
        });
      });
      assert.equal((await snapshot(page)).modal.isOpen, false);
      await page
        .getByRole("button", { name: "Show form", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Create Event", exact: true })
        .click();
      await page.evaluate(async () => {
        window.eventCreateHarness.openEvent("other-event");
        await window.eventCreateHarness.settle(1, {
          ok: true,
          eventId: "late-event",
        });
      });
      assert.equal((await snapshot(page)).modal.eventId, "other-event");
    });
  },
);

test(
  "event create failures remain in the pending modal and allow a new attempt",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page
        .getByRole("button", { name: "Create Event", exact: true })
        .click();
      await page.evaluate(() =>
        window.eventCreateHarness.settle(0, { ok: false }),
      );
      let failed = await snapshot(page);
      assert.equal(failed.modal.pendingCreateError, "Failed to create event.");
      assert.equal(failed.isCreatingEvent, false);
      await page
        .getByRole("button", { name: "Show form", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Create Event", exact: true })
        .click();
      assert.equal((await snapshot(page)).modal.pendingCreateError, null);
      await page.evaluate(() =>
        window.eventCreateHarness.settle(
          1,
          { ok: false },
          "Schedule is too far ahead.",
        ),
      );
      failed = await snapshot(page);
      assert.equal(
        failed.modal.pendingCreateError,
        "Schedule is too far ahead.",
      );
      await page
        .getByRole("button", { name: "Show form", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Create Event", exact: true })
        .click();
      await page.evaluate(async () => {
        await window.eventCreateHarness.dismiss();
        await window.eventCreateHarness.settle(
          2,
          { ok: false },
          "Late failure",
        );
      });
      assert.equal((await snapshot(page)).modal.isOpen, false);
      assert.equal((await snapshot(page)).modal.pendingCreateError, null);
    });
  },
);
