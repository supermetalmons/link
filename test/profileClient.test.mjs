import { canonicalProfile, required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { ProfileClient } = await import("../src/connection/profileClient.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");
const { MINING_MATERIAL_NAMES } =
  await import("../src/connection/connectionModels.ts");

const settle = () => new Promise(setImmediate);
/** @param {string} id @param {Partial<import("@mons/shared/mining").MiningMaterials>} [materials] */
const profile = (id, materials = {}) =>
  canonicalProfile({
    id,
    mining: {
      lastRockDate: null,
      materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0, ...materials },
    },
  });

/** @param {{api?: Partial<import("../src/connection/profileClient.ts").ProfileClientApi>;
 * authenticate?: () => Promise<void>; wait?: (milliseconds: number) => void | Promise<void>; now?: () => number}} [options] */
function harness({ api: handlers = {}, authenticate, wait, now } = {}) {
  /** @type {{now: number; user: Parameters<typeof createUserBoundAuthTokenProvider>[0]; profileId: string | null;
   * storedAura: import("@mons/shared/appearance").Aura; authCalls: number; providerCalls: number;
   * providerError: Error | null; invalidations: number; auraReads: number; waits: number[]}} */
  const state = {
    now: 100,
    user: { uid: "login", getIdToken: async () => "token" },
    profileId: "profile",
    storedAura: "rainbow",
    authCalls: 0,
    providerCalls: 0,
    providerError: null,
    invalidations: 0,
    auraReads: 0,
    waits: [],
  };
  /** @type {Array<{name: keyof import("../src/connection/profileClient.ts").ProfileClientApi; args: unknown[]}>} */
  const calls = [];
  /** @type {import("../src/connection/profileClient.ts").ProfileClientApi} */
  const defaults = {
    getProfileByLoginIdViaApi: async (id) => profile(id),
    getProfileByIdViaApi: async (id) => profile(id),
    resolveProfileIdViaApi: async (id) => id,
    readLeaderboardViaApi: async (type) => [profile(type)],
    editUsernameViaApi: async () => ({ ok: true }),
    updateProfileCustomizationViaApi: async () => ({ ok: true }),
  };
  /** @type {import("../src/connection/profileClient.ts").ProfileClientApi} */
  const api = {
    getProfileByLoginIdViaApi: (...args) => {
      calls.push({ name: "getProfileByLoginIdViaApi", args });
      return (
        handlers.getProfileByLoginIdViaApi ?? defaults.getProfileByLoginIdViaApi
      )(...args);
    },
    getProfileByIdViaApi: (...args) => {
      calls.push({ name: "getProfileByIdViaApi", args });
      return (handlers.getProfileByIdViaApi ?? defaults.getProfileByIdViaApi)(
        ...args,
      );
    },
    resolveProfileIdViaApi: (...args) => {
      calls.push({ name: "resolveProfileIdViaApi", args });
      return (
        handlers.resolveProfileIdViaApi ?? defaults.resolveProfileIdViaApi
      )(...args);
    },
    readLeaderboardViaApi: (...args) => {
      calls.push({ name: "readLeaderboardViaApi", args });
      return (handlers.readLeaderboardViaApi ?? defaults.readLeaderboardViaApi)(
        ...args,
      );
    },
    editUsernameViaApi: (...args) => {
      calls.push({ name: "editUsernameViaApi", args });
      return (handlers.editUsernameViaApi ?? defaults.editUsernameViaApi)(
        ...args,
      );
    },
    updateProfileCustomizationViaApi: (...args) => {
      calls.push({ name: "updateProfileCustomizationViaApi", args });
      return (
        handlers.updateProfileCustomizationViaApi ??
        defaults.updateProfileCustomizationViaApi
      )(...args);
    },
  };
  /** @type {import("../src/services/apiTransport.ts").AuthTokenProvider} */
  const tokenProvider = (forceRefresh) => state.user.getIdToken(forceRefresh);
  const client = new ProfileClient({
    ensureAuthenticated: async () => {
      state.authCalls++;
      await authenticate?.();
    },
    getAuthApiToken: tokenProvider,
    getUserBoundAuthTokenProvider: () => {
      state.providerCalls++;
      if (state.providerError) throw state.providerError;
      return createUserBoundAuthTokenProvider(state.user, () => state.user);
    },
    getLocalProfileId: () => state.profileId,
    getStoredEmojiAura: () => {
      state.auraReads++;
      return state.storedAura;
    },
    invalidateInitialIdentity: () => state.invalidations++,
    api,
    now: () => (now ? now() : state.now),
    wait: async (milliseconds) => {
      state.waits.push(milliseconds);
      await wait?.(milliseconds);
    },
  });
  return { client, state, calls, tokenProvider };
}

