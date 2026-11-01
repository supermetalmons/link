import { browserServerOrigin } from "./browserViteServer.mjs";
import {
  canonicalAppearance,
  canonicalEvent,
} from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Game } from "mons-rules";
import { eventSnapshotEtag } from "@mons/shared/events";
import { createBrowserViteServer } from "./browserViteServer.mjs";

const require = createRequire(import.meta.url);
/** @type {typeof import("playwright")} */
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
/** @template Value @param {Value} value @returns {NonNullable<Value>} */
function present(value) {
  assert.ok(value !== null && value !== undefined);
  return value;
}
/** @param {unknown} value @returns {Record<string, unknown>} */
function jsonRecord(value) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @returns {string} */
function stringValue(value) {
  assert.ok(typeof value === "string");
  return value;
}
const repository = fileURLToPath(new URL("../", import.meta.url));
const cacheDirectory = resolve(
  repository,
  "node_modules/.vite-browser-tests",
  `auth-identity-${process.pid}`,
);
test.after(() => rm(cacheDirectory, { recursive: true, force: true }));
const buildDirectory = process.env.MONS_IDENTITY_BUILD;
const uid = "u".repeat(28);
const guestId = "g".repeat(28);
const inviteId = "IdentityBootstrapGame";
const eventId = "identity-bootstrap-event";
const cachedName = "CachedBeforeVerification";
/** @type {import("@mons/shared/profiles").CompletePlayerProfile & {username: string}} */
const profile = {
  ...canonicalAppearance(),
  id: "canonical-identity-profile",
  username: "VerifiedFastPlayer",
  eth: null,
  sol: null,
  emoji: 7,
  aura: "none",
  rating: 1777,
  nonce: 43,
  totalManaPoints: 321,
  win: true,
  completedProblemIds: [],
  isTutorialCompleted: true,
  mining: {
    lastRockDate: "2026-09-15",
    materials: { dust: 2, slime: 3, gum: 4, metal: 5, ice: 6 },
  },
};
/** @type {typeof profile} */
const presentationProfile = {
  ...profile,
  cardBackgroundId: 3,
  cardSubtitleId: 1,
  cardStickers: { mana: "blue-mana" },
  profileCounter: "mp",
  profileMons: { demon: 0, angel: 0, drainer: 0, spirit: 0, mystic: 0 },
};
const fen = new Game({ variant: "Classic" }).toFen();
/** @param {"white" | "black"} color @returns {import("@mons/shared/game-sessions").GameSessionMatch} */
const matchRecord = (color) => ({
  schemaVersion: 1,
  version: 2,
  color,
  emojiId: 1,
  aura: "none",
  gameVariant: "Classic",
  fen,
  status: "active",
  flatMovesString: "",
  timer: { state: "idle" },
});
/**
 * @typedef {import("@mons/shared/game-bootstrap").ReadGameBootstrapResponse} IdentityGameFixture
 * @typedef {{path: string, query: string, method: string, body: Record<string, unknown> | undefined}} IdentityRequest
 * @typedef {{page: import("playwright").Page, context: import("playwright").BrowserContext, origin: string, requests: IdentityRequest[], appGate: PromiseWithResolvers<void>, sessionGate: PromiseWithResolvers<void>, identityGate: PromiseWithResolvers<void>, appRequested: PromiseWithResolvers<void>, sessionRequested: PromiseWithResolvers<void>, identityRequested: PromiseWithResolvers<void>, metadataConnected: PromiseWithResolvers<void>, setAuthoritativeProfile(next: typeof profile): void, fillGuest(): void}} IdentityFixtureContext
 * @typedef {{path?: string, restored?: boolean, holdApp?: boolean, holdSession?: boolean, holdIdentity?: boolean, spectator?: boolean, unpaired?: boolean, quotaKey?: string | null, storedUsername?: string, holdPresentationFrames?: boolean, identity?: unknown, fallbackIdentity?: unknown}} IdentityOptions
 */
/** @type {IdentityGameFixture} */
const gameBootstrap = {
  ok: true,
  schemaVersion: 1,
  metadata: {
    inviteId,
    revision: 1,
    hostId: uid,
    guestId,
    hostColor: "white",
    hostRematches: { state: "open", indices: [] },
    guestRematches: { state: "open", indices: [] },
    automatchStateHint: null,
    eventId: null,
    eventOwned: false,
  },
  viewer: { role: "host", actorUid: uid, automatchOperationId: null },
  match: {
    inviteId,
    matchId: inviteId,
    revision: 1,
    hostPlayerId: uid,
    guestPlayerId: guestId,
    hostMatch: matchRecord("white"),
    guestMatch: matchRecord("black"),
  },
  hasPendingProposal: false,
};
const eventSeed = {
  snapshot: {
    ok: true,
    eventId,
    revision: 1,
    event: canonicalEvent({ eventId }),
    prizeSelections: {},
  },
  etag: eventSnapshotEtag(eventId, 1),
  bookmark: "mons-d1-v1:11111111-1111-4111-8111-111111111111:identity",
};

/** @returns {PromiseWithResolvers<void>} */
const deferred = () => Promise.withResolvers();

