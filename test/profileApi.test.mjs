import { required } from "./fixtures/canonicalData.mjs";
import { isEmojiId } from "@mons/shared/appearance";
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

const {
  editUsernameViaApi,
  getProfileByIdViaApi,
  getProfileByLoginIdViaApi,
  ProfileApiError,
  PROFILE_API_MAX_RESPONSE_BYTES,
  readLeaderboardViaApi,
  resolveProfileIdViaApi,
  updateProfileCustomizationViaApi,
} = await import("../src/services/profileApi.ts");
const { AuthApiError } = await import("../src/services/authApi.ts");
const {
  getProfileFallbackEmojiId,
  isLeaderboardReadRequest,
  isLeaderboardReadResponse,
  isPlayerProfile,
  isProfileCustomizationUpdateRequest,
  isProfileCustomizationUpdateResponse,
  isProfileLookupRequest,
  isProfileLookupResponse,
  isResolveProfileIdRequest,
  isResolveProfileIdResponse,
  PROFILE_STICKER_CATALOG,
} = await import("@mons/shared/profiles");
const { STICKER_PATHS } = await import("../src/utils/stickers.ts");
const { isUsernameEditRequest, isUsernameEditResponse } =
  await import("@mons/shared/usernames");

const originalFetch = globalThis.fetch;
const profile = {
  id: "profile-1",
  nonce: -1,
  rating: 1500,
  totalManaPoints: 0,
  win: true,
  emoji: 12,
  aura: "rainbow",
  cardBackgroundId: 3,
  cardSubtitleId: 4,
  profileCounter: "mp",
  profileMons: { demon: 1, angel: 2, drainer: 0, spirit: 0, mystic: 0 },
  cardStickers: {},
  username: null,
  eth: null,
  sol: null,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
};

/**
 * @param {unknown} body
 * @param {number} [status]
 */
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("shared profile contracts validate exact requests and responses", () => {
  assert.equal(isProfileLookupRequest({ kind: "login", id: "uid" }), true);
  assert.equal(
    isProfileLookupRequest({ kind: "profile", id: "profile-1" }),
    true,
  );
  assert.equal(
    isProfileLookupRequest({ kind: "login", id: "uid", extra: true }),
    false,
  );
  assert.equal(isProfileLookupRequest({ kind: "login", id: "" }), false);
  assert.equal(isLeaderboardReadRequest({ type: "rating" }), true);
  assert.equal(isLeaderboardReadRequest({ type: "ice" }), true);
  assert.equal(isLeaderboardReadRequest({ type: "total" }), false);
  assert.equal(isPlayerProfile(profile), true);
  assert.equal(isPlayerProfile({ ...profile, mining: {} }), false);
  assert.equal(isPlayerProfile({ ...profile, privateField: true }), false);
  assert.equal(isProfileLookupResponse({ ok: true, profile }), true);
  assert.equal(isProfileLookupResponse({ ok: true, profile: null }), true);
  assert.equal(
    isLeaderboardReadResponse({ ok: true, profiles: [profile] }),
    true,
  );
  assert.equal(
    isLeaderboardReadResponse({
      ok: true,
      profiles: [{ ...profile, emoji: {} }],
    }),
    false,
  );
  assert.equal(getProfileFallbackEmojiId("A"), 66);
  assert.equal(isEmojiId("12"), false);
  assert.equal(isEmojiId(0), true);
  assert.equal(isEmojiId("invalid"), false);
  assert.equal(isUsernameEditRequest({ username: "Mons" }), true);
  assert.equal(isUsernameEditRequest({ username: "Mons", extra: true }), false);
  assert.equal(isUsernameEditRequest({ username: 7 }), false);
  assert.equal(isUsernameEditResponse({ ok: true }), true);
  assert.equal(isUsernameEditResponse({ ok: false }), true);
  assert.equal(
    isUsernameEditResponse({ ok: false, validationError: "Taken" }),
    true,
  );
  assert.equal(
    isUsernameEditResponse({ ok: false, validationError: "", extra: true }),
    false,
  );
  for (const request of [
    { field: "emojiAndAura", value: { emoji: 7, aura: "none" } },
    {
      field: "emojiAndAura",
      value: { emoji: 1009, aura: "rainbow" },
    },
    { field: "cardBackgroundId", value: 3 },
    { field: "cardSubtitleId", value: 4 },
    { field: "profileCounter", value: "mp" },
    {
      field: "profileMons",
      value: { demon: 1, angel: 2, drainer: 3, spirit: 1, mystic: 2 },
    },
    { field: "cardStickers", value: {} },
    { field: "completedProblems", value: ["one"] },
    { field: "tutorialCompleted", value: true },
  ]) {
    assert.equal(isProfileCustomizationUpdateRequest(request), true);
  }
  for (const request of [
    { field: "emoji", value: 7 },
    { field: "aura", value: "rainbow" },
    { field: "emojiAndAura", value: { emoji: -1, aura: "none" } },
    { field: "emojiAndAura", value: { emoji: 156, aura: "none" } },
    { field: "emojiAndAura", value: { emoji: 7, aura: "rainbow" } },
    {
      field: "emojiAndAura",
      value: { emoji: 1009, aura: "rainbow", extra: true },
    },
    { field: "cardBackgroundId", value: 37 },
    { field: "cardSubtitleId", value: 30 },
    { field: "aura", value: "x".repeat(33) },
    { field: "profileCounter", value: "xp" },
    { field: "profileMons", value: "0,0,6,0,0" },
    { field: "cardStickers", value: '{"unknown":"sticker"}' },
    { field: "completedProblems", value: [1] },
    { field: "tutorialCompleted", value: true, extra: true },
  ]) {
    assert.equal(isProfileCustomizationUpdateRequest(request), false);
  }
  assert.equal(isProfileCustomizationUpdateResponse({ ok: true }), true);
  assert.equal(
    isProfileCustomizationUpdateResponse({ ok: true, extra: true }),
    false,
  );
  assert.deepEqual(
    PROFILE_STICKER_CATALOG,
    Object.fromEntries(
      Object.entries(STICKER_PATHS).map(([field, stickers]) => [
        field,
        stickers.map(({ name }) => name),
      ]),
    ),
  );
});

