import { browserServerOrigin } from "./browserViteServer.mjs";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createBrowserViteServer as createViteServer } from "./browserViteServer.mjs";
import { Game } from "mons-rules";

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
  `game-loading-${process.pid}`,
);
test.after(() => rm(cacheDirectory, { recursive: true, force: true }));
const defaultInviteId = "FastLoadingGame";
const inviteId = defaultInviteId;
const hostId = "h".repeat(28);
const guestId = "g".repeat(28);
const fen = new Game({ variant: "Classic" }).toFen();
/** @param {"white" | "black"} color @returns {import("@mons/shared/game-sessions").GameSessionMatch} */
const record = (color) => ({
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
/** @type {import("@mons/shared/invite-metadata").InviteMetadataSnapshot} */
const metadata = {
  inviteId,
  revision: 1,
  hostId,
  guestId,
  hostColor: "white",
  hostRematches: { state: "open", indices: [] },
  guestRematches: { state: "open", indices: [] },
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
};
/** @type {import("@mons/shared/invite-metadata").InviteMetadataViewer} */
const viewer = { role: "host", actorUid: hostId, automatchOperationId: null };
/** @type {import("@mons/shared/match-sync").MatchSyncSnapshot} */
const match = {
  inviteId,
  matchId: inviteId,
  revision: 1,
  hostPlayerId: hostId,
  guestPlayerId: guestId,
  hostMatch: record("white"),
  guestMatch: record("black"),
};
/** @type {import("@mons/shared/game-bootstrap").ReadGameBootstrapResponse} */
const bootstrap = {
  ok: true,
  schemaVersion: 1,
  metadata,
  viewer,
  match,
  hasPendingProposal: false,
};
const benchmark = process.env.MONS_LOADING_BENCHMARK === "1";
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
            () => reject(new Error("loading-fixture-timeout")),
            30_000,
          );
        })
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function serve() {
  if (!process.env.MONS_LOADING_BUILD) {
    const server = await createViteServer({
      root: repository,
      cacheDir: cacheDirectory,
      logLevel: "error",
      optimizeDeps: { force: true },
      server: {
        host: "127.0.0.1",
        port: 0,
        open: false,
        watch: null,
        hmr: false,
      },
    });
    await server.listen();
    return {
      origin: browserServerOrigin(server),
      close: () => server.close(),
    };
  }
  const root = resolve(process.env.MONS_LOADING_BUILD);
  const server = createHttpServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = pathname.startsWith("/assets/")
      ? pathname.slice(1)
      : "index.html";
    try {
      const content = await readFile(resolve(root, relative));
      const type =
        { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
          extname(relative)
        ] || "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Encoding": "gzip",
      });
      response.end(gzipSync(content));
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
    close: () =>
      /** @type {Promise<void>} */ (
        new Promise((done) => server.close(() => done()))
      ),
  };
}

/**
 * @typedef {import("@mons/shared/invite-metadata").InviteMetadataSnapshot} Metadata
 * @typedef {import("@mons/shared/match-sync").MatchSyncSnapshot} MatchSnapshot
 * @typedef {import("@mons/shared/invite-wagers").InviteWagersSnapshot} WagersSnapshot
 * @typedef {{path: string, query: string, method: string, at: number}} LoadingRequest
 * @typedef {{page: import("playwright").Page, context: import("playwright").BrowserContext, sessions: Set<string>, registerSession(sessionId: string, uid: string): void, requests: LoadingRequest[], sockets: string[], coreSocketsReady: Promise<[void, void]>, publishMetadata(update: Partial<Metadata>): void, publishMatch(update: Partial<MatchSnapshot>): void, publishWagers(update: Partial<WagersSnapshot>): Promise<void>, resources: string[], assetsGate: PromiseWithResolvers<void>, bootstrapGate: PromiseWithResolvers<void>, sessionBootstrapGate: PromiseWithResolvers<void>, extrasGate: PromiseWithResolvers<void>, bootstrapRequested: PromiseWithResolvers<void>, selectedAssetsRequested: PromiseWithResolvers<void>, wagersRequested: PromiseWithResolvers<void>, profilesRequested: PromiseWithResolvers<void>}} LoadingFixtureContext
 * @typedef {{inviteId?: string, startFromHome?: boolean, inlineAutomatchBootstrap?: boolean, holdMatchSnapshots?: boolean, apiDelayMs?: number, holdAssets?: boolean, holdBootstrap?: boolean, holdExtras?: boolean, spectator?: boolean, paired?: boolean, pendingRematch?: boolean, healthyCoreSockets?: boolean, sessionMode?: "fresh" | "restored", sessionBootstrapResult?: unknown, holdSessionBootstrap?: boolean, initialSessionUid?: string, initialSessionStatus?: number, initialSessionGame?: unknown, initialMetadata?: Partial<Metadata>, initialMatch?: Partial<MatchSnapshot>, historicalPairs?: import("@mons/shared/game-sessions").HistoricalMatchPair[], initialWagers?: WagersSnapshot["wagers"] | null}} LoadingOptions
 */
