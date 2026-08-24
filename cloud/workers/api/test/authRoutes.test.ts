import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthIntentDocument,
  AuthRepository,
  XRedirectFlowDocument,
} from "../src/firestore.ts";
import { handleAuthRoute } from "../src/authRoutes.ts";
import { AuthApiFailure } from "../src/authErrors.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const ctx = {
  waitUntil: () => undefined,
};
const X_INTENT_ID = "abcdefghijklmnopqrstuvwx";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_DISABLE_X_VERIFY: "false",
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "x-client-id",
  X_CLIENT_SECRET: "x-client-secret",
} as Env;

function request(
  path: string,
  method: string,
  body?: unknown,
  origin = "https://mons.link",
) {
  return new Request(`https://api.mons.link${path}`, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function repository(overrides: Partial<AuthRepository> = {}): AuthRepository {
  return {
    createAuthIntent: async () => "created",
    createXFlow: async () => "created",
    getAuthIntent: async () => ({
      consumedAtMs: 0,
      expiresAtMs: 2_000_000,
      method: "x",
      uid: "firebase-uid",
    }),
    getLinkedAuthMethods: async () => ({
      ok: true,
      profileId: null,
      linkedMethods: { apple: false, eth: false, sol: false, x: false },
      appleLinked: false,
    }),
    getProfileClaimSource: async () => ({
      ok: true,
      profileId: null,
      linkedMethods: { apple: false, eth: false, sol: false, x: false },
      appleLinked: false,
    }),
    ...overrides,
  };
}

const verifyIdentity = async () => ({
  idToken: "firebase-id-token",
  uid: "firebase-uid",
});

function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function deterministicBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index + 1);
}

test("auth routes apply exact origin-aware preflight policy", async () => {
  const preflight = await handleAuthRoute(
    request("/auth/intents", "OPTIONS"),
    env,
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
  assert.equal(preflight.headers.get("Vary"), "Origin");
  assert.equal(preflight.headers.get("Cache-Control"), "no-store");

  const rejected = await handleAuthRoute(
    request("/auth/intents", "OPTIONS", undefined, "https://attacker.invalid"),
    env,
    ctx,
  );
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("Access-Control-Allow-Origin"), null);
  assert.deepEqual(await responseJson(rejected), {
    ok: false,
    error: "permission-denied",
    message: "origin-not-allowed",
  });

  const preview = await handleAuthRoute(
    request(
      "/auth/intents",
      "OPTIONS",
      undefined,
      "https://8bdf84df-mons-link.lil-org.workers.dev",
    ),
    env,
    ctx,
  );
  assert.equal(preview.status, 204);
  assert.equal(
    preview.headers.get("Access-Control-Allow-Origin"),
    "https://8bdf84df-mons-link.lil-org.workers.dev",
  );
});

