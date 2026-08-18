import assert from "node:assert/strict";
import test from "node:test";
import {
  createXFlowRepository,
  FirestoreFailure,
  parseXRedirectFlowDocument,
} from "../src/firestore.ts";
import {
  createGoogleAccessToken,
  createServiceAccountAssertion,
  GoogleAuthFailure,
} from "../src/googleAuth.ts";

const env = {
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
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

function firestoreDocument() {
  return {
    name: "projects/mons-link/databases/(default)/documents/xAuthRedirectFlows/abcdefghijklmnopqrstuvwx",
    fields: {
      returnUrl: { stringValue: "https://mons.link/" },
      consentSource: { stringValue: "signin" },
      status: { stringValue: "created" },
      errorCode: { nullValue: null },
      expiresAtMs: { integerValue: "1500000" },
      createdAtMs: { integerValue: "900000" },
      callbackUri: {
        stringValue: "https://api.mons.link/auth/x/callback",
      },
      codeVerifier: { stringValue: "verifier" },
    },
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

test("parses only the Firestore scalar fields used by X redirects", () => {
  assert.deepEqual(parseXRedirectFlowDocument(firestoreDocument()), {
    returnUrl: "https://mons.link/",
    consentSource: "signin",
    status: "created",
    errorCode: "",
    expiresAtMs: 1_500_000,
    createdAtMs: 900_000,
    callbackUri: "https://api.mons.link/auth/x/callback",
    codeVerifier: "verifier",
  });
  assert.throws(() => parseXRedirectFlowDocument({}), FirestoreFailure);
});

test("reads and patches the existing flow through authenticated Firestore REST", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input, init });
    if (!init?.method) {
      return new Response(JSON.stringify(firestoreDocument()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(firestoreDocument()), { status: 200 });
  };
  let accessTokenCalls = 0;
  const repository = createXFlowRepository(env, {
    fetcher,
    getAccessToken: async () => {
      accessTokenCalls++;
      return "google-access-token";
    },
  });
  assert.equal(
    (await repository.getFlow("abcdefghijklmnopqrstuvwx"))?.status,
    "created",
  );
  await repository.updateFlow("abcdefghijklmnopqrstuvwx", {
    status: "verified",
    xUserId: "2244994945",
    xUsername: null,
    errorCode: null,
    updatedAtMs: 1_000_000,
  });

  assert.equal(accessTokenCalls, 1);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(
      new Headers(request.init?.headers).get("authorization"),
      "Bearer google-access-token",
    );
    assert.ok(request.init?.signal instanceof AbortSignal);
  }
  const patchUrl = new URL(String(requests[1].input));
  assert.equal(requests[1].init?.method, "PATCH");
  assert.deepEqual(patchUrl.searchParams.getAll("updateMask.fieldPaths"), [
    "status",
    "xUserId",
    "xUsername",
    "errorCode",
    "updatedAtMs",
  ]);
  assert.equal(patchUrl.searchParams.get("currentDocument.exists"), "true");
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
    fields: {
      status: { stringValue: "verified" },
      xUserId: { stringValue: "2244994945" },
      xUsername: { nullValue: null },
      errorCode: { nullValue: null },
      updatedAtMs: { integerValue: "1000000" },
    },
  });
});

test("maps absent, oversized, and failed Firestore responses without exposing bodies", async () => {
  const missing = createXFlowRepository(env, {
    getAccessToken: async () => "token",
    fetcher: async () => new Response(null, { status: 404 }),
  });
  assert.equal(await missing.getFlow("abcdefghijklmnopqrstuvwx"), null);

  for (const fetcher of [
    async () => new Response("private-error", { status: 403 }),
    async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(64 * 1024 + 1) },
      }),
    async () => {
      throw new DOMException("private-timeout-detail", "TimeoutError");
    },
  ] as Array<typeof fetch>) {
    const repository = createXFlowRepository(env, {
      getAccessToken: async () => "token",
      fetcher,
    });
    await assert.rejects(
      repository.getFlow("abcdefghijklmnopqrstuvwx"),
      FirestoreFailure,
    );
  }
});
