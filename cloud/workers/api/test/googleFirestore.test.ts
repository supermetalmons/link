import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthRepository,
  LoginProfileConflict,
} from "../src/firestore.ts";
import {
  createGoogleAccessToken,
  createServiceAccountAssertion,
  GoogleAuthFailure,
} from "../src/googleAuth.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}

function privateKeyPem(bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

async function generateTestKeyPair() {
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    privateKeyPem: privateKeyPem(
      await crypto.subtle.exportKey("pkcs8", keys.privateKey),
    ),
    publicKey: keys.publicKey,
  };
}

test("creates and signs the exact Google service-account assertion", async () => {
  const { privateKeyPem: pem, publicKey } = await generateTestKeyPair();
  const assertion = await createServiceAccountAssertion({
    email: "worker@example.iam.gserviceaccount.com",
    privateKeyPem: pem,
    nowMs: 1_700_000_000_000,
  });
  const parts = assertion.split(".");
  assert.equal(parts.length, 3);
  assert.deepEqual(
    JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
    { alg: "RS256", typ: "JWT" },
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    {
      iss: "worker@example.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    },
  );
  assert.equal(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      exactArrayBuffer(base64UrlBytes(parts[2])),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    ),
    true,
  );
});

test("accepts explicit ordered OAuth scopes for non-Firestore services", async () => {
  const { privateKeyPem: pem } = await generateTestKeyPair();
  const assertion = await createServiceAccountAssertion({
    email: "worker@example.iam.gserviceaccount.com",
    privateKeyPem: pem,
    nowMs: 1_700_000_000_000,
    scopes: ["scope:first", "scope:second"],
  });
  const payload = JSON.parse(
    Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"),
  ) as { scope: string };
  assert.equal(payload.scope, "scope:first scope:second");
});

test("exchanges a signed assertion for a bounded Google access token", async () => {
  const { privateKeyPem: pem } = await generateTestKeyPair();
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input, init });
    return new Response(
      JSON.stringify({ access_token: "google-access-token", expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const accessToken = await createGoogleAccessToken(
    {
      ...env,
      FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: pem,
    },
    { fetcher, now: () => 1_700_000_000_000 },
  );
  assert.equal(accessToken, "google-access-token");
  assert.equal(requests.length, 1);
  assert.equal(
    String(requests[0].input),
    "https://oauth2.googleapis.com/token",
  );
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(
    new Headers(requests[0].init?.headers).get("content-type"),
    "application/x-www-form-urlencoded",
  );
  const body = new URLSearchParams(String(requests[0].init?.body));
  assert.equal(
    body.get("grant_type"),
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  assert.match(body.get("assertion") || "", /^[^.]+\.[^.]+\.[^.]+$/);
  assert.ok(requests[0].init?.signal instanceof AbortSignal);
});

test("rejects malformed keys, failed exchanges, oversized bodies, and fetch errors", async () => {
  await assert.rejects(
    createServiceAccountAssertion({
      email: env.FIRESTORE_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: "not-a-private-key",
      nowMs: Date.now(),
    }),
    GoogleAuthFailure,
  );

  const { privateKeyPem: pem } = await generateTestKeyPair();
  const authEnv = { ...env, FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: pem };
  const operationController = new AbortController();
  operationController.abort();
  await assert.rejects(
    createGoogleAccessToken(authEnv, {
      fetcher: async (_input, init) => {
        assert.equal(init?.signal?.aborted, true);
        throw new DOMException("aborted", "AbortError");
      },
      signal: operationController.signal,
    }),
    GoogleAuthFailure,
  );
  for (const fetcher of [
    async () => new Response("denied", { status: 403 }),
    async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(64 * 1024 + 1) },
      }),
    async () => {
      throw new DOMException("private-timeout-detail", "TimeoutError");
    },
  ] as Array<typeof fetch>) {
    await assert.rejects(
      createGoogleAccessToken(authEnv, { fetcher }),
      GoogleAuthFailure,
    );
  }
});

