import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createBrowserViteServer } from "./browserViteServer.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const environmentPath = fileURLToPath(
  new URL("./fixtures/leaderboardEnvironment.ts", import.meta.url),
);
let server;
let browser;
let origin;

before(async () => {
  server = await createBrowserViteServer({
    root: repository,
    cacheDir: `node_modules/.vite-leaderboard-${process.pid}`,
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      hmr: false,
      watch: null,
    },
    resolve: {
      alias: [
        { find: /^.*\/utils\/ensResolver$/, replacement: environmentPath },
      ],
    },
    logLevel: "error",
    plugins: [
      {
        name: "leaderboard-browser-fixture",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__leaderboard") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body { margin: 32px; } #root { width: 360px; }</style><div id="root"></div><script type="module" src="/test/fixtures/leaderboardHarness.tsx"></script>',
            );
          });
        },
      },
    ],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MONS_BROWSER_EXECUTABLE
      ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
      : { channel: "chrome" }),
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function fixture(run) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://cdn.lil.org/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><rect width="26" height="26" fill="#789"/></svg>',
    }),
  );
  try {
    await page.goto(`${origin}/__leaderboard`);
    await page.waitForFunction(() => !!window.leaderboardHarness);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

const mounted = (name, run) =>
  test(name, { timeout: 60000 }, () => fixture(run));
const call = (page, method, ...args) =>
  page.evaluate(
    ({ method, args }) => window.leaderboardHarness[method](...args),
    {
      method,
      args,
    },
  );
const snapshot = (page) => call(page, "snapshot");
const latestRequest = async (page) =>
  (await snapshot(page)).requests.length - 1;
const ids = (entries) => entries?.map((entry) => entry.id) ?? null;
const profile = (id, patch = {}) => ({
  id,
  username: id,
  emoji: 7,
  rating: 1500,
  totalManaPoints: 4,
  ...patch,
});
const refresh = async (page) => {
  await call(page, "render", { show: false });
  await call(page, "render", { show: true });
};

mounted(
  "cached rows hydrate while hidden and every visible selection refreshes",
  async (page) => {
    await call(page, "seedCache", "rating", [profile("cached-rating")]);
    await call(page, "render");
    assert.deepEqual(ids((await snapshot(page)).data), ["cached-rating"]);
    assert.deepEqual((await snapshot(page)).requests, []);

    await call(page, "render", { show: true });
    assert.deepEqual((await snapshot(page)).requests, ["rating"]);
    assert.deepEqual(ids((await snapshot(page)).data), ["cached-rating"]);
    await call(page, "complete", 0, [profile("fresh-rating")]);
    await call(page, "render", { show: false });
    assert.deepEqual(ids((await snapshot(page)).data), ["fresh-rating"]);

    await call(page, "seedCache", "mp", [profile("cached-mp")]);
    await call(page, "render", { leaderboardType: "mp" });
    assert.deepEqual(ids((await snapshot(page)).data), ["cached-mp"]);
    assert.equal((await snapshot(page)).requests.length, 1);
    await call(page, "render", { show: true });
    await call(page, "complete", 1, [profile("fresh-mp")]);
    await call(page, "render", { leaderboardType: "total" });
    assert.equal((await snapshot(page)).data, null);
    await call(page, "complete", 2, []);
    assert.deepEqual((await snapshot(page)).data, []);
    await refresh(page);
    assert.deepEqual((await snapshot(page)).requests, [
      "rating",
      "mp",
      "total",
      "total",
    ]);
  },
);

mounted(
  "replayed, superseded, hidden, and unmounted requests cannot commit",
  async (page) => {
    await call(page, "render", { show: true });
    assert.deepEqual((await snapshot(page)).requests, ["rating", "rating"]);
    await call(page, "complete", 0, [profile("strict-replay")]);
    assert.deepEqual((await snapshot(page)).cache, {});
    await call(page, "render", { leaderboardType: "mp" });
    await call(page, "complete", 1, [profile("old-type")]);
    assert.deepEqual((await snapshot(page)).cache, {});

    await call(page, "writeStorage", { profileId: "own", loginId: "login-a" });
    assert.equal((await snapshot(page)).currentProfileId, "");
    assert.equal((await snapshot(page)).requests.length, 3);
    await call(page, "render");
    await call(page, "complete", 2, [profile("old-identity")]);
    assert.deepEqual((await snapshot(page)).cache, {});
    await call(page, "complete", 3, [profile("current")]);
    assert.deepEqual(ids((await snapshot(page)).data), ["current", "own"]);
    await call(page, "writeStorage", { loginId: "login-b" });
    await call(page, "render");
    assert.equal((await snapshot(page)).requests.length, 5);
    await call(page, "render", { show: false });
    await call(page, "complete", 4, [profile("hidden")]);
    assert.deepEqual(ids((await snapshot(page)).cache.mp), ["current", "own"]);

    await call(page, "render", { show: true });
    await call(page, "dispose");
    const disposed = await snapshot(page);
    await call(page, "complete", 5, [profile("unmounted")]);
    assert.deepEqual(await snapshot(page), disposed);
  },
);

mounted(
  "own fallback reads current fields after flushing cosmetics and rejects another profile's stash",
  async (page) => {
    await call(page, "writeStorage", {
      profileId: "own",
      loginId: "login",
      username: "Before request",
      playerRating: 1677.6,
      playerNonce: 8,
      playerTotalManaPoints: 9,
      playerEmojiId: "invalid",
      playerEmojiAura: "rainbow",
      cardBackgroundId: 7,
      playerMiningMaterials: { dust: 5 },
    });
    await call(
      page,
      "stashProfile",
      "login",
      profile("someone-else", { rating: 9999 }),
    );
    await call(page, "render", { show: true });
    await call(page, "writeStorage", { username: "After request" });
    await call(page, "queueCosmetics", {
      cardBackgroundId: 0,
      profileMons: "",
    });
    assert.equal((await snapshot(page)).cosmeticWrites, 0);
    await call(page, "complete", await latestRequest(page), [
      profile("ranked"),
    ]);
    const result = await snapshot(page);
    assert.deepEqual(ids(result.data), ["ranked", "own"]);
    const own = result.data[1];
    assert.equal(own.username, "After request");
    assert.equal(own.rating, 1678);
    assert.equal(own.emoji, 1);
    assert.equal(own.aura, "rainbow");
    assert.equal(own.profile.nonce, 8);
    assert.equal(own.profile.cardBackgroundId, 0);
    assert.equal(own.profile.profileMons, "");
    assert.equal(result.cosmeticWrites, 2);
    assert.deepEqual(own.materials, {
      dust: 5,
      slime: 0,
      gum: 0,
      metal: 0,
      ice: 0,
    });
    assert.deepEqual(result.cache.rating, result.data);
  },
);

mounted(
  "matching stashed values retain nullish precedence and a server self row wins",
  async (page) => {
    await call(page, "writeStorage", {
      profileId: "own",
      loginId: "login",
      username: "stored",
      playerRating: 1777,
      playerEmojiAura: "rainbow",
      cardBackgroundId: 7,
      playerMiningMaterials: { dust: 5 },
    });
    await call(
      page,
      "stashProfile",
      "login",
      profile("own", {
        username: "",
        rating: 0,
        win: false,
        nonce: 0,
        aura: "",
        totalManaPoints: 0,
        cardBackgroundId: 0,
        profileMons: "",
        completedProblemIds: ["p1"],
        isTutorialCompleted: false,
        mining: { lastRockDate: null, materials: { slime: 3 } },
      }),
    );
    await call(page, "render", { show: true });
    await call(page, "complete", await latestRequest(page), []);
    const own = (await snapshot(page)).data[0];
    assert.equal(own.username, "");
    assert.equal(own.rating, 0);
    assert.equal(own.win, false);
    assert.equal(own.aura, "");
    assert.equal(own.mp, 0);
    assert.equal(own.profile.nonce, 0);
    assert.equal(own.profile.cardBackgroundId, 0);
    assert.deepEqual(own.profile.completedProblemIds, ["p1"]);
    assert.equal(own.profile.isTutorialCompleted, false);
    assert.equal(own.materials.dust, 0);
    assert.equal(own.materials.slime, 3);

    await refresh(page);
    await call(page, "queueCosmetics", { cardBackgroundId: 3 });
    const serverOwn = profile("own", { username: "Server own", rating: 1999 });
    await call(page, "complete", await latestRequest(page), [serverOwn]);
    const result = await snapshot(page);
    assert.equal(result.data.length, 1);
    assert.deepEqual(result.data[0].profile, serverOwn);
    assert.equal(result.cosmeticWrites, 1);
  },
);

mounted(
  "ENS enrichment accumulates by row and stale names cannot change another selection",
  async (page) => {
    await call(page, "render", { show: true });
    await call(page, "complete", await latestRequest(page), [
      profile("a", { username: null, eth: "0xa" }),
      profile("b", { username: "", eth: "0xb" }),
      profile("named", { eth: "0xnamed" }),
      profile("no-eth", { username: null, sol: "sol-address" }),
      profile("missing", { username: null, eth: "0xmissing" }),
    ]);
    assert.deepEqual((await snapshot(page)).ensRequests, [
      "0xa",
      "0xb",
      "0xmissing",
    ]);
    await call(page, "resolveEns", 1, "b.eth");
    await call(page, "resolveEns", 0, "a.eth");
    await call(page, "resolveEns", 2, null);
    let result = await snapshot(page);
    assert.deepEqual(
      result.data.map((row) => row.ensName),
      ["a.eth", "b.eth", null, null, null],
    );
    assert.deepEqual(result.cache.rating, result.data);

    await refresh(page);
    await call(page, "complete", await latestRequest(page), [
      profile("old", { username: null, eth: "0xold" }),
    ]);
    await call(page, "render", { leaderboardType: "mp" });
    await call(page, "complete", await latestRequest(page), [
      profile("new", { username: null, eth: "0xnew" }),
    ]);
    await call(page, "resolveEns", 3, "late-type.eth");
    assert.equal((await snapshot(page)).cache.rating[0].ensName, null);
    await call(page, "render", { show: false });
    await call(page, "resolveEns", 4, "late-hidden.eth");
    result = await snapshot(page);
    assert.equal(result.data[0].ensName, null);
    assert.equal(result.cache.mp[0].ensName, null);

    await call(page, "render", { show: true });
    await call(page, "complete", await latestRequest(page), [
      profile("old-identity", { username: null, eth: "0xidentity" }),
    ]);
    await call(page, "writeStorage", { profileId: "own", loginId: "login" });
    await call(page, "render");
    await call(page, "complete", await latestRequest(page), [
      profile("last", { username: null, eth: "0xlast" }),
    ]);
    await call(page, "resolveEns", 5, "late-identity.eth");
    result = await snapshot(page);
    assert.deepEqual(ids(result.data), ["last", "own"]);
    assert.equal(result.data[0].ensName, null);
    assert.equal(result.cache.mp[0].ensName, null);
    assert.equal(result.cache.rating[0].ensName, null);
    await call(page, "dispose");
    const disposed = await snapshot(page);
    await call(page, "resolveEns", 6, "late-unmounted.eth");
    assert.deepEqual(await snapshot(page), disposed);
  },
);

mounted(
  "material caches warm from server rows without the own fallback or overwriting existing selections",
  async (page) => {
    await call(page, "writeStorage", {
      profileId: "own",
      playerMiningMaterials: { dust: 100, slime: 100 },
    });
    await call(page, "seedCache", "ice", [profile("cached-ice")]);
    await call(page, "render", { show: true, leaderboardType: "dust" });
    await call(page, "complete", await latestRequest(page), [
      profile("dust-first", { mining: { materials: { dust: 9, slime: 1 } } }),
      profile("slime-first", { mining: { materials: { dust: 2, slime: 20 } } }),
    ]);
    const result = await snapshot(page);
    assert.deepEqual(ids(result.data), ["dust-first", "slime-first", "own"]);
    assert.deepEqual(ids(result.cache.dust), ids(result.data));
    assert.deepEqual(ids(result.cache.slime), ["slime-first", "dust-first"]);
    assert.deepEqual(ids(result.cache.total), ["slime-first", "dust-first"]);
    assert.deepEqual(ids(result.cache.ice), ["cached-ice"]);
    assert.deepEqual(ids(result.cache.metal), ["dust-first", "slime-first"]);
    assert.equal(result.cache.rating, undefined);
    assert.equal(result.cache.mp, undefined);
  },
);

mounted(
  "failures preserve rows or null and resetting the cache retains its existing nonreactive behavior",
  async (page) => {
    const logs = [];
    page.on("console", (message) => {
      if (message.type() === "error") logs.push(message.text());
    });
    await call(page, "render", { show: true });
    await call(page, "reject", await latestRequest(page));
    assert.equal((await snapshot(page)).data, null);
    assert.ok(
      logs.some((message) =>
        message.includes("Failed to fetch leaderboard data:"),
      ),
    );

    await call(page, "seedCache", "mp", [profile("cached")]);
    await call(page, "render", { leaderboardType: "mp" });
    await call(page, "reject", await latestRequest(page));
    assert.deepEqual(ids((await snapshot(page)).data), ["cached"]);
    await refresh(page);
    await call(page, "resetCache");
    assert.deepEqual((await snapshot(page)).cache, {});
    assert.deepEqual(ids((await snapshot(page)).data), ["cached"]);
    await call(page, "complete", await latestRequest(page), [
      profile("still-active", { username: null, eth: "0xactive" }),
    ]);
    assert.deepEqual(ids((await snapshot(page)).cache.mp), ["still-active"]);
    await call(page, "resetCache");
    await call(page, "resolveEns", 0, "active.eth");
    assert.equal((await snapshot(page)).cache.mp[0].ensName, "active.eth");
  },
);

mounted(
  "the view retains own rank, card actions, and scroll resets across type and identity changes",
  async (page) => {
    const ranked = Array.from({ length: 99 }, (_, index) =>
      profile(`ranked-${index}`),
    );
    const own = profile("own", { username: "Own Player" });
    await call(page, "writeStorage", { profileId: "own", loginId: "login-a" });
    await call(page, "seedCache", "rating", [...ranked, own]);
    await call(page, "holdScrollResets");
    await call(page, "render", { mode: "view", show: true });
    const ownRow = page.locator('tr[data-current="true"]');
    assert.equal(await ownRow.locator("td").first().textContent(), "∅");
    assert.match(await ownRow.textContent(), /Own Player/);
    await ownRow.dispatchEvent("click");
    assert.deepEqual((await snapshot(page)).cards, [[own, "Own Player", true]]);
    await call(page, "flushScrollResets");

    await call(page, "scrollTo", 500);
    assert.equal((await snapshot(page)).scrollTop, 500);
    await call(page, "writeStorage", { loginId: "login-b" });
    await call(page, "render");
    assert.equal((await snapshot(page)).scrollResets, 1);
    assert.equal((await snapshot(page)).scrollTop, 500);
    await call(page, "render", { show: false });
    await call(page, "flushScrollResets");
    assert.equal((await snapshot(page)).scrollTop, 0);

    await call(page, "seedCache", "mp", [
      ...ranked,
      profile("own", { username: "Own MP", totalManaPoints: 321 }),
    ]);
    await call(page, "render", { show: true, leaderboardType: "mp" });
    assert.match(await ownRow.textContent(), /Own MP/);
    assert.equal(await ownRow.locator("td").last().textContent(), "321");
    assert.equal((await snapshot(page)).scrollTop, 0);
    await call(page, "flushScrollResets");
    await call(page, "scrollTo", 500);
    await call(page, "writeStorage", { profileId: "ranked-0" });
    await call(page, "render");
    assert.match(await ownRow.textContent(), /ranked-0/);
    assert.equal((await snapshot(page)).scrollResets, 1);
    await call(page, "flushScrollResets");
    assert.equal((await snapshot(page)).scrollTop, 0);

    await call(page, "render", { leaderboardType: "gum" });
    assert.equal(await page.locator("table").count(), 0);
    assert.equal(
      await page.getByText("UPDATING...", { exact: true }).count(),
      1,
    );
  },
);