/** @template Value @param {Promise<Value>} promise @returns {Promise<Value>} */
async function withinDeadline(promise) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      /** @type {Promise<never>} */ (
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("identity-browser-fixture-timeout")),
            20_000,
          );
        })
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function serve() {
  if (!buildDirectory) {
    const server = await createBrowserViteServer({
      root: repository,
      cacheDir: cacheDirectory,
      server: {
        host: "127.0.0.1",
        port: 0,
        open: false,
        watch: null,
        hmr: false,
      },
      logLevel: "error",
    });
    await server.listen();
    return {
      origin: browserServerOrigin(server),
      appPath: "/src/index.tsx",
      close: () => server.close(),
    };
  }
  const root = resolve(buildDirectory);
  const html = await readFile(resolve(root, "index.html"), "utf8");
  const entryPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert.ok(entryPath, "Built HTML must reference its bootstrap module");
  const entry = await readFile(resolve(root, entryPath.slice(1)), "utf8");
  const appImports = [...entry.matchAll(/import\(["'`]([^"'`]+)["'`]\)/g)]
    .map((match) => present(match[1]))
    .filter((specifier) => /^\.\/src-[\w-]+\.js$/.test(specifier));
  assert.equal(
    appImports.length,
    1,
    "Built bootstrap must identify exactly one application chunk",
  );
  const appPath = new URL(present(appImports[0]), `http://fixture${entryPath}`)
    .pathname;
  const server = createHttpServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
    const relative = extname(pathname) ? pathname.slice(1) : "index.html";
    try {
      const content = await readFile(resolve(root, relative));
      const contentType =
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".webmanifest": "application/manifest+json",
        }[extname(relative)] ?? "application/octet-stream";
      response.writeHead(200, { "Content-Type": contentType });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await /** @type {Promise<void>} */ (
    new Promise((done) => server.listen(0, "127.0.0.1", done))
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    appPath,
    close: () =>
      /** @type {Promise<void>} */ (
        new Promise((done) => server.close(() => done()))
      ),
  };
}

/** @param {(context: IdentityFixtureContext) => Promise<void>} run @param {IdentityOptions} [options] */
async function fixture(
  run,
  {
    path = "/",
    restored = true,
    holdApp = false,
    holdSession = false,
    holdIdentity = false,
    spectator = false,
    unpaired = false,
    quotaKey = null,
    storedUsername = cachedName,
    holdPresentationFrames = false,
    identity = { ok: true, profile },
    fallbackIdentity = { ok: true, profile },
  } = {},
) {
  /** @type {IdentityGameFixture} */
  let routedGameBootstrap =
    spectator || unpaired
      ? {
          ...gameBootstrap,
          metadata: {
            ...gameBootstrap.metadata,
            hostId: "h".repeat(28),
            guestId: unpaired ? null : guestId,
          },
          viewer: { role: "watch", actorUid: null, automatchOperationId: null },
          match: {
            ...gameBootstrap.match,
            hostPlayerId: "h".repeat(28),
            guestPlayerId: unpaired ? null : guestId,
            guestMatch: unpaired ? null : gameBootstrap.match.guestMatch,
          },
        }
      : gameBootstrap;
  let authoritativeProfile = profile;
  /** @type {Set<import("playwright").WebSocketRoute>} */
  const metadataSockets = new Set();
  const metadataConnected = deferred();
  /** @param {string} playerId @param {boolean} [broadcast] */
  const pairGame = (playerId, broadcast = false) => {
    routedGameBootstrap = {
      ...routedGameBootstrap,
      metadata: {
        ...routedGameBootstrap.metadata,
        revision: routedGameBootstrap.metadata.revision + 1,
        guestId: playerId,
      },
      viewer: {
        role: playerId === uid ? "guest" : "watch",
        actorUid: playerId === uid ? uid : null,
        automatchOperationId: null,
      },
      match: {
        ...routedGameBootstrap.match,
        revision: routedGameBootstrap.match.revision + 1,
        guestPlayerId: playerId,
        guestMatch: matchRecord("black"),
      },
    };
    if (broadcast)
      for (const socket of metadataSockets)
        socket.send(
          JSON.stringify({
            schemaVersion: 1,
            type: "snapshot",
            snapshot: routedGameBootstrap.metadata,
          }),
        );
  };
  const server = await serve();
  const appGate = deferred();
  const sessionGate = deferred();
  const identityGate = deferred();
  const appRequested = deferred();
  const sessionRequested = deferred();
  const identityRequested = deferred();
  /** @type {IdentityRequest[]} */
  const requests = [];
  /** @type {{name: string, message: string, stack: string | undefined}[]} */
  const errors = [];
  /** @type {Set<string>} */
  const sessions = new Set();
  /** @type {import("playwright").Browser | undefined} */
  let browser;
  let closed = false;
  if (!holdApp) appGate.resolve();
  if (!holdSession) sessionGate.resolve();
  if (!holdIdentity) identityGate.resolve();
  try {
    const { origin } = server;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MONS_BROWSER_EXECUTABLE
        ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    context.setDefaultTimeout(20_000);
    await context.routeWebSocket(/wss:\/\/api\.mons\.link\/.*/, (socket) => {
      if (!unpaired || !socket.url().includes("/metadata/socket")) return;
      metadataSockets.add(socket);
      socket.onClose(() => metadataSockets.delete(socket));
      metadataConnected.resolve();
      socket.send(
        JSON.stringify({
          schemaVersion: 1,
          type: "snapshot",
          snapshot: routedGameBootstrap.metadata,
        }),
      );
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) {
        if (url.pathname === "/__identity-seed")
          return route.fulfill({
            contentType: "text/html",
            body: "<!doctype html>",
          });
        if (url.pathname === server.appPath) {
          appRequested.resolve();
          await appGate.promise;
        }
        if (!closed) await route.continue();
        return;
      }
      if (url.origin !== "https://api.mons.link") return route.abort();
      const headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, X-Mons-Data-Epoch",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Timing-Allow-Origin": origin,
        "Server-Timing": "session;dur=1, identity;dur=2, total;dur=3",
      };
      if (request.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers });
      if (url.pathname === "/release")
        return route.fulfill({
          status: 200,
          headers,
          json: { state: "active", dataEpoch: 1, generation: 1 },
        });
      const body = request.postData()
        ? jsonRecord(request.postDataJSON())
        : undefined;
      requests.push({
        path: url.pathname,
        query: url.search,
        method: request.method(),
        body,
      });
      /** @type {unknown} */
      let json;
      if (/^\/auth\/session\/(anonymous|refresh)$/.test(url.pathname)) {
        const sessionId = url.pathname.endsWith("/anonymous")
          ? stringValue(jsonRecord(body).sessionId)
          : stringValue(present(request.headers().authorization).split(".")[1]);
        if (url.pathname.endsWith("/anonymous")) sessions.add(sessionId);
        assert.ok(sessions.has(sessionId));
        sessionRequested.resolve();
        await sessionGate.promise;
        const exp = Math.floor(Date.now() / 1000) + 300;
        /** @type {Record<string, unknown>} */
        const sessionResponse = {
          ok: true,
          uid,
          sessionId,
          accessToken: `header.${Buffer.from(JSON.stringify({ sub: uid, sid: sessionId, iat: exp - 300, exp })).toString("base64url")}.signature`,
          accessExpiresAtMs: exp * 1000,
        };
        if (
          url.searchParams.get("bootstrapIdentity") === "1" &&
          identity !== "missing"
        )
          sessionResponse.identityBootstrap = identity;
        if (url.searchParams.has("bootstrapInviteId"))
          sessionResponse.gameBootstrap = {
            inviteId,
            selection: "current",
            result: routedGameBootstrap,
          };
        if (url.searchParams.has("bootstrapEventId"))
          sessionResponse.eventBootstrap = { eventId, result: eventSeed };
        json = sessionResponse;
      } else if (url.pathname === "/auth/identity") {
        identityRequested.resolve();
        await identityGate.promise;
        json = fallbackIdentity;
      } else if (url.pathname === "/auth/profile/sync") {
        json = {
          ok: true,
          profileId: profile.id,
          linkedMethods: { apple: true, eth: false, sol: false, x: false },
          appleLinked: true,
        };
      } else if (url.pathname === "/auth/session/logout") {
        return route.fulfill({ status: 204, headers });
      } else if (url.pathname === "/profiles/lookup") {
        json = {
          ok: true,
          profile: jsonRecord(body).id === uid ? authoritativeProfile : null,
        };
      } else if (url.pathname === "/invites/join") {
        pairGame(uid);
        json = {
          ok: true,
          inviteId,
          guestId: uid,
          joined: true,
          matchId: inviteId,
        };
      } else if (url.pathname === `/invites/${inviteId}/bootstrap`) {
        json = routedGameBootstrap;
      } else if (url.pathname === `/invites/${inviteId}/metadata`) {
        json = {
          ok: true,
          snapshot: routedGameBootstrap.metadata,
          viewer: routedGameBootstrap.viewer,
        };
      } else if (url.pathname === `/invites/${inviteId}/wagers`) {
        json = { ok: true, snapshot: { inviteId, revision: 1, wagers: {} } };
      } else if (
        url.pathname === `/invites/${inviteId}/matches/${inviteId}/presentation`
      ) {
        const presentation = {
          matchId: inviteId,
          actorUid: routedGameBootstrap.metadata.hostId,
          emojiId: body?.emojiId ?? profile.emoji,
          aura: "none",
          revision: 1,
        };
        json = {
          ok: true,
          presentation: body
            ? presentation
            : {
                matchId: inviteId,
                players: { [presentation.actorUid]: presentation },
              },
        };
      } else if (url.pathname === `/events/${eventId}/snapshot`) {
        json = eventSeed.snapshot;
      }
      if (!closed)
        await route.fulfill({
          status: json ? 200 : 503,
          headers,
          json: json ?? {
            ok: false,
            error: "unavailable",
            message: "Local identity browser fixture",
          },
        });
    });
    await context.addInitScript(
      ({ expectedName, quotaKey, holdPresentationFrames }) => {
        localStorage.setItem(
          "mons:data:v1:preferredAssetsSet",
          JSON.stringify("Pixel"),
        );
        localStorage.setItem("mons:data:v1:isMuted", "true");
        globalThis.identitySessionStorageProbe = { opens: 0, puts: 0 };
        const open = indexedDB.open;
        indexedDB.open = function (...args) {
          if (args[0] === "mons-link-sessions-v1")
            globalThis.identitySessionStorageProbe.opens += 1;
          return open.apply(this, args);
        };
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put =
          /** @this {IDBObjectStore} @param {[value: unknown, key?: IDBValidKey | undefined]} args */ function (
            ...args
          ) {
            if (this.transaction.db.name === "mons-link-sessions-v1")
              globalThis.identitySessionStorageProbe.puts += 1;
            return put.apply(this, args);
          };
        const cosmeticKeys = new Set(
          [
            "cardBackgroundId",
            "cardStickers",
            "cardSubtitleId",
            "profileCounter",
            "profileMons",
          ].map((key) => `mons:data:v1:${key}`),
        );
        globalThis.identityCosmeticWrites = [];
        const recordSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem =
          /** @this {Storage} @param {string} key @param {string} value */ function (
            key,
            value,
          ) {
            if (this === localStorage && cosmeticKeys.has(key)) {
              globalThis.identityCosmeticWrites.push({
                key,
                value,
                time: performance.now(),
                nameVisible:
                  performance.getEntriesByName("auth:name-visible").length > 0,
              });
            }
            return recordSetItem.call(this, key, value);
          };
        if (holdPresentationFrames) {
          const requestFrame = requestAnimationFrame;
          const cancelFrame = cancelAnimationFrame;
          /** @type {Map<number, FrameRequestCallback>} */
          const heldFrames = new Map();
          let nextFrame = -1;
          let released = false;
          window.requestAnimationFrame = (callback) => {
            if (
              !released &&
              performance.getEntriesByName("auth:name-committed").length > 0
            ) {
              const id = nextFrame--;
              heldFrames.set(id, callback);
              return id;
            }
            return requestFrame(callback);
          };
          window.cancelAnimationFrame = (id) => {
            if (id < 0) heldFrames.delete(id);
            else cancelFrame(id);
          };
          globalThis.releaseIdentityPresentationFrames = () => {
            released = true;
            const frames = [...heldFrames.values()];
            heldFrames.clear();
            frames.forEach((callback) => requestFrame(callback));
          };
        }
        if (quotaKey) {
          if (quotaKey === "cardStickers")
            localStorage.setItem("mons:data:v1:cardStickers", "{}");
          globalThis.identityQuotaFailures = 0;
          const setItem = Storage.prototype.setItem;
          Storage.prototype.setItem =
            /** @this {Storage} @param {string} key @param {string} value */ function (
              key,
              value,
            ) {
              if (
                this === localStorage &&
                key === `mons:data:v1:${quotaKey}` &&
                location.pathname !== "/__identity-seed" &&
                value.length > (this.getItem(key)?.length ?? 0)
              ) {
                globalThis.identityQuotaFailures += 1;
                throw new DOMException(
                  "Local profile cache quota exceeded",
                  "QuotaExceededError",
                );
              }
              return setItem.call(this, key, value);
            };
        }
        globalThis.identityMarkProbe = [];
        const mark = performance.mark.bind(performance);
        performance.mark = (name, options) => {
          if (name.startsWith("auth:")) {
            globalThis.identityMarkProbe.push({
              name,
              time: performance.now(),
              sessionStorage: { ...globalThis.identitySessionStorageProbe },
              nameInDom: Array.from(document.querySelectorAll("button")).some(
                (button) => button.textContent === expectedName,
              ),
            });
          }
          return mark(name, options);
        };
      },
      { expectedName: profile.username, quotaKey, holdPresentationFrames },
    );
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      errors.push({
        name: error.name,
        message: error.message,
        stack: error.stack,
      }),
    );
    if (restored) {
      const sessionId = crypto.randomUUID();
      sessions.add(sessionId);
      await page.goto(`${origin}/__identity-seed`);
      await page.evaluate(
        ({ sessionId, uid, cachedName }) =>
          /** @type {Promise<void>} */ (
            new Promise((resolve, reject) => {
              localStorage.setItem("mons:data:v1:loginId", JSON.stringify(uid));
              localStorage.setItem(
                "mons:data:v1:profileId",
                JSON.stringify("cached-before-canonical-merge"),
              );
              localStorage.setItem(
                "mons:data:v1:username",
                JSON.stringify(cachedName),
              );
              const open = indexedDB.open("mons-link-sessions-v1", 1);
              open.onupgradeneeded = () =>
                open.result.createObjectStore("state");
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const db = open.result;
                const transaction = db.transaction("state", "readwrite");
                transaction.objectStore("state").put(
                  {
                    generation: crypto.randomUUID(),
                    revision: 1,
                    initialized: true,
                    session: {
                      sessionId,
                      uid,
                      refreshSecret: "a".repeat(42) + "A",
                      revokeSecret: "b".repeat(42) + "A",
                    },
                    revocations: [],
                  },
                  "current",
                );
                transaction.oncomplete = () => {
                  db.close();
                  resolve();
                };
                transaction.onerror = () => reject(transaction.error);
              };
            })
          ),
        { sessionId, uid, cachedName: storedUsername },
      );
    }
    await page.goto(`${origin}${path}`, { waitUntil: "commit" });
    try {
      await run({
        page,
        context,
        origin,
        requests,
        appGate,
        sessionGate,
        identityGate,
        appRequested,
        sessionRequested,
        identityRequested,
        metadataConnected,
        setAuthoritativeProfile: (next) => {
          authoritativeProfile = next;
        },
        fillGuest: () => pairGame(guestId, true),
      });
    } catch (error) {
      assert.ok(error instanceof Error);
      error.message += `\nBrowser errors: ${JSON.stringify(errors)}`;
      throw error;
    }
    assert.deepEqual(errors, []);
  } finally {
    closed = true;
    appGate.resolve();
    sessionGate.resolve();
    identityGate.resolve();
    await browser?.close();
    await server.close();
  }
}

