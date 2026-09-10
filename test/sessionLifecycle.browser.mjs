import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));

async function fixture(run) {
  const server = await createServer({
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    context.setDefaultTimeout(15_000);
    const sessions = new Map();
    const revoked = new Set();
    const refreshes = [];
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
      if (url.pathname === "/auth/session/logout") {
        revoked.add(request.headers().authorization.split(".")[1]);
        return route.fulfill({ status: 204, headers });
      }
      let session;
      if (url.pathname === "/auth/session/anonymous") {
        const input = request.postDataJSON();
        session = sessions.get(input.sessionId);
        if (!session) {
          session = {
            sessionId: input.sessionId,
            uid: `m${String(sessions.size + 1).padStart(27, "0")}`,
          };
          sessions.set(input.sessionId, session);
        }
      } else if (url.pathname === "/auth/session/refresh") {
        const sessionId = request.headers().authorization.split(".")[1];
        refreshes.push(sessionId);
        session = sessions.get(sessionId);
      }
      if (session && !revoked.has(session.sessionId)) {
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        return route.fulfill({
          status: 200,
          headers,
          json: {
            ok: true,
            ...session,
            accessToken: `header.${Buffer.from(JSON.stringify({ iat: expiresAt - 300, exp: expiresAt })).toString("base64url")}.signature`,
            accessExpiresAtMs: expiresAt * 1000,
          },
        });
      }
      return route.fulfill({
        status: session ? 401 : 503,
        headers,
        json: {
          ok: false,
          error: "unavailable",
          message: "Local browser fixture",
        },
      });
    });
    const open = async () => {
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        globalThis.testSessionAuth = sessionAuth;
      });
      await page.waitForFunction(() =>
        Boolean(globalThis.testSessionAuth.currentUser?.uid),
      );
      return page;
    };
    await run({ context, open, origin, sessions, refreshes, revoked });
  } finally {
    await browser?.close();
    await server.close();
  }
}

test(
  "clearing native IndexedDB invalidates live cached and forced tokens before a new guest can sign in",
  { timeout: 60_000 },
  async () => {
    await fixture(async ({ open, refreshes, sessions }) => {
      const page = await open();
      const old = await page.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        globalThis.oldSessionUser = sessionAuth.currentUser;
        await globalThis.oldSessionUser.getIdToken();
        return {
          uid: sessionAuth.currentUser.uid,
          sessionId: sessionAuth.currentUser.sessionId,
        };
      });
      const previousRefreshes = refreshes.length;
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase("mons-link-sessions-v1");
            request.onsuccess = () => resolve();
            request.onerror = () =>
              reject(new Error("native-session-clear-failed"));
            request.onblocked = () =>
              reject(new Error("native-session-clear-blocked"));
          }),
      );
      const cleared = await page.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        const outcomes = [];
        for (const force of [false, true]) {
          try {
            await globalThis.oldSessionUser.getIdToken(force);
            outcomes.push("token-returned");
          } catch (error) {
            outcomes.push(error.message);
          }
        }
        return { outcomes, user: sessionAuth.currentUser?.uid ?? null };
      });
      assert.deepEqual(cleared, {
        outcomes: ["authentication-changed", "authentication-changed"],
        user: null,
      });
      assert.equal(refreshes.length, previousRefreshes);
      const replacement = await page.evaluate(async () => {
        const { connection } = await import("/src/connection/connection.ts");
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        await connection.signIn();
        return {
          uid: sessionAuth.currentUser?.uid,
          sessionId: sessionAuth.currentUser?.sessionId,
        };
      });
      assert.notEqual(replacement.uid, old.uid);
      assert.notEqual(replacement.sessionId, old.sessionId);
      assert.equal(sessions.size, 2);
      await page.getByRole("button", { name: "Sign In", exact: true }).click();
      await page
        .getByRole("button", { name: "Ethereum", exact: true })
        .waitFor({ state: "visible" });
    });
  },
);

