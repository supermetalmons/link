import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import { handleProfileRoute, validLookupId } from "../src/profileRoute.ts";
import type { ProfileRepository } from "../src/profileRepository.ts";
import type {
  ProfileCustomizationRepository,
  ProfileCustomizationUpdateOutcome,
} from "../src/profileCustomizationRepository.ts";
import type {
  UsernameEditOutcome,
  UsernameRepository,
} from "../src/usernameRepository.ts";
import { handleRequest } from "../src/router.ts";
import {
  TELEGRAM_TEST_ENV as BASE_ENV,
  withProfileControl,
} from "./testEnv.ts";

const ctx = { waitUntil: () => undefined };
const identity = { idToken: "firebase-id-token", uid: "firebase-uid" };
const TELEGRAM_TEST_ENV = {
  ...BASE_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
    "identity@example.iam.gserviceaccount.com",
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
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

function customizationRepository(
  outcome: ProfileCustomizationUpdateOutcome = "updated",
): ProfileCustomizationRepository {
  return { updateCustomization: async () => outcome };
}

const customizationProfile = {
  documentName: "profile-document",
  eth: "",
  sol: "",
};

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
  for (const body of [
    {},
    { field: "unknown", value: true },
    { field: "emoji", value: 7 },
    { field: "aura", value: "rainbow" },
    { field: "cardBackgroundId", value: -1 },
    {
      field: "emojiAndAura",
      value: { emoji: 7, aura: "rainbow" },
    },
    { field: "emojiAndAura", value: { emoji: 7, aura: "", extra: true } },
    { field: "profileCounter", value: "xp" },
    { field: "tutorialCompleted", value: true, extra: true },
  ]) {
    const response = await handleProfileRoute(
      request("/profiles/custom", body),
      TELEGRAM_TEST_ENV,
      ctx,
      {
        customizationRepository: customizationRepository(),
        verifyIdentity: async () => identity,
      },
    );
    assert.equal(response.status, 400);
  }
  assert.equal(reads, 0);
});

test("freezes profile writes while keeping profile reads available", async () => {
  let usernameWrites = 0;
  const frozenEnv = withProfileControl(TELEGRAM_TEST_ENV, "frozen");
  const write = await handleProfileRoute(
    request("/profiles/username", { username: "Mons" }),
    frozenEnv,
    ctx,
    {
      usernameRepository: {
        editUsername: async () => {
          usernameWrites++;
          return "updated";
        },
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(write.status, 503);
  assert.equal(write.headers.get("Retry-After"), "60");
  assert.deepEqual(await responseJson(write), {
    ok: false,
    error: "unavailable",
    message: "profile-writes-disabled",
  });
  assert.equal(usernameWrites, 0);

  const read = await handleProfileRoute(
    request("/profiles/lookup", { kind: "profile", id: "profile-1" }),
    frozenEnv,
    ctx,
    { repository: repository(), verifyIdentity: async () => identity },
  );
  assert.equal(read.status, 200);
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

test("updates one exact customization field for the verified login", async () => {
  const calls: Array<[string, unknown]> = [];
  const response = await handleProfileRoute(
    request("/profiles/custom", { field: "completedProblems", value: ["1"] }),
    TELEGRAM_TEST_ENV,
    ctx,
    {
      customizationRepository: {
        updateCustomization: async (uid, update) => {
          calls.push([uid, update]);
          return "updated";
        },
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), { ok: true });
  assert.deepEqual(calls, [
    ["firebase-uid", { field: "completedProblems", value: ["1"] }],
  ]);
});

test("authorizes protected customization before writing", async () => {
  let writes = 0;
  const response = await handleProfileRoute(
    request("/profiles/custom", { field: "cardBackgroundId", value: 100 }),
    TELEGRAM_TEST_ENV,
    ctx,
    {
      authorizeCustomization: async () => {
        throw new AuthApiFailure(
          403,
          "permission-denied",
          "profile-customization-not-owned",
        );
      },
      customizationRepository: {
        updateCustomization: async (_uid, _update, authorize) => {
          await authorize(customizationProfile);
          writes++;
          return "updated";
        },
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 403);
  assert.equal(writes, 0);
});

test("maps missing and conflicting customization owners", async () => {
  for (const [outcome, status, error, message] of [
    ["profile-not-found", 404, "not-found", "profile-not-found"],
    [
      "login-profile-conflict",
      409,
      "failed-precondition",
      "login-profile-conflict",
    ],
  ] as const) {
    const response = await handleProfileRoute(
      request("/profiles/custom", { field: "tutorialCompleted", value: true }),
      TELEGRAM_TEST_ENV,
      ctx,
      {
        customizationRepository: customizationRepository(outcome),
        verifyIdentity: async () => identity,
      },
    );
    assert.equal(response.status, status);
    assert.deepEqual(await responseJson(response), {
      ok: false,
      error,
      message,
    });
  }
});

test("does not rate limit customization", async () => {
  let writes = 0;
  const response = await handleProfileRoute(
    request("/profiles/custom", { field: "tutorialCompleted", value: true }),
    {
      ...TELEGRAM_TEST_ENV,
      AUTH_RATE_LIMITER: {
        limit: async () => {
          throw new Error("unexpected rate limiter call");
        },
      },
    },
    ctx,
    {
      customizationRepository: {
        updateCustomization: async () => {
          writes++;
          return "updated";
        },
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(writes, 1);
});

test("does not write customization after its request deadline", async () => {
  const controller = new AbortController();
  controller.abort();
  let writes = 0;
  const response = await handleProfileRoute(
    request("/profiles/custom", { field: "tutorialCompleted", value: true }),
    TELEGRAM_TEST_ENV,
    ctx,
    {
      authorizeCustomization: async () => undefined,
      customizationRepository: {
        updateCustomization: async (_uid, _update, authorize) => {
          await authorize(customizationProfile);
          writes++;
          return "updated";
        },
      },
      customizationSignal: controller.signal,
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 503);
  assert.equal(writes, 0);
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

  const customizationFailure = await handleProfileRoute(
    request("/profiles/custom", { field: "tutorialCompleted", value: true }),
    TELEGRAM_TEST_ENV,
    ctx,
    {
      customizationRepository: {
        updateCustomization: async () => {
          throw new Error("private-firestore-detail");
        },
      },
      logFailure: (kind) => logged.push(kind),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(customizationFailure.status, 503);
  assert.deepEqual(await responseJson(customizationFailure), {
    ok: false,
    error: "unavailable",
    message: "profile-service-unavailable",
  });

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

  const customizationRouted = await handleRequest(
    request("/profiles/custom", { field: "profileCounter", value: "mp" }),
    TELEGRAM_TEST_ENV,
    {
      profile: {
        customizationRepository: customizationRepository(),
        verifyIdentity: async () => identity,
      },
    },
    ctx,
  );
  assert.equal(customizationRouted.status, 200);
  assert.deepEqual(await responseJson(customizationRouted), { ok: true });
});