/** @param {IdentityRequest[]} requests @param {boolean} [restored] */
function assertSingleIdentitySession(requests, restored = true) {
  const session = requests.filter(({ path }) =>
    /^\/auth\/session\/(anonymous|refresh)$/.test(path),
  );
  assert.equal(session.length, 1, JSON.stringify(requests));
  const first = present(session[0]);
  assert.equal(
    first.path,
    `/auth/session/${restored ? "refresh" : "anonymous"}`,
  );
  assert.equal(new URLSearchParams(first.query).get("bootstrapIdentity"), "1");
  assert.equal(
    requests.some(({ path }) => path === "/auth/profile/sync"),
    false,
    JSON.stringify(requests),
  );
  return new URLSearchParams(first.query);
}

/** @param {import("playwright").Page} page */
async function assertVerifiedProfile(page) {
  await page
    .getByRole("button", { name: profile.username, exact: true })
    .waitFor({ state: "visible" });
  assert.equal(
    await page.getByRole("button", { name: cachedName, exact: true }).count(),
    0,
  );
  assert.deepEqual(
    await page.evaluate(() =>
      Object.fromEntries(
        [
          "profileId",
          "username",
          "playerRating",
          "playerNonce",
          "playerTotalManaPoints",
          "playerMiningMaterials",
          "tutorialCompleted",
        ].map((key) => [key, localStorage.getItem(`mons:data:v1:${key}`)]),
      ),
    ),
    {
      profileId: JSON.stringify(profile.id),
      username: JSON.stringify(profile.username),
      playerRating: String(profile.rating),
      playerNonce: String(profile.nonce),
      playerTotalManaPoints: String(profile.totalManaPoints),
      playerMiningMaterials: JSON.stringify(profile.mining.materials),
      tutorialCompleted: "true",
    },
  );
}