test.beforeEach((t) => {
  assert.ok("mock" in t);
  t.mock.method(console, "error", () => {});
});

test("profile lookups preserve blank-ID handling, auth sequencing and unbound tokens", async () => {
  /** @type {PromiseWithResolvers<void>} */
  const authenticated = Promise.withResolvers();
  const h = harness({ authenticate: () => authenticated.promise });
  assert.equal(await h.client.getProfileById("  "), null);
  assert.equal(await h.client.resolveProfileId("\t"), null);
  assert.equal(h.state.authCalls, 0);

  const login = h.client.getProfileByLoginId(" login ");
  const canonical = h.client.getProfileById(" profile ");
  assert.equal(h.state.authCalls, 2);
  assert.deepEqual(h.calls, []);
  authenticated.resolve();
  assert.equal((await login).id, " login ");
  assert.equal(required(await canonical).id, "profile");
  assert.deepEqual(
    h.calls.map(({ name, args }) => [name, ...args]),
    [
      ["getProfileByLoginIdViaApi", " login ", h.tokenProvider],
      ["getProfileByIdViaApi", "profile", h.tokenProvider],
    ],
  );
  assert.equal(h.state.providerCalls, 0);
});

test("plain lookups preserve null results, failures and late unbound replies", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/profiles").CompletePlayerProfile | null>} */
  const response = Promise.withResolvers();
  const failure = new Error("profile-not-found");
  const h = harness({
    api: {
      getProfileByIdViaApi: () => response.promise,
      getProfileByLoginIdViaApi: async () => {
        throw failure;
      },
    },
  });
  await assert.rejects(h.client.getProfileByLoginId("missing"), failure);
  const pending = h.client.getProfileById("missing");
  await settle();
  h.state.user = { ...h.state.user };
  response.resolve(null);
  assert.equal(await pending, null);
  assert.equal(h.state.providerCalls, 0);
});

test("canonical resolution trims IDs, preserves null and rejects stale auth replies", async () => {
  /** @type {PromiseWithResolvers<string | null>} */
  const response = Promise.withResolvers();
  const h = harness({
    api: { resolveProfileIdViaApi: () => response.promise },
  });
  const pending = h.client.resolveProfileId(" retired-profile ");
  await settle();
  assert.equal(h.state.authCalls, 1);
  assert.equal(required(h.calls[0]).args[0], "retired-profile");
  assert.notEqual(required(h.calls[0]).args[1], h.tokenProvider);
  h.state.user = { ...h.state.user };
  response.resolve("canonical-profile");
  await assert.rejects(pending, /authentication-changed/);

  const missing = harness({
    api: { resolveProfileIdViaApi: async () => null },
  });
  assert.equal(await missing.client.resolveProfileId("missing"), null);
  assert.equal(missing.state.providerCalls, 1);
});

test("player lookup retries once after one second with the same bound provider", async () => {
  const expected = profile("player");
  let attempts = 0;
  const h = harness({
    api: {
      getProfileByLoginIdViaApi: async () => {
        if (++attempts === 1) throw new Error("temporary-failure");
        return expected;
      },
    },
  });
  assert.equal(
    await h.client.getPlayerProfileWithRetry("player-login", () => true),
    expected,
  );
  assert.equal(h.state.authCalls, 1);
  assert.equal(h.state.providerCalls, 1);
  assert.deepEqual(h.state.waits, [1_000]);
  assert.equal(h.calls.length, 2);
  assert.equal(required(h.calls[0]).args[0], "player-login");
  assert.equal(required(h.calls[0]).args[1], required(h.calls[1]).args[1]);
  assert.notEqual(required(h.calls[0]).args[1], h.tokenProvider);
});