/** @param {(context: LoadingFixtureContext) => Promise<void>} run @param {LoadingOptions} [options] */
async function fixture(
  run,
  {
    inviteId = defaultInviteId,
    startFromHome = false,
    inlineAutomatchBootstrap = true,
    holdMatchSnapshots = false,
    apiDelayMs = 0,
    holdAssets = false,
    holdBootstrap = false,
    holdExtras = true,
    spectator = false,
    paired = true,
    pendingRematch = false,
    healthyCoreSockets = false,
    sessionMode = "fresh",
    sessionBootstrapResult = "success",
    holdSessionBootstrap = false,
    initialSessionUid = spectator ? "s".repeat(28) : hostId,
    initialSessionStatus = 200,
    initialSessionGame,
    initialMetadata,
    initialMatch,
    historicalPairs = [],
    initialWagers = null,
  } = {},
) {
  /** @type {Metadata} */
  const currentMetadata = {
    ...metadata,
    inviteId,
    guestId: paired ? guestId : null,
    hostRematches: pendingRematch
      ? { state: "open", indices: [1] }
      : { state: "open", indices: [] },
    automatchStateHint: inviteId.startsWith("auto_")
      ? paired
        ? "matched"
        : "pending"
      : null,
    ...initialMetadata,
  };
  /** @type {import("@mons/shared/invite-metadata").InviteMetadataViewer} */
  const currentViewer = spectator
    ? { role: "watch", actorUid: null, automatchOperationId: null }
    : { ...viewer };
  /** @type {MatchSnapshot} */
  const currentMatch = {
    ...match,
    inviteId,
    matchId: pendingRematch ? `${inviteId}1` : inviteId,
    guestPlayerId: paired ? guestId : null,
    guestMatch: paired && !pendingRematch ? match.guestMatch : null,
    ...initialMatch,
  };
  /** @type {WagersSnapshot} */
  const currentWagers = { inviteId, revision: 1, wagers: initialWagers ?? {} };
  const historyByMatchId = new Map(
    historicalPairs.map((pair) => [pair.matchId, pair]),
  );
  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.MONS_BROWSER_EXECUTABLE
      ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
      : { channel: "chrome" }),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const assetsGate = deferred();
  const bootstrapGate = deferred();
  const matchSnapshotGate = deferred();
  const metadataSocketReady = deferred();
  const matchSocketReady = deferred();
  const wagersSocketReady = deferred();
  /** @type {Map<string, import("playwright").WebSocketRoute>} */
  const coreSockets = new Map();
  const sessionBootstrapGate = holdSessionBootstrap
    ? deferred()
    : bootstrapGate;
  const extrasGate = deferred();
  const bootstrapRequested = deferred();
  const selectedAssetsRequested = deferred();
  const wagersRequested = deferred();
  const profilesRequested = deferred();
  /** @type {LoadingRequest[]} */
  const requests = [];
  /** @type {string[]} */
  const sockets = [];
  /** @type {string[]} */
  const resources = [];
  /** @type {string[]} */
  const pageErrors = [];
  /** @type {Set<string>} */
  const sessions = new Set();
  /** @type {Map<string, string>} */
  const sessionUids = new Map();
  let closed = false;
  if (!holdAssets) assetsGate.resolve();
  if (!holdBootstrap) bootstrapGate.resolve();
  if (!holdMatchSnapshots) matchSnapshotGate.resolve();
  if (!holdExtras) extrasGate.resolve();
  try {
    await context.routeWebSocket(/wss:\/\/api\.mons\.link\/.*/, (socket) => {
      sockets.push(socket.url());
      if (!healthyCoreSockets) return;
      const pathname = new URL(socket.url()).pathname;
      const snapshot = pathname.endsWith("/metadata/socket")
        ? currentMetadata
        : pathname.endsWith(`/matches/${currentMatch.matchId}/socket`)
          ? currentMatch
          : pathname.endsWith("/wagers/socket") && initialWagers !== null
            ? currentWagers
            : null;
      if (snapshot)
        socket.send(
          JSON.stringify({ schemaVersion: 1, type: "snapshot", snapshot }),
        );
      if (pathname.endsWith("/metadata/socket")) {
        coreSockets.set("metadata", socket);
        metadataSocketReady.resolve();
      } else if (pathname.endsWith(`/matches/${currentMatch.matchId}/socket`)) {
        coreSockets.set("match", socket);
        matchSocketReady.resolve();
      } else if (pathname.endsWith("/wagers/socket")) {
        coreSockets.set("wagers", socket);
        wagersSocketReady.resolve();
      }
      socket.onMessage((message) => {
        if (message === "ping") socket.send("pong");
      });
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      resources.push(url.pathname);
      if (url.origin === server.origin) {
        if (url.pathname === "/__loading-seed")
          return route.fulfill({
            contentType: "text/html",
            body: "<!doctype html>",
          });
        if (/gameAssetsPixel/.test(url.pathname)) {
          selectedAssetsRequested.resolve();
          await assetsGate.promise;
        }
        if (!closed) await route.continue();
        return;
      }
      if (url.origin !== "https://api.mons.link") return route.abort();
      const headers = {
        "Access-Control-Allow-Origin": server.origin,
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, X-Mons-Data-Epoch",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      };
      if (request.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers });
      if (url.pathname === "/release")
        return route.fulfill({
          status: 200,
          headers,
          json: { state: "active", dataEpoch: 1, generation: 1 },
        });
      requests.push({
        path: url.pathname,
        query: url.search,
        method: request.method(),
        at: Date.now(),
      });
      /** @type {Record<string, unknown> | import("@mons/shared/game-bootstrap").ReadGameBootstrapResponse | undefined} */
      let body;
      let status;
      if (
        url.pathname === "/auth/session/anonymous" ||
        url.pathname === "/auth/session/refresh"
      ) {
        const sessionId =
          url.pathname === "/auth/session/anonymous"
            ? stringValue(jsonRecord(request.postDataJSON()).sessionId)
            : stringValue(
                present(request.headers().authorization).split(".")[1],
              );
        if (url.pathname === "/auth/session/anonymous") sessions.add(sessionId);
        assert.ok(sessions.has(sessionId));
        const uid = sessionUids.get(sessionId) ?? initialSessionUid;
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        /** @type {Record<string, unknown>} */
        const sessionResponse = {
          ok: true,
          sessionId,
          uid,
          accessToken: `header.${Buffer.from(JSON.stringify({ sub: uid, sid: sessionId, iat: expiresAt - 300, exp: expiresAt })).toString("base64url")}.signature`,
          accessExpiresAtMs: expiresAt * 1000,
        };
        if (url.searchParams.has("bootstrapInviteId")) {
          assert.equal(url.searchParams.get("bootstrapInviteId"), inviteId);
          assert.equal(url.searchParams.get("bootstrapSelection"), "current");
          bootstrapRequested.resolve();
          await sessionBootstrapGate.promise;
          if (sessionBootstrapResult !== "missing")
            sessionResponse.gameBootstrap = {
              inviteId,
              selection: "current",
              result:
                sessionBootstrapResult === "success"
                  ? (initialSessionGame ?? {
                      ...bootstrap,
                      metadata: currentMetadata,
                      viewer: currentViewer,
                      match: currentMatch,
                      hasPendingProposal: pendingRematch,
                    })
                  : sessionBootstrapResult,
            };
          body = sessionResponse;
          status = initialSessionStatus;
          if (status !== 200)
            body = {
              ok: false,
              error: "unavailable",
              message: "Old session fixture failure",
            };
        } else body = sessionResponse;
      } else if (url.pathname === "/automatch/start") {
        assert.equal(url.searchParams.get("bootstrap"), "1");
        currentViewer.automatchOperationId =
          url.searchParams.get("operationId");
        body = {
          ok: true,
          inviteId,
          mode: paired ? "matched" : "pending",
          matchedImmediately: paired,
          ...(inlineAutomatchBootstrap && paired
            ? {
                bootstrap: {
                  ...bootstrap,
                  metadata: currentMetadata,
                  viewer: currentViewer,
                  match: currentMatch,
                  hasPendingProposal: false,
                },
              }
            : {}),
        };
      } else if (url.pathname === `/invites/${inviteId}/bootstrap`) {
        bootstrapRequested.resolve();
        await bootstrapGate.promise;
        body = {
          ...bootstrap,
          metadata: currentMetadata,
          viewer: currentViewer,
          match: currentMatch,
          hasPendingProposal: pendingRematch,
        };
      } else if (url.pathname === `/invites/${inviteId}/metadata`) {
        body = { ok: true, snapshot: currentMetadata, viewer: currentViewer };
      } else if (url.pathname === `/invites/${inviteId}/wagers`) {
        wagersRequested.resolve();
        await extrasGate.promise;
        body = { ok: true, snapshot: currentWagers };
      } else if (
        url.pathname === "/matches/history" &&
        historyByMatchId.size > 0
      ) {
        body = {
          ok: true,
          pair:
            historyByMatchId.get(url.searchParams.get("matchId") ?? "") ?? null,
        };
      } else if (url.pathname === "/matches/snapshot") {
        body = {
          ok: true,
          playerId: hostId,
          matchId: inviteId,
          match: match.hostMatch,
        };
      } else if (
        url.pathname ===
        `/invites/${inviteId}/matches/${currentMatch.matchId}/snapshot`
      ) {
        await matchSnapshotGate.promise;
        body = { ok: true, snapshot: currentMatch };
      } else {
        if (url.pathname.includes("/profiles/")) profilesRequested.resolve();
        await extrasGate.promise;
      }
      if (apiDelayMs) await new Promise((done) => setTimeout(done, apiDelayMs));
      if (closed) return;
      await route.fulfill({
        status: status ?? (body ? 200 : 503),
        headers,
        json: body || {
          ok: false,
          error: "unavailable",
          message: "Local loading fixture",
        },
      });
    });
    await context.addInitScript(() => {
      localStorage.setItem(
        "mons:data:v1:preferredAssetsSet",
        JSON.stringify("Pixel"),
      );
      /** @type {import("./fixtures/loadingGlobals.ts").LoadingProbe} */
      const timing = { shell: null, populated: null };
      window.loadingProbe = timing;
      new MutationObserver(() => {
        if (timing.shell === null && document.getElementById("monsboard"))
          timing.shell = performance.now();
        if (
          timing.populated === null &&
          document.querySelectorAll("#itemsLayer .item").length >= 20
        ) {
          requestAnimationFrame(() => {
            timing.populated ??= performance.now();
          });
        }
      }).observe(document, { childList: true, subtree: true });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(process.env.MONS_LOADING_BUILD ? 10_000 : 30_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    if (sessionMode === "restored") {
      const sessionId = crypto.randomUUID();
      sessions.add(sessionId);
      await page.goto(`${server.origin}/__loading-seed`);
      await page.evaluate(
        ({ sessionId, uid }) =>
          /** @type {Promise<void>} */ (
            new Promise((resolve, reject) => {
              const open = indexedDB.open("mons-link-sessions-v1", 1);
              open.onupgradeneeded = () =>
                open.result.createObjectStore("state");
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const database = open.result;
                const transaction = database.transaction("state", "readwrite");
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
                  database.close();
                  resolve();
                };
                transaction.onerror = () => reject(transaction.error);
              };
            })
          ),
        { sessionId, uid: initialSessionUid },
      );
      requests.length = 0;
      resources.length = 0;
    }
    if (benchmark) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    }
    await page.goto(`${server.origin}/${startFromHome ? "" : inviteId}`, {
      waitUntil: "commit",
    });
    await run({
      page,
      context,
      sessions,
      registerSession(sessionId, uid) {
        sessions.add(sessionId);
        sessionUids.set(sessionId, uid);
      },
      requests,
      sockets,
      coreSocketsReady: Promise.all([
        metadataSocketReady.promise,
        matchSocketReady.promise,
      ]),
      publishMetadata(update) {
        Object.assign(currentMetadata, update);
        present(coreSockets.get("metadata")).send(
          JSON.stringify({
            schemaVersion: 1,
            type: "snapshot",
            snapshot: currentMetadata,
          }),
        );
      },
      publishMatch(update) {
        Object.assign(currentMatch, update);
        present(coreSockets.get("match")).send(
          JSON.stringify({
            schemaVersion: 1,
            type: "snapshot",
            snapshot: currentMatch,
          }),
        );
      },
      async publishWagers(update) {
        await withinDeadline(wagersSocketReady.promise);
        Object.assign(currentWagers, update);
        present(coreSockets.get("wagers")).send(
          JSON.stringify({
            schemaVersion: 1,
            type: "snapshot",
            snapshot: currentWagers,
          }),
        );
      },
      resources,
      assetsGate,
      bootstrapGate,
      sessionBootstrapGate,
      extrasGate,
      bootstrapRequested,
      selectedAssetsRequested,
      wagersRequested,
      profilesRequested,
    }).catch(async (error) => {
      const state = await page
        .evaluate(() => window.gameStateProbe?.())
        .catch(() => undefined);
      throw new Error(JSON.stringify({ state, sockets, requests }), {
        cause: error,
      });
    });
    assert.deepEqual(pageErrors, []);
  } finally {
    closed = true;
    assetsGate.resolve();
    bootstrapGate.resolve();
    matchSnapshotGate.resolve();
    sessionBootstrapGate.resolve();
    extrasGate.resolve();
    await browser.close();
    await server.close();
  }
}