test("queries only linked auth fields with the user's Firebase token", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const repository = createAuthRepository(env, {
    getAccessToken: async () => "unused-service-token",
    fetcher: async (input, init) => {
      requests.push({ input, init });
      return new Response(
        JSON.stringify([
          {
            document: {
              name: "projects/mons-link/databases/(default)/documents/users/profile-1",
              fields: {
                appleSub: { stringValue: "apple-sub" },
                eth: {
                  stringValue: "0x1111111111111111111111111111111111111111",
                },
                sol: { stringValue: "11111111111111111111" },
                xUserId: { stringValue: "not-numeric" },
              },
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.deepEqual(
    await repository.getLinkedAuthMethods("firebase-uid", "firebase-id-token"),
    {
      ok: true,
      profileId: "profile-1",
      linkedMethods: { apple: true, eth: true, sol: true, x: false },
      appleLinked: true,
    },
  );
  assert.equal(requests.length, 1);
  assert.equal(String(requests[0].input).endsWith("/documents:runQuery"), true);
  assert.equal(
    new Headers(requests[0].init?.headers).get("Authorization"),
    "Bearer firebase-id-token",
  );
  const query = JSON.parse(String(requests[0].init?.body));
  assert.deepEqual(query.structuredQuery.select.fields, [
    { fieldPath: "appleSub" },
    { fieldPath: "eth" },
    { fieldPath: "sol" },
    { fieldPath: "xUserId" },
  ]);
  assert.deepEqual(query.structuredQuery.where.fieldFilter, {
    field: { fieldPath: "logins" },
    op: "ARRAY_CONTAINS",
    value: { stringValue: "firebase-uid" },
  });
  assert.equal(query.structuredQuery.limit, 1);
});

test("returns the exact empty linked-method response without service auth", async () => {
  let serviceTokenCalls = 0;
  const repository = createAuthRepository(env, {
    getAccessToken: async () => {
      serviceTokenCalls++;
      return "unused";
    },
    fetcher: async () =>
      new Response(JSON.stringify([{ readTime: "2026-08-18T00:00:00Z" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  assert.deepEqual(
    await repository.getLinkedAuthMethods("firebase-uid", "firebase-token"),
    {
      ok: true,
      profileId: null,
      linkedMethods: { apple: false, eth: false, sol: false, x: false },
      appleLinked: false,
    },
  );
  assert.equal(serviceTokenCalls, 0);
});

test("queries two profiles for claim sync and blocks ambiguous ownership", async () => {
  const requests: RequestInit[] = [];
  const document = (profileId: string) => ({
    document: {
      name: `projects/mons-link/databases/(default)/documents/users/${profileId}`,
      fields: {
        appleSub: { stringValue: "apple-sub" },
        eth: { stringValue: "" },
        sol: { stringValue: "11111111111111111111" },
        xUserId: { stringValue: "" },
      },
    },
  });
  const repository = createAuthRepository(env, {
    getAccessToken: async () => "unused",
    fetcher: async (_input, init) => {
      requests.push(init || {});
      return new Response(
        JSON.stringify([document("profile-1"), document("profile-2")]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  await assert.rejects(
    repository.getProfileClaimSource("firebase-uid", "firebase-token"),
    LoginProfileConflict,
  );
  const query = JSON.parse(String(requests[0].body)).structuredQuery;
  assert.equal(query.limit, 2);
  assert.deepEqual(query.select.fields, [
    { fieldPath: "appleSub" },
    { fieldPath: "eth" },
    { fieldPath: "sol" },
    { fieldPath: "xUserId" },
  ]);
});

test("returns a claim source without legacy recovery state", async () => {
  const repository = createAuthRepository(env, {
    getAccessToken: async () => "unused",
    fetcher: async () =>
      new Response(
        JSON.stringify([
          {
            document: {
              name: "projects/mons-link/databases/(default)/documents/users/profile-1",
              fields: {
                sol: { stringValue: "11111111111111111111" },
              },
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  assert.deepEqual(
    await repository.getProfileClaimSource("firebase-uid", "firebase-token"),
    {
      ok: true,
      profileId: "profile-1",
      linkedMethods: { apple: false, eth: false, sol: true, x: false },
      appleLinked: false,
    },
  );
});
