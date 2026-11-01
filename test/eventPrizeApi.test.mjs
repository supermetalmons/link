import { required } from "./fixtures/canonicalData.mjs";
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
  EVENT_PRIZE_API_DEADLINE_MS,
  EventPrizeWithdrawalApiError,
  withdrawEventPrizeViaApi,
} = await import("../src/services/eventPrizeApi.ts");
const { AuthApiError } = await import("../src/services/authApi.ts");

const eventId = "NN3eRzoZo80";
const prizeId = "1092";
const operationId = `epw_${"a".repeat(64)}`;
const recipientAddress = "11111111111111111111111111111111";
const completed = {
  ok: true,
  status: "completed",
  operationId,
  eventId,
  prizeId,
  assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
  recipientAddress,
  transactionSignature: "signature",
};
const processing = {
  ok: true,
  status: "processing",
  operationId,
  eventId,
  prizeId,
};

/**
 * @param {unknown} body
 * @param {number} [status]
 */
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("returns an immediately completed Worker withdrawal", async () => {
  /** @type {Array<boolean>} */
  const calls = [];
  /** @type {Array<{ input: RequestInfo | URL; init: RequestInit | undefined; }>} */
  const requests = [];
  const result = await withdrawEventPrizeViaApi(
    eventId,
    prizeId,
    recipientAddress,
    async (forceRefresh) => {
      calls.push(forceRefresh);
      return "token";
    },
    {
      fetcher: async (input, init) => {
        requests.push({ input, init });
        return jsonResponse(completed);
      },
    },
  );
  assert.deepEqual(result, completed);
  assert.deepEqual(calls, [false]);
  assert.equal(requests.length, 1);
  assert.equal(
    required(requests[0]).input,
    "https://api.mons.link/events/prizes/withdrawals",
  );
  const init = required(required(requests[0]).init);
  assert.equal(init.method, "POST");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(parseRequestJson(init.body), {
    eventId,
    prizeId,
    solanaAddress: recipientAddress,
  });
  const headers = new Headers(init.headers);
  assert.equal(headers.get("Authorization"), "Bearer token");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("Accept"), "application/json");
});

test("polls processing operations and tolerates transient status failures", async () => {
  const responses = [
    jsonResponse(processing, 202),
    jsonResponse(
      { ok: false, error: "unavailable", message: "temporarily unavailable" },
      503,
    ),
    jsonResponse(completed),
  ];
  /** @type {Array<string>} */
  const paths = [];
  /** @type {Array<number>} */
  const sleeps = [];
  let now = 0;
  const result = await withdrawEventPrizeViaApi(
    eventId,
    prizeId,
    recipientAddress,
    async () => "token",
    {
      deadlineMs: 10_000,
      fetcher: async (input) => {
        paths.push(new URL(String(input)).pathname);
        return required(responses.shift());
      },
      now: () => now,
      pollIntervalMs: 2_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    },
  );
  assert.deepEqual(result, completed);
  assert.deepEqual(paths, [
    "/events/prizes/withdrawals",
    "/events/prizes/withdrawals/status",
    "/events/prizes/withdrawals/status",
  ]);
  assert.deepEqual(sleeps, [2_000, 2_000]);
});