/** @param {import("playwright").Page} page */
async function assertBoardAcceptsInput(page) {
  await page.waitForFunction(
    () =>
      window.loadingProbe.populated !== null &&
      performance.getEntriesByName("main-game:interaction-ready").length > 0 &&
      performance.getEntriesByName("main-game:route-prepared").length > 0,
  );
  await page.evaluate(() => {
    document.addEventListener(
      "click",
      (event) => {
        window.loadingProbe.trustedInput = event.isTrusted;
        window.loadingProbe.firstInput = performance.now();
      },
      { once: true },
    );
  });
  await page.locator('.board-rect[x="500"][y="1000"]').click();
  await page.waitForFunction(
    () =>
      (document.querySelector("#highlightsLayer")?.childElementCount ?? 0) > 0,
  );
  assert.equal(
    await page.evaluate(() => window.loadingProbe.trustedInput),
    true,
  );
}

/** @param {import("playwright").Page} page */
async function startAutomatchAndWaitForGame(page) {
  const readyCount = await page.evaluate(
    () => performance.getEntriesByName("main-game:interaction-ready").length,
  );
  await page.getByRole("button", { name: "Automatch", exact: true }).click();
  await page.waitForFunction(
    (count) =>
      performance.getEntriesByName("main-game:interaction-ready").length >
      count,
    readyCount,
  );
}