test(
  "device clock skew and clock changes do not prevent session creation or extend cached token lifetime",
  { timeout: 60_000 },
  async () => {
    await fixture(async ({ context, open, refreshes }) => {
      await context.addInitScript(() => {
        const realNow = Date.now.bind(Date);
        globalThis.testClockSkew = 10 * 60_000;
        Date.now = () => realNow() + globalThis.testClockSkew;
      });
      const page = await open();
      const first = await page.evaluate(async () => {
        const auth = globalThis.testSessionAuth;
        const token = await auth.currentUser.getIdToken();
        return { token, remaining: auth.getTokenRemainingMs(token) };
      });
      assert.ok(first.remaining > 250_000 && first.remaining <= 299_000);
      const count = refreshes.length;
      const afterClockChange = await page.evaluate(async () => {
        globalThis.testClockSkew = -24 * 60 * 60_000;
        const auth = globalThis.testSessionAuth;
        const token = await auth.currentUser.getIdToken();
        return { token, remaining: auth.getTokenRemainingMs(token) };
      });
      assert.equal(afterClockChange.token, first.token);
      assert.equal(refreshes.length, count);
      assert.ok(afterClockChange.remaining <= first.remaining);
      await page.evaluate(async () => {
        const { connection } = await import("/src/connection/connection.ts");
        await connection.signOut();
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.evaluate(async () => {
        globalThis.testClockSkew = -10 * 60_000;
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        await sessionAuth.signInAnonymously();
        const token = await sessionAuth.currentUser.getIdToken(true);
        if (sessionAuth.getTokenRemainingMs(token) <= 0)
          throw new Error("clock-skew-token-unusable");
      });
    });
  },
);

test(
  "failed logout exposes a retry and clears the original session after storage recovers",
  { timeout: 60_000 },
  async () => {
    await fixture(async ({ open, revoked }) => {
      const page = await open();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.clock.install();
      const original = await page.evaluate(async () => {
        const auth = globalThis.testSessionAuth;
        await auth.flushRevocations();
        localStorage.setItem("loginId", auth.currentUser.uid);
        localStorage.setItem("profileId", "prior-linked-profile");
        const { setAuthStatusGlobally } =
          await import("/src/connection/authentication.ts");
        const { handleLogout } =
          await import("/src/ui/identity/profileUiPort.ts");
        setAuthStatusGlobally("authenticated");
        handleLogout();
        const open = indexedDB.open;
        const setItem = Storage.prototype.setItem;
        globalThis.restoreLogoutStorage = () => {
          indexedDB.open = open;
          Storage.prototype.setItem = setItem;
        };
        indexedDB.open = () => {
          throw new DOMException("Temporary storage failure", "UnknownError");
        };
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith("__mons_link_session_logout__:"))
            throw new DOMException(
              "Storage quota exhausted",
              "QuotaExceededError",
            );
          return setItem.call(this, key, value);
        };
        return {
          uid: auth.currentUser.uid,
          sessionId: auth.currentUser.sessionId,
        };
      });
      await page.getByRole("button", { name: "Log Out", exact: true }).click();
      const dialog = page.getByRole("alertdialog", { name: "Log out failed" });
      await dialog.waitFor({ state: "visible" });
      assert.equal(
        await page
          .getByRole("button", { name: "Sign In", exact: true })
          .count(),
        0,
      );
      const retry = dialog.getByRole("button", {
        name: "Retry Log Out",
        exact: true,
      });
      await retry.click();
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("button")).some(
          (button) =>
            button.textContent === "Retry Log Out" && !button.disabled,
        ),
      );
      await page.clock.fastForward(18_000);
      assert.equal(await dialog.isVisible(), true);
      assert.equal(revoked.has(original.sessionId), false);
      await page.evaluate(() => {
        globalThis.restoreLogoutStorage();
        window.dispatchEvent(new Event("online"));
        window.dispatchEvent(new Event("pageshow"));
      });
      const navigation = page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
      });
      await retry.click();
      await navigation;
      const restored = await page.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        const { storage } = await import("/src/utils/storage.ts");
        await sessionAuth.signInAnonymously();
        await sessionAuth.flushRevocations();
        return {
          uid: sessionAuth.currentUser.uid,
          profileId: storage.getProfileId(""),
        };
      });
      assert.notEqual(restored.uid, original.uid);
      assert.equal(restored.profileId, "");
      assert.equal(revoked.has(original.sessionId), true);
      await page
        .getByRole("button", { name: "Sign In", exact: true })
        .waitFor({ state: "visible" });
      assert.deepEqual(errors, []);
    });
  },
);

