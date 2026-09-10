import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const noticeText =
  "Your session was reset. Sign in again to restore your profile.";
const noticeKey = "__mons_link_session_reset_notice__";
const uid = "m".repeat(28);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test(
  "the real React sign-in popup retains the cutoff notice through auth readiness and null-user transitions",
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      root: repository,
      server: { host: "127.0.0.1", port: 0, open: false },
      logLevel: "error",
    });
    let browser;
    const releaseCreate = deferred();
    try {
      await server.listen();
      const address = server.httpServer.address();
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({
        headless: true,
        ...(process.env.MONS_BROWSER_EXECUTABLE
          ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
          : { channel: "chrome" }),
      });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 1000 },
        storageState: {
          cookies: [],
          origins: [
            {
              origin,
              localStorage: [
                { name: "loginId", value: JSON.stringify("old-login") },
                { name: "profileId", value: JSON.stringify("old-profile") },
                { name: "isMuted", value: "true" },
              ],
            },
          ],
        },
      });
      const createStarted = deferred();
      const sessions = new Map();
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "https://api.mons.link") return route.abort();
        const headers = {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        };
        if (request.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers });
        if (url.pathname === "/auth/session/anonymous") {
          const session = request.postDataJSON();
          sessions.set(session.sessionId, session);
          createStarted.resolve();
          await releaseCreate.promise;
          const expiresAt = Math.floor(Date.now() / 1000) + 300;
          const accessToken = `header.${Buffer.from(JSON.stringify({ iat: expiresAt - 300, exp: expiresAt })).toString("base64url")}.signature`;
          return route.fulfill({
            status: 200,
            headers,
            json: {
              ok: true,
              uid,
              sessionId: session.sessionId,
              accessToken,
              accessExpiresAtMs: expiresAt * 1000,
            },
          });
        }
        if (url.pathname === "/auth/session/refresh") {
          const sessionId = request.headers().authorization.split(".")[1];
          assert.ok(sessions.has(sessionId));
          const expiresAt = Math.floor(Date.now() / 1000) + 300;
          return route.fulfill({
            status: 200,
            headers,
            json: {
              ok: true,
              uid,
              sessionId,
              accessToken: `header.${Buffer.from(JSON.stringify({ iat: expiresAt - 300, exp: expiresAt })).toString("base64url")}.signature`,
              accessExpiresAtMs: expiresAt * 1000,
            },
          });
        }
        return route.fulfill({
          status: 503,
          headers,
          json: {
            ok: false,
            error: "unavailable",
            message: "Local UI fixture",
          },
        });
      });
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await createStarted.promise;
      const signIn = page.getByRole("button", { name: "Sign In", exact: true });
      await signIn.waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(() => localStorage.getItem("profileId")),
        null,
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem("isMuted")),
        "true",
      );
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), noticeKey),
        "1",
      );
      assert.equal(
        await page.getByText(noticeText, { exact: true }).count(),
        0,
      );
      await signIn.click();
      const notice = page.getByText(noticeText, { exact: true });
      await notice.waitFor({ state: "visible" });
      await page.waitForFunction(
        (key) => localStorage.getItem(key) === null,
        noticeKey,
      );
      releaseCreate.resolve();
      await page.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        globalThis.testSessionAuth = sessionAuth;
      });
      await page.waitForFunction(
        (expected) => globalThis.testSessionAuth.currentUser?.uid === expected,
        uid,
      );
      assert.equal(await notice.isVisible(), true);
      await signIn.click();
      await notice.waitFor({ state: "hidden" });
      await signIn.click();
      await page
        .getByRole("button", { name: "Ethereum", exact: true })
        .waitFor({ state: "visible" });
      assert.equal(await notice.count(), 0);
      await page.reload({ waitUntil: "domcontentloaded" });
      await signIn.click();
      await page
        .getByRole("button", { name: "Ethereum", exact: true })
        .waitFor({ state: "visible" });
      assert.equal(await notice.count(), 0);
    } finally {
      releaseCreate.resolve();
      await browser?.close();
      await server.close();
    }
  },
);