/** @param {LoadingRequest[]} requests @param {"fresh" | "restored"} [sessionMode] */
function assertBundledBootstrap(requests, sessionMode = "fresh") {
  const sessions = requests.filter(({ path }) =>
    /^\/auth\/session\/(anonymous|refresh)$/.test(path),
  );
  assert.equal(sessions.length, 1);
  const first = present(sessions[0]);
  assert.equal(
    first.path,
    `/auth/session/${sessionMode === "fresh" ? "anonymous" : "refresh"}`,
  );
  assert.equal(
    new URLSearchParams(first.query).get("bootstrapInviteId"),
    inviteId,
  );
  assert.equal(
    requests.filter(({ path }) => path.endsWith("/bootstrap")).length,
    0,
  );
}

/** @param {import("playwright").Page} page @param {string} path */
async function navigateWithinApp(page, path) {
  await page.evaluate((path) => {
    for (const name of [
      "main-game:interaction-ready",
      "main-game:route-prepared",
      "main-game:initial-view-ready",
    ])
      performance.clearMarks(name);
    history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.waitForFunction(
    () => performance.getEntriesByName("main-game:route-prepared").length > 0,
  );
}

test(
  "game bootstrap starts before board assets and is adopted once",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({
        page,
        requests,
        resources,
        assetsGate,
        selectedAssetsRequested,
        bootstrapRequested,
      }) => {
        await withinDeadline(
          Promise.all([
            selectedAssetsRequested.promise,
            bootstrapRequested.promise,
          ]),
        ).catch((error) => {
          throw new Error(
            JSON.stringify({ requests, resources: resources.slice(-20) }),
            { cause: error },
          );
        });
        assert.equal(await page.locator("#monsboard").count(), 0);
        assetsGate.resolve();
        await assertBoardAcceptsInput(page);
        assertBundledBootstrap(requests);
        assert.equal(
          requests.some(
            ({ path }) =>
              path === "/matches/snapshot" ||
              path.endsWith("/metadata") ||
              path.endsWith("/snapshot"),
          ),
          false,
        );
      },
      { holdAssets: true, healthyCoreSockets: true },
    );
  },
);

test(
  "a populated game accepts input while wagers, profiles and sockets remain unresolved",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({
        page,
        bootstrapRequested,
        bootstrapGate,
        requests,
        resources,
        wagersRequested,
        profilesRequested,
        sockets,
      }) => {
        await withinDeadline(bootstrapRequested.promise);
        await page.waitForSelector("#monsboard");
        assert.equal(await page.locator("#itemsLayer .item").count(), 0);
        assert.deepEqual(
          resources.filter((path) =>
            /gameAssetsOriginal|gameAssetsPangchiu|monsSprites|IslandButton|particle-effects|\/boards\/backgrounds\/thumbs\//.test(
              path,
            ),
          ),
          [],
        );
        bootstrapGate.resolve();
        await assertBoardAcceptsInput(page);
        await withinDeadline(
          Promise.all([wagersRequested.promise, profilesRequested.promise]),
        );
        assert.ok(sockets.length > 0);
        assertBundledBootstrap(requests);
      },
      { holdBootstrap: true },
    );
  },
);

test(
  "spectator installs both sides without enabling player input",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await page.waitForFunction(
          () => window.loadingProbe.populated !== null,
        );
        await page
          .locator('.board-rect[x="500"][y="1000"]')
          .dispatchEvent("click");
        assert.equal(await page.locator("#highlightsLayer > *").count(), 0);
        assert.equal(
          await page.evaluate(
            () =>
              performance.getEntriesByName("main-game:interaction-ready")
                .length,
          ),
          0,
        );
        assertBundledBootstrap(requests);
        assert.equal(
          requests.some(({ path }) => path.endsWith("/snapshot")),
          false,
        );
      },
      { spectator: true, healthyCoreSockets: true },
    );
  },
);

test(
  "an unjoined host settles the waiting view without enabling game input",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page }) => {
        await page.waitForFunction(
          () =>
            performance.getEntriesByName("main-game:initial-view-ready")
              .length > 0,
        );
        assert.equal(
          await page.evaluate(
            () =>
              performance.getEntriesByName("main-game:interaction-ready")
                .length,
          ),
          0,
        );
      },
      { paired: false },
    );
  },
);

test(
  "an immediate automatch becomes playable from its response without a bootstrap GET",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await startAutomatchAndWaitForGame(page);
        await assertBoardAcceptsInput(page);
        assert.equal(
          requests.filter(({ path }) => path === "/automatch/start").length,
          1,
        );
        assert.equal(
          requests.some(({ path }) => path.endsWith("/bootstrap")),
          false,
        );
        assert.equal(
          requests.some(({ path }) => path.endsWith("/snapshot")),
          false,
        );
      },
      {
        inviteId: "auto_loading",
        startFromHome: true,
        holdBootstrap: true,
        healthyCoreSockets: true,
      },
    );
  },
);