test("stops polling after a terminal Workflow failure", async () => {
  let calls = 0;
  let now = 0;
  await assert.rejects(
    withdrawEventPrizeViaApi(
      eventId,
      prizeId,
      recipientAddress,
      async () => "token",
      {
        deadlineMs: 10_000,
        fetcher: async () => {
          calls += 1;
          return calls === 1
            ? jsonResponse(processing, 202)
            : jsonResponse(
                {
                  ok: false,
                  error: "unavailable",
                  message: "Prize withdrawal service is unavailable.",
                  details: { terminal: true },
                },
                503,
              );
        },
        now: () => now,
        pollIntervalMs: 2_000,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    ),
    (error) =>
      error instanceof EventPrizeWithdrawalApiError &&
      error.code === "unavailable",
  );
  assert.equal(calls, 2);
  assert.equal(now, 2_000);
});

test("refreshes an expired token once", async () => {
  /** @type {Array<boolean>} */
  const refreshes = [];
  let requestCount = 0;
  const result = await withdrawEventPrizeViaApi(
    eventId,
    prizeId,
    recipientAddress,
    async (forceRefresh) => {
      refreshes.push(forceRefresh);
      return forceRefresh ? "fresh" : "stale";
    },
    {
      fetcher: async () => {
        requestCount += 1;
        return requestCount === 1
          ? jsonResponse({ ok: false }, 401)
          : jsonResponse(completed);
      },
    },
  );
  assert.deepEqual(result, completed);
  assert.deepEqual(refreshes, [false, true]);
});

test("times out locally without cancelling the Workflow", async () => {
  let now = 0;
  await assert.rejects(
    withdrawEventPrizeViaApi(
      eventId,
      prizeId,
      recipientAddress,
      async () => "token",
      {
        deadlineMs: 2_000,
        fetcher: async () => jsonResponse(processing, 202),
        now: () => now,
        pollIntervalMs: 2_000,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    ),
    (error) =>
      error instanceof EventPrizeWithdrawalApiError &&
      error.code === "deadline-exceeded",
  );
});

test("bounds stalled session token acquisition", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejection = assert.rejects(
    withdrawEventPrizeViaApi(
      eventId,
      prizeId,
      recipientAddress,
      async () => new Promise(() => {}),
      {
        deadlineMs: 100,
        requestTimeoutMs: 5,
        fetcher: async () => {
          throw new Error("unexpected-fetch");
        },
      },
    ),
    (error) =>
      error instanceof EventPrizeWithdrawalApiError &&
      error.code === "unavailable" &&
      error.message === "Prize withdrawal timed out.",
  );
  t.mock.timers.tick(5);
  await rejection;
});

test("clips polling request timeouts to the remaining overall deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  /** @type {AbortSignal | null | undefined} */
  let signal;

  /** @type {PromiseWithResolvers<void>} */
  const { promise: started, resolve: pollingStarted } = Promise.withResolvers();
  /** @type {Array<string>} */
  const paths = [];
  /** @type {Array<number>} */
  const sleeps = [];
  const withdrawal = withdrawEventPrizeViaApi(
    eventId,
    prizeId,
    recipientAddress,
    async () => "token",
    {
      deadlineMs: 900,
      requestTimeoutMs: 500,
      pollIntervalMs: 700,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      fetcher: async (input, init) => {
        paths.push(new URL(String(input)).pathname);
        if (paths.length === 1) return jsonResponse(processing, 202);
        assert.deepEqual(parseRequestJson(required(init).body), {
          eventId,
          operationId,
          prizeId,
        });
        signal = required(init).signal;
        pollingStarted();
        return new Promise(() => undefined);
      },
    },
  );
  const rejection = assert.rejects(
    withdrawal,
    (error) =>
      error instanceof EventPrizeWithdrawalApiError &&
      error.code === "deadline-exceeded" &&
      error.message === "Prize withdrawal timed out.",
  );
  await started;
  t.mock.timers.tick(199);
  assert.equal(required(signal).aborted, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal(required(signal).aborted, true);
  assert.deepEqual(sleeps, [700]);
  assert.deepEqual(paths, [
    "/events/prizes/withdrawals",
    "/events/prizes/withdrawals/status",
  ]);
});

test("keeps the default overall withdrawal deadline at 135 seconds", async () => {
  assert.equal(EVENT_PRIZE_API_DEADLINE_MS, 135_000);
  let now = 0;
  /** @type {Array<number>} */
  const sleeps = [];
  /** @type {Array<string>} */
  const paths = [];
  await assert.rejects(
    withdrawEventPrizeViaApi(
      eventId,
      prizeId,
      recipientAddress,
      async () => "token",
      {
        now: () => now,
        pollIntervalMs: 100_000,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
        fetcher: async (input) => {
          paths.push(new URL(String(input)).pathname);
          return jsonResponse(processing, 202);
        },
      },
    ),
    (error) =>
      error instanceof EventPrizeWithdrawalApiError &&
      error.code === "deadline-exceeded",
  );
  assert.equal(now, 135_000);
  assert.deepEqual(sleeps, [100_000, 35_000]);
  assert.deepEqual(paths, [
    "/events/prizes/withdrawals",
    "/events/prizes/withdrawals/status",
  ]);
});

test("converts auth token errors and masks unrelated token failures", async () => {
  const authError = new AuthApiError(
    "unauthenticated",
    "authentication-changed",
  );
  let fetches = 0;
  for (const failure of [authError, new Error("private-token-detail")]) {
    await assert.rejects(
      withdrawEventPrizeViaApi(
        eventId,
        prizeId,
        recipientAddress,
        async () => {
          throw failure;
        },
        {
          fetcher: async () => {
            fetches++;
            throw new Error("unexpected-fetch");
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof EventPrizeWithdrawalApiError);
        assert.equal(error.name, "EventPrizeWithdrawalApiError");
        if (failure === authError) {
          assert.equal(error.code, authError.code);
          assert.equal(error.message, authError.message);
          assert.equal(error.details, authError.details);
        } else {
          assert.equal(error.code, "unavailable");
          assert.equal(
            error.message,
            "Prize withdrawal service is unavailable.",
          );
          assert.equal(error.details, undefined);
        }
        return true;
      },
    );
  }
  assert.equal(fetches, 0);
});

test("preserves withdrawal stream errors but masks auth stream failures", async () => {
  const withdrawalError = new EventPrizeWithdrawalApiError(
    "unavailable",
    "withdrawal-interrupted",
    { terminal: true },
  );
  const authError = new AuthApiError(
    "unauthenticated",
    "authentication-changed",
  );
  for (const failure of [withdrawalError, authError]) {
    let fetches = 0;
    /** @type {Array<number>} */
    const sleeps = [];
    await assert.rejects(
      withdrawEventPrizeViaApi(
        eventId,
        prizeId,
        recipientAddress,
        async () => "token",
        {
          fetcher: async () => {
            fetches++;
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(failure);
                },
              }),
            );
          },
          sleep: async (milliseconds) => {
            sleeps.push(milliseconds);
          },
        },
      ),
      (error) => {
        if (failure === withdrawalError) {
          assert.equal(error, withdrawalError);
        } else {
          assert.ok(error instanceof EventPrizeWithdrawalApiError);
          assert.equal(error.code, "unavailable");
          assert.equal(
            error.message,
            "Prize withdrawal service is unavailable.",
          );
          assert.equal(error.details, undefined);
        }
        return true;
      },
    );
    assert.equal(fetches, 1);
    assert.deepEqual(sleeps, []);
  }
});

