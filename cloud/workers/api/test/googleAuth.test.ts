import assert from "node:assert/strict";
import test from "node:test";
import {
  createGoogleAccessToken,
  createServiceAccountAssertion,
  GoogleAuthFailure,
} from "../test/legacyGoogleAuth.ts";

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}

function privateKeyPem(bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

async function generateKeyPair() {
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

test("creates a signed service-account assertion for explicit scopes", async () => {
  const { privateKeyPem: pem, publicKey } = await generateKeyPair();
  const assertion = await createServiceAccountAssertion({
    email: "identity@example.iam.gserviceaccount.com",
    privateKeyPem: pem,
    nowMs: 1_700_000_000_000,
    scopes: ["scope:first", "scope:second"],
  });
  const parts = assertion.split(".");
  assert.equal(parts.length, 3);
  assert.deepEqual(
    JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    {
      iss: "identity@example.iam.gserviceaccount.com",
      scope: "scope:first scope:second",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    },
  );
  assert.equal(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      exactArrayBuffer(new Uint8Array(Buffer.from(parts[2], "base64url"))),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    ),
    true,
  );
});

test("exchanges an assertion using explicit service-account credentials", async () => {
  const { privateKeyPem: pem } = await generateKeyPair();
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const accessToken = await createGoogleAccessToken({
    credentials: {
      email: "gameplay@example.iam.gserviceaccount.com",
      privateKeyPem: pem,
    },
    fetcher: async (input, init) => {
      requests.push({ input, init });
      return Response.json({ access_token: "google-access-token" });
    },
    now: () => 1_700_000_000_000,
    scopes: ["scope:test"],
  });
  assert.equal(accessToken, "google-access-token");
  assert.equal(requests.length, 1);
  assert.equal(
    String(requests[0].input),
    "https://oauth2.googleapis.com/token",
  );
  assert.equal(requests[0].init?.method, "POST");
  assert.ok(requests[0].init?.signal instanceof AbortSignal);
  const assertion = new URLSearchParams(String(requests[0].init?.body)).get(
    "assertion",
  )!;
  const claims = JSON.parse(
    Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"),
  );
  assert.equal(claims.iss, "gameplay@example.iam.gserviceaccount.com");
  assert.equal(claims.scope, "scope:test");
});

test("fails closed for malformed credentials and rejected exchanges", async () => {
  await assert.rejects(
    createServiceAccountAssertion({
      email: "identity@example.iam.gserviceaccount.com",
      privateKeyPem: "not-a-private-key",
      nowMs: Date.now(),
      scopes: ["scope:test"],
    }),
    GoogleAuthFailure,
  );
  const { privateKeyPem: pem } = await generateKeyPair();
  await assert.rejects(
    createServiceAccountAssertion({
      email: "identity@example.iam.gserviceaccount.com",
      privateKeyPem: pem,
      nowMs: Date.now(),
      scopes: [],
    }),
    GoogleAuthFailure,
  );
  await assert.rejects(
    createGoogleAccessToken({
      credentials: {
        email: "gameplay@example.iam.gserviceaccount.com",
        privateKeyPem: pem,
      },
      fetcher: async () => new Response("denied", { status: 403 }),
      scopes: ["scope:test"],
    }),
    GoogleAuthFailure,
  );
});