test("canonical profile ID contracts distinguish missing ownership from malformed data", () => {
  assert.equal(
    isResolveProfileIdRequest({ profileId: "retired-profile" }),
    true,
  );
  for (const request of [
    {},
    { profileId: "" },
    { profileId: null },
    { profileId: "   " },
    { profileId: "retired-profile", extra: true },
    { kind: "profile", id: "retired-profile" },
  ]) {
    assert.equal(isResolveProfileIdRequest(request), false);
  }
  assert.equal(
    isResolveProfileIdResponse({ ok: true, profileId: "canonical-profile" }),
    true,
  );
  assert.equal(isResolveProfileIdResponse({ ok: true, profileId: null }), true);
  for (const response of [
    { ok: false, profileId: "canonical-profile" },
    { ok: true },
    { ok: true, profileId: "" },
    { ok: true, profileId: "   " },
    { ok: true, profileId: 7 },
    { ok: true, profileId: "canonical-profile", extra: true },
    { ok: true, profile: null },
  ]) {
    assert.equal(isResolveProfileIdResponse(response), false);
  }
});

test("resolves canonical profile IDs with an authenticated request and preserves null", async () => {
  /**
   * @type {{ input: string; init: RequestInit | undefined; }[]}
   */
  const calls = [];
  const ids = ["canonical-profile", null];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse({ ok: true, profileId: ids.shift() });
  };
  const tokenProvider = async () => "session-token";
  assert.equal(
    await resolveProfileIdViaApi("retired-profile", tokenProvider),
    "canonical-profile",
  );
  assert.equal(
    await resolveProfileIdViaApi("missing-profile", tokenProvider),
    null,
  );
  assert.deepEqual(
    calls.map(({ input, init }) => [
      input,
      parseRequestJson(required(init).body),
    ]),
    [
      [
        "https://api.mons.link/profiles/canonical-id",
        { profileId: "retired-profile" },
      ],
      [
        "https://api.mons.link/profiles/canonical-id",
        { profileId: "missing-profile" },
      ],
    ],
  );
  for (const { init } of calls) {
    assert.equal(required(init).method, "POST");
    assert.equal(required(init).cache, "no-store");
    assert.equal(
      new Headers(required(init).headers).get("Authorization"),
      "Bearer session-token",
    );
  }
});

