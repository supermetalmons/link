import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  AuthApiError,
  beginAuthIntentViaApi,
  beginXRedirectAuthViaApi,
  bindAuthSessionResult,
  completeXRedirectAuthViaApi,
  createUserBoundAuthTokenProvider,
  getLinkedAuthMethodsViaApi,
  syncProfileClaimViaApi,
  unlinkAuthMethodViaApi,
  verifyAppleTokenViaApi,
  verifyEthereumAddressViaApi,
  verifySolanaAddressViaApi,
} = await import("../src/services/authApi.ts");

const originalFetch = globalThis.fetch;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("auth API clients send exact bearer requests and validate responses", async () => {
  const calls = [];
  const intentId = "abcdefghijklmnopqrstuvwx";
  const responses = [
    {
      ok: true,
      intentId,
      nonce: "nonce",
      state: "state",
      expiresAtMs: 1_300_000,
    },
    {
      ok: true,
      profileId: "profile-1",
      linkedMethods: { apple: true, eth: false, sol: true, x: false },
      appleLinked: true,
    },
    {
      ok: true,
      profileId: "profile-1",
      linkedMethods: { apple: true, eth: false, sol: true, x: false },
      appleLinked: true,
    },
    {
      ok: true,
      flowId: "flow-id",
      authUrl: "https://x.com/i/oauth2/authorize",
      expiresAtMs: 1_600_000,
    },
  ];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(responses.shift());
  };
  const tokenProvider = async (forceRefresh) =>
    forceRefresh ? "fresh-token" : "firebase-token";

  assert.equal(
    (await beginAuthIntentViaApi("eth", tokenProvider)).intentId,
    intentId,
  );
  assert.equal(
    (await getLinkedAuthMethodsViaApi(tokenProvider)).profileId,
    "profile-1",
  );
  assert.equal(
    (await syncProfileClaimViaApi(tokenProvider)).profileId,
    "profile-1",
  );
  assert.equal(
    (
      await beginXRedirectAuthViaApi(
        {
          intentId,
          consentSource: "settings",
          returnUrl: "https://mons.link/settings",
        },
        tokenProvider,
      )
    ).flowId,
    "flow-id",
  );

  assert.deepEqual(
    calls.map((call) => [call.input, call.init.method]),
    [
      ["https://api.mons.link/auth/intents", "POST"],
      ["https://api.mons.link/auth/methods", "GET"],
      ["https://api.mons.link/auth/profile-claim/sync", "POST"],
      ["https://api.mons.link/auth/x/flows", "POST"],
    ],
  );
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("Authorization"), "Bearer firebase-token");
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.equal(new Headers(calls[1].init.headers).get("Content-Type"), null);
  assert.deepEqual(JSON.parse(calls[0].init.body), { method: "eth" });
  assert.deepEqual(JSON.parse(calls[2].init.body), {});
});

test("auth mutation clients use exact Worker routes and preserve typed responses", async () => {
  const calls = [];
  const profile = {
    ok: true,
    uid: "login-1",
    profileId: "profile-1",
    username: "Mons123",
    emoji: 1,
    linkedMethods: { apple: true, eth: true, sol: true, x: true },
    appleLinked: true,
    profileMons: "x".repeat(70 * 1024),
    opId: "operation-1",
  };
  const responses = [
    profile,
    profile,
    profile,
    profile,
    {
      ok: true,
      profileId: "profile-1",
      linkedMethods: { apple: false, eth: true, sol: true, x: true },
      appleLinked: false,
    },
  ];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(responses.shift());
  };
  const token = async () => "firebase-token";
  await verifySolanaAddressViaApi(
    {
      intentId: "intent-sol",
      address: "11111111111111111111111111111111",
      signature: "signature",
      emoji: 1,
      aura: "",
    },
    token,
  );
  await verifyEthereumAddressViaApi(
    {
      intentId: "intent-eth",
      message: "message",
      signature: "signature",
      emoji: 1,
      aura: null,
    },
    token,
  );
  await verifyAppleTokenViaApi(
    {
      intentId: "intent-apple",
      idToken: "apple-token",
      consentSource: "signin",
      emoji: 1,
      aura: "",
    },
    token,
  );
  await completeXRedirectAuthViaApi(
    { flowId: "flow-1", emoji: 1, aura: "" },
    token,
  );
  await unlinkAuthMethodViaApi("apple", token);
  assert.deepEqual(
    calls.map((call) => call.input),
    [
      "https://api.mons.link/auth/methods/sol/verify",
      "https://api.mons.link/auth/methods/eth/verify",
      "https://api.mons.link/auth/methods/apple/verify",
      "https://api.mons.link/auth/x/flows/complete",
      "https://api.mons.link/auth/methods/unlink",
    ],
  );
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(
      new Headers(call.init.headers).get("Authorization"),
      "Bearer firebase-token",
    );
  }
  const unlinkBody = JSON.parse(calls[4].init.body);
  assert.equal(unlinkBody.method, "apple");
  assert.match(unlinkBody.opId, /^[0-9a-f-]{36}$/);
});