test(
  "a new automatch client still loads a legacy server response through bootstrap",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await startAutomatchAndWaitForGame(page);
        await assertBoardAcceptsInput(page);
        assert.equal(
          requests.filter(({ path }) => path === "/automatch/start").length,
          1,
        );
        assert.equal(
          requests.filter(
            ({ path }) => path === "/invites/auto_loading/bootstrap",
          ).length,
          1,
        );
      },
      {
        inviteId: "auto_loading",
        startFromHome: true,
        inlineAutomatchBootstrap: false,
        healthyCoreSockets: true,
      },
    );
  },
);

for (const metadataFirst of [false, true]) {
  test(
    `a waiting automatch host uses its existing match socket when ${metadataFirst ? "metadata" : "the pair"} arrives first`,
    { skip: benchmark, timeout: 60_000 },
    async () => {
      await fixture(
        async ({
          page,
          requests,
          sockets,
          coreSocketsReady,
          publishMetadata,
          publishMatch,
        }) => {
          await withinDeadline(coreSocketsReady);
          await page.waitForFunction(
            () =>
              performance.getEntriesByName("main-game:initial-view-ready")
                .length > 0,
          );
          assert.equal(
            await page.evaluate(
              () =>
                performance.getEntriesByName("main-game:interaction-ready")
                  .length,
            ),
            0,
          );
          const sendMetadata = () =>
            publishMetadata({
              revision: 2,
              guestId,
              automatchStateHint: "matched",
            });
          const sendMatch = () =>
            publishMatch({
              revision: 2,
              guestPlayerId: guestId,
              guestMatch: record("black"),
            });
          if (metadataFirst) sendMetadata();
          else sendMatch();
          await page.evaluate(
            () =>
              /** @type {Promise<number>} */ (
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                )
              ),
          );
          assert.equal(
            await page.evaluate(
              () =>
                performance.getEntriesByName("main-game:interaction-ready")
                  .length,
            ),
            0,
          );
          if (metadataFirst) sendMatch();
          else sendMetadata();
          await assertBoardAcceptsInput(page);
          assert.equal(
            sockets.filter((url) =>
              url.endsWith("/matches/auto_loading/socket"),
            ).length,
            1,
          );
          assert.equal(
            requests.some(({ path }) => path.endsWith("/bootstrap")),
            false,
          );
          if (!metadataFirst)
            assert.equal(
              requests.some(({ path }) => path.endsWith("/snapshot")),
              false,
            );
        },
        {
          inviteId: "auto_loading",
          paired: false,
          healthyCoreSockets: true,
          holdMatchSnapshots: true,
        },
      );
    },
  );
}

test(
  "an existing rematch proposal settles while the opponent response remains pending",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page }) => {
        await page
          .getByRole("button", { name: "End Match", exact: true })
          .waitFor({ state: "visible" });
        await page.waitForFunction(
          () =>
            performance.getEntriesByName("main-game:initial-view-ready")
              .length > 0,
        );
        assert.equal(
          await page.evaluate(
            () =>
              performance.getEntriesByName("main-game:interaction-ready")
                .length,
          ),
          0,
        );
        await page
          .locator('.board-rect[x="500"][y="1000"]')
          .dispatchEvent("click");
        assert.equal(await page.locator("#highlightsLayer > *").count(), 0);
      },
      { pendingRematch: true },
    );
  },
);

/** @param {import("playwright").Page} page */
async function installGameStateProbe(page) {
  await page.waitForFunction(() => window.loadingProbe.populated !== null);
  await page.evaluate(async () => {
    const { getGameControlsSnapshot } =
      await import("/src/game/gameControlsStore.ts");
    const { getBoardPlayerInfoOverlayState } =
      await import("/src/game/boardUiPort.ts");
    const { getWagerState } = await import("/src/game/wagerState.ts");
    const { getRematchSeriesNavigatorItems } =
      await import("/src/game/gameController.ts");
    const { connection } = await import("/src/connection/connection.ts");
    const { getLifecycleCounters } =
      await import("/src/lifecycle/lifecycleDiagnostics.ts");
    window.gameStateProbe = () => ({
      context: getGameControlsSnapshot().context,
      timer: getGameControlsSnapshot().presentation.gameControls.timer,
      playerInfo: getBoardPlayerInfoOverlayState(),
      wager: getWagerState(),
      selectedMatchId: getRematchSeriesNavigatorItems().find(
        (item) => item.isSelected,
      )?.matchId,
      activeMatchId: connection.getActiveMatchId(),
      counters: getLifecycleCounters(),
    });
  });
}

/** @type {import("@mons/shared/game-sessions").HistoricalMatchPair} */
const historicalPair = {
  matchId: inviteId,
  hostPlayerId: hostId,
  guestPlayerId: guestId,
  hostMatch: record("white"),
  guestMatch: record("black"),
};