test("player lookup stops when its caller expires before authentication, response or retry", async () => {
  const inactive = harness();
  assert.equal(
    await inactive.client.getPlayerProfileWithRetry("login", () => false),
    null,
  );
  assert.equal(inactive.state.authCalls, 1);
  assert.equal(inactive.state.providerCalls, 0);
  assert.deepEqual(inactive.calls, []);

  /** @type {PromiseWithResolvers<import("@mons/shared/profiles").CompletePlayerProfile>} */
  const response = Promise.withResolvers();
  let current = true;
  const late = harness({
    api: { getProfileByLoginIdViaApi: () => response.promise },
  });
  const pending = late.client.getPlayerProfileWithRetry("login", () => current);
  await settle();
  current = false;
  response.resolve(profile("late"));
  assert.equal(await pending, null);

  current = true;
  const retry = harness({
    api: {
      getProfileByLoginIdViaApi: async () => {
        throw new Error("temporary-failure");
      },
    },
    wait: () => {
      current = false;
    },
  });
  assert.equal(
    await retry.client.getPlayerProfileWithRetry("login", () => current),
    null,
  );
  assert.equal(retry.calls.length, 1);
  assert.deepEqual(retry.state.waits, [1_000]);
});

test("player lookup rejects a replaced auth owner and propagates the final failure", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/profiles").CompletePlayerProfile>} */
  const response = Promise.withResolvers();
  const h = harness({
    api: { getProfileByLoginIdViaApi: () => response.promise },
  });
  const pending = h.client.getPlayerProfileWithRetry("login", () => true);
  await settle();
  h.state.user = { ...h.state.user };
  response.resolve(profile("stale"));
  await assert.rejects(pending, /authentication-changed/);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.state.waits, [1_000]);

  const failure = new Error("still-unavailable");
  const failed = harness({
    api: {
      getProfileByLoginIdViaApi: async () => {
        throw failure;
      },
    },
  });
  await assert.rejects(
    failed.client.getPlayerProfileWithRetry("login", () => true),
    failure,
  );
  assert.equal(failed.calls.length, 2);
});

test("material leaderboards share a complete batch until TTL expiry or profile reset", async () => {
  const h = harness();
  const dust = await h.client.getLeaderboard("dust");
  assert.deepEqual(
    h.calls.map(({ args }) => args[0]),
    MINING_MATERIAL_NAMES,
  );
  assert.ok(h.calls.every(({ args }) => args[1] === h.tokenProvider));
  h.state.now += 59_999;
  assert.equal(await h.client.getLeaderboard("dust"), dust);
  await h.client.getLeaderboard("ice");
  await h.client.getLeaderboard("total");
  assert.equal(h.calls.length, 5);
  h.state.now++;
  assert.notEqual(await h.client.getLeaderboard("dust"), dust);
  assert.equal(h.calls.length, 10);
  h.client.resetProfile();
  await h.client.getLeaderboard("slime");
  assert.equal(h.calls.length, 15);
  assert.equal(h.state.authCalls, 6);
  assert.equal(h.state.providerCalls, 0);
});

test("material batches publish only when complete and retain independent simultaneous fetches", async () => {
  /** @type {Array<PromiseWithResolvers<import("@mons/shared/profiles").CompletePlayerProfile[]>>} */
  const responses = [];
  const h = harness({
    api: {
      readLeaderboardViaApi: () => {
        /** @type {PromiseWithResolvers<import("@mons/shared/profiles").CompletePlayerProfile[]>} */
        const response = Promise.withResolvers();
        responses.push(response);
        return response.promise;
      },
    },
  });
  const first = h.client.getLeaderboard("dust");
  await settle();
  assert.equal(responses.length, 5);
  const second = h.client.getLeaderboard("ice");
  await settle();
  assert.equal(responses.length, 10);
  for (const response of responses.slice(0, 5)) {
    response.resolve([profile("batch-0")]);
  }
  assert.equal(required((await first)[0]).id, "batch-0");
  for (const response of responses.slice(5)) {
    response.resolve([profile("batch-1")]);
  }
  assert.equal(required((await second)[0]).id, "batch-1");

  let shouldFail = true;
  const failure = new Error("one-material-unavailable");
  const failing = harness({
    api: {
      readLeaderboardViaApi: async (/** @type {string} */ type) => {
        if (shouldFail && type === "gum") throw failure;
        return [profile(type)];
      },
    },
  });
  await assert.rejects(failing.client.getLeaderboard("total"), failure);
  shouldFail = false;
  await failing.client.getLeaderboard("dust");
  assert.equal(failing.calls.length, 10);
});