test("retries exactly once with a forced token refresh after 401", async () => {
  const refreshes = [];
  const tokens = [];
  globalThis.fetch = async (_input, init) => {
    tokens.push(new Headers(init.headers).get("Authorization"));
    if (tokens.length === 1) {
      return jsonResponse(
        {
          ok: false,
          error: "unauthenticated",
          message: "authentication-required",
        },
        401,
      );
    }
    return jsonResponse({
      ok: true,
      profileId: null,
      linkedMethods: { apple: false, eth: false, sol: false, x: false },
      appleLinked: false,
    });
  };
  const response = await getLinkedAuthMethodsViaApi(async (forceRefresh) => {
    refreshes.push(forceRefresh);
    return forceRefresh ? "fresh-token" : "stale-token";
  });
  assert.equal(response.profileId, null);
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(tokens, ["Bearer stale-token", "Bearer fresh-token"]);
});

test("keeps one unlink operation ID across a forced token refresh", async () => {
  const bodies = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return jsonResponse(
        {
          ok: false,
          error: "unauthenticated",
          message: "authentication-required",
        },
        401,
      );
    }
    return jsonResponse({
      ok: true,
      profileId: "profile-1",
      linkedMethods: { apple: false, eth: true, sol: false, x: false },
      appleLinked: false,
    });
  };
  await unlinkAuthMethodViaApi("apple", async (refresh) =>
    refresh ? "fresh" : "stale",
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].opId, bodies[1].opId);
  assert.match(bodies[0].opId, /^[0-9a-f-]{36}$/);
});

test("does not retry unlink after the authenticated user changes", async () => {
  const tokenRequests = [];
  const userA = {
    uid: "user-a",
    async getIdToken(forceRefresh) {
      tokenRequests.push([this.uid, forceRefresh]);
      return "user-a-token";
    },
  };
  const userB = {
    uid: "user-b",
    async getIdToken(forceRefresh) {
      tokenRequests.push([this.uid, forceRefresh]);
      return "user-b-token";
    },
  };
  let currentUser = userA;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    currentUser = userB;
    return jsonResponse(
      {
        ok: false,
        error: "unauthenticated",
        message: "authentication-required",
      },
      401,
    );
  };

  await assert.rejects(
    unlinkAuthMethodViaApi(
      "apple",
      createUserBoundAuthTokenProvider(userA, () => currentUser),
    ),
    (error) =>
      error instanceof AuthApiError &&
      error.code === "unauthenticated" &&
      error.message === "authentication-changed",
  );
  assert.equal(requests, 1);
  assert.deepEqual(tokenRequests, [["user-a", false]]);
});

test("does not send unlink after the user changes during token acquisition", async () => {
  let resolveToken;
  const token = new Promise((resolve) => {
    resolveToken = resolve;
  });
  const userA = {
    uid: "user-a",
    getIdToken() {
      return token;
    },
  };
  const userB = {
    uid: "user-b",
    async getIdToken() {
      return "user-b-token";
    },
  };
  let currentUser = userA;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return jsonResponse({
      ok: true,
      profileId: "profile-a",
      linkedMethods: { apple: false, eth: true, sol: false, x: false },
      appleLinked: false,
    });
  };

  const unlink = unlinkAuthMethodViaApi(
    "apple",
    createUserBoundAuthTokenProvider(userA, () => currentUser),
  );
  currentUser = userB;
  resolveToken("user-a-token");

  await assert.rejects(
    unlink,
    (error) =>
      error instanceof AuthApiError &&
      error.code === "unauthenticated" &&
      error.message === "authentication-changed",
  );
  assert.equal(requests, 0);
});

test("rechecks the user in the microtask between token acquisition and fetch", async () => {
  let resolveToken;
  const token = new Promise((resolve) => {
    resolveToken = resolve;
  });
  const userA = {
    uid: "user-a",
    getIdToken() {
      return token;
    },
  };
  const userB = {
    uid: "user-b",
    async getIdToken() {
      return "user-b-token";
    },
  };
  let currentUser = userA;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return jsonResponse({
      ok: true,
      profileId: "profile-a",
      linkedMethods: { apple: false, eth: true, sol: false, x: false },
      appleLinked: false,
    });
  };

  const unlink = unlinkAuthMethodViaApi(
    "apple",
    createUserBoundAuthTokenProvider(userA, () => currentUser),
  );
  resolveToken("user-a-token");
  queueMicrotask(() => {
    currentUser = userB;
  });

  await assert.rejects(
    unlink,
    (error) =>
      error instanceof AuthApiError &&
      error.code === "unauthenticated" &&
      error.message === "authentication-changed",
  );
  assert.equal(requests, 0);
});

