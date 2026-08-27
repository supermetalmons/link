import assert from "node:assert/strict";
import test from "node:test";
import {
  EventPrizeWithdrawalApiError,
  withdrawEventPrizeViaApi,
} from "../src/services/eventPrizeApi.ts";
import { AuthApiError } from "../src/services/authApi.ts";

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

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("returns an immediately completed Worker withdrawal", async () => {
  const calls = [];
  const result = await withdrawEventPrizeViaApi(
    eventId,
    prizeId,
    recipientAddress,
    async (forceRefresh) => {
      calls.push(forceRefresh);
      return "token";
    },
    { fetcher: async () => jsonResponse(completed) },
  );
  assert.deepEqual(result, completed);
  assert.deepEqual(calls, [false]);
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
  const paths = [];
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
        paths.push(new URL(input).pathname);
        return responses.shift();
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

test("bounds stalled Firebase token acquisition", async () => {
  await assert.rejects(
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
      error.code === "unavailable",
  );
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
