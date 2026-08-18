"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const firebaseAdmin = require("../functions/firebaseAdmin");
const authIdentity = require("../functions/authIdentity");
const appleToken = require("../functions/auth/appleToken");
const authOperations = require("../functions/auth/authOperations");
const identityService = require("../functions/auth/identityService");
const policy = require("../functions/auth/policy");
const siwe = require("../functions/auth/siwe");
const sharedAuth = require("../functions/shared/auth");

const withFirestore = async (firestore, callback) => {
  const originalFirestore = firebaseAdmin.firestore;
  firebaseAdmin.firestore = firestore;
  try {
    return await callback();
  } finally {
    firebaseAdmin.firestore = originalFirestore;
  }
};

const withEnvironment = async (updates, callback) => {
  const originalValues = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  );
  Object.entries(updates).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  try {
    return await callback();
  } finally {
    Object.entries(originalValues).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
};

const assertHttpsError = (callback, code, message) => {
  assert.throws(
    callback,
    (error) => error.code === code && error.message.includes(message),
  );
};

test("authIdentity remains the exact compatibility façade", () => {
  assert.deepEqual(Object.keys(authIdentity), [
    "consumeAuthIntent",
    "normalizeMethodValue",
    "linkVerifiedMethod",
    "peekAuthOpReplay",
    "unlinkMethodForUid",
    "syncProfileClaimForUid",
    "verifyAppleIdToken",
    "validateSiweDomainAndUri",
  ]);
  assert.strictEqual(
    authIdentity.consumeAuthIntent,
    identityService.consumeAuthIntent,
  );
  assert.strictEqual(
    authIdentity.linkVerifiedMethod,
    identityService.linkVerifiedMethod,
  );
  assert.strictEqual(
    authIdentity.peekAuthOpReplay,
    identityService.peekAuthOpReplay,
  );
  assert.strictEqual(
    authIdentity.unlinkMethodForUid,
    identityService.unlinkMethodForUid,
  );
  assert.strictEqual(
    authIdentity.syncProfileClaimForUid,
    identityService.syncProfileClaimForUid,
  );
  assert.strictEqual(
    authIdentity.normalizeMethodValue,
    policy.normalizeMethodValue,
  );
  assert.strictEqual(
    authIdentity.verifyAppleIdToken,
    appleToken.verifyAppleIdToken,
  );
  assert.strictEqual(
    authIdentity.validateSiweDomainAndUri,
    siwe.validateSiweDomainAndUri,
  );
});

test("auth method policy preserves normalization and profile detection", () => {
  const eth = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const sol = "12345678901234567890";

  assert.equal(policy.assertSupportedMethod(" ETH "), "eth");
  assert.equal(policy.normalizeMethodValue("eth", eth), eth.toLowerCase());
  assert.equal(policy.normalizeMethodValue("sol", ` ${sol} `), sol);
  assert.equal(
    policy.normalizeMethodValue("apple", " apple-sub "),
    "apple-sub",
  );
  assert.equal(policy.normalizeMethodValue("x", " 12345 "), "12345");
  assertHttpsError(
    () => policy.normalizeMethodValue("eth", "0x123"),
    "invalid-argument",
    "Invalid Ethereum address.",
  );
  assertHttpsError(
    () => policy.normalizeMethodValue("sol", "short"),
    "invalid-argument",
    "Invalid Solana address.",
  );
  assertHttpsError(
    () => policy.normalizeMethodValue("apple", "short"),
    "invalid-argument",
    "Invalid Apple subject.",
  );
  assertHttpsError(
    () => policy.normalizeMethodValue("x", "x-user"),
    "invalid-argument",
    "Invalid X user id.",
  );
  assertHttpsError(
    () => policy.normalizeMethodValue("unknown", "value"),
    "invalid-argument",
    "Unsupported auth method.",
  );

  assert.deepEqual(
    policy.linkedMethodsFromProfileData({
      appleSub: "apple-sub",
      eth,
      sol: "invalid",
      xUserId: "42",
    }),
    { apple: true, eth: true, sol: false, x: true },
  );
  assert.equal(
    policy.linkedMethodCount({ appleSub: "apple-sub", eth, xUserId: "42" }),
    3,
  );
  assert.equal(policy.getMethodField("apple"), "appleSub");
  assert.equal(
    policy.getMethodKey("x", "42"),
    `x:${Buffer.from("42").toString("base64url")}`,
  );
  assert.equal(
    policy.hashMethodValue("x", "42"),
    crypto.createHash("sha256").update("x:42").digest("hex"),
  );
});