test(
  "real game owners preserve historical wagers while live timers update and clean up on navigation",
  {
    skip: benchmark || Boolean(process.env.MONS_LOADING_BUILD),
    timeout: 60_000,
  },
  async () => {
    const liveMatchId = `${inviteId}1`;
    /** @param {number} count @returns {import("@mons/shared/invite-wagers").PublicMatchWagerState} */
    const proposals = (count) => ({
      schemaVersion: 1,
      state: "proposed",
      proposals: { [hostId]: { material: "dust", count, createdAt: 1 } },
      proposedBy: { [hostId]: true },
      agreed: null,
      resolved: null,
      blocked: null,
    });
    await fixture(
      async ({ page, coreSocketsReady, publishMatch, publishWagers }) => {
        await withinDeadline(coreSocketsReady);
        await installGameStateProbe(page);
        await page.waitForFunction(
          (hostId) =>
            window.gameStateProbe().wager?.proposals?.[hostId]?.count === 3,
          hostId,
        );
        const series = page.getByRole("group", { name: "Rematch series" });
        await series.getByRole("button").nth(0).click();
        await page.waitForFunction(
          (inviteId) =>
            window.gameStateProbe().context.boardViewMode ===
              "historicalView" &&
            window.gameStateProbe().selectedMatchId === inviteId,
          inviteId,
        );
        assert.equal(
          await page.evaluate((hostId) => {
            const proposal = window.gameStateProbe().wager?.proposals?.[hostId];
            if (!proposal) throw new Error("loading-probe-wager-missing");
            return proposal.count;
          }, hostId),
          7,
        );
        /** @type {import("@mons/shared/timers").MatchTimer} */
        const timer = {
          state: "running",
          turnNumber: new Game({ variant: "Classic" }).turnNumber,
          deadlineAtMs: Date.now() + 60_000,
        };
        publishMatch({
          revision: 2,
          guestMatch: { ...record("black"), timer },
        });
        await publishWagers({
          revision: 2,
          wagers: {
            [inviteId]: proposals(9),
            [liveMatchId]: proposals(4),
          },
        });
        await page.waitForFunction(
          (hostId) =>
            window.gameStateProbe().wager?.proposals?.[hostId]?.count === 9,
          hostId,
        );
        const historical = await page.evaluate(() => window.gameStateProbe());
        assert.equal(historical.activeMatchId, liveMatchId);
        assert.equal(historical.context.boardViewMode, "historicalView");
        assert.equal(historical.timer.mode, "hidden");
        assert.equal(historical.playerInfo.player.timerVisible, false);
        assert.equal(historical.playerInfo.opponent.timerVisible, false);

        await series.getByRole("button").nth(1).click();
        await page.waitForFunction(
          ({ liveMatchId, hostId }) => {
            const state = window.gameStateProbe();
            return (
              state.context.boardViewMode === "activeLive" &&
              state.selectedMatchId === liveMatchId &&
              state.wager?.proposals?.[hostId]?.count === 4
            );
          },
          { liveMatchId, hostId },
        );
        const restored = await page.evaluate(() => window.gameStateProbe());
        assert.equal(
          restored.playerInfo.player.timerVisible,
          true,
          JSON.stringify(restored),
        );
        assert.equal(restored.timer.mode, "hidden");
        assert.match(restored.playerInfo.player.timerText, /^\d+s$/);
        assert.ok(parseInt(restored.playerInfo.player.timerText, 10) <= 60);

        await navigateWithinApp(page, "/");
        await page.waitForFunction(() => {
          const state = window.gameStateProbe();
          return (
            state.activeMatchId === null &&
            state.counters.connectionObservers === 0 &&
            state.counters.gameTimeouts === 0
          );
        });
        const disposed = await page.evaluate(() => window.gameStateProbe());
        assert.equal(disposed.wager, null);
        assert.equal(disposed.timer.mode, "hidden");
        assert.equal(disposed.playerInfo.player.timerVisible, false);
        assert.equal(disposed.playerInfo.opponent.timerVisible, false);
      },
      {
        healthyCoreSockets: true,
        holdExtras: false,
        initialMetadata: {
          hostColor: "black",
          hostRematches: { state: "open", indices: [1] },
          guestRematches: { state: "open", indices: [1] },
        },
        initialMatch: {
          matchId: liveMatchId,
          hostMatch: record("white"),
          guestMatch: record("black"),
        },
        historicalPairs: [
          {
            ...historicalPair,
            hostMatch: record("black"),
            guestMatch: record("white"),
          },
        ],
        initialWagers: {
          [inviteId]: proposals(7),
          [liveMatchId]: proposals(3),
        },
      },
    );
  },
);

test(
  "an incoming rematch acceptance restores the real live view from historical selection",
  {
    skip: benchmark || Boolean(process.env.MONS_LOADING_BUILD),
    timeout: 60_000,
  },
  async () => {
    await fixture(
      async ({ page, coreSocketsReady, publishMatch, publishMetadata }) => {
        await withinDeadline(coreSocketsReady);
        await installGameStateProbe(page);
        await page.waitForFunction(
          () => window.gameStateProbe().context.boardViewMode === "waitingLive",
        );
        await page
          .getByRole("group", { name: "Rematch series" })
          .getByRole("button")
          .nth(0)
          .click();
        await page.waitForFunction(
          () =>
            window.gameStateProbe().context.boardViewMode === "historicalView",
        );
        publishMatch({ revision: 2, guestMatch: record("white") });
        publishMetadata({
          revision: 2,
          guestRematches: { state: "open", indices: [1] },
        });
        await page.waitForFunction((liveMatchId) => {
          const state = window.gameStateProbe();
          return (
            state.context.boardViewMode === "activeLive" &&
            state.activeMatchId === liveMatchId &&
            state.selectedMatchId === liveMatchId
          );
        }, `${inviteId}1`);
        assert.equal(
          (await page.locator("#itemsLayer .item").count()) >= 20,
          true,
        );
      },
      {
        pendingRematch: true,
        healthyCoreSockets: true,
        holdExtras: false,
        initialMatch: { hostMatch: record("black") },
        historicalPairs: [historicalPair],
      },
    );
  },
);

test(
  "a restored session hydrates from its single combined refresh request",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await assertBoardAcceptsInput(page);
        assertBundledBootstrap(requests, "restored");
      },
      { sessionMode: "restored" },
    );
  },
);

for (const sessionBootstrapResult of ["missing", { malformed: true }]) {
  test(
    `a ${sessionBootstrapResult === "missing" ? "legacy" : "malformed"} inline response keeps the session token and performs one GET fallback`,
    { skip: benchmark, timeout: 60_000 },
    async () => {
      await fixture(
        async ({ page, requests }) => {
          await assertBoardAcceptsInput(page);
          assert.equal(
            requests.filter(({ path }) => path.startsWith("/auth/session/"))
              .length,
            1,
          );
          assert.equal(
            requests.filter(({ path }) => path.endsWith("/bootstrap")).length,
            1,
          );
        },
        { sessionBootstrapResult },
      );
    },
  );
}