test("auth routes enforce methods and authentication before repository work", async () => {
  let repositoryCalls = 0;
  const methods = await handleAuthRoute(
    request("/auth/methods", "POST", {}),
    env,
    ctx,
    {
      repository: repository({
        getLinkedAuthMethods: async () => {
          repositoryCalls++;
          throw new Error("unexpected");
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(methods.status, 405);

  const unauthenticated = await handleAuthRoute(
    request("/auth/methods", "GET"),
    env,
    ctx,
    {
      repository: repository(),
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
  assert.equal(repositoryCalls, 0);
});

test("creates exact auth intents for every supported method", async () => {
  const documents: AuthIntentDocument[] = [];
  const keys: string[] = [];
  const rateEnv = {
    ...env,
    AUTH_RATE_LIMITER: {
      limit: async ({ key }: RateLimitOptions) => {
        keys.push(key);
        return { success: true };
      },
    },
  } as Env;
  for (const method of ["eth", "sol", "apple", "x"] as const) {
    const response = await handleAuthRoute(
      request("/auth/intents", "POST", { method }),
      rateEnv,
      ctx,
      {
        now: () => 1_000_000,
        randomBytes: deterministicBytes,
        repository: repository({
          createAuthIntent: async (document) => {
            documents.push(document);
            return "created";
          },
        }),
        verifyIdentity,
      },
    );
    assert.equal(response.status, 200);
    const payload = await responseJson(response);
    assert.equal(payload.ok, true);
    assert.match(String(payload.intentId), /^[A-Za-z0-9_-]{24}$/);
    assert.match(String(payload.state), /^[A-Za-z0-9_-]{24}$/);
    assert.equal(payload.expiresAtMs, 1_300_000);
  }
  assert.deepEqual(keys, [
    "auth-intent:eth:firebase-uid",
    "auth-intent:sol:firebase-uid",
    "auth-intent:apple:firebase-uid",
    "auth-intent:x:firebase-uid",
  ]);
  assert.equal(documents.length, 4);
  assert.match(documents[0].nonce, /^[A-Za-z0-9]{24}$/);
  assert.match(documents[1].nonce, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(documents[0].consumedAtMs, null);
  assert.equal(documents[0].uid, "firebase-uid");
});

test("validates intent bodies, fails closed, and bounds ID collisions", async () => {
  for (const body of [{}, { method: "unknown" }, { method: "eth", extra: 1 }]) {
    const response = await handleAuthRoute(
      request("/auth/intents", "POST", body),
      env,
      ctx,
      { repository: repository(), verifyIdentity },
    );
    assert.equal(response.status, 400);
  }

  const denied = await handleAuthRoute(
    request("/auth/intents", "POST", { method: "eth" }),
    {
      ...env,
      AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as Env,
    ctx,
    { repository: repository(), verifyIdentity },
  );
  assert.equal(denied.status, 429);

  const unavailable = await handleAuthRoute(
    request("/auth/intents", "POST", { method: "eth" }),
    {
      ...env,
      AUTH_RATE_LIMITER: {
        limit: async () => {
          throw new Error("binding-private-detail");
        },
      },
    } as Env,
    ctx,
    { repository: repository(), verifyIdentity },
  );
  assert.equal(unavailable.status, 503);
  assert.equal(
    (await responseJson(unavailable)).message,
    "rate-limit-unavailable",
  );

  let attempts = 0;
  const collisions = await handleAuthRoute(
    request("/auth/intents", "POST", { method: "sol" }),
    env,
    ctx,
    {
      randomBytes: deterministicBytes,
      repository: repository({
        createAuthIntent: async () => {
          attempts++;
          return "exists";
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(collisions.status, 503);
  assert.equal(attempts, 3);
});

test("returns linked methods using the verified UID and original token", async () => {
  const calls: string[][] = [];
  const response = await handleAuthRoute(
    request("/auth/methods", "GET"),
    env,
    ctx,
    {
      repository: repository({
        getLinkedAuthMethods: async (uid, idToken) => {
          calls.push([uid, idToken]);
          return {
            ok: true,
            profileId: "profile-1",
            linkedMethods: { apple: true, eth: false, sol: true, x: false },
            appleLinked: true,
          };
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["firebase-uid", "firebase-id-token"]]);
  assert.deepEqual(await responseJson(response), {
    ok: true,
    profileId: "profile-1",
    linkedMethods: { apple: true, eth: false, sol: true, x: false },
    appleLinked: true,
  });
});

test("synchronizes the profile claim through the authenticated POST route", async () => {
  const calls: string[][] = [];
  const recoveries: string[] = [];
  const response = await handleAuthRoute(
    request("/auth/profile-claim/sync", "POST", {}),
    env,
    ctx,
    {
      repository: repository({
        getProfileClaimSource: async (uid, idToken) => {
          calls.push([uid, idToken]);
          return {
            ok: true,
            profileId: "profile-1",
            linkedMethods: {
              apple: true,
              eth: false,
              sol: true,
              x: false,
            },
            appleLinked: true,
            pendingRecovery: true,
          };
        },
      }),
      enqueuePendingProfileRecovery: async (profileId) => {
        recoveries.push(profileId);
      },
      profileClaim: {
        authClient: {
          getUser: async (uid) => ({
            uid,
            customClaims: { profileId: "profile-1" },
          }),
          setCustomUserClaims: async () => undefined,
        },
        rtdbClient: {
          getPath: async () => "profile-1",
          patchRoot: async () => undefined,
        },
      },
      verifyIdentity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    ["firebase-uid", "firebase-id-token"],
    ["firebase-uid", "firebase-id-token"],
  ]);
  assert.deepEqual(recoveries, ["profile-1"]);
  assert.deepEqual(await responseJson(response), {
    ok: true,
    profileId: "profile-1",
    linkedMethods: { apple: true, eth: false, sol: true, x: false },
    appleLinked: true,
  });

  const rejectedMethod = await handleAuthRoute(
    request("/auth/profile-claim/sync", "GET"),
    env,
    ctx,
    { repository: repository(), verifyIdentity },
  );
  assert.equal(rejectedMethod.status, 405);
});

test("propagates pending profile recovery enqueue failures", async () => {
  const logs: string[] = [];
  const response = await handleAuthRoute(
    request("/auth/profile-claim/sync", "POST", {}),
    env,
    ctx,
    {
      enqueuePendingProfileRecovery: async () => {
        throw new Error("private-queue-detail");
      },
      logFailure: (kind) => logs.push(kind),
      repository: repository({
        getProfileClaimSource: async () => ({
          ok: true,
          profileId: "profile-1",
          linkedMethods: { apple: false, eth: true, sol: false, x: false },
          appleLinked: false,
          pendingRecovery: true,
        }),
      }),
      profileClaim: {
        authClient: {
          getUser: async () => ({
            uid: "firebase-uid",
            customClaims: { profileId: "profile-1" },
          }),
          setCustomUserClaims: async () => undefined,
        },
        rtdbClient: {
          getPath: async () => "profile-1",
          patchRoot: async () => undefined,
        },
      },
      verifyIdentity,
    },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(logs, ["auth-service-unavailable"]);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: "unavailable",
    message: "auth-service-unavailable",
  });
});

test("sanitizes profile-claim reconciliation failures", async () => {
  const logs: string[] = [];
  const response = await handleAuthRoute(
    request("/auth/profile-claim/sync", "POST", {}),
    env,
    ctx,
    {
      logFailure: (kind) => logs.push(kind),
      repository: repository({
        getProfileClaimSource: async () => ({
          ok: true,
          profileId: "profile-1",
          linkedMethods: { apple: false, eth: false, sol: true, x: false },
          appleLinked: false,
        }),
      }),
      profileClaim: {
        authClient: {
          getUser: async () => {
            throw new Error("private-auth-response");
          },
          setCustomUserClaims: async () => undefined,
        },
        rtdbClient: {
          getPath: async () => "profile-1",
          patchRoot: async () => undefined,
        },
      },
      verifyIdentity,
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(logs, ["auth-service-unavailable"]);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: "unavailable",
    message: "auth-service-unavailable",
  });
});

test("rate limits profile-claim synchronization before repository work", async () => {
  const keys: string[] = [];
  let profileReads = 0;
  const response = await handleAuthRoute(
    request("/auth/profile-claim/sync", "POST", {}),
    {
      ...env,
      AUTH_RATE_LIMITER: {
        limit: async ({ key }: RateLimitOptions) => {
          keys.push(key);
          return { success: false };
        },
      },
    } as Env,
    ctx,
    {
      repository: repository({
        getProfileClaimSource: async () => {
          profileReads++;
          return {
            ok: true,
            profileId: null,
            linkedMethods: {
              apple: false,
              eth: false,
              sol: false,
              x: false,
            },
            appleLinked: false,
          };
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(response.status, 429);
  assert.deepEqual(keys, ["auth-profile-claim:firebase-uid"]);
  assert.equal(profileReads, 0);
});

test("creates an exact X flow with bounded intent and PKCE state", async () => {
  const created: XRedirectFlowDocument[] = [];
  const rateKeys: string[] = [];
  const response = await handleAuthRoute(
    request("/auth/x/flows", "POST", {
      intentId: X_INTENT_ID,
      consentSource: "settings",
      returnUrl: "https://mons.link/settings?tab=identity",
    }),
    {
      ...env,
      AUTH_RATE_LIMITER: {
        limit: async ({ key }: RateLimitOptions) => {
          rateKeys.push(key);
          return { success: true };
        },
      },
    } as Env,
    ctx,
    {
      now: () => 1_000_000,
      randomBytes: deterministicBytes,
      repository: repository({
        createXFlow: async (document) => {
          created.push(document);
          return "created";
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(response.status, 200);
  const payload = await responseJson(response);
  assert.match(String(payload.flowId), /^[A-Za-z0-9_-]{24}$/);
  assert.equal(payload.expiresAtMs, 1_600_000);
  const authUrl = new URL(String(payload.authUrl));
  assert.equal(authUrl.origin, "https://x.com");
  assert.equal(authUrl.searchParams.get("client_id"), "x-client-id");
  assert.equal(authUrl.searchParams.get("state"), payload.flowId);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(created.length, 1);
  assert.equal(created[0].callbackUri, "https://api.mons.link/auth/x/callback");
  assert.equal(created[0].consentSource, "settings");
  assert.equal(created[0].returnUrl, "https://mons.link/settings?tab=identity");
  assert.equal(created[0].codeVerifier.length, 64);
  assert.equal(created[0].codeChallenge.length, 43);
  assert.deepEqual(rateKeys, ["auth-x-flow:firebase-uid"]);
});

test("rate limits X flow reads and creation", async () => {
  let intentReads = 0;
  const response = await handleAuthRoute(
    request("/auth/x/flows", "POST", { intentId: X_INTENT_ID }),
    {
      ...env,
      AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as Env,
    ctx,
    {
      repository: repository({
        getAuthIntent: async () => {
          intentReads++;
          return null;
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(response.status, 429);
  assert.equal(intentReads, 0);

  let rateCalls = 0;
  const invalid = await handleAuthRoute(
    request("/auth/x/flows", "POST", { intentId: "short" }),
    {
      ...env,
      AUTH_RATE_LIMITER: {
        limit: async () => {
          rateCalls++;
          return { success: true };
        },
      },
    } as Env,
    ctx,
    { repository: repository(), verifyIdentity },
  );
  assert.equal(invalid.status, 400);
  assert.equal(rateCalls, 0);
});

test("rejects disabled, missing, foreign, wrong-method, and stale X intents", async () => {
  const disabledEnv = { ...env } as Env;
  Object.defineProperty(disabledEnv, "AUTH_DISABLE_X_VERIFY", {
    value: "true",
  });
  const cases: Array<{
    testEnv?: Env;
    intent: Awaited<ReturnType<AuthRepository["getAuthIntent"]>>;
    status: number;
  }> = [
    {
      testEnv: disabledEnv,
      intent: null,
      status: 409,
    },
    { intent: null, status: 409 },
    {
      intent: {
        consumedAtMs: 0,
        expiresAtMs: 2_000_000,
        method: "x",
        uid: "other-user",
      },
      status: 403,
    },
    {
      intent: {
        consumedAtMs: 0,
        expiresAtMs: 2_000_000,
        method: "eth",
        uid: "firebase-uid",
      },
      status: 409,
    },
    {
      intent: {
        consumedAtMs: 1,
        expiresAtMs: 2_000_000,
        method: "x",
        uid: "firebase-uid",
      },
      status: 409,
    },
    {
      intent: {
        consumedAtMs: 0,
        expiresAtMs: 999_999,
        method: "x",
        uid: "firebase-uid",
      },
      status: 409,
    },
  ];
  for (const entry of cases) {
    const response = await handleAuthRoute(
      request("/auth/x/flows", "POST", { intentId: X_INTENT_ID }),
      entry.testEnv || env,
      ctx,
      {
        now: () => 1_000_000,
        repository: repository({ getAuthIntent: async () => entry.intent }),
        verifyIdentity,
      },
    );
    assert.equal(response.status, entry.status);
  }
});

test("falls back unsafe X return URLs and sanitizes repository failures", async () => {
  const created: XRedirectFlowDocument[] = [];
  const response = await handleAuthRoute(
    request("/auth/x/flows", "POST", {
      intentId: X_INTENT_ID,
      returnUrl: "https://attacker.invalid/steal",
    }),
    env,
    ctx,
    {
      now: () => 1_000_000,
      randomBytes: deterministicBytes,
      repository: repository({
        createXFlow: async (document) => {
          created.push(document);
          return "created";
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(created[0].returnUrl, "https://mons.link/");

  const logs: string[] = [];
  const failed = await handleAuthRoute(
    request("/auth/methods", "GET"),
    env,
    ctx,
    {
      logFailure: (kind) => logs.push(kind),
      repository: repository({
        getLinkedAuthMethods: async () => {
          throw new Error("private-firebase-id-token-flow-id");
        },
      }),
      verifyIdentity,
    },
  );
  assert.equal(failed.status, 503);
  assert.deepEqual(logs, ["auth-service-unavailable"]);
  assert.equal(
    JSON.stringify(await responseJson(failed)).includes("private"),
    false,
  );
});

test("rate limits and dispatches auth mutations after Firebase authentication", async () => {
  const keys: string[] = [];
  const response = await handleAuthRoute(
    request("/auth/methods/unlink", "POST", {
      method: "apple",
      opId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    }),
    {
      ...env,
      AUTH_RATE_LIMITER: {
        limit: async ({ key }: RateLimitOptions) => {
          keys.push(key);
          return { success: true };
        },
      },
    } as Env,
    ctx,
    {
      mutation: {
        identityService: {
          consumeIntent: async () => {
            throw new Error("unexpected");
          },
          readIntent: async () => {
            throw new Error("unexpected");
          },
          prepareVerifiedMethod: async () => {
            throw new Error("unexpected");
          },
          linkVerifiedMethod: async () => {
            throw new Error("unexpected");
          },
          peekVerifyReplay: async () => null,
          refreshCompletedVerifyResult: async () => null,
          recoverPendingProfile: async () => true,
          unlinkMethod: async (uid, method, opId) => {
            assert.equal(uid, "firebase-uid");
            assert.equal(method, "apple");
            assert.equal(opId, "6ba7b810-9dad-41d1-80b4-00c04fd430c8");
            return {
              ok: true,
              profileId: "profile-1",
              linkedMethods: {
                apple: false,
                eth: true,
                sol: false,
                x: false,
              },
              appleLinked: false,
            };
          },
        },
      },
      repository: repository(),
      verifyIdentity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(keys, ["auth-mutation:methods:unlink:firebase-uid"]);
  assert.deepEqual(await responseJson(response), {
    ok: true,
    profileId: "profile-1",
    linkedMethods: { apple: false, eth: true, sol: false, x: false },
    appleLinked: false,
  });
});