test("shared linked-method projection preserves every boolean combination", () => {
  for (let mask = 0; mask < 16; mask += 1) {
    assert.deepEqual(
      sharedAuth.getLinkedAuthMethodsFromProfile({
        appleSub: mask & 1 ? "apple-sub" : "short",
        eth:
          mask & 2 ? "0x1111111111111111111111111111111111111111" : "invalid",
        sol: mask & 4 ? "11111111111111111111" : "short",
        xUserId: mask & 8 ? "2244994945" : "not-numeric",
      }),
      {
        apple: !!(mask & 1),
        eth: !!(mask & 2),
        sol: !!(mask & 4),
        x: !!(mask & 8),
      },
    );
  }
});

test("cooldown policy preserves legacy timestamp precedence and details", () => {
  assert.equal(
    policy.parseCooldownRetryAtMs({
      retryAtMs: 500,
      expiresAtMs: 400,
      startedAtMs: 300,
    }),
    500,
  );
  assert.equal(policy.parseCooldownRetryAtMs({ expiresAtMs: 400 }), 400);
  assert.equal(
    policy.parseCooldownRetryAtMs(
      { createdAtMs: 100, revokedAtMs: 200, cooldownMs: 50 },
      10,
    ),
    250,
  );
  assert.equal(policy.parseCooldownRetryAtMs({}, 100), 0);
  assert.equal(
    policy.getProfileMethodCooldownDocId(" profile ", "X"),
    "profile:x",
  );
  assert.deepEqual(
    policy.buildMethodReuseCooldownDetails({ method: "eth", retryAtMs: -1 }),
    {
      reason: "method-reuse-cooldown",
      scope: "method",
      method: "eth",
      retryAtMs: 0,
      cooldownMs: 86400000,
    },
  );
  assert.deepEqual(
    policy.buildProfileMethodCooldownDetails({
      method: "sol",
      profileId: " profile ",
      retryAtMs: "123",
    }),
    {
      reason: "profile-method-cooldown",
      scope: "profile-method",
      method: "sol",
      retryAtMs: 123,
      cooldownMs: 86400000,
      profileId: "profile",
    },
  );
  assert.throws(
    () => policy.throwMethodReuseCooldownError({ method: "x", retryAtMs: 10 }),
    (error) =>
      error.code === "failed-precondition" &&
      error.message.includes("method-reuse-cooldown") &&
      error.details.retryAtMs === 10,
  );
});

test("feature flags and generated auth tokens retain accepted forms", async () => {
  await withEnvironment({ AUTH_TEST_FLAG: " yes " }, async () =>
    assert.equal(policy.isFeatureDisabled("AUTH_TEST_FLAG"), true),
  );
  await withEnvironment({ AUTH_TEST_FLAG: "off" }, async () =>
    assert.equal(policy.isFeatureDisabled("AUTH_TEST_FLAG"), false),
  );

  assert.match(policy.createOpId(), /^[a-f0-9]{32}$/);
  assert.match(policy.createToken(18), /^[A-Za-z0-9_-]{24}$/);
  assert.match(policy.createSiweNonce(8), /^[A-Za-z0-9]{8}$/);
  assert.match(policy.createSiweNonce(3), /^[A-Za-z0-9]{24}$/);
});