test("canonical profile ID resolution rejects malformed responses and unavailable ownership", async () => {
  for (const body of [
    { ok: true },
    { ok: true, profileId: "" },
    { ok: true, profileId: "   " },
    { ok: true, profile: null },
    { ok: true, profileId: "canonical-profile", extra: true },
  ]) {
    globalThis.fetch = async () => jsonResponse(body);
    await assert.rejects(
      resolveProfileIdViaApi("retired-profile", async () => "token"),
      (error) =>
        error instanceof ProfileApiError && error.code === "unavailable",
    );
  }
  globalThis.fetch = async () =>
    jsonResponse(
      {
        ok: false,
        error: "unavailable",
        message: "profile-ownership-unavailable",
      },
      503,
    );
  await assert.rejects(
    resolveProfileIdViaApi("retired-profile", async () => "token"),
    (error) =>
      error instanceof ProfileApiError &&
      error.code === "unavailable" &&
      error.message === "profile-ownership-unavailable",
  );
});

test("sends exact authenticated profile requests", async () => {
  /** @type {Array<{ input: string; init: RequestInit | undefined; }>} */
  const calls = [];
  const responses = [
    { ok: true, profile },
    { ok: true, profile: null },
    { ok: true, profiles: [profile] },
    { ok: true },
    { ok: true },
  ];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(responses.shift());
  };
  const tokenProvider = async () => "session-token";

  assert.equal(
    (await getProfileByLoginIdViaApi("login-1", tokenProvider)).id,
    "profile-1",
  );
  assert.equal(await getProfileByIdViaApi("missing", tokenProvider), null);
  assert.equal(
    required((await readLeaderboardViaApi("rating", tokenProvider))[0]).id,
    "profile-1",
  );
  assert.deepEqual(await editUsernameViaApi("Mons", tokenProvider), {
    ok: true,
  });
  assert.deepEqual(
    await updateProfileCustomizationViaApi(
      {
        field: "emojiAndAura",
        value: { emoji: 1009, aura: "rainbow" },
      },
      tokenProvider,
    ),
    { ok: true },
  );

  assert.deepEqual(
    calls.map((call) => [
      call.input,
      parseRequestJson(required(call.init).body),
    ]),
    [
      [
        "https://api.mons.link/profiles/lookup",
        { kind: "login", id: "login-1" },
      ],
      [
        "https://api.mons.link/profiles/lookup",
        { kind: "profile", id: "missing" },
      ],
      ["https://api.mons.link/leaderboards/read", { type: "rating" }],
      ["https://api.mons.link/profiles/username", { username: "Mons" }],
      [
        "https://api.mons.link/profiles/custom",
        {
          field: "emojiAndAura",
          value: { emoji: 1009, aura: "rainbow" },
        },
      ],
    ],
  );
  for (const call of calls) {
    assert.equal(required(call.init).method, "POST");
    assert.equal(required(call.init).cache, "no-store");
    assert.ok(required(call.init).signal instanceof AbortSignal);
    const headers = new Headers(required(call.init).headers);
    assert.equal(headers.get("Authorization"), "Bearer session-token");
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.get("Content-Type"), "application/json");
  }
  assert.equal(required(required(calls.at(-1)).init).keepalive, true);
});

test("refreshes once after 401 and preserves missing-login compatibility", async () => {
  /** @type {Array<boolean>} */
  const refreshes = [];
  /** @type {Array<string | null>} */
  const tokens = [];
  globalThis.fetch = async (_input, init) => {
    tokens.push(new Headers(required(init).headers).get("Authorization"));
    if (tokens.length === 1) {
      return jsonResponse(
        {
          ok: false,
          error: "unauthenticated",
          message: "authentication-required",
        },
        401,
      );
    }
    return jsonResponse({ ok: true, profiles: [profile] });
  };
  assert.equal(
    required(
      (
        await readLeaderboardViaApi("mp", async (forceRefresh) => {
          refreshes.push(forceRefresh);
          return forceRefresh ? "fresh-token" : "stale-token";
        })
      )[0],
    ).id,
    "profile-1",
  );
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(tokens, ["Bearer stale-token", "Bearer fresh-token"]);

  globalThis.fetch = async () => jsonResponse({ ok: true, profile: null });
  await assert.rejects(
    getProfileByLoginIdViaApi("missing", async () => "token"),
    (error) =>
      error instanceof ProfileApiError &&
      error.code === "not-found" &&
      error.message === "Profile not found",
  );
});

