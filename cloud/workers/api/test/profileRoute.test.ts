import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import { handleProfileRoute, validLookupId } from "../src/profileRoute.ts";
import type { ProfileRepository } from "../src/profileRepository.ts";
import type {
  UsernameEditOutcome,
  UsernameRepository,
} from "../src/usernameRepository.ts";
import { handleRequest } from "../src/router.ts";
import { TELEGRAM_TEST_ENV as BASE_ENV } from "./testEnv.ts";

const ctx = { waitUntil: () => undefined };
const identity = { idToken: "firebase-id-token", uid: "firebase-uid" };
const TELEGRAM_TEST_ENV = {
  ...BASE_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;
const profile = {
  id: "profile-1",
  nonce: -1,
  rating: 1500,
  totalManaPoints: 0,
  win: true,
  emoji: "1",
  username: null,
  eth: null,
  sol: null,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
};

function repository(
  overrides: Partial<ProfileRepository> = {},
): ProfileRepository {
  return {
    getProfileById: async () => profile,
    getProfileByLoginId: async () => profile,
    readLeaderboard: async () => [profile],
    ...overrides,
  };
}

function usernameRepository(
  outcome: UsernameEditOutcome = "updated",
): UsernameRepository {
  return {
    editUsername: async () => outcome,
  };
}

function request(
  path: string,
  body: unknown,
  method = "POST",
  origin = "https://mons.link",
): Request {
  return new Request(`https://api.mons.link${path}`, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("applies authenticated CORS and rejects methods before authentication", async () => {
  let verifications = 0;
  const preflight = await handleProfileRoute(
    request("/profiles/lookup", undefined, "OPTIONS"),
    TELEGRAM_TEST_ENV,
    ctx,
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("Access-Control-Allow-Origin"),
    "https://mons.link",
  );
  assert.equal(preflight.headers.get("Cache-Control"), "no-store");

  const rejectedOrigin = await handleProfileRoute(
    request(
      "/leaderboards/read",
      undefined,
      "OPTIONS",
      "https://attacker.invalid",
    ),
    TELEGRAM_TEST_ENV,
    ctx,
  );
  assert.equal(rejectedOrigin.status, 403);

  const wrongMethod = await handleProfileRoute(
    request("/profiles/lookup", undefined, "GET"),
    TELEGRAM_TEST_ENV,
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

test("accepts Firebase UID character limits and Firestore ID byte limits", () => {
  assert.equal(validLookupId("login", "é".repeat(128)), true);
  assert.equal(validLookupId("login", "é".repeat(129)), false);
  assert.equal(validLookupId("profile", "é".repeat(750)), true);
  assert.equal(validLookupId("profile", "é".repeat(751)), false);
});

test("authenticates before parsing and strictly validates request bodies", async () => {
  const unauthenticatedRequest = request("/profiles/lookup", {
    kind: "login",
    id: "login-1",
  });
  const unauthenticated = await handleProfileRoute(
    unauthenticatedRequest,
    TELEGRAM_TEST_ENV,
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

  let reads = 0;
  const testRepository = repository({
    getProfileByLoginId: async () => {
      reads++;
      return profile;
    },
    readLeaderboard: async () => {
      reads++;
      return [profile];
    },
  });
  const invalidBodies = [
    {},
    { kind: "login", id: "" },
    { kind: "other", id: "login-1" },
    { kind: "profile", id: "path/segment" },
    { kind: "login", id: "login-1", extra: true },
  ];
  for (const body of invalidBodies) {
    const response = await handleProfileRoute(
      request("/profiles/lookup", body),
      TELEGRAM_TEST_ENV,
      ctx,
      { repository: testRepository, verifyIdentity: async () => identity },
    );
    assert.equal(response.status, 400);
  }
  for (const body of [{}, { type: "total" }, { type: "rating", extra: true }]) {
    const response = await handleProfileRoute(
      request("/leaderboards/read", body),
      TELEGRAM_TEST_ENV,
      ctx,
      { repository: testRepository, verifyIdentity: async () => identity },
    );
    assert.equal(response.status, 400);
  }
  for (const body of [{}, { username: 7 }, { username: "mons", extra: true }]) {
    const response = await handleProfileRoute(
      request("/profiles/username", body),
      TELEGRAM_TEST_ENV,
      ctx,
      {
        usernameRepository: usernameRepository(),
        verifyIdentity: async () => identity,
      },
    );
    assert.equal(response.status, 400);
  }
  assert.equal(reads, 0);
});

test("preserves username validation and repository outcomes", async () => {
  const validationCases = [
    [" anon ", "This name is reserved."],
    ["abcdefghijklmnop", "Must be shorter than 15 characters."],
    ["mons!", "Use only letters and numbers."],
  ];
  for (const [username, validationError] of validationCases) {
    let writes = 0;
    const response = await handleProfileRoute(
      request("/profiles/username", { username }),
      TELEGRAM_TEST_ENV,
      ctx,
      {
        usernameRepository: {
          editUsername: async () => {
            writes++;
            return "updated";
          },
        },
        verifyIdentity: async () => identity,
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await responseJson(response), {
      ok: false,
      validationError,
    });
    assert.equal(writes, 0);
  }

  const outcomeResponses = new Map<
    UsernameEditOutcome,
    Record<string, unknown>
  >([
    ["updated", { ok: true }],
    ["profile-not-found", { ok: false }],
    [
      "taken",
      {
        ok: false,
        validationError: "That name has been taken. Choose another.",
      },
    ],
    ["cannot-clear", { ok: false, validationError: "Can't be empty." }],
  ]);
  for (const [outcome, expected] of outcomeResponses) {
    const calls: Array<[string, string]> = [];
    const response = await handleProfileRoute(
      request("/profiles/username", { username: " Mons " }),
      TELEGRAM_TEST_ENV,
      ctx,
      {
        usernameRepository: {
          editUsername: async (uid, username) => {
            calls.push([uid, username]);
            return outcome;
          },
        },
        verifyIdentity: async () => identity,
      },
    );
    assert.deepEqual(await responseJson(response), expected);
    assert.deepEqual(calls, [["firebase-uid", "Mons"]]);
  }
});

test("returns exact lookup and leaderboard responses with the verified token", async () => {
  const calls: Array<[string, string, string]> = [];
  const testRepository = repository({
    getProfileById: async (id, token) => {
      calls.push(["profile", id, token]);
      return null;
    },
    getProfileByLoginId: async (id, token) => {
      calls.push(["login", id, token]);
      return profile;
    },
    readLeaderboard: async (type, token) => {
      calls.push(["leaderboard", type, token]);
      return [profile];
    },
  });
  const dependencies = {
    repository: testRepository,
    verifyIdentity: async () => identity,
  };

  const login = await handleProfileRoute(
    request("/profiles/lookup", { kind: "login", id: " login-1 " }),
    TELEGRAM_TEST_ENV,
    ctx,
    dependencies,
  );
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await responseJson(login), { ok: true, profile });

  const byId = await handleProfileRoute(
    request("/profiles/lookup", { kind: "profile", id: "profile-2" }),
    TELEGRAM_TEST_ENV,
    ctx,
    dependencies,
  );
  assert.deepEqual(await responseJson(byId), { ok: true, profile: null });

  const leaderboard = await handleProfileRoute(
    request("/leaderboards/read", { type: "metal" }),
    TELEGRAM_TEST_ENV,
    ctx,
    dependencies,
  );
  assert.deepEqual(await responseJson(leaderboard), {
    ok: true,
    profiles: [profile],
  });
  assert.deepEqual(calls, [
    ["login", "login-1", "firebase-id-token"],
    ["profile", "profile-2", "firebase-id-token"],
    ["leaderboard", "metal", "firebase-id-token"],
  ]);
});

test("sanitizes repository failures and router dispatches both paths", async () => {
  const logged: string[] = [];
  const failure = await handleProfileRoute(
    request("/leaderboards/read", { type: "rating" }),
    TELEGRAM_TEST_ENV,
    ctx,
    {
      logFailure: (kind) => logged.push(kind),
      repository: repository({
        readLeaderboard: async () => {
          throw new Error("private-firestore-detail");
        },
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(failure.status, 503);
  assert.deepEqual(await responseJson(failure), {
    ok: false,
    error: "unavailable",
    message: "profile-service-unavailable",
  });
  assert.deepEqual(logged, ["profile-service-unavailable"]);

  const usernameFailure = await handleProfileRoute(
    request("/profiles/username", { username: "mons" }),
    TELEGRAM_TEST_ENV,
    ctx,
    {
      logFailure: (kind) => logged.push(kind),
      usernameRepository: {
        editUsername: async () => {
          throw new Error("private-firestore-detail");
        },
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(usernameFailure.status, 503);
  assert.deepEqual(await responseJson(usernameFailure), {
    ok: false,
    error: "unavailable",
    message: "profile-service-unavailable",
  });
  assert.deepEqual(logged, [
    "profile-service-unavailable",
    "profile-service-unavailable",
  ]);

  const routed = await handleRequest(
    request("/profiles/lookup", { kind: "profile", id: "profile-1" }),
    TELEGRAM_TEST_ENV,
    {
      profile: {
        repository: repository(),
        verifyIdentity: async () => identity,
      },
    },
    ctx,
  );
  assert.equal(routed.status, 200);
  assert.deepEqual(await responseJson(routed), { ok: true, profile });

  const usernameRouted = await handleRequest(
    request("/profiles/username", { username: "mons" }),
    TELEGRAM_TEST_ENV,
    {
      profile: {
        usernameRepository: usernameRepository(),
        verifyIdentity: async () => identity,
      },
    },
    ctx,
  );
  assert.equal(usernameRouted.status, 200);
  assert.deepEqual(await responseJson(usernameRouted), { ok: true });
});