for (const type of /** @type {const} */ (["dust", "total"])) {
  test(`profile reset rejects a pending ${type} batch without filling the cache`, async () => {
    /** @type {PromiseWithResolvers<import("@mons/shared/profiles").CompletePlayerProfile[]>} */
    const response = Promise.withResolvers();
    const freshRows = [profile("fresh")];
    let requests = 0;
    const h = harness({
      api: {
        readLeaderboardViaApi: () =>
          ++requests <= 5 ? response.promise : Promise.resolve(freshRows),
      },
    });
    const rejected = assert.rejects(
      h.client.getLeaderboard(type),
      /authentication-changed/,
    );
    await settle();
    h.client.resetProfile();
    response.resolve([profile("stale")]);
    await rejected;
    assert.deepEqual(await h.client.getLeaderboard("total"), freshRows);
    assert.equal(await h.client.getLeaderboard("ice"), freshRows);
    assert.equal(h.calls.length, 10);
  });

  test(`profile reset during ${type} authentication prevents stale reads`, async () => {
    /** @type {PromiseWithResolvers<void>} */
    const authentication = Promise.withResolvers();
    const h = harness({ authenticate: () => authentication.promise });
    const rejected = assert.rejects(
      h.client.getLeaderboard(type),
      /authentication-changed/,
    );
    h.client.resetProfile();
    authentication.resolve();
    await rejected;
    assert.deepEqual(h.calls, []);
    await h.client.getLeaderboard("dust");
    assert.equal(h.calls.length, 5);
  });
}

test("old material batches cannot replace a new profile cache or extend its TTL", async () => {
  /** @type {Array<PromiseWithResolvers<import("@mons/shared/profiles").CompletePlayerProfile[]>>} */
  const batches = Array.from({ length: 4 }, () => Promise.withResolvers());
  let requests = 0;
  const h = harness({
    api: {
      readLeaderboardViaApi: () =>
        required(batches[Math.floor(requests++ / 5)]).promise,
    },
  });
  const firstRejected = assert.rejects(
    h.client.getLeaderboard("dust"),
    /authentication-changed/,
  );
  await settle();
  h.client.resetProfile();
  const secondRejected = assert.rejects(
    h.client.getLeaderboard("total"),
    /authentication-changed/,
  );
  await settle();
  h.client.resetProfile();
  const fresh = h.client.getLeaderboard("ice");
  await settle();
  const freshRows = [profile("fresh")];
  required(batches[2]).resolve(freshRows);
  assert.equal(await fresh, freshRows);

  h.state.now += 59_999;
  required(batches[1]).resolve([profile("second-stale")]);
  required(batches[0]).resolve([profile("first-stale")]);
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(await h.client.getLeaderboard("dust"), freshRows);
  assert.equal(h.calls.length, 15);

  h.state.now++;
  const refresh = h.client.getLeaderboard("dust");
  await settle();
  assert.equal(h.calls.length, 20);
  const refreshedRows = [profile("refreshed")];
  required(batches[3]).resolve(refreshedRows);
  assert.equal(await refresh, refreshedRows);
});

for (const type of /** @type {const} */ (["dust", "total"])) {
  test(`profile reset between ${type} publication and return rejects the old caller`, async () => {
    let resetScheduled = false;
    const h = harness({
      now: () => {
        if (!resetScheduled) {
          resetScheduled = true;
          queueMicrotask(() => h.client.resetProfile());
        }
        return 100;
      },
    });
    await assert.rejects(
      h.client.getLeaderboard(type),
      /authentication-changed/,
    );
    assert.equal(required((await h.client.getLeaderboard("ice"))[0]).id, "ice");
    assert.equal(h.calls.length, 10);
  });
}