test(
  "a logout that cannot open IndexedDB clears the original session and profile before restoring after reload",
  { timeout: 60_000 },
  async () => {
    await fixture(async ({ open, revoked }) => {
      const page = await open();
      const original = await page.evaluate(async () => {
        const auth = globalThis.testSessionAuth;
        await auth.flushRevocations();
        localStorage.setItem("loginId", auth.currentUser.uid);
        localStorage.setItem("profileId", "prior-linked-profile");
        localStorage.setItem("username", "Prior player");
        localStorage.setItem(
          "playerMiningMaterials",
          JSON.stringify({ dust: 7 }),
        );
        return {
          uid: auth.currentUser.uid,
          sessionId: auth.currentUser.sessionId,
          generation: auth.generation,
        };
      });
      const navigation = page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
      });
      await page.evaluate(async (generation) => {
        const { connection } = await import("/src/connection/connection.ts");
        const { performLogoutCleanupAndReload } =
          await import("/src/session/logoutOrchestrator.ts");
        indexedDB.open = () => {
          throw new DOMException("Temporary storage failure", "UnknownError");
        };
        await connection.signOut().catch(() => {});
        if (
          localStorage.getItem("__mons_link_session_logout__:" + generation) !==
          "1"
        )
          throw new Error("logout-intent-not-persisted");
        void performLogoutCleanupAndReload().catch(() => {});
      }, original.generation);
      await navigation;
      const restored = await page.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        const { storage } = await import("/src/utils/storage.ts");
        const { rocksMiningService } =
          await import("/src/services/rocksMiningService.ts");
        await sessionAuth.signInAnonymously();
        await sessionAuth.flushRevocations();
        return {
          uid: sessionAuth.currentUser.uid,
          sessionId: sessionAuth.currentUser.sessionId,
          loginId: storage.getLoginId(""),
          profileId: storage.getProfileId(""),
          username: storage.getUsername(""),
          dust: rocksMiningService.getSnapshot().materials.dust,
        };
      });
      assert.notEqual(restored.uid, original.uid);
      assert.notEqual(restored.sessionId, original.sessionId);
      assert.equal(restored.loginId, "");
      assert.equal(restored.profileId, "");
      assert.equal(restored.username, "");
      assert.equal(restored.dust, 0);
      assert.equal(revoked.has(original.sessionId), true);
    });
  },
);

test(
  "a stopped logout recovers after a transient native storage-open failure",
  { timeout: 60_000 },
  async () => {
    await fixture(async ({ open }) => {
      const page = await open();
      const oldUid = await page.evaluate(async () => {
        const { connection } = await import("/src/connection/connection.ts");
        const auth = globalThis.testSessionAuth;
        const uid = auth.currentUser.uid;
        localStorage.setItem("loginId", uid);
        localStorage.setItem("profileId", "prior-linked-profile");
        localStorage.setItem(
          "playerMiningMaterials",
          JSON.stringify({ dust: 7 }),
        );
        await connection.signOut();
        await auth.flushRevocations();
        return uid;
      });
      const navigation = page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
      });
      await page.evaluate(async () => {
        const { performLogoutCleanupAndReload } =
          await import("/src/session/logoutOrchestrator.ts");
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (...args) => {
          indexedDB.open = open;
          throw new DOMException("Temporary storage failure", "UnknownError");
        };
        void performLogoutCleanupAndReload().catch(() => {});
      });
      await navigation;
      const restored = await page.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        const { storage } = await import("/src/utils/storage.ts");
        const { rocksMiningService } =
          await import("/src/services/rocksMiningService.ts");
        await sessionAuth.signInAnonymously();
        return {
          uid: sessionAuth.currentUser.uid,
          stopped: sessionAuth.isStoppedForLogout,
          loginId: storage.getLoginId(""),
          profileId: storage.getProfileId(""),
          dust: rocksMiningService.getSnapshot().materials.dust,
        };
      });
      assert.notEqual(restored.uid, oldUid);
      assert.equal(restored.stopped, false);
      assert.equal(restored.loginId, "");
      assert.equal(restored.profileId, "");
      assert.equal(restored.dust, 0);
    });
  },
);

