import assert from "node:assert/strict";
import test from "node:test";
import {
  createDropsForMiningEvent,
  createEmptyMaterials,
  type MineRockRequest,
  type MiningSnapshot,
} from "@mons/shared/mining";
import { AuthApiFailure } from "../src/authErrors.ts";
import { handleMiningRoute } from "../src/miningRoute.ts";
import type {
  MiningProfile,
  MiningRepository,
} from "../src/miningRepository.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "./testEnv.ts";

const NOW_MS = Date.UTC(2026, 7, 18, 12);
const ctx = { waitUntil: () => undefined };
const identity = { idToken: "firebase-id-token", uid: "firebase-uid" };

function envWithRateLimit(
  limit: (
    options: RateLimitOptions,
  ) => Promise<RateLimitOutcome> = async () => ({
    success: true,
  }),
): Env {
  return {
    ...TELEGRAM_TEST_ENV,
    AUTH_RATE_LIMITER: { limit },
    FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
      "identity@example.iam.gserviceaccount.com",
    FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
    HELIUS_RPC_API_KEY: "test-helius-key",
    NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    X_CLIENT_ID: "test-x-client",
    X_CLIENT_SECRET: "test-x-secret",
  } as Env;
}

function materials(dust = 0, slime = 0, gum = 0, metal = 0, ice = 0) {
  return { dust, slime, gum, metal, ice };
}