for (const type of /** @type {const} */ (["rating", "mp"])) {
  test(`profile reset rejects pending ${type} results before they reach UI caches`, async () => {
    /** @type {PromiseWithResolvers<import("@mons/shared/profiles").CompletePlayerProfile[]>} */
    const response = Promise.withResolvers();
    const h = harness({
      api: { readLeaderboardViaApi: () => response.promise },
    });
    const rejected = assert.rejects(
      h.client.getLeaderboard(type),
      /authentication-changed/,
    );
    await settle();
    h.client.resetProfile();
    response.resolve([profile("stale")]);
    await rejected;
    assert.equal(h.calls.length, 1);
  });
}

test("total leaderboards preserve first records, summed ordering, ties and the 99-entry cap", async () => {
  const first = profile("duplicate", { dust: 3, slime: 7 });
  const tied = profile("tie", { ice: 10 });
  const highest = profile("highest", { dust: 15 });
  const { mining: omittedMining, ...noMining } = canonicalProfile({
    id: "no-mining",
  });
  void omittedMining;
  const rows = [first, tied, noMining];
  const rawHandlers = {};
  const h = harness({ api: rawHandlers });
  Reflect.set(
    rawHandlers,
    "readLeaderboardViaApi",
    async (/** @type {string} */ type) =>
      type === "dust"
        ? rows
        : type === "slime"
          ? [profile("duplicate", { dust: 500 }), highest]
          : [],
  );
  const result = await h.client.getLeaderboard("total");
  assert.deepEqual(result, [highest, first, tied, noMining]);
  assert.deepEqual(rows, [first, tied, noMining]);
  assert.equal(await h.client.getLeaderboard("dust"), rows);

  const capped = harness({
    api: {
      readLeaderboardViaApi: async (/** @type {string} */ type) =>
        type === "dust"
          ? Array.from({ length: 101 }, (_, index) =>
              profile(String(index), { dust: index }),
            )
          : [],
    },
  });
  const top = await capped.client.getLeaderboard("total");
  assert.equal(top.length, 99);
  assert.equal(required(top[0]).id, "100");
  assert.equal(required(top.at(-1)).id, "2");
});

test("rating and mana leaderboards remain uncached and default to rating", async () => {
  const h = harness();
  await h.client.getLeaderboard();
  await h.client.getLeaderboard("rating");
  await h.client.getLeaderboard("mp");
  await h.client.getLeaderboard("mp");
  assert.deepEqual(
    h.calls.map(({ args }) => args[0]),
    ["rating", "rating", "mp", "mp"],
  );
  assert.ok(h.calls.every(({ args }) => args[1] === h.tokenProvider));
});

test("username edits preserve response validation, auth guards and successful invalidation", async () => {
  /** @type {import("@mons/shared/usernames").UsernameEditResponse} */
  const ok = { ok: true };
  const h = harness({ api: { editUsernameViaApi: async () => ok } });
  assert.equal(await h.client.editUsername(" Player "), ok);
  assert.equal(required(h.calls[0]).args[0], " Player ");
  assert.notEqual(required(h.calls[0]).args[1], h.tokenProvider);
  assert.equal(h.state.authCalls, 1);
  assert.equal(h.state.invalidations, 1);

  /** @type {import("@mons/shared/usernames").UsernameEditResponse} */
  const invalid = { ok: false, validationError: "Reserved" };
  const rejected = harness({
    api: { editUsernameViaApi: async () => invalid },
  });
  assert.equal(await rejected.client.editUsername("reserved"), invalid);
  assert.equal(rejected.state.invalidations, 0);

  /** @type {PromiseWithResolvers<import("@mons/shared/usernames").UsernameEditResponse>} */
  const response = Promise.withResolvers();
  const late = harness({ api: { editUsernameViaApi: () => response.promise } });
  const pending = late.client.editUsername("stale");
  await settle();
  late.state.user = { ...late.state.user };
  response.resolve(ok);
  await assert.rejects(pending, /authentication-changed/);
  assert.equal(late.state.invalidations, 0);

  const failure = new Error("username-unavailable");
  const failed = harness({
    api: {
      editUsernameViaApi: async () => {
        throw failure;
      },
    },
  });
  await assert.rejects(failed.client.editUsername("failed"), failure);
  assert.equal(failed.state.invalidations, 0);
});