test(
  "restoration reuses IndexedDB and paints the verified name before cosmetic persistence",
  { timeout: 60_000 },
  async (t) => {
    await fixture(
      async ({ page, requests }) => {
        await assertVerifiedProfile(page);
        await page.waitForFunction(
          () =>
            performance.getEntriesByName("auth:name-visible").length > 0 &&
            globalThis.identityCosmeticWrites.length === 5,
        );
        const probe = await page.evaluate(() => ({
          storage: globalThis.identitySessionStorageProbe,
          writes: globalThis.identityCosmeticWrites,
          timings: Object.fromEntries(
            performance
              .getEntriesByType("measure")
              .filter((entry) => entry.name.startsWith("auth:"))
              .map((entry) => [entry.name, Math.round(entry.duration)]),
          ),
        }));
        t.diagnostic(
          JSON.stringify({
            sessionStorage: probe.storage,
            cosmeticWritesAfterNameVisible: probe.writes.filter(
              (write) => write.nameVisible,
            ).length,
            timingsMs: probe.timings,
          }),
        );
        assert.deepEqual(probe.storage, { opens: 1, puts: 0 });
        assert.ok(probe.writes.every((write) => write.nameVisible));
        assertSingleIdentitySession(requests);
        const preconnect = page.locator(
          'link[rel="preconnect"][href="https://api.mons.link"]',
        );
        assert.equal(await preconnect.count(), 1);
        assert.equal(await preconnect.getAttribute("crossorigin"), "");
      },
      { identity: { ok: true, profile: presentationProfile } },
    );
  },
);