function request(
  body: unknown,
  method = "POST",
  origin = "https://mons.link",
): Request {
  return new Request("https://api.mons.link/mining/rock", {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function profile(
  mining: MiningSnapshot = {
    lastRockDate: null,
    materials: createEmptyMaterials(),
  },
  updateTime = "2026-08-18T10:00:00Z",
): MiningProfile {
  return { profileId: "profile-1", mining, updateTime };
}

function repository(
  overrides: Partial<MiningRepository> = {},
): MiningRepository {
  return {
    getProfile: async () => profile(),
    updateMining: async () => "updated",
    ...overrides,
  };
}

function mineRequest(
  mining: MiningSnapshot = {
    lastRockDate: null,
    materials: createEmptyMaterials(),
  },
  date = "2026-08-18",
): MineRockRequest {
  return {
    date,
    materials: createDropsForMiningEvent("profile-1", date, mining).delta,
  };
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const verifyIdentity = async () => identity;

test("applies authenticated CORS and rejects methods before authentication", async () => {
  let verifications = 0;
  const preflight = await handleMiningRoute(
    request(undefined, "OPTIONS"),
    envWithRateLimit(),
    ctx,
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("Access-Control-Allow-Origin"),
    "https://mons.link",
  );
  assert.equal(
    preflight.headers.get("Access-Control-Allow-Headers"),
    "Authorization, Content-Type",
  );
  assert.equal(preflight.headers.get("Cache-Control"), "no-store");

  const rejectedOrigin = await handleMiningRoute(
    request(undefined, "OPTIONS", "https://attacker.invalid"),
    envWithRateLimit(),
    ctx,
  );
  assert.equal(rejectedOrigin.status, 403);

  const wrongMethod = await handleMiningRoute(
    request(undefined, "GET"),
    envWithRateLimit(),
    ctx,
    {
      verifyIdentity: async () => {
        verifications++;
        return identity;
      },
    },
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(verifications, 0);
});

test("authenticates and rate limits before reading the request body", async () => {
  const unauthenticatedRequest = request({ date: "2026-08-18" });
  const unauthenticated = await handleMiningRoute(
    unauthenticatedRequest,
    envWithRateLimit(),
    ctx,
    {
      verifyIdentity: async () => {
        throw new AuthApiFailure(
          401,
          "unauthenticated",
          "authentication-required",
        );
      },
    },
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticatedRequest.bodyUsed, false);

  const keys: string[] = [];
  const limitedRequest = request({ date: "2026-08-18" });
  const limited = await handleMiningRoute(
    limitedRequest,
    envWithRateLimit(async ({ key }) => {
      keys.push(key);
      return { success: false };
    }),
    ctx,
    { verifyIdentity },
  );
  assert.equal(limited.status, 429);
  assert.equal(limitedRequest.bodyUsed, false);
  assert.deepEqual(keys, ["mining:firebase-uid"]);

  const unavailable = await handleMiningRoute(
    request({ date: "2026-08-18" }),
    envWithRateLimit(async () => {
      throw new Error("binding-detail");
    }),
    ctx,
    { verifyIdentity },
  );
  assert.equal(unavailable.status, 503);
  assert.equal(
    (await responseJson(unavailable)).message,
    "rate-limit-unavailable",
  );
});

test("freezes mining before rate limiting or repository work", async () => {
  let rateLimitCalls = 0;
  let repositoryCalls = 0;
  const frozenEnv = withProfileControl(
    envWithRateLimit(async () => {
      rateLimitCalls++;
      return { success: true };
    }),
    "frozen",
  );
  const mine = request(mineRequest());
  const response = await handleMiningRoute(mine, frozenEnv, ctx, {
    repository: repository({
      getProfile: async () => {
        repositoryCalls++;
        return profile();
      },
    }),
    verifyIdentity,
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: "unavailable",
    message: "profile-writes-disabled",
  });
  assert.equal(rateLimitCalls, 0);
  assert.equal(repositoryCalls, 0);
  assert.equal(mine.bodyUsed, false);
});

test("validates bounded request bodies before repository access", async () => {
  let repositoryCalls = 0;
  const testRepository = repository({
    getProfile: async () => {
      repositoryCalls++;
      return profile();
    },
  });
  const cases = [
    {},
    { date: 20260818, materials: materials(1) },
    { date: "2026-8-18", materials: materials(1) },
    { date: "2026-08-18", materials: materials() },
  ];
  for (const body of cases) {
    const response = await handleMiningRoute(
      request(body),
      envWithRateLimit(),
      ctx,
      { repository: testRepository, verifyIdentity },
    );
    assert.equal(response.status, 400);
  }
  const oversized = await handleMiningRoute(
    request({
      date: "2026-08-18",
      materials: materials(1),
      padding: "x".repeat(4096),
    }),
    envWithRateLimit(),
    ctx,
    { repository: testRepository, verifyIdentity },
  );
  assert.equal(oversized.status, 400);
  assert.equal(repositoryCalls, 0);
});

test("preserves numeric material normalization", async () => {
  let written: MiningSnapshot | null = null;
  const response = await handleMiningRoute(
    request({ date: "2026-08-18", materials: { dust: "1" } }),
    envWithRateLimit(),
    ctx,
    {
      now: () => NOW_MS,
      repository: repository({
        updateMining: async (_profileId, mining) => {
          written = mining;
          return "updated";
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(written, {
    lastRockDate: "2026-08-18",
    materials: materials(1),
  });
});

test("preserves every business failure response", async () => {
  let profileReads = 0;
  const outOfRange = await handleMiningRoute(
    request(mineRequest(undefined, "2026-08-10")),
    envWithRateLimit(),
    ctx,
    {
      now: () => NOW_MS,
      repository: repository({
        getProfile: async () => {
          profileReads++;
          return profile();
        },
      }),
      verifyIdentity,
    },
  );
  assert.deepEqual(await responseJson(outOfRange), {
    ok: false,
    reason: "date-out-of-range",
  });
  assert.equal(profileReads, 0);

  const missing = await handleMiningRoute(
    request(mineRequest()),
    envWithRateLimit(),
    ctx,
    {
      now: () => NOW_MS,
      repository: repository({ getProfile: async () => null }),
      verifyIdentity,
    },
  );
  assert.deepEqual(await responseJson(missing), {
    ok: false,
    reason: "profile-not-found",
  });

  const alreadyMinedState = {
    lastRockDate: "2026-08-18",
    materials: materials(3),
  };
  const alreadyMined = await handleMiningRoute(
    request(mineRequest(alreadyMinedState)),
    envWithRateLimit(),
    ctx,
    {
      now: () => NOW_MS,
      repository: repository({
        getProfile: async () => profile(alreadyMinedState),
      }),
      verifyIdentity,
    },
  );
  assert.deepEqual(await responseJson(alreadyMined), {
    ok: false,
    reason: "date-not-advanced",
  });

  const mismatch = await handleMiningRoute(
    request({ date: "2026-08-18", materials: materials(2) }),
    envWithRateLimit(),
    ctx,
    {
      now: () => NOW_MS,
      repository: repository(),
      verifyIdentity,
    },
  );
  assert.deepEqual(await responseJson(mismatch), {
    ok: false,
    reason: "materials-mismatch",
  });
});

test("writes exact first and subsequent mining snapshots", async () => {
  const states: MiningSnapshot[] = [
    { lastRockDate: null, materials: createEmptyMaterials() },
    { lastRockDate: "2026-08-17", materials: materials(4, 3, 2, 1, 0) },
  ];
  for (const state of states) {
    const updates: Array<{
      profileId: string;
      mining: MiningSnapshot;
      updateTime: string;
    }> = [];
    const input = mineRequest(state);
    const response = await handleMiningRoute(
      request(input),
      envWithRateLimit(),
      ctx,
      {
        now: () => NOW_MS,
        repository: repository({
          getProfile: async () => profile(state),
          updateMining: async (profileId, mining, updateTime) => {
            updates.push({ profileId, mining, updateTime });
            return "updated";
          },
        }),
        verifyIdentity,
      },
    );
    assert.equal(response.status, 200);
    const expectedMining = {
      lastRockDate: input.date,
      materials: Object.fromEntries(
        Object.keys(state.materials).map((key) => [
          key,
          state.materials[key as keyof typeof state.materials] +
            input.materials[key as keyof typeof input.materials],
        ]),
      ),
    };
    assert.deepEqual(await responseJson(response), {
      ok: true,
      mining: expectedMining,
    });
    assert.deepEqual(updates, [
      {
        profileId: "profile-1",
        mining: expectedMining,
        updateTime: "2026-08-18T10:00:00Z",
      },
    ]);
  }
});

test("re-reads after conflicts and bounds optimistic retries", async () => {
  const state = {
    lastRockDate: "2026-08-17",
    materials: materials(1, 1, 1, 1, 1),
  };
  const input = mineRequest(state);
  let reads = 0;
  let writes = 0;
  const recovered = await handleMiningRoute(
    request(input),
    envWithRateLimit(),
    ctx,
    {
      now: () => NOW_MS,
      repository: repository({
        getProfile: async () => {
          reads++;
          return profile(
            {
              ...state,
              materials: {
                ...state.materials,
                dust: state.materials.dust + reads - 1,
              },
            },
            `2026-08-18T10:00:0${reads}Z`,
          );
        },
        updateMining: async () => {
          writes++;
          return writes < 3 ? "conflict" : "updated";
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(recovered.status, 200);
  assert.equal(reads, 3);
  assert.equal(writes, 3);
  assert.equal(
    ((await responseJson(recovered)).mining as { materials: { dust: number } })
      .materials.dust,
    state.materials.dust + 2 + input.materials.dust,
  );

  const logged: string[] = [];
  const exhausted = await handleMiningRoute(
    request(input),
    envWithRateLimit(),
    ctx,
    {
      logFailure: (kind) => logged.push(kind),
      now: () => NOW_MS,
      repository: repository({
        getProfile: async () => profile(state),
        updateMining: async () => "conflict",
      }),
      verifyIdentity,
    },
  );
  assert.equal(exhausted.status, 503);
  assert.equal(
    (await responseJson(exhausted)).message,
    "mining-write-conflict",
  );
  assert.deepEqual(logged, ["mining-write-conflict"]);
});

test("sanitizes unexpected repository failures", async () => {
  const logged: string[] = [];
  const response = await handleMiningRoute(
    request(mineRequest()),
    envWithRateLimit(),
    ctx,
    {
      logFailure: (kind) => logged.push(kind),
      now: () => NOW_MS,
      repository: repository({
        getProfile: async () => {
          throw new Error("profile-repository-unavailable");
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: "unavailable",
    message: "mining-service-unavailable",
  });
  assert.deepEqual(logged, ["mining-service-unavailable"]);
});