test("customization methods remain void and send exact fields without authentication waits", async () => {
  const h = harness();
  /** @type {import("@mons/shared/appearance").StickerMap} */
  const stickers = { mana: "blue-mana" };
  const completed = ["first", "second"];
  /** @type {Array<{invoke: () => void; request: import("@mons/shared/profiles").ProfileCustomizationUpdateRequest}>} */
  const requests = [
    {
      invoke: () => h.client.updateCardBackgroundId(0),
      request: { field: "cardBackgroundId", value: 0 },
    },
    {
      invoke: () => h.client.updateCardSubtitleId(3),
      request: { field: "cardSubtitleId", value: 3 },
    },
    {
      invoke: () => h.client.updateProfileCounter("gp"),
      request: { field: "profileCounter", value: "gp" },
    },
    {
      invoke: () => h.client.updateProfileCounter("mp"),
      request: { field: "profileCounter", value: "mp" },
    },
    {
      invoke: () => h.client.updateProfileMons(null),
      request: { field: "profileMons", value: null },
    },
    {
      invoke: () => h.client.updateCardStickers(stickers),
      request: { field: "cardStickers", value: stickers },
    },
    {
      invoke: () => h.client.updateCompletedProblems(completed),
      request: { field: "completedProblems", value: completed },
    },
    {
      invoke: () => h.client.updateTutorialCompleted(false),
      request: { field: "tutorialCompleted", value: false },
    },
  ];
  for (const { invoke } of requests) assert.equal(invoke(), undefined);
  assert.equal(
    Reflect.apply(h.client.updateProfileCounter, h.client, ["unsupported"]),
    undefined,
  );
  assert.deepEqual(
    h.calls.map(({ args }) => args[0]),
    requests.map(({ request }) => request),
  );
  assert.equal(h.state.authCalls, 0);
  assert.equal(h.state.invalidations, 0);
  assert.ok(h.calls.every(({ args }) => args[1] !== h.tokenProvider));
  await settle();
  assert.equal(h.state.invalidations, requests.length);
});

test("stored emoji updates preserve canonical aura and an omitted aura uses the current preference", async () => {
  const h = harness();
  for (const aura of /** @type {const} */ ([undefined, "none", "rainbow"])) {
    assert.equal(h.client.updateStoredEmoji(1009, aura), undefined);
  }
  h.state.storedAura = "none";
  h.client.updateStoredEmoji(8, undefined);
  assert.deepEqual(
    h.calls.map(({ args }) => args[0]),
    [
      { field: "emojiAndAura", value: { emoji: 1009, aura: "rainbow" } },
      { field: "emojiAndAura", value: { emoji: 1009, aura: "none" } },
      { field: "emojiAndAura", value: { emoji: 1009, aura: "rainbow" } },
      { field: "emojiAndAura", value: { emoji: 8, aura: "none" } },
    ],
  );
  assert.equal(h.state.auraReads, 2);
  await settle();
});

test("customization skips absent profiles and provider failures and ignores rejected or stale replies", async () => {
  const h = harness();
  h.state.profileId = null;
  h.client.updateCardBackgroundId(1);
  assert.equal(h.state.providerCalls, 0);
  h.state.profileId = "profile";
  h.state.providerError = new Error("no-current-user");
  h.client.updateCardBackgroundId(2);
  assert.deepEqual(h.calls, []);

  const failed = harness({
    api: {
      updateProfileCustomizationViaApi: async () => {
        throw new Error("unavailable");
      },
    },
  });
  assert.equal(failed.client.updateCardBackgroundId(3), undefined);
  await settle();
  assert.equal(failed.state.invalidations, 0);

  /** @type {PromiseWithResolvers<import("@mons/shared/profiles").ProfileCustomizationUpdateResponse>} */
  const response = Promise.withResolvers();
  const late = harness({
    api: { updateProfileCustomizationViaApi: () => response.promise },
  });
  late.client.updateCardBackgroundId(4);
  late.state.user = { ...late.state.user };
  response.resolve({ ok: true });
  await settle();
  assert.equal(late.state.invalidations, 0);
});