test(
  "opening the own profile card flushes pending cosmetics before held paint callbacks",
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page }) => {
        await assertVerifiedProfile(page);
        assert.equal(
          await page.evaluate(() => globalThis.identityCosmeticWrites.length),
          0,
        );
        await page
          .getByRole("button", { name: profile.username, exact: true })
          .dispatchEvent("click");
        assert.deepEqual(
          await page.evaluate(() => ({
            background: localStorage.getItem("mons:data:v1:cardBackgroundId"),
            counter: localStorage.getItem("mons:data:v1:profileCounter"),
            writes: globalThis.identityCosmeticWrites.length,
          })),
          {
            background: JSON.stringify(presentationProfile.cardBackgroundId),
            counter: JSON.stringify(presentationProfile.profileCounter),
            writes: 5,
          },
        );
        await page.evaluate(() =>
          globalThis.releaseIdentityPresentationFrames(),
        );
      },
      {
        identity: { ok: true, profile: presentationProfile },
        holdPresentationFrames: true,
      },
    );
  },
);

test(
  "the own leaderboard fallback flushes pending cosmetics before caching its profile",
  { timeout: 60_000, skip: Boolean(buildDirectory) },
  async () => {
    await fixture(
      async ({ page, origin, sessionRequested, sessionGate }) => {
        await withinDeadline(sessionRequested.promise);
        await page.route("https://api.mons.link/leaderboards/read", (route) =>
          route.fulfill({
            headers: {
              "Access-Control-Allow-Origin": origin,
              "Access-Control-Allow-Headers":
                "Authorization, Content-Type, X-Mons-Data-Epoch",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
            },
            json: { ok: true, profiles: [] },
          }),
        );
        await page.evaluate(() => {
          localStorage.setItem("mons:data:v1:cardBackgroundId", "7");
          localStorage.setItem(
            "mons:data:v1:profileMons",
            JSON.stringify({
              demon: 1,
              angel: 1,
              drainer: 1,
              spirit: 1,
              mystic: 1,
            }),
          );
        });
        sessionGate.resolve();
        await assertVerifiedProfile(page);
        assert.equal(
          await page.evaluate(() =>
            localStorage.getItem("mons:data:v1:cardBackgroundId"),
          ),
          "7",
        );
        await page.locator('button:has(img[alt=""])').dispatchEvent("click");
        await page
          .locator("tr")
          .filter({ hasText: profile.username })
          .first()
          .waitFor({ state: "visible" });
        const readPresentation = () =>
          page.evaluate(async (profileId) => {
            const { leaderboardCache } =
              await import("/src/ui/leaderboardCache.ts");
            const cachedProfile = leaderboardCache
              .get("rating")
              ?.find((row) => row.id === profileId)?.profile;
            return {
              storedBackground: localStorage.getItem(
                "mons:data:v1:cardBackgroundId",
              ),
              storedMons: localStorage.getItem("mons:data:v1:profileMons"),
              cachedBackground: cachedProfile?.cardBackgroundId,
              cachedMons: cachedProfile?.profileMons,
              cachedUsername: cachedProfile?.username,
            };
          }, profile.id);
        const expected = {
          storedBackground: JSON.stringify(profile.cardBackgroundId),
          storedMons:
            profile.profileMons === null
              ? null
              : JSON.stringify(profile.profileMons),
          cachedBackground: profile.cardBackgroundId,
          cachedMons: profile.profileMons,
          cachedUsername: profile.username,
        };
        assert.deepEqual(await readPresentation(), expected);
        await page.evaluate(() =>
          globalThis.releaseIdentityPresentationFrames(),
        );
        await page.waitForFunction(
          () => performance.getEntriesByName("auth:name-visible").length > 0,
        );
        assert.deepEqual(await readPresentation(), expected);
      },
      { holdSession: true, holdPresentationFrames: true },
    );
  },
);

test(
  "a newer cosmetic edit survives deferred restoration while the other fields persist",
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page }) => {
        await assertVerifiedProfile(page);
        await page.evaluate(() => {
          localStorage.setItem("mons:data:v1:cardBackgroundId", "7");
          globalThis.releaseIdentityPresentationFrames();
        });
        await page.waitForFunction(
          () =>
            localStorage.getItem("mons:data:v1:profileCounter") ===
            JSON.stringify("mp"),
        );
        assert.equal(
          await page.evaluate(() =>
            localStorage.getItem("mons:data:v1:cardBackgroundId"),
          ),
          "7",
        );
      },
      {
        identity: { ok: true, profile: presentationProfile },
        holdPresentationFrames: true,
      },
    );
  },
);

test(
  "own board sprite selection flushes verified cosmetics before reading them",
  { timeout: 60_000, skip: Boolean(buildDirectory) },
  async () => {
    await fixture(
      async ({ page }) => {
        await assertVerifiedProfile(page);
        const selection = await page.evaluate(async () => {
          const { getMonsIndexes } = await import("/src/utils/namedMons.ts");
          const before = globalThis.identityCosmeticWrites.length;
          const indexes = getMonsIndexes(false, null);
          const writes = globalThis.identityCosmeticWrites.length;
          globalThis.releaseIdentityPresentationFrames();
          return { before, indexes, writes };
        });
        assert.deepEqual(selection, {
          before: 0,
          indexes: [1, 1, 1, 1, 1],
          writes: 5,
        });
      },
      {
        identity: {
          ok: true,
          profile: {
            ...presentationProfile,
            profileMons: {
              demon: 1,
              angel: 1,
              drainer: 1,
              spirit: 1,
              mystic: 1,
            },
          },
        },
        holdPresentationFrames: true,
      },
    );
  },
);

test(
  "logout before cosmetic persistence prevents the deferred profile from returning",
  { timeout: 60_000, skip: Boolean(buildDirectory) },
  async () => {
    await fixture(
      async ({ page }) => {
        await assertVerifiedProfile(page);
        await page.evaluate(async () => {
          const { connection } = await import("/src/connection/connection.ts");
          const { storage } = await import("/src/utils/storage.ts");
          await connection.signOut();
          storage.signOut();
          globalThis.releaseIdentityPresentationFrames();
          await /** @type {Promise<number>} */ (
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            )
          );
        });
        assert.deepEqual(
          await page.evaluate(() => ({
            background: localStorage.getItem("mons:data:v1:cardBackgroundId"),
            counter: localStorage.getItem("mons:data:v1:profileCounter"),
            writes: globalThis.identityCosmeticWrites.length,
          })),
          { background: null, counter: null, writes: 0 },
        );
      },
      {
        identity: { ok: true, profile: presentationProfile },
        holdPresentationFrames: true,
      },
    );
  },
);

