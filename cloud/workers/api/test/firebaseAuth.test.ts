import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { verifyFirebaseRequest } from "../src/firebaseAuth.ts";

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = NOW_MS / 1_000;
const PROJECT_ID = "mons-link";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

function context() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        promises.push(promise);
      },
    },
    settle: () => Promise.all(promises),
  };
}

function request(token: string): Request {
  return new Request("https://api.mons.link/auth/methods", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function signingKey() {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: { ...publicJwk, alg: "RS256", kid: "firebase-key", use: "sig" },
  };
}

async function signToken(
  privateKey: CryptoKey,
  overrides: Record<string, unknown> = {},
  kid = "firebase-key",
  subject = "firebase-uid",
): Promise<string> {
  return new SignJWT({
    auth_time: NOW_SECONDS - 20,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(PROJECT_ID)
    .setSubject(subject)
    .setIssuedAt(NOW_SECONDS - 10)
    .setExpirationTime(NOW_SECONDS + 3_600)
    .sign(privateKey);
}

function jwksFetch(jwk: JWK, calls: { count: number }): typeof fetch {
  return async () => {
    calls.count++;
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": "application/json",
      },
    });
  };
}

test("verifies an exact Firebase ID token and returns only UID plus token", async () => {
  const { privateKey, publicJwk } = await signingKey();
  const token = await signToken(privateKey);
  const { ctx } = context();
  const identity = await verifyFirebaseRequest(request(token), ctx, {
    cache: null,
    fetcher: jwksFetch(publicJwk, { count: 0 }),
    now: () => NOW_MS,
  });
  assert.deepEqual(identity, { idToken: token, uid: "firebase-uid" });
});