test(
  "a completed logout finalizer reloads into a newer other-tab session without erasing it",
  { timeout: 60_000 },
  async () => {
    await fixture(async ({ open, revoked }) => {
      const first = await open();
      const original = await first.evaluate(async () => {
        const { connection } = await import("/src/connection/connection.ts");
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        const sessionId = sessionAuth.currentUser.sessionId;
        const applied = await connection.signOut();
        await sessionAuth.flushRevocations();
        return { applied, sessionId, stopped: sessionAuth.isStoppedForLogout };
      });
      assert.equal(original.applied, true);
      assert.equal(original.stopped, true);
      assert.equal(revoked.has(original.sessionId), true);
      const second = await open();
      const replacement = await second.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        localStorage.setItem("new-session-marker", "preserve");
        return {
          uid: sessionAuth.currentUser.uid,
          sessionId: sessionAuth.currentUser.sessionId,
        };
      });
      assert.notEqual(replacement.sessionId, original.sessionId);
      const navigation = first.waitForEvent("framenavigated", {
        predicate: (frame) => frame === first.mainFrame(),
      });
      await first.evaluate(() => {
        void import("/src/session/logoutOrchestrator.ts").then(
          ({ performLogoutCleanupAndReload }) =>
            performLogoutCleanupAndReload(),
        );
      });
      await navigation;
      await first.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        globalThis.testSessionAuth = sessionAuth;
      });
      await first.waitForFunction((sessionId) => {
        return (
          globalThis.testSessionAuth.currentUser?.sessionId === sessionId &&
          !globalThis.testSessionAuth.isStoppedForLogout
        );
      }, replacement.sessionId);
      const restored = await first.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        await sessionAuth.currentUser.getIdToken(true);
        return {
          uid: sessionAuth.currentUser.uid,
          marker: localStorage.getItem("new-session-marker"),
        };
      });
      assert.deepEqual(restored, { uid: replacement.uid, marker: "preserve" });
      assert.equal(revoked.has(replacement.sessionId), false);
      await first.getByRole("button", { name: "Sign In", exact: true }).click();
      await first
        .getByRole("button", { name: "Ethereum", exact: true })
        .waitFor({ state: "visible" });
    });
  },
);

