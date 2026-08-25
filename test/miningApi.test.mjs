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

const { MiningApiError, mineRockViaApi } =
  await import("../src/services/miningApi.ts");

const originalFetch = globalThis.fetch;
const request = {
  date: "2026-08-18",
  materials: { dust: 1, slime: 0, gum: 0, metal: 0, ice: 0 },
};
const success = {
  ok: true,
  mining: {
    lastRockDate: "2026-08-18",
    materials: { dust: 1, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("sends the exact authenticated mining request and validates responses", async () => {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(success);
  };

  assert.deepEqual(
    await mineRockViaApi(request, async () => "firebase-token"),
    success,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://api.mons.link/mining/rock");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.cache, "no-store");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Authorization"), "Bearer firebase-token");
  assert.equal(headers.get("Content-Type"), "application/json");

  globalThis.fetch = async () =>
    jsonResponse({ ok: false, reason: "date-not-advanced" });
  assert.deepEqual(
    await mineRockViaApi(request, async () => "firebase-token"),
    { ok: false, reason: "date-not-advanced" },
  );
});

test("refreshes the Firebase token exactly once after a 401", async () => {
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
    return jsonResponse(success);
  };
  assert.deepEqual(
    await mineRockViaApi(request, async (forceRefresh) => {
      refreshes.push(forceRefresh);
      return forceRefresh ? "fresh-token" : "stale-token";
    }),
    success,
  );
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(tokens, ["Bearer stale-token", "Bearer fresh-token"]);
});

test("does not retry mutations after non-authentication failures", async () => {
  let fetches = 0;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    fetches++;
    return jsonResponse(
      {
        ok: false,
        error: "unavailable",
        message: "mining-service-unavailable",
      },
      503,
    );
  };
  await assert.rejects(
    mineRockViaApi(request, async () => {
      tokenCalls++;
      return "token";
    }),
    (error) =>
      error instanceof MiningApiError &&
      error.code === "unavailable" &&
      error.message === "mining-service-unavailable",
  );
  assert.equal(fetches, 1);
  assert.equal(tokenCalls, 1);

  globalThis.fetch = async () => {
    fetches++;
    throw new Error("private-network-detail");
  };
  await assert.rejects(
    mineRockViaApi(request, async () => "token"),
    (error) =>
      error instanceof MiningApiError &&
      error.message === "Mining service is unavailable." &&
      !error.message.includes("private"),
  );
  assert.equal(fetches, 2);
});

test("rejects malformed and oversized responses", async () => {
  const responses = [
    jsonResponse({ ok: true }),
    jsonResponse({ ok: false, reason: "unknown" }),
    new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(64 * 1024 + 1) },
    }),
    new Response("{"),
  ];
  globalThis.fetch = async () => responses.shift();
  for (let index = 0; index < 4; index++) {
    await assert.rejects(
      mineRockViaApi(request, async () => "token"),
      (error) =>
        error instanceof MiningApiError && error.code === "unavailable",
    );
  }
});

test("applies one deadline to token acquisition and response reading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tokenRequest = mineRockViaApi(
    request,
    () => new Promise(() => undefined),
  );
  const tokenRejection = assert.rejects(
    tokenRequest,
    (error) =>
      error instanceof MiningApiError &&
      error.message === "Mining request timed out.",
  );
  t.mock.timers.runAll();
  await tokenRejection;

  let signal;
  let bodyStarted;
  const started = new Promise((resolve) => {
    bodyStarted = resolve;
  });
  globalThis.fetch = async (_input, init) => {
    signal = init.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          bodyStarted();
        },
      }),
    );
  };
  const bodyRequest = mineRockViaApi(request, async () => "token");
  await started;
  const bodyRejection = assert.rejects(
    bodyRequest,
    (error) =>
      error instanceof MiningApiError &&
      error.message === "Mining request timed out.",
  );
  assert.equal(signal.aborted, false);
  t.mock.timers.runAll();
  await bodyRejection;
  assert.equal(signal.aborted, true);
});