test("auth operation helpers preserve context and replay policies", async () => {
  const nowMs = 1_000_000;
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    assert.equal(
      authOperations.getAuthOpContextState(
        {},
        {
          opId: "op",
          kind: "verify",
          method: "eth",
          uid: "uid",
        },
      ),
      "missing",
    );
    assert.equal(
      authOperations.getAuthOpContextState(
        { uid: "uid", kind: "verify", method: "eth" },
        { opId: "op", kind: "verify", method: "eth", uid: "uid" },
      ),
      "match",
    );
    const replay = { ok: true, profileId: "profile" };
    assert.strictEqual(
      authOperations.getReplayResultFromAuthOpData({
        status: "success",
        result: replay,
        updatedAtMs: nowMs - 600_000,
      }),
      replay,
    );
    assert.equal(
      authOperations.getReplayResultFromAuthOpData({
        status: "success",
        result: replay,
        updatedAtMs: nowMs - 600_001,
      }),
      null,
    );
    assert.equal(
      authOperations.getReplayResultFromAuthOpData({
        status: "failed",
        result: replay,
        updatedAtMs: nowMs,
      }),
      null,
    );
  } finally {
    Date.now = originalDateNow;
  }

  const explicitHash = "a".repeat(64);
  assert.equal(
    authOperations.getExpectedMethodValueHashFromAuthOp("apple", {
      meta: { methodValueHash: explicitHash, methodValue: "redacted" },
    }),
    explicitHash,
  );
  assert.equal(
    authOperations.getExpectedMethodValueHashFromAuthOp("apple", {
      meta: { methodValue: "redacted" },
    }),
    "",
  );
  const eth = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(
    authOperations.getExpectedMethodValueHashFromAuthOp("eth", {
      meta: { methodValue: eth },
    }),
    policy.hashMethodValue("eth", eth.toLowerCase()),
  );
  assert.throws(
    () => authOperations.createAuthOperations({}),
    /isVerifyReplayStillValid is required/,
  );
});

test("operation replay delegates verify freshness without changing other kinds", async () => {
  const replay = { ok: true, profileId: "profile" };
  const opData = {
    uid: "uid",
    kind: "verify",
    method: "eth",
    status: "success",
    result: replay,
    updatedAtMs: Date.now(),
  };
  const firestore = () => ({
    collection: (name) => {
      assert.equal(name, "authOps");
      return {
        doc: (opId) => {
          assert.equal(opId, "op-id");
          return {
            get: async () => ({
              exists: true,
              data: () => opData,
            }),
          };
        },
      };
    },
  });
  let validationCalls = 0;
  const operations = authOperations.createAuthOperations({
    isVerifyReplayStillValid: async (options) => {
      validationCalls += 1;
      assert.strictEqual(options.replay, replay);
      return true;
    },
  });

  assert.strictEqual(
    await withFirestore(firestore, () =>
      operations.peekAuthOpReplay({
        opId: "op-id",
        kind: "verify",
        method: "eth",
        uid: "uid",
      }),
    ),
    replay,
  );
  assert.equal(validationCalls, 1);
  assert.equal(
    await operations.peekAuthOpReplay({
      opId: "",
      kind: "verify",
      method: "eth",
      uid: "uid",
    }),
    null,
  );
});

test("rate limiting preserves keying, window resets, and the maximum count", async () => {
  const nowMs = 2_000_000;
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  const writes = [];
  const ip = "203.0.113.9";
  const ipHash = crypto
    .createHash("sha256")
    .update(ip)
    .digest("hex")
    .slice(0, 12);
  const createFirestore = (data) => () => ({
    collection: (name) => {
      assert.equal(name, "authRateLimits");
      return {
        doc: (key) => {
          assert.equal(key, `verify-eth:uid:${ipHash}`);
          return { path: `authRateLimits/${key}` };
        },
      };
    },
    runTransaction: async (callback) =>
      callback({
        get: async () => ({ exists: true, data: () => data }),
        set: (...args) => writes.push(args),
      }),
  });

  try {
    await withFirestore(
      createFirestore({ windowStartedAtMs: nowMs - 60_001, count: 20 }),
      () =>
        authOperations.enforceRateLimit({
          uid: "uid",
          method: "verify-eth",
          request: { rawRequest: { ip } },
        }),
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1].count, 1);
    assert.equal(writes[0][1].windowStartedAtMs, nowMs);

    await assert.rejects(
      withFirestore(
        createFirestore({ windowStartedAtMs: nowMs, count: 20 }),
        () =>
          authOperations.enforceRateLimit({
            uid: "uid",
            method: "verify-eth",
            request: { rawRequest: { ip } },
          }),
      ),
      (error) =>
        error.code === "resource-exhausted" &&
        error.message.includes("Too many auth attempts."),
    );
    assert.equal(writes.length, 1);
  } finally {
    Date.now = originalDateNow;
  }
});