test(
  "a newer login for the same user supersedes deferred restoration cosmetics",
  { timeout: 60_000, skip: Boolean(buildDirectory) },
  async () => {
    await fixture(
      async ({ page }) => {
        await assertVerifiedProfile(page);
        await page.evaluate(
          async ({ uid, profile }) => {
            const { handleLoginSuccess } =
              await import("/src/connection/loginSuccess.ts");
            const { setAuthStatusGlobally } =
              await import("/src/connection/authentication.ts");
            if (
              !handleLoginSuccess({
                ok: true,
                linkedMethods: {
                  apple: true,
                  eth: false,
                  sol: false,
                  x: false,
                },
                appleLinked: true,
                opId: "identity-browser-login",
                ...profile,
                uid,
                profileId: "newer-verified-profile",
                username: "NewerVerifiedLogin",
                cardBackgroundId: 7,
                profileCounter: "gp",
              })
            )
              throw new Error("newer-login-rejected");
            setAuthStatusGlobally("authenticated");
            globalThis.releaseIdentityPresentationFrames();
            await /** @type {Promise<number>} */ (
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              )
            );
          },
          { uid, profile: presentationProfile },
        );
        await page
          .getByRole("button", { name: "NewerVerifiedLogin", exact: true })
          .waitFor({ state: "visible" });
        assert.deepEqual(
          await page.evaluate(() => ({
            profileId: localStorage.getItem("mons:data:v1:profileId"),
            background: localStorage.getItem("mons:data:v1:cardBackgroundId"),
            counter: localStorage.getItem("mons:data:v1:profileCounter"),
            writes: globalThis.identityCosmeticWrites.length,
          })),
          {
            profileId: JSON.stringify("newer-verified-profile"),
            background: "7",
            counter: JSON.stringify("gp"),
            writes: 5,
          },
        );
      },
      {
        identity: { ok: true, profile: presentationProfile },
        holdPresentationFrames: true,
      },
    );
  },
);

test(
  "hidden documents finish cosmetic persistence without waiting for animation frames",
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, sessionRequested, sessionGate }) => {
        await withinDeadline(sessionRequested.promise);
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        sessionGate.resolve();
        await assertVerifiedProfile(page);
        await page.waitForFunction(
          () =>
            localStorage.getItem("mons:data:v1:profileCounter") ===
            JSON.stringify("mp"),
        );
        assert.equal(
          await page.evaluate(() => globalThis.identityCosmeticWrites.length),
          5,
        );
        await page.evaluate(() =>
          globalThis.releaseIdentityPresentationFrames(),
        );
      },
      {
        identity: { ok: true, profile: presentationProfile },
        holdSession: true,
        holdPresentationFrames: true,
      },
    );
  },
);

test(
  "a same-name profile refresh persists cosmetics without a header rerender",
  { timeout: 60_000, skip: Boolean(buildDirectory) },
  async () => {
    await fixture(
      async ({ page }) => {
        await assertVerifiedProfile(page);
        await page.waitForFunction(
          () => localStorage.getItem("mons:data:v1:cardBackgroundId") === "3",
        );
        await page.evaluate(
          async ({ profile, uid }) => {
            const { applyVerifiedProfile } =
              await import("/src/connection/verifiedProfile.ts");
            applyVerifiedProfile({ ...profile, cardBackgroundId: 9 }, uid, {
              deferPresentationCache: true,
            });
          },
          { profile: presentationProfile, uid },
        );
        await page.waitForFunction(
          () => localStorage.getItem("mons:data:v1:cardBackgroundId") === "9",
        );
        assert.equal(
          await page
            .getByRole("button", { name: profile.username, exact: true })
            .count(),
          1,
        );
      },
      { identity: { ok: true, profile: presentationProfile } },
    );
  },
);

for (const {
  label,
  path,
  target,
} of /** @type {{label: string, path: string, target?: [string, string]}[]} */ ([
  { label: "home", path: "/" },
  {
    label: "invite",
    path: `/${inviteId}`,
    target: ["bootstrapInviteId", inviteId],
  },
  {
    label: "event",
    path: `/event/${eventId}`,
    target: ["bootstrapEventId", eventId],
  },
  { label: "watch", path: "/watch" },
])) {
  test(
    `${label} restores its verified full profile from one session request before the application loads`,
    { timeout: 60_000 },
    async () => {
      await fixture(
        async ({ page, requests, appRequested, sessionRequested, appGate }) => {
          await withinDeadline(
            Promise.all([appRequested.promise, sessionRequested.promise]),
          );
          assert.equal(await page.locator("#root > *").count(), 0);
          const query = assertSingleIdentitySession(requests);
          if (target) assert.equal(query.get(target[0]), target[1]);
          await page.waitForFunction(
            () => performance.getEntriesByName("auth:session-ready").length > 0,
          );
          appGate.resolve();
          await assertVerifiedProfile(page);
          assertSingleIdentitySession(requests);
          assert.equal(
            requests.some(({ path }) => path === "/auth/identity"),
            false,
          );
          assert.equal(
            requests.some(
              ({ path, body }) =>
                path === "/profiles/lookup" && jsonRecord(body).id === uid,
            ),
            false,
            JSON.stringify(requests),
          );
          assert.equal(
            await page.evaluate(() =>
              localStorage.getItem("__mons_link_signin_sync__"),
            ),
            null,
          );
          if (target)
            assert.equal(
              requests.some(
                ({ path }) =>
                  path ===
                  `/${label === "invite" ? "invites" : "events"}/${target[1]}/${label === "invite" ? "bootstrap" : "snapshot"}`,
              ),
              false,
            );
          await page.waitForFunction(
            () => performance.getEntriesByName("auth:name-visible").length > 0,
          );
          const marks = await page.evaluate(() => globalThis.identityMarkProbe);
          const orderedNames = [
            "auth:restore-start",
            "auth:local-ready",
            "auth:session-ready",
            "auth:identity-ready",
            "auth:name-committed",
            "auth:name-visible",
          ];
          const orderedMarks = orderedNames.map((name) =>
            marks.find((mark) => mark.name === name),
          );
          assert.ok(orderedMarks.every(Boolean), JSON.stringify(marks));
          for (let index = 1; index < orderedMarks.length; index += 1)
            assert.ok(
              present(orderedMarks[index]).time >=
                present(orderedMarks[index - 1]).time,
            );
          assert.equal(present(orderedMarks[4]).nameInDom, true);
          assert.equal(present(orderedMarks[5]).nameInDom, true);
        },
        { path, holdApp: true },
      );
    },
  );
}