test(
  "an inline missing invite settles the error view without retrying bootstrap",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await page.waitForFunction(
          () =>
            performance.getEntriesByName("main-game:initial-view-ready")
              .length > 0,
        );
        assert.equal(await page.locator("#itemsLayer .item").count(), 0);
        assert.equal(
          await page.evaluate(
            () =>
              performance.getEntriesByName("main-game:interaction-ready")
                .length,
          ),
          0,
        );
        assertBundledBootstrap(requests);
      },
      { sessionBootstrapResult: { ok: false, status: 404 } },
    );
  },
);

test(
  "navigation discards a delayed inline game while preserving the completed session",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests, bootstrapRequested, bootstrapGate }) => {
        await withinDeadline(bootstrapRequested.promise);
        await page.waitForSelector("#monsboard");
        await navigateWithinApp(page, "/");
        const completed = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/auth/session/anonymous",
        );
        bootstrapGate.resolve();
        await (await completed).finished();
        await page.waitForFunction(
          () =>
            window.loadingProbe.populated !== null &&
            performance.getEntriesByName("main-game:interaction-ready").length >
              0 &&
            performance.getEntriesByName("main-game:initial-view-ready")
              .length > 0,
        );
        assert.equal(new URL(page.url()).pathname, "/");
        assert.equal(
          requests.some(({ path }) => path.startsWith(`/invites/${inviteId}/`)),
          false,
        );
        await navigateWithinApp(page, `/${inviteId}`);
        await assertBoardAcceptsInput(page);
        assert.equal(
          requests.filter(({ path }) => path.startsWith("/auth/session/"))
            .length,
          1,
        );
        assert.equal(
          requests.filter(({ path }) => path.endsWith("/bootstrap")).length,
          1,
        );
      },
      { holdBootstrap: true },
    );
  },
);

/** @param {import("playwright").Page} page */
async function readReplacementState(page) {
  return page.evaluate(async () => {
    const { sessionAuth } = await import("/src/session/sessionAuth.ts");
    const { connection } = await import("/src/connection/connection.ts");
    const { getMainGameLoadState } =
      await import("/src/game/mainGameLoadState.ts");
    const user = sessionAuth.currentUser;
    if (!user) throw new Error("loading-probe-session-user-missing");
    const token = await user.getIdToken();
    const segment = token.split(".")[1];
    if (!segment) throw new Error("loading-probe-token-segment-missing");
    const claims = /** @type {unknown} */ (
      JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/")))
    );
    if (!claims || typeof claims !== "object" || !("sid" in claims))
      throw new Error("loading-probe-token-claims-invalid");
    const probePath = "/test/fixtures/loadingGlobals.ts";
    const { loadingConnectionInternals } =
      /** @type {typeof import("./fixtures/loadingGlobals.ts")} */ (
        await import(probePath)
      );
    const context = connection.getActiveContextSnapshot();
    if (!context) throw new Error("loading-probe-context-missing");
    return {
      sessionId: user.sessionId,
      uid: user.uid,
      tokenSessionId: claims.sid,
      context,
      ...loadingConnectionInternals(connection),
      canPlay: getMainGameLoadState().canPlay,
    };
  });
}