for (const [scenario, name] of [
  [
    "failed",
    "retrying logout after another tab replaces the session reconnects the current invite",
  ],
  [
    "concurrent",
    "ordinary concurrent logout reconnects the invite under the replacement session",
  ],
  [
    "signal",
    "superseded background logout reconnects the invite under the replacement session",
  ],
  [
    "finalizer",
    "superseded local logout finalizer reconnects the invite under the replacement session",
  ],
  [
    "late-signal",
    "late logout signal reconnects the invite under the replacement session",
  ],
]) {
  test(name, { timeout: 60_000 }, async () => {
    await fixture(async ({ context, open, origin, revoked }) => {
      const inviteId = "recovery-invite";
      const metadataPath = `/invites/${inviteId}/metadata`;
      const wagersPath = `/invites/${inviteId}/wagers`;
      const matchPath = `/invites/${inviteId}/matches/${inviteId}/snapshot`;
      await context.routeWebSocket("**/*", (socket) => socket.close());
      await context.route(
        `https://api.mons.link/invites/${inviteId}/**`,
        async (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          const headers = {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          };
          if (request.method() === "OPTIONS")
            return route.fulfill({ status: 204, headers });
          let json;
          if (pathname === metadataPath) {
            json = {
              ok: true,
              snapshot: {
                inviteId,
                revision: 1,
                hostId: "host",
                guestId: "guest",
                hostColor: "white",
                hostRematches: "",
                guestRematches: "",
                automatchStateHint: null,
                eventId: null,
                eventOwned: false,
              },
              viewer: {
                role: "watch",
                actorUid: null,
                automatchOperationId: null,
              },
            };
          } else if (pathname === wagersPath) {
            json = {
              ok: true,
              snapshot: { inviteId, revision: 1, wagers: {} },
            };
          } else if (pathname === matchPath) {
            json = {
              ok: true,
              snapshot: {
                inviteId,
                matchId: inviteId,
                revision: 1,
                hostPlayerId: "host",
                guestPlayerId: "guest",
                hostMatch: null,
                guestMatch: null,
              },
            };
          } else {
            return route.fallback();
          }
          return route.fulfill({ status: 200, headers, json });
        },
      );
      const first = await open();
      const errors = [];
      first.on("pageerror", (error) => errors.push(error.message));
      await first.evaluate(async (inviteId) => {
        const { connection } = await import("/src/connection/connection.ts");
        globalThis.testSessionConnection = connection;
        connection.connectToInvite(inviteId);
      }, inviteId);
      await first.waitForFunction(
        (inviteId) =>
          globalThis.testSessionConnection.getActiveContextSnapshot()
            ?.matchId === inviteId &&
          globalThis.testSessionConnection.matchSyncSubscription !== null,
        inviteId,
      );
      const original = await first.evaluate(async () => {
        const auth = globalThis.testSessionAuth;
        await auth.flushRevocations();
        const { isWatchOnly } = await import("/src/game/gameController.ts");
        return {
          uid: auth.currentUser.uid,
          sessionId: auth.currentUser.sessionId,
          watching: isWatchOnly,
        };
      });
      assert.equal(original.watching, true);
      const second = await open();
      await first.evaluate(async (scenario) => {
        const auth = globalThis.testSessionAuth;
        localStorage.setItem("loginId", auth.currentUser.uid);
        localStorage.setItem("profileId", "original-profile");
        const { setAuthStatusGlobally } =
          await import("/src/connection/authentication.ts");
        const { handleLogout } =
          await import("/src/ui/identity/profileUiPort.ts");
        setAuthStatusGlobally("authenticated");
        if (scenario === "failed" || scenario === "concurrent") {
          handleLogout();
        }
        if (scenario === "finalizer") {
          await globalThis.testSessionConnection.signOut();
          await auth.flushRevocations();
        }
        if (scenario !== "failed") {
          const update = auth.dependencies.store.update.bind(
            auth.dependencies.store,
          );
          const waitForStopped =
            scenario === "signal" || scenario === "finalizer";
          const heldOperation = scenario === "finalizer" ? 2 : 1;
          let operations = 0;
          auth.dependencies.store.update = (change) => {
            if (
              (!waitForStopped || auth.isStoppedForLogout) &&
              ++operations === heldOperation
            ) {
              return new Promise((resolve) => {
                globalThis.resumeLogoutStorage = resolve;
              }).then(() => update(change));
            }
            return update(change);
          };
          if (scenario === "finalizer") {
            const { performLogoutCleanupAndReload } =
              await import("/src/session/logoutOrchestrator.ts");
            void performLogoutCleanupAndReload();
          }
          return;
        }
        const open = indexedDB.open;
        const setItem = Storage.prototype.setItem;
        globalThis.resumeLogoutStorage = () => {
          indexedDB.open = open;
          Storage.prototype.setItem = setItem;
        };
        indexedDB.open = () => {
          throw new DOMException("Temporary storage failure", "UnknownError");
        };
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith("__mons_link_session_logout__:"))
            throw new DOMException(
              "Storage quota exhausted",
              "QuotaExceededError",
            );
          return setItem.call(this, key, value);
        };
      }, scenario);
      if (scenario === "failed" || scenario === "concurrent") {
        await first
          .getByRole("button", { name: "Log Out", exact: true })
          .click();
      }
      const dialog = first.getByRole("alertdialog", {
        name: "Log out failed",
      });
      const waitForStoppedLogout = () =>
        first.waitForFunction(
          () =>
            globalThis.resumeLogoutStorage &&
            globalThis.testSessionAuth.isStoppedForLogout &&
            !globalThis.testSessionConnection.inviteMetadataSubscription &&
            !globalThis.testSessionConnection.inviteWagersSubscription &&
            !globalThis.testSessionConnection.matchSyncSubscription,
        );
      if (scenario !== "signal" && scenario !== "late-signal") {
        await waitForStoppedLogout();
      }
      if (scenario === "failed") {
        await dialog.waitFor({ state: "visible" });
        assert.equal(
          await first.evaluate(() =>
            globalThis.testSessionConnection.getActiveContextSnapshot(),
          ),
          null,
        );
      } else {
        assert.equal(await dialog.count(), 0);
      }
      const secondReload = second.waitForEvent("framenavigated", {
        predicate: (frame) => frame === second.mainFrame(),
      });
      await second.evaluate(async () => {
        const { connection } = await import("/src/connection/connection.ts");
        const { performLogoutCleanupAndReload } =
          await import("/src/session/logoutOrchestrator.ts");
        await connection.signOut();
        void performLogoutCleanupAndReload();
      });
      await secondReload;
      const replacement = await second.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        await sessionAuth.signInAnonymously();
        await sessionAuth.flushRevocations();
        localStorage.setItem("new-session-marker", "preserve");
        return {
          uid: sessionAuth.currentUser.uid,
          sessionId: sessionAuth.currentUser.sessionId,
        };
      });
      assert.notEqual(replacement.uid, original.uid);
      if (scenario === "signal") {
        await waitForStoppedLogout();
      } else if (scenario === "late-signal") {
        await first.waitForFunction(() => globalThis.resumeLogoutStorage);
        assert.equal(
          await first.evaluate(
            () => globalThis.testSessionAuth.isStoppedForLogout,
          ),
          false,
        );
      }
      const firstReload = first.waitForEvent("framenavigated", {
        predicate: (frame) => frame === first.mainFrame(),
      });
      const resumedReads = [metadataPath, wagersPath, matchPath].map((path) =>
        first.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === path &&
            response.request().method() === "GET" &&
            response.status() === 200,
        ),
      );
      await first.evaluate(() => globalThis.resumeLogoutStorage());
      if (scenario === "failed") {
        await dialog
          .getByRole("button", { name: "Retry Log Out", exact: true })
          .click();
      }
      await firstReload;
      await Promise.all(resumedReads);
      await first.evaluate(async () => {
        const { connection } = await import("/src/connection/connection.ts");
        globalThis.testSessionConnection = connection;
      });
      await first.waitForFunction(
        (inviteId) =>
          globalThis.testSessionConnection.getActiveContextSnapshot()
            ?.matchId === inviteId &&
          Boolean(
            globalThis.testSessionConnection.inviteMetadataSubscription,
          ) &&
          Boolean(globalThis.testSessionConnection.inviteWagersSubscription) &&
          Boolean(globalThis.testSessionConnection.matchSyncSubscription),
        inviteId,
      );
      const restored = await first.evaluate(async () => {
        const { sessionAuth } = await import("/src/session/sessionAuth.ts");
        const { isWatchOnly } = await import("/src/game/gameController.ts");
        const { getCurrentRouteState } =
          await import("/src/navigation/routeState.ts");
        await sessionAuth.currentUser.getIdToken(true);
        return {
          uid: sessionAuth.currentUser.uid,
          sessionId: sessionAuth.currentUser.sessionId,
          contextUid: globalThis.testSessionConnection.activeContext.loginUid,
          stopped: sessionAuth.isStoppedForLogout,
          inviteId: getCurrentRouteState().inviteId,
          watching: isWatchOnly,
          marker: localStorage.getItem("new-session-marker"),
        };
      });
      assert.deepEqual(restored, {
        ...replacement,
        contextUid: replacement.uid,
        stopped: false,
        inviteId,
        watching: true,
        marker: "preserve",
      });
      assert.equal(revoked.has(original.sessionId), true);
      assert.equal(revoked.has(replacement.sessionId), false);
      assert.deepEqual(errors, []);
    });
  });
}