test("rejects a session change after token acquisition before submitting", async () => {
  let current = true;
  let fetches = 0;
  const tokenProvider = Object.assign(
    async () => {
      current = false;
      return "token";
    },
    {
      assertCurrentUser: () => {
        if (!current) {
          throw new AuthApiError("unauthenticated", "authentication-changed");
        }
      },
    },
  );
  await assert.rejects(
    withdrawEventPrizeViaApi(
      eventId,
      prizeId,
      recipientAddress,
      tokenProvider,
      {
        fetcher: async () => {
          fetches++;
          return jsonResponse(completed);
        },
      },
    ),
    (error) =>
      error instanceof EventPrizeWithdrawalApiError &&
      error.code === "unauthenticated" &&
      error.message === "authentication-changed",
  );
  assert.equal(fetches, 0);
});

test("rejects a response after the authenticated user changes", async () => {
  let current = true;
  const tokenProvider = Object.assign(async () => "token", {
    assertCurrentUser: () => {
      if (!current) {
        throw new AuthApiError("unauthenticated", "authentication-changed");
      }
    },
  });
  await assert.rejects(
    withdrawEventPrizeViaApi(
      eventId,
      prizeId,
      recipientAddress,
      tokenProvider,
      {
        fetcher: async () => {
          current = false;
          return jsonResponse(processing, 202);
        },
      },
    ),
    (error) =>
      error instanceof EventPrizeWithdrawalApiError &&
      error.code === "unauthenticated" &&
      error.message === "authentication-changed",
  );
});

/** @param {unknown} body @returns {Record<string, unknown>} */
function parseRequestJson(body) {
  assert.ok(typeof body === "string");
  /** @type {unknown} */
  const value = JSON.parse(body);
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return Object.fromEntries(Object.entries(value));
}