test("Apple token provider preserves audiences, nonce forms, signature checks, and caching", async () => {
  assert.equal(appleToken.maskEmail("invalid"), null);
  assert.equal(appleToken.maskEmail("@example.com"), "***@example.com");
  assert.equal(appleToken.maskEmail("a@example.com"), "a***@example.com");
  assert.equal(appleToken.maskEmail("alice@example.com"), "a***e@example.com");
  assert.deepEqual(
    [...appleToken.buildNonceHashes("nonce")],
    [
      "nonce",
      crypto.createHash("sha256").update("nonce").digest("hex"),
      crypto.createHash("sha256").update("nonce").digest("base64url"),
    ],
  );
  assertHttpsError(
    () => appleToken.readJwt("invalid"),
    "invalid-argument",
    "Invalid JWT format.",
  );

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const keyId = "apple-test-key";
  const publicJwk = {
    ...publicKey.export({ format: "jwk" }),
    alg: "RS256",
    kid: keyId,
    use: "sig",
  };
  const nonce = "expected-nonce";
  const nonceHash = crypto.createHash("sha256").update(nonce).digest("hex");
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: keyId }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "mons.link.test",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: nonceHash,
      sub: "apple-subject",
      email: "alice@example.com",
      email_verified: "true",
    }),
  ).toString("base64url");
  const signedContent = `${header}.${payload}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signedContent), privateKey)
    .toString("base64url");
  const idToken = `${signedContent}.${signature}`;
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async (url) => {
    fetchCalls += 1;
    assert.equal(url, "https://appleid.apple.com/auth/keys");
    return {
      ok: true,
      json: async () => ({ keys: [publicJwk] }),
    };
  };

  try {
    await withEnvironment(
      {
        APPLE_AUDIENCES: " other, mons.link.test ",
        APPLE_CLIENT_ID: undefined,
      },
      async () => {
        assert.deepEqual(appleToken.getAppleAudiences(), [
          "other",
          "mons.link.test",
        ]);
        assert.deepEqual(
          await appleToken.verifyAppleIdToken({
            idToken,
            expectedNonce: nonce,
          }),
          {
            sub: "apple-subject",
            emailMasked: "a***e@example.com",
            emailVerified: true,
          },
        );
        await appleToken.verifyAppleIdToken({ idToken, expectedNonce: nonce });
        await assert.rejects(
          appleToken.verifyAppleIdToken({
            idToken,
            expectedNonce: "wrong-nonce",
          }),
          /apple-nonce-mismatch/,
        );
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 1);
});

test("SIWE validation preserves default, configured, and port-aware domains", async () => {
  await withEnvironment({ SIWE_ALLOWED_DOMAINS: undefined }, async () => {
    assert.deepEqual(siwe.getAllowedSiweDomains(), [
      "mons.link",
      "www.mons.link",
      "localhost",
      "127.0.0.1",
    ]);
    assert.doesNotThrow(() =>
      siwe.validateSiweDomainAndUri({
        domain: "localhost:5173",
        uri: "http://localhost:5173/sign-in",
      }),
    );
    assertHttpsError(
      () =>
        siwe.validateSiweDomainAndUri({
          domain: "example.com",
          uri: "https://example.com",
        }),
      "permission-denied",
      "siwe-domain-not-allowed",
    );
  });

  await withEnvironment(
    { SIWE_ALLOWED_DOMAINS: " AUTH.EXAMPLE,api.example " },
    async () => {
      assert.deepEqual(siwe.getAllowedSiweDomains(), [
        "auth.example",
        "api.example",
      ]);
      assert.doesNotThrow(() =>
        siwe.validateSiweDomainAndUri({
          domain: "AUTH.EXAMPLE",
          uri: "https://api.example/path",
        }),
      );
      assertHttpsError(
        () =>
          siwe.validateSiweDomainAndUri({
            domain: "auth.example",
            uri: "https://other.example/path",
          }),
        "permission-denied",
        "siwe-uri-not-allowed",
      );
    },
  );
});