test(
  "a paired invite spectator reuses verified identity through the watch-only transition",
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests, appRequested, sessionRequested, appGate }) => {
        await withinDeadline(
          Promise.all([appRequested.promise, sessionRequested.promise]),
        );
        await page.waitForFunction(
          () => performance.getEntriesByName("auth:session-ready").length > 0,
        );
        appGate.resolve();
        await assertVerifiedProfile(page);
        await page
          .getByRole("button", { name: "Watching", exact: true })
          .waitFor();
        await page.waitForFunction(
          () =>
            performance.getEntriesByName("main-game:route-prepared").length > 0,
        );
        assert.equal(
          assertSingleIdentitySession(requests).get("bootstrapInviteId"),
          inviteId,
        );
        assert.equal(
          requests.some(({ path }) => path === "/auth/identity"),
          false,
        );
        assert.equal(
          requests.some(
            ({ path, body }) =>
              path === "/profiles/lookup" && jsonRecord(body).id === uid,
          ),
          false,
          JSON.stringify(requests),
        );
      },
      { path: `/${inviteId}`, holdApp: true, spectator: true },
    );
  },
);

for (const join of [true, false]) {
  test(
    `an initially unpaired invite fetches current own mining data when ${join ? "joining later" : "another guest joins later"}`,
    { timeout: 60_000, skip: Boolean(buildDirectory) },
    async () => {
      await fixture(
        async ({
          page,
          requests,
          metadataConnected,
          setAuthoritativeProfile,
          fillGuest,
        }) => {
          await assertVerifiedProfile(page);
          const joinButton = page.getByRole("button", {
            name: "Join Game",
            exact: true,
          });
          await joinButton.waitFor({ state: "visible" });
          await page.waitForFunction(
            () =>
              performance.getEntriesByName("main-game:route-prepared").length >
              0,
          );
          assert.equal(
            requests.some(
              ({ path, body }) =>
                path === "/profiles/lookup" && jsonRecord(body).id === uid,
            ),
            false,
          );
          const localMining = {
            ...profile.mining,
            materials: { ...profile.mining.materials, dust: 42 },
          };
          const currentMining = {
            ...profile.mining,
            materials: { ...profile.mining.materials, dust: 77 },
          };
          await page.evaluate(async (mining) => {
            const { rocksMiningService } =
              await import("/src/services/rocksMiningService.ts");
            rocksMiningService.setFromServer(mining, { persist: true });
          }, localMining);
          setAuthoritativeProfile({ ...profile, mining: currentMining });
          const ownLookup = page.waitForRequest(
            (request) =>
              new URL(request.url()).pathname === "/profiles/lookup" &&
              request.method() === "POST" &&
              jsonRecord(request.postDataJSON()).id === uid,
          );
          if (join) await joinButton.click();
          else {
            await withinDeadline(metadataConnected.promise);
            fillGuest();
          }
          await ownLookup;
          await page.waitForFunction(() => {
            const materials = /** @type {unknown} */ (
              JSON.parse(
                localStorage.getItem("mons:data:v1:playerMiningMaterials") ??
                  "null",
              )
            );
            return (
              materials !== null &&
              typeof materials === "object" &&
              "dust" in materials &&
              materials.dust === 77
            );
          });
          assert.deepEqual(
            await page.evaluate(async () => {
              const { rocksMiningService } =
                await import("/src/services/rocksMiningService.ts");
              return rocksMiningService.getSnapshot();
            }),
            currentMining,
          );
          if (!join)
            await page
              .getByRole("button", { name: "Watching", exact: true })
              .waitFor();
          assertSingleIdentitySession(requests);
          assert.equal(
            requests.filter(
              ({ path, body }) =>
                path === "/profiles/lookup" && jsonRecord(body).id === uid,
            ).length,
            1,
          );
        },
        { path: `/${inviteId}`, unpaired: true },
      );
    },
  );
}

test(
  "cached usernames stay hidden until the current identity is verified",
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests, sessionRequested, sessionGate }) => {
        await withinDeadline(sessionRequested.promise);
        await page.waitForSelector("#monsboard");
        assert.equal(
          await page
            .getByRole("button", { name: cachedName, exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("button", { name: profile.username, exact: true })
            .count(),
          0,
        );
        sessionGate.resolve();
        await assertVerifiedProfile(page);
        assertSingleIdentitySession(requests);
      },
      { holdSession: true },
    );
  },
);

test(
  "optional card cache quota failures preserve the verified identity without retrying authentication",
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await assertVerifiedProfile(page);
        await page.waitForFunction(
          () => performance.getEntriesByName("auth:name-visible").length > 0,
        );
        const snapshot = await page.evaluate(() => ({
          failures: globalThis.identityQuotaFailures,
          cardStickers: localStorage.getItem("mons:data:v1:cardStickers"),
          loginId: localStorage.getItem("mons:data:v1:loginId"),
        }));
        assert.ok(snapshot.failures > 0);
        assert.equal(snapshot.cardStickers, "{}");
        assert.equal(snapshot.loginId, JSON.stringify(uid));
        assert.equal(
          await page
            .getByRole("button", { name: "Sign In", exact: true })
            .count(),
          0,
        );
        assertSingleIdentitySession(requests);
        assert.equal(
          requests.some(
            ({ path }) =>
              path === "/auth/identity" || path === "/profiles/lookup",
          ),
          false,
        );
      },
      {
        quotaKey: "cardStickers",
        identity: {
          ok: true,
          profile: {
            ...profile,
            cardStickers: {
              mana: "blue-mana",
              "bottom-left": "rock",
            },
          },
        },
      },
    );
  },
);