test("rejects a successful unlink response after the user changes", async () => {
  let resolveResponse;
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => {
    markRequestStarted = resolve;
  });
  const userA = {
    uid: "user-a",
    async getIdToken() {
      return "user-a-token";
    },
  };
  const userB = {
    uid: "user-b",
    async getIdToken() {
      return "user-b-token";
    },
  };
  let currentUser = userA;
  globalThis.fetch = async () => {
    markRequestStarted();
    return response;
  };

  const unlink = unlinkAuthMethodViaApi(
    "apple",
    createUserBoundAuthTokenProvider(userA, () => currentUser),
  );
  await requestStarted;
  currentUser = userB;
  resolveResponse(
    jsonResponse({
      ok: true,
      profileId: "profile-a",
      linkedMethods: { apple: false, eth: true, sol: false, x: false },
      appleLinked: false,
    }),
  );

  await assert.rejects(
    unlink,
    (error) =>
      error instanceof AuthApiError &&
      error.code === "unauthenticated" &&
      error.message === "authentication-changed",
  );
});

test("session-bound results reject an auth change before caller mutations", async () => {
  let resolveResponse;
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const userA = {
    uid: "user-a",
    async getIdToken() {
      return "user-a-token";
    },
  };
  const userB = {
    uid: "user-b",
    async getIdToken() {
      return "user-b-token";
    },
  };
  let currentUser = userA;
  const tokenProvider = createUserBoundAuthTokenProvider(
    userA,
    () => currentUser,
  );
  const connectionUnlink = async () => {
    const result = await response;
    return bindAuthSessionResult(result, tokenProvider.assertCurrentUser);
  };
  let mutations = 0;
  const disconnect = (async () => {
    const result = (await connectionUnlink()).read();
    mutations++;
    return result;
  })();

  resolveResponse({ ok: true });
  queueMicrotask(() => {
    currentUser = userB;
  });

  await assert.rejects(
    disconnect,
    (error) =>
      error instanceof AuthApiError &&
      error.code === "unauthenticated" &&
      error.message === "authentication-changed",
  );
  assert.equal(mutations, 0);
});

test("does not wait for a stalled 401 body cancellation", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    if (requests === 1) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
          },
          cancel() {
            return new Promise(() => undefined);
          },
        }),
        { status: 401 },
      );
    }
    return jsonResponse({
      ok: true,
      profileId: null,
      linkedMethods: { apple: false, eth: false, sol: false, x: false },
      appleLinked: false,
    });
  };
  const response = await getLinkedAuthMethodsViaApi(async (refresh) =>
    refresh ? "fresh" : "stale",
  );
  assert.equal(response.profileId, null);
  assert.equal(requests, 2);
});

test("applies the request deadline to Firebase token acquisition", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) =>
    originalSetTimeout(callback, 0, ...args);
  try {
    await assert.rejects(
      getLinkedAuthMethodsViaApi(() => new Promise(() => undefined)),
      (error) =>
        error instanceof AuthApiError &&
        error.code === "unavailable" &&
        error.message === "Auth request timed out.",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("allows profile claim synchronization a longer request deadline", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(callback, 60_000, ...args);
  };
  globalThis.fetch = async () =>
    jsonResponse({
      ok: true,
      profileId: "profile-1",
      linkedMethods: { apple: false, eth: false, sol: true, x: false },
      appleLinked: false,
    });
  try {
    await getLinkedAuthMethodsViaApi(async () => "token");
    await syncProfileClaimViaApi(async () => "token");
    assert.deepEqual(delays, [15_000, 30_000]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("maps server errors without retrying writes and preserves details", async () => {
  let fetches = 0;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    fetches++;
    return jsonResponse(
      {
        ok: false,
        error: "failed-precondition",
        message: "x-auth-disabled",
        details: { reason: "disabled" },
      },
      409,
    );
  };
  await assert.rejects(
    beginXRedirectAuthViaApi({ intentId: "intent-id" }, async () => {
      tokenCalls++;
      return "token";
    }),
    (error) => {
      assert.ok(error instanceof AuthApiError);
      assert.equal(error.code, "failed-precondition");
      assert.equal(error.message, "x-auth-disabled");
      assert.deepEqual(error.details, { reason: "disabled" });
      return true;
    },
  );
  assert.equal(fetches, 1);
  assert.equal(tokenCalls, 1);
});

test("rejects malformed, oversized, and transport-failed responses safely", async () => {
  const cases = [
    async () => jsonResponse({ ok: true }),
    async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(8 * 1024 * 1024 + 1) },
      }),
    async () => {
      throw new Error("private-network-detail");
    },
  ];
  for (const fetcher of cases) {
    globalThis.fetch = fetcher;
    await assert.rejects(
      beginAuthIntentViaApi("sol", async () => "token"),
      (error) =>
        error instanceof AuthApiError &&
        error.code === "unavailable" &&
        !error.message.includes("private"),
    );
  }
});
