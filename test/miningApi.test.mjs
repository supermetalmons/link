import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";

registerTypeScriptTestHooks();

const { MiningApiError, mineRockViaApi } =
  await import("../src/services/miningApi.ts");
const { AuthApiError } = await import("../src/services/authApi.ts");

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

/** @param {unknown} body */
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("sends the exact authenticated mining request and validates responses", async () => {
  /** @type {{ input: string, init: RequestInit }[]} */
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init: required(init) });
    return jsonResponse(success);
  };

  assert.deepEqual(
    await mineRockViaApi(request, async () => "session-token"),
    success,
  );
  assert.equal(calls.length, 1);
  assert.equal(required(calls[0]).input, "https://api.mons.link/mining/rock");
  assert.equal(required(calls[0]).init.method, "POST");
  assert.equal(required(calls[0]).init.cache, "no-store");
  assert.ok(required(calls[0]).init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(required(calls[0]).init.body)), request);
  const headers = new Headers(required(calls[0]).init.headers);
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Authorization"), "Bearer session-token");
  assert.equal(headers.get("Content-Type"), "application/json");

  globalThis.fetch = async () =>
    jsonResponse({ ok: false, reason: "date-not-advanced" });
  assert.deepEqual(await mineRockViaApi(request, async () => "session-token"), {
    ok: false,
    reason: "date-not-advanced",
  });
});

test("refreshes the session token exactly once after a 401", async () => {
  /** @type {(boolean | undefined)[]} */
  const refreshes = [];
  /** @type {(string | null)[]} */
  const tokens = [];
  globalThis.fetch = async (_input, init) => {
    tokens.push(new Headers(required(init).headers).get("Authorization"));
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

test("serializes mining input after acquiring each attempt's token", async () => {
  const input = { ...request, materials: { ...request.materials } };
  /** @type {unknown[]} */
  const bodies = [];
  /** @type {(boolean | undefined)[]} */
  const refreshes = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(required(init).body)));
    return bodies.length === 1
      ? jsonResponse({ ok: false }, 401)
      : jsonResponse(success);
  };

  await mineRockViaApi(input, async (forceRefresh) => {
    refreshes.push(forceRefresh);
    input.materials.dust = forceRefresh ? 3 : 2;
    return "token";
  });

  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(bodies, [
    { ...request, materials: { ...request.materials, dust: 2 } },
    { ...request, materials: { ...request.materials, dust: 3 } },
  ]);
});

test("masks auth token failures as mining service errors", async () => {
  let fetches = 0;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("unexpected-fetch");
  };

  await assert.rejects(
    mineRockViaApi(request, async () => {
      tokenCalls++;
      throw Reflect.construct(AuthApiError, [
        "unauthenticated",
        "authentication-changed",
        {
          reason: "private-session-detail",
        },
      ]);
    }),
    (error) =>
      error instanceof MiningApiError &&
      error.name === "MiningApiError" &&
      error.code === "unavailable" &&
      error.message === "Mining service is unavailable." &&
      error.details === undefined,
  );
  assert.equal(tokenCalls, 1);
  assert.equal(fetches, 0);
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
  globalThis.fetch = async () => required(responses.shift());
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

  /** @type {{ signal?: AbortSignal | null | undefined }} */
  const captured = {};
  /** @type {PromiseWithResolvers<void>} */
  const { promise: started, resolve: bodyStarted } = Promise.withResolvers();
  globalThis.fetch = async (_input, init) => {
    captured.signal = required(init).signal;
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
  assert.equal(required(captured.signal).aborted, false);
  t.mock.timers.runAll();
  await bodyRejection;
  assert.equal(required(captured.signal).aborted, true);
});