test("serializes profile edits after each token and retains keepalive", async () => {
  /** @type {Extract<import("@mons/shared/profiles").ProfileCustomizationUpdateRequest, {field: "profileMons"}>} */
  const request = {
    field: "profileMons",
    value: { demon: 1, angel: 2, drainer: 0, spirit: 0, mystic: 0 },
  };
  /** @type {Array<{ body: Record<string, unknown>; keepalive: boolean | undefined; }>} */
  const calls = [];
  /** @type {Array<boolean>} */
  const refreshes = [];
  globalThis.fetch = async (_input, init) => {
    calls.push({
      body: parseRequestJson(required(init).body),
      keepalive: required(init).keepalive,
    });
    return calls.length === 1
      ? jsonResponse({ ok: false }, 401)
      : jsonResponse({ ok: true });
  };

  await updateProfileCustomizationViaApi(request, async (forceRefresh) => {
    refreshes.push(forceRefresh);
    request.value = {
      demon: forceRefresh ? 1 : 0,
      angel: 3,
      drainer: 4,
      spirit: 0,
      mystic: 0,
    };
    return "token";
  });

  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(calls, [
    {
      body: {
        field: "profileMons",
        value: { demon: 0, angel: 3, drainer: 4, spirit: 0, mystic: 0 },
      },
      keepalive: true,
    },
    {
      body: {
        field: "profileMons",
        value: { demon: 1, angel: 3, drainer: 4, spirit: 0, mystic: 0 },
      },
      keepalive: true,
    },
  ]);
});

test("masks auth token failures as profile service errors", async () => {
  let fetches = 0;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("unexpected-fetch");
  };

  await assert.rejects(
    getProfileByIdViaApi("profile-1", async () => {
      tokenCalls++;
      throw Reflect.construct(AuthApiError, [
        "unauthenticated",
        "authentication-changed",
        {
          reason: "private-session-detail",
        },
      ]);
    }),
    (error) =>
      error instanceof ProfileApiError &&
      error.name === "ProfileApiError" &&
      error.code === "unavailable" &&
      error.message === "Profile service is unavailable." &&
      error.details === undefined,
  );
  assert.equal(tokenCalls, 1);
  assert.equal(fetches, 0);
});

test("rejects malformed, oversized, failed, and timed-out responses", async () => {
  const responses = [
    jsonResponse({ ok: true, profile: { id: "incomplete" } }),
    new Response("{}", {
      status: 200,
      headers: {
        "Content-Length": String(PROFILE_API_MAX_RESPONSE_BYTES + 1),
      },
    }),
  ];
  for (const response of responses) {
    globalThis.fetch = async () => response;
    await assert.rejects(
      getProfileByIdViaApi("profile-1", async () => "token"),
      (error) =>
        error instanceof ProfileApiError && error.code === "unavailable",
    );
  }

  globalThis.fetch = async () => {
    throw new Error("private-network-detail");
  };
  await assert.rejects(
    readLeaderboardViaApi("rating", async () => "token"),
    (error) =>
      error instanceof ProfileApiError &&
      !error.message.includes("private-network-detail"),
  );

  const originalSetTimeout = globalThis.setTimeout;
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value:
      /** @param {(...args: unknown[]) => void} callback @param {number | undefined} _delay @param {...unknown} args */ (
        callback,
        _delay,
        ...args
      ) => originalSetTimeout(callback, 0, ...args),
  });
  try {
    await assert.rejects(
      getProfileByIdViaApi("profile-1", () => new Promise(() => undefined)),
      (error) =>
        error instanceof ProfileApiError &&
        error.message === "Profile request timed out.",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

/** @param {unknown} body @returns {Record<string, unknown>} */
function parseRequestJson(body) {
  assert.ok(typeof body === "string");
  /** @type {unknown} */
  const value = JSON.parse(body);
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return Object.fromEntries(Object.entries(value));
}