for (const {
  name,
  sessionMode,
  initialSessionStatus,
  uiReadyBeforeReplacement = false,
} of /** @type {{name: string, sessionMode: "fresh" | "restored", initialSessionStatus: number, uiReadyBeforeReplacement?: boolean}[]} */ ([
  {
    name: "a session replaced before board assets load fetches its own game",
    sessionMode: "restored",
    initialSessionStatus: 200,
  },
  {
    name: "a fresh anonymous session replacement stays playable after the old create succeeds",
    sessionMode: "fresh",
    initialSessionStatus: 200,
  },
  {
    name: "a fresh anonymous session replacement stays playable after the old create fails",
    sessionMode: "fresh",
    initialSessionStatus: 503,
  },
  {
    name: "an initialized UI keeps an anonymous session replacement playable after the old create succeeds",
    sessionMode: "fresh",
    initialSessionStatus: 200,
    uiReadyBeforeReplacement: true,
  },
  {
    name: "an initialized UI keeps an anonymous session replacement playable after the old create fails",
    sessionMode: "fresh",
    initialSessionStatus: 503,
    uiReadyBeforeReplacement: true,
  },
])) {
  test(
    name,
    {
      skip: benchmark || Boolean(process.env.MONS_LOADING_BUILD),
      timeout: 60_000,
    },
    async () => {
      await fixture(
        async ({
          page,
          registerSession,
          requests,
          bootstrapRequested,
          bootstrapGate,
          sessionBootstrapGate,
          selectedAssetsRequested,
          assetsGate,
        }) => {
          await withinDeadline(
            Promise.all([
              bootstrapRequested.promise,
              selectedAssetsRequested.promise,
            ]),
          );
          assert.equal(await page.locator("#monsboard").count(), 0);
          if (uiReadyBeforeReplacement) {
            assetsGate.resolve();
            await page.waitForFunction(
              () =>
                performance.getEntriesByName("main-game:route-prepared")
                  .length > 0,
            );
            assert.equal(await page.locator("#monsboard").count(), 1);
            assert.equal(await page.locator("#itemsLayer .item").count(), 0);
            assert.equal(
              requests.filter(({ path }) => path.endsWith("/bootstrap")).length,
              0,
            );
          }
          const replacementId = crypto.randomUUID();
          registerSession(replacementId, hostId);
          const replacementRead = page.waitForRequest(
            (request) =>
              request.method() === "GET" &&
              new URL(request.url()).pathname ===
                `/invites/${inviteId}/bootstrap`,
          );
          await page.evaluate(
            async ({ replacementId, uid, sessionMode }) => {
              const { sessionAuth } =
                await import("/src/session/sessionAuth.ts");
              const previous = sessionAuth.currentUser;
              if (sessionMode === "fresh" && previous !== null)
                throw new Error(
                  "anonymous-user-published-before-create-response",
                );
              const probePath = "/test/fixtures/loadingGlobals.ts";
              const { loadingOriginalSessionRequest, loadingSessionStore } =
                /** @type {typeof import("./fixtures/loadingGlobals.ts")} */ (
                  await import(probePath)
                );
              const originalRequest = loadingOriginalSessionRequest(
                sessionAuth,
                sessionMode,
              );
              if (!originalRequest)
                throw new Error("original-session-request-missing");
              globalThis.oldSessionRequestSettled = false;
              const settled = () => {
                globalThis.oldSessionRequestSettled = true;
              };
              void originalRequest.then(settled, settled);
              await loadingSessionStore(sessionAuth).update((state) => ({
                ...state,
                revision: state.revision + 1,
                generation: crypto.randomUUID(),
                session: {
                  sessionId: replacementId,
                  uid,
                  refreshSecret: "c".repeat(42) + "A",
                  revokeSecret: "d".repeat(42) + "A",
                },
              }));
              await sessionAuth.reconcile();
              if (sessionAuth.currentUser === previous)
                throw new Error("session-object-was-not-replaced");
            },
            { replacementId, uid: hostId, sessionMode },
          );
          assetsGate.resolve();
          const request = await replacementRead;
          const claims = jsonRecord(
            JSON.parse(
              Buffer.from(
                present(present(request.headers().authorization).split(".")[1]),
                "base64url",
              ).toString("utf8"),
            ),
          );
          assert.equal(claims.sid, replacementId);
          assert.equal(claims.sub, hostId);
          bootstrapGate.resolve();
          await assertBoardAcceptsInput(page);
          const before = await readReplacementState(page);
          assert.equal(before.sessionId, replacementId);
          assert.equal(before.tokenSessionId, replacementId);
          assert.equal(before.uid, hostId);
          assert.equal(before.loginUid, hostId);
          assert.equal(before.actorUid, hostId);
          assert.equal(before.context.canWrite, true);
          assert.equal(before.color, "white");
          assert.equal(before.fen, fen);
          assert.equal(before.canPlay, true);
          assert.equal(
            await page.evaluate(() => globalThis.oldSessionRequestSettled),
            false,
          );
          const completed = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname ===
                `/auth/session/${sessionMode === "fresh" ? "anonymous" : "refresh"}` &&
              url.searchParams.has("bootstrapInviteId")
            );
          });
          sessionBootstrapGate.resolve();
          const oldResponse = await completed;
          assert.equal(oldResponse.status(), initialSessionStatus);
          await page.waitForFunction(
            () => globalThis.oldSessionRequestSettled === true,
          );
          assert.deepEqual(await readReplacementState(page), before);
          await page.evaluate(async () => {
            const { didClickOutsideBoard } =
              await import("/src/game/gameController.ts");
            didClickOutsideBoard();
          });
          assert.equal(await page.locator("#highlightsLayer > *").count(), 0);
          await assertBoardAcceptsInput(page);
          assert.equal(
            requests.filter(({ path }) => path.endsWith("/bootstrap")).length,
            1,
          );
          assert.equal(
            requests.filter(({ path }) => path.startsWith("/auth/session/"))
              .length,
            2,
          );
        },
        {
          holdBootstrap: true,
          holdSessionBootstrap: true,
          holdAssets: true,
          sessionMode,
          initialSessionUid: sessionMode === "fresh" ? guestId : hostId,
          initialSessionStatus,
          initialSessionGame:
            sessionMode === "fresh"
              ? {
                  ...bootstrap,
                  viewer: {
                    role: "guest",
                    actorUid: guestId,
                    automatchOperationId: null,
                  },
                }
              : undefined,
        },
      );
    },
  );
}

test(
  "production loading benchmark",
  { skip: !benchmark, timeout: 180_000 },
  async (t) => {
    /** @typedef {import("./fixtures/loadingGlobals.ts").LoadingProbe & {interactionReady: number, routePrepared: number, requests: Pick<LoadingRequest, "path" | "query" | "method">[]}} BenchmarkSample */
    /** @type {Record<string, {runs: BenchmarkSample[], medianShellMs: number, medianPopulatedMs: number, medianInteractionReadyMs: number, medianFirstInputMs: number}>} */
    const scenarios = {};
    for (const sessionMode of /** @type {const} */ (["fresh", "restored"])) {
      /** @type {BenchmarkSample[]} */
      const samples = [];
      for (let index = 0; index < 5; index++) {
        await fixture(
          async ({ page, requests }) => {
            await assertBoardAcceptsInput(page);
            samples.push({
              ...(await page.evaluate(() => {
                const interaction = performance.getEntriesByName(
                  "main-game:interaction-ready",
                )[0];
                const prepared = performance.getEntriesByName(
                  "main-game:route-prepared",
                )[0];
                if (!interaction || !prepared)
                  throw new Error("loading-probe-timing-missing");
                return {
                  ...window.loadingProbe,
                  interactionReady: interaction.startTime,
                  routePrepared: prepared.startTime,
                };
              })),
              requests: requests.map(({ path, query, method }) => ({
                path,
                query,
                method,
              })),
            });
            t.diagnostic(
              JSON.stringify({
                sessionMode,
                sample: index + 1,
                populated: present(samples.at(-1)).populated,
                interactionReady: present(samples.at(-1)).interactionReady,
              }),
            );
          },
          { apiDelayMs: 200, holdExtras: false, sessionMode },
        );
      }
      /** @param {"shell" | "populated" | "interactionReady" | "firstInput"} key */
      const median = (key) =>
        present(
          samples
            .map((sample) => {
              const value = sample[key];
              assert.ok(typeof value === "number");
              return value;
            })
            .sort((a, b) => a - b)[2],
        );
      scenarios[sessionMode] = {
        runs: samples,
        medianShellMs: median("shell"),
        medianPopulatedMs: median("populated"),
        medianInteractionReadyMs: median("interactionReady"),
        medianFirstInputMs: median("firstInput"),
      };
    }
    const report = {
      build: process.env.MONS_LOADING_BUILD,
      cpuSlowdown: 4,
      apiDelayMs: 200,
      staticAssets: "gzip",
      networkThrottle: "none",
      scenarios,
    };
    if (process.env.MONS_LOADING_REPORT) {
      const output = resolve(process.env.MONS_LOADING_REPORT);
      await mkdir(resolve(output, ".."), { recursive: true });
      await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    }
    t.diagnostic(JSON.stringify(report));
  },
);