test(
  "username cache quota failures still measure the verified name after it reaches the DOM",
  { timeout: 60_000 },
  async () => {
    const storedUsername = "OldName";
    await fixture(
      async ({ page, requests }) => {
        await page
          .getByRole("button", { name: profile.username, exact: true })
          .waitFor({ state: "visible" });
        await page.waitForFunction(
          () =>
            performance.getEntriesByName("auth:name-visible", "mark").length ===
            1,
        );
        const snapshot = await page.evaluate(() => ({
          failures: globalThis.identityQuotaFailures,
          username: localStorage.getItem("mons:data:v1:username"),
          marks: globalThis.identityMarkProbe,
        }));
        assert.ok(snapshot.failures > 0);
        assert.equal(snapshot.username, JSON.stringify(storedUsername));
        for (const name of ["auth:name-committed", "auth:name-visible"])
          assert.deepEqual(
            snapshot.marks
              .filter((mark) => mark.name === name)
              .map((mark) => mark.nameInDom),
            [true],
          );
        assertSingleIdentitySession(requests);
        assert.equal(
          requests.some(
            ({ path }) =>
              path === "/auth/identity" || path === "/profiles/lookup",
          ),
          false,
        );
      },
      { quotaKey: "username", storedUsername },
    );
  },
);

test(
  "a fresh anonymous identity uses one create request and leaves sign-in available",
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await page
          .getByRole("button", { name: "Sign In", exact: true })
          .waitFor();
        await page.waitForFunction(
          () => performance.getEntriesByName("auth:identity-ready").length > 0,
        );
        assertSingleIdentitySession(requests, false);
        assert.equal(
          requests.some(({ path }) =>
            ["/auth/identity", "/profiles/lookup"].includes(path),
          ),
          false,
        );
        assert.equal(
          await page.evaluate(() =>
            localStorage.getItem("mons:data:v1:profileId"),
          ),
          null,
        );
      },
      { restored: false, identity: { ok: true, profile: null } },
    );
  },
);

test(
  "malformed inline identity preserves the token and obtains one standalone verified identity",
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await assertVerifiedProfile(page);
        assertSingleIdentitySession(requests);
        assert.equal(
          requests.filter(({ path }) => path === "/auth/identity").length,
          1,
        );
      },
      { identity: { ok: true, profile: { id: profile.id } } },
    );
  },
);

test(
  "missing inline identity uses the read-only identity route without profile synchronization",
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await assertVerifiedProfile(page);
        assertSingleIdentitySession(requests);
        assert.equal(
          requests.filter(({ path }) => path === "/auth/identity").length,
          1,
        );
        assert.equal(
          requests.some(({ path }) => path === "/auth/profile/sync"),
          false,
        );
      },
      { identity: "missing" },
    );
  },
);

test(
  "only the repair-required identity response runs profile sync before reading the repaired profile",
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await assertVerifiedProfile(page);
        assert.deepEqual(
          requests
            .filter(({ path }) =>
              [
                "/auth/session/refresh",
                "/auth/profile/sync",
                "/auth/identity",
                "/profiles/lookup",
              ].includes(path),
            )
            .map(({ path }) => path),
          ["/auth/session/refresh", "/auth/profile/sync", "/auth/identity"],
        );
      },
      { identity: { ok: false, status: 409 } },
    );
  },
);

test(
  "a newer successful login prevents a delayed identity read from restoring an older profile",
  { timeout: 60_000, skip: Boolean(buildDirectory) },
  async () => {
    const newName = "NewerVerifiedLogin";
    await fixture(
      async ({ page, identityRequested, identityGate }) => {
        await withinDeadline(identityRequested.promise);
        await page.waitForSelector("#monsboard");
        await page.evaluate(
          async ({ uid, profile, newName }) => {
            const { handleLoginSuccess } =
              await import("/src/connection/loginSuccess.ts");
            const { setAuthStatusGlobally } =
              await import("/src/connection/authentication.ts");
            if (
              !handleLoginSuccess({
                ok: true,
                linkedMethods: {
                  apple: true,
                  eth: false,
                  sol: false,
                  x: false,
                },
                appleLinked: true,
                opId: "identity-browser-login",
                ...profile,
                profileId: "newer-verified-profile",
                uid,
                username: newName,
              })
            )
              throw new Error("login-fixture-rejected");
            setAuthStatusGlobally("authenticated");
          },
          { uid, profile, newName },
        );
        await page
          .getByRole("button", { name: newName, exact: true })
          .waitFor();
        const response = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/auth/identity",
        );
        identityGate.resolve();
        await (await response).finished();
        await page.evaluate(
          () =>
            /** @type {Promise<number>} */ (
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              )
            ),
        );
        assert.equal(
          await page
            .getByRole("button", { name: newName, exact: true })
            .isVisible(),
          true,
        );
        assert.equal(
          await page.evaluate(() =>
            localStorage.getItem("mons:data:v1:profileId"),
          ),
          JSON.stringify("newer-verified-profile"),
        );
      },
      { identity: { ok: false, status: 503 }, holdIdentity: true },
    );
  },
);

test(
  "logout rejects a delayed identity result without redisplaying the verified name",
  { timeout: 60_000, skip: Boolean(buildDirectory) },
  async () => {
    await fixture(
      async ({ page, identityRequested, identityGate }) => {
        await withinDeadline(identityRequested.promise);
        await page.waitForSelector("#monsboard");
        await page.evaluate(async () => {
          const { connection } = await import("/src/connection/connection.ts");
          const { storage } = await import("/src/utils/storage.ts");
          await connection.signOut();
          storage.signOut();
        });
        const response = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/auth/identity",
        );
        identityGate.resolve();
        await (await response).finished();
        await page
          .getByRole("button", { name: "Sign In", exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: profile.username, exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.evaluate(() =>
            localStorage.getItem("mons:data:v1:profileId"),
          ),
          null,
        );
      },
      { identity: { ok: false, status: 503 }, holdIdentity: true },
    );
  },
);
