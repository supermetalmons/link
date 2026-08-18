import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  getLinkedAuthMethodsViaApi,
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
  const responses = [
    {
      ok: true,
      intentId: "intent-id",
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
    "intent-id",
  );
  assert.equal(
    (await getLinkedAuthMethodsViaApi(tokenProvider)).profileId,
    "profile-1",
  );
  assert.equal(
    (
      await beginXRedirectAuthViaApi(
        {
          intentId: "intent-id",
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
      assert.deepEqual(error.customData, { details: { reason: "disabled" } });
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
        headers: { "Content-Length": String(64 * 1024 + 1) },
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

test("connection keeps migrated auth callable names off Firebase", () => {
  const source = readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  );
  for (const name of [
    "beginAuthIntent",
    "beginXRedirectAuth",
    "getLinkedAuthMethods",
  ]) {
    assert.doesNotMatch(source, new RegExp(`httpsCallable\\([^)]*${name}`));
    assert.doesNotMatch(source, new RegExp(`\"${name}\"`));
  }
  assert.match(source, /httpsCallable\(/);
});
