import assert from "node:assert/strict";
import test from "node:test";
import {
  createFirebaseAuthAdminClient,
  encodeCustomClaims,
  FirebaseAuthAdminFailure,
  FIREBASE_AUTH_ROOT,
  IDENTITY_TOOLKIT_SCOPE,
  MAX_CUSTOM_CLAIMS_BYTES,
  MAX_FIREBASE_AUTH_BODY_BYTES,
  parseUser,
} from "../src/firebaseAuthAdmin.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
    "worker@example.iam.gserviceaccount.com",
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("looks up users and preserves exact claims through authenticated admin REST", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const accessTokenOptions: Array<
    Parameters<typeof import("../src/googleAuth.ts").createGoogleAccessToken>[1]
  > = [];
  const responses = [
    jsonResponse({
      users: [
        {
          localId: "firebase-uid",
          customAttributes: JSON.stringify({ admin: true, profileId: "old" }),
        },
      ],
    }),
    jsonResponse({ localId: "firebase-uid" }),
  ];
  const client = createFirebaseAuthAdminClient(env, {
    getAccessToken: async (_env, options) => {
      accessTokenOptions.push(options);
      return "google-access-token";
    },
    fetcher: async (input, init) => {
      requests.push({ input, init });
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  });

  assert.deepEqual(await client.getUser("firebase-uid"), {
    uid: "firebase-uid",
    customClaims: { admin: true, profileId: "old" },
  });
  await client.setCustomUserClaims("firebase-uid", {
    admin: true,
    profileId: "profile-1",
  });

  assert.equal(accessTokenOptions.length, 1);
  const tokenOptions = accessTokenOptions[0];
  assert.ok(tokenOptions);
  assert.deepEqual(tokenOptions.credentials, {
    email: env.FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL,
    privateKeyPem: env.FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY,
  });
  assert.deepEqual(tokenOptions.scopes, [IDENTITY_TOOLKIT_SCOPE]);
  assert.deepEqual(
    requests.map(({ input }) => String(input)),
    [
      `${FIREBASE_AUTH_ROOT}/accounts:lookup`,
      `${FIREBASE_AUTH_ROOT}/accounts:update`,
    ],
  );
  for (const request of requests) {
    assert.equal(request.init?.method, "POST");
    assert.equal(
      new Headers(request.init?.headers).get("Authorization"),
      "Bearer google-access-token",
    );
    assert.ok(request.init?.signal instanceof AbortSignal);
  }
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    localId: ["firebase-uid"],
  });
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
    localId: "firebase-uid",
    customAttributes: JSON.stringify({
      admin: true,
      profileId: "profile-1",
    }),
  });
});

test("accepts absent claims and rejects malformed user payloads", () => {
  assert.deepEqual(
    parseUser({ users: [{ localId: "firebase-uid" }] }, "firebase-uid"),
    { uid: "firebase-uid", customClaims: {} },
  );
  for (const value of [
    {},
    { users: [] },
    { users: [{ localId: "other" }] },
    { users: [{ localId: "firebase-uid", customAttributes: "[1]" }] },
    { users: [{ localId: "firebase-uid", customAttributes: "{" }] },
  ]) {
    assert.throws(
      () => parseUser(value, "firebase-uid"),
      FirebaseAuthAdminFailure,
    );
  }
});

test("bounds custom claims before account updates", () => {
  assert.equal(
    encodeCustomClaims({ profileId: "profile-1" }),
    '{"profileId":"profile-1"}',
  );
  const remaining = MAX_CUSTOM_CLAIMS_BYTES + 1;
  assert.throws(
    () => encodeCustomClaims({ value: "x".repeat(remaining) }),
    FirebaseAuthAdminFailure,
  );
});

test("fails closed on rejected, malformed, oversized, and unavailable admin responses", async () => {
  const cases: Array<typeof fetch> = [
    async () => new Response("private-denied", { status: 403 }),
    async () => jsonResponse({ users: [] }),
    async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "Content-Length": String(MAX_FIREBASE_AUTH_BODY_BYTES + 1),
        },
      }),
    async () => {
      throw new DOMException("private-timeout-detail", "TimeoutError");
    },
  ];
  for (const fetcher of cases) {
    const client = createFirebaseAuthAdminClient(env, {
      fetcher,
      getAccessToken: async () => "token",
    });
    await assert.rejects(
      client.getUser("firebase-uid"),
      FirebaseAuthAdminFailure,
    );
  }
});