test("rejects noncanonical and malformed Firebase UIDs", async () => {
  const { privateKey, publicJwk } = await signingKey();
  for (const uid of [
    "",
    " firebase-uid",
    "firebase-uid ",
    " ",
    "firebase/uid",
    "firebase.uid",
    "firebase#uid",
    "firebase$uid",
    "firebase[uid",
    "firebase]uid",
    "firebase\u0000uid",
    "firebase\ud800uid",
    "firebase\udc00uid",
  ]) {
    const token = await signToken(privateKey, {}, "firebase-key", uid);
    const { ctx } = context();
    await assert.rejects(
      verifyFirebaseRequest(request(token), ctx, {
        cache: null,
        fetcher: jwksFetch(publicJwk, { count: 0 }),
        now: () => NOW_MS,
      }),
      (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 401,
    );
  }
});

test("applies the Firebase UID UTF-16 length limit", async () => {
  const { privateKey, publicJwk } = await signingKey();
  const validUid = "😀".repeat(64);
  const validToken = await signToken(privateKey, {}, "firebase-key", validUid);
  const validContext = context();
  assert.deepEqual(
    await verifyFirebaseRequest(request(validToken), validContext.ctx, {
      cache: null,
      fetcher: jwksFetch(publicJwk, { count: 0 }),
      now: () => NOW_MS,
    }),
    { idToken: validToken, uid: validUid },
  );

  const invalidUid = "😀".repeat(65);
  const invalidToken = await signToken(
    privateKey,
    {},
    "firebase-key",
    invalidUid,
  );
  const invalidContext = context();
  await assert.rejects(
    verifyFirebaseRequest(request(invalidToken), invalidContext.ctx, {
      cache: null,
      fetcher: jwksFetch(publicJwk, { count: 0 }),
      now: () => NOW_MS,
    }),
    (error: unknown) =>
      error instanceof Error && "status" in error && error.status === 401,
  );
});

test("retains only a validated optional profile claim", async () => {
  const { privateKey, publicJwk } = await signingKey();
  const validToken = await signToken(privateKey, {
    profileId: " profile-1 ",
  });
  const invalidToken = await signToken(privateKey, {
    profileId: `profile-${"x".repeat(1_500)}`,
  });
  const validContext = context();
  assert.deepEqual(
    await verifyFirebaseRequest(request(validToken), validContext.ctx, {
      cache: null,
      fetcher: jwksFetch(publicJwk, { count: 0 }),
      now: () => NOW_MS,
    }),
    { idToken: validToken, uid: "firebase-uid", profileId: "profile-1" },
  );
  const invalidContext = context();
  assert.deepEqual(
    await verifyFirebaseRequest(request(invalidToken), invalidContext.ctx, {
      cache: null,
      fetcher: jwksFetch(publicJwk, { count: 0 }),
      now: () => NOW_MS,
    }),
    { idToken: invalidToken, uid: "firebase-uid" },
  );
});

test("rejects missing, malformed, oversized, invalid, and unknown-key tokens", async () => {
  const { privateKey, publicJwk } = await signingKey();
  const other = await signingKey();
  const wrongAlgorithm = await new SignJWT({
    auth_time: NOW_SECONDS - 20,
  })
    .setProtectedHeader({ alg: "HS256", kid: "firebase-key" })
    .setIssuer(ISSUER)
    .setAudience(PROJECT_ID)
    .setSubject("firebase-uid")
    .setIssuedAt(NOW_SECONDS - 10)
    .setExpirationTime(NOW_SECONDS + 3_600)
    .sign(new TextEncoder().encode("not-a-firebase-signing-secret"));
  const invalidTokens = [
    "",
    "malformed",
    "x".repeat(8 * 1024 + 1),
    await signToken(other.privateKey),
    await signToken(privateKey, {}, "unknown-key"),
    await signToken(privateKey, { auth_time: NOW_SECONDS + 30 }),
    await signToken(privateKey, { auth_time: undefined }),
    wrongAlgorithm,
  ];
  for (const token of invalidTokens) {
    const { ctx } = context();
    const input = token ? request(token) : new Request("https://api.mons.link");
    await assert.rejects(
      verifyFirebaseRequest(input, ctx, {
        cache: null,
        fetcher: jwksFetch(publicJwk, { count: 0 }),
        now: () => NOW_MS,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        error.status === 401 &&
        (!token || !error.message.includes(token)),
    );
  }
});

test("rejects expired, future-issued, wrong-issuer, and wrong-audience tokens", async () => {
  const { privateKey, publicJwk } = await signingKey();
  const tokens = [
    new SignJWT({ auth_time: NOW_SECONDS - 20 })
      .setProtectedHeader({ alg: "RS256", kid: "firebase-key" })
      .setIssuer(ISSUER)
      .setAudience(PROJECT_ID)
      .setSubject("firebase-uid")
      .setIssuedAt(NOW_SECONDS - 100)
      .setExpirationTime(NOW_SECONDS - 10)
      .sign(privateKey),
    new SignJWT({ auth_time: NOW_SECONDS - 20 })
      .setProtectedHeader({ alg: "RS256", kid: "firebase-key" })
      .setIssuer(ISSUER)
      .setAudience(PROJECT_ID)
      .setSubject("firebase-uid")
      .setIssuedAt(NOW_SECONDS + 30)
      .setExpirationTime(NOW_SECONDS + 3_600)
      .sign(privateKey),
    new SignJWT({ auth_time: NOW_SECONDS - 20 })
      .setProtectedHeader({ alg: "RS256", kid: "firebase-key" })
      .setIssuer("https://securetoken.google.com/other")
      .setAudience(PROJECT_ID)
      .setSubject("firebase-uid")
      .setIssuedAt(NOW_SECONDS - 10)
      .setExpirationTime(NOW_SECONDS + 3_600)
      .sign(privateKey),
    new SignJWT({ auth_time: NOW_SECONDS - 20 })
      .setProtectedHeader({ alg: "RS256", kid: "firebase-key" })
      .setIssuer(ISSUER)
      .setAudience("other")
      .setSubject("firebase-uid")
      .setIssuedAt(NOW_SECONDS - 10)
      .setExpirationTime(NOW_SECONDS + 3_600)
      .sign(privateKey),
  ];
  for (const tokenPromise of tokens) {
    const token = await tokenPromise;
    const { ctx } = context();
    await assert.rejects(
      verifyFirebaseRequest(request(token), ctx, {
        cache: null,
        fetcher: jwksFetch(publicJwk, { count: 0 }),
        now: () => NOW_MS,
      }),
      (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 401,
    );
  }
});

test("fails closed on JWKS errors and never exposes upstream bodies", async () => {
  const { privateKey } = await signingKey();
  const token = await signToken(privateKey);
  for (const fetcher of [
    async () => new Response("private-jwks-error", { status: 503 }),
    async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(64 * 1024 + 1) },
      }),
    async () => {
      throw new Error("private-network-error");
    },
  ] as Array<typeof fetch>) {
    const { ctx } = context();
    await assert.rejects(
      verifyFirebaseRequest(request(token), ctx, {
        cache: null,
        fetcher,
        now: () => NOW_MS,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        error.status === 503 &&
        !error.message.includes("private"),
    );
  }
});

test("reuses a bounded JWKS response through the Worker cache", async () => {
  const { privateKey, publicJwk } = await signingKey();
  const token = await signToken(privateKey);
  let stored: Response | undefined;
  const cache: Cache = {
    add: async () => undefined,
    addAll: async () => undefined,
    delete: async () => {
      stored = undefined;
      return true;
    },
    keys: async () => [],
    match: async () => stored?.clone(),
    matchAll: async () => (stored ? [stored.clone()] : []),
    put: async (_request: RequestInfo | URL, response: Response) => {
      stored = response.clone();
    },
  };
  const calls = { count: 0 };
  const fetcher = jwksFetch(publicJwk, calls);

  for (let index = 0; index < 2; index++) {
    const { ctx, settle } = context();
    await verifyFirebaseRequest(request(token), ctx, {
      cache,
      fetcher,
      now: () => NOW_MS,
    });
    await settle();
  }
  assert.equal(calls.count, 1);
  assert.ok(stored);
  assert.match(stored.headers.get("Cache-Control") || "", /max-age=3600/);
});

test("refreshes a stale cached JWKS when Firebase rotates to a new kid", async () => {
  const oldKey = await signingKey();
  const newKey = await signingKey();
  newKey.publicJwk.kid = "rotated-key";
  const token = await signToken(newKey.privateKey, {}, "rotated-key");
  let stored = new Response(JSON.stringify({ keys: [oldKey.publicJwk] }), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
      "X-Firebase-JWKS-Fetched-At": String(NOW_MS - 31_000),
    },
  });
  const cache: Cache = {
    add: async () => undefined,
    addAll: async () => undefined,
    delete: async () => true,
    keys: async () => [],
    match: async () => stored.clone(),
    matchAll: async () => [stored.clone()],
    put: async (_request, response) => {
      stored = response.clone();
    },
  };
  const calls = { count: 0 };
  const { ctx, settle } = context();
  const identity = await verifyFirebaseRequest(request(token), ctx, {
    cache,
    fetcher: jwksFetch(newKey.publicJwk, calls),
    now: () => NOW_MS,
  });
  await settle();
  assert.equal(identity.uid, "firebase-uid");
  assert.equal(calls.count, 1);
});
