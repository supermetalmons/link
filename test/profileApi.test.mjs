import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  getProfileByIdViaApi,
  getProfileByLoginIdViaApi,
  ProfileApiError,
  PROFILE_API_MAX_RESPONSE_BYTES,
  readLeaderboardViaApi,
} = await import("../src/services/profileApi.ts");
const {
  getProfileFallbackEmojiId,
  isLeaderboardReadRequest,
  isLeaderboardReadResponse,
  isPlayerProfile,
  isProfileLookupRequest,
  isProfileLookupResponse,
  normalizeProfileEmojiId,
} = await import("@mons/shared/profiles");

const originalFetch = globalThis.fetch;
const profile = {
  id: "profile-1",
  nonce: -1,
  rating: 1500,
  totalManaPoints: 0,
  win: true,
  emoji: "12",
  aura: "rainbow",
  cardBackgroundId: 3,
  cardSubtitleId: 4,
  profileCounter: "mp",
  profileMons: "1,2",
  cardStickers: "{}",
  username: null,
  eth: null,
  sol: null,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
};

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
  assert.equal(getProfileFallbackEmojiId("A"), "66");
  assert.equal(normalizeProfileEmojiId("12"), 12);
  assert.equal(normalizeProfileEmojiId(0), 0);
  assert.equal(normalizeProfileEmojiId("invalid", 7), 7);
});

test("sends exact authenticated lookup and leaderboard requests", async () => {
  const calls = [];
  const responses = [
    { ok: true, profile },
    { ok: true, profile: null },
    { ok: true, profiles: [profile] },
  ];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(responses.shift());
  };
  const tokenProvider = async () => "firebase-token";

  assert.equal(
    (await getProfileByLoginIdViaApi("login-1", tokenProvider)).id,
    "profile-1",
  );
  assert.equal(await getProfileByIdViaApi("missing", tokenProvider), null);
  assert.equal(
    (await readLeaderboardViaApi("rating", tokenProvider))[0].id,
    "profile-1",
  );

  assert.deepEqual(
    calls.map((call) => [call.input, JSON.parse(call.init.body)]),
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
    ],
  );
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal instanceof AbortSignal);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("Authorization"), "Bearer firebase-token");
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.get("Content-Type"), "application/json");
  }
});

test("refreshes once after 401 and preserves missing-login compatibility", async () => {
  const refreshes = [];
  const tokens = [];
  globalThis.fetch = async (_input, init) => {
    tokens.push(new Headers(init.headers).get("Authorization"));
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
    (
      await readLeaderboardViaApi("mp", async (forceRefresh) => {
        refreshes.push(forceRefresh);
        return forceRefresh ? "fresh-token" : "stale-token";
      })
    )[0].id,
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
  globalThis.setTimeout = (callback, _delay, ...args) =>
    originalSetTimeout(callback, 0, ...args);
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

test("connection routes one-shot reads through the API and keeps material caching", () => {
  const source = readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /getProfileByLoginIdViaApi/);
  assert.match(source, /getProfileByIdViaApi/);
  assert.match(source, /readLeaderboardViaApi/);
  assert.match(
    source,
    /MINING_MATERIAL_NAMES\.map\(\(material\) =>\s*readLeaderboardViaApi/,
  );
  assert.match(source, /LEADERBOARD_CACHE_TTL = 60000/);
  assert.match(source, /if \(type === "total"\)/);
  assert.doesNotMatch(source, /where\("logins", "array-contains", loginId\)/);

  const leaderboardSource = readFileSync(
    new URL("../src/ui/Leaderboard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    leaderboardSource,
    /showShinyCard\(row\.profile, getLeaderboardDisplayName\(row\), true\)/,
  );
  assert.doesNotMatch(leaderboardSource, /getProfileDetails/);
});
