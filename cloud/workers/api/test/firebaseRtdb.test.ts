import assert from "node:assert/strict";
import test from "node:test";
import {
  createFirebaseRtdbClient,
  FIREBASE_RTDB_SERVER_TIMESTAMP,
  FirebaseRtdbFailure,
  firebaseRtdbIncrement,
  MAX_RTDB_BODY_BYTES,
} from "../src/firebaseRtdb.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
    "worker@example.iam.gserviceaccount.com",
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

function jsonResponse(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("reads gameplay state through authenticated bounded REST requests", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const repository = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "access-token",
    fetcher: async (input, init) => {
      requests.push({ input, init });
      return jsonResponse({ desired: { revision: "revision-1" } });
    },
  });
  assert.deepEqual(await repository.getPath("telegramAutomatches/invite-1"), {
    desired: { revision: "revision-1" },
  });
  assert.equal(
    String(requests[0].input),
    "https://mons-link-default-rtdb.firebaseio.com/telegramAutomatches/invite-1.json",
  );
  assert.equal(
    new Headers(requests[0].init?.headers).get("Authorization"),
    "Bearer access-token",
  );
});

test("encodes exact RTDB queries and silent multipath server-value updates", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const controller = new AbortController();
  const client = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "access-token",
    fetcher: async (input, init) => {
      requests.push({ input, init });
      return init?.method === "PATCH"
        ? new Response(null, { status: 204 })
        : jsonResponse({ invite: { uid: "firebase-uid" } });
    },
  });
  assert.deepEqual(
    await client.getPath(
      "automatch",
      {
        orderBy: "uid",
        equalTo: "firebase-uid",
        limitToFirst: 1,
      },
      controller.signal,
    ),
    { invite: { uid: "firebase-uid" } },
  );
  assert.deepEqual(
    await client.getPath("automatch", {
      orderBy: "updatedAtMs",
      startAt: 0,
      endAt: 1_000,
      limitToFirst: 100,
    }),
    { invite: { uid: "firebase-uid" } },
  );
  await client.patchRoot(
    {
      "automatch/invite": null,
      "invites/invite/canceledAt": FIREBASE_RTDB_SERVER_TIMESTAMP,
      "telegramAutomatches/invite/generation": firebaseRtdbIncrement(1),
    },
    controller.signal,
  );

  const queryUrl = new URL(String(requests[0].input));
  assert.equal(queryUrl.pathname, "/automatch.json");
  assert.equal(queryUrl.searchParams.get("orderBy"), '"uid"');
  assert.equal(queryUrl.searchParams.get("equalTo"), '"firebase-uid"');
  assert.equal(queryUrl.searchParams.get("limitToFirst"), "1");
  const rangeUrl = new URL(String(requests[1].input));
  assert.equal(rangeUrl.searchParams.get("orderBy"), '"updatedAtMs"');
  assert.equal(rangeUrl.searchParams.get("startAt"), "0");
  assert.equal(rangeUrl.searchParams.get("endAt"), "1000");
  assert.equal(rangeUrl.searchParams.get("limitToFirst"), "100");
  const patchUrl = new URL(String(requests[2].input));
  assert.equal(patchUrl.pathname, "/.json");
  assert.equal(patchUrl.searchParams.get("print"), "silent");
  assert.equal(requests[2].init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(requests[2].init?.body)), {
    "automatch/invite": null,
    "invites/invite/canceledAt": { ".sv": "timestamp" },
    "telegramAutomatches/invite/generation": {
      ".sv": { increment: 1 },
    },
  });
  assert.equal(
    new Headers(requests[2].init?.headers).get("Authorization"),
    "Bearer access-token",
  );
  controller.abort();
  assert.equal(requests[0].init?.signal?.aborted, true);
  assert.equal(requests[1].init?.signal?.aborted, false);
  assert.equal(requests[2].init?.signal?.aborted, true);
  assert.throws(() => firebaseRtdbIncrement(Number.NaN), TypeError);
  await assert.rejects(
    () => client.getPath("automatch", { limitToFirst: 0 }),
    FirebaseRtdbFailure,
  );
});

test("encodes shallow RTDB reads and rejects filtered shallow queries", async () => {
  const requests: Array<RequestInfo | URL> = [];
  const client = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "access-token",
    fetcher: async (input) => {
      requests.push(input);
      return jsonResponse({ "match-1": true });
    },
  });

  assert.deepEqual(
    await client.getPath("players/firebase-uid/matches", { shallow: true }),
    { "match-1": true },
  );
  const shallowUrl = new URL(String(requests[0]));
  assert.equal(shallowUrl.pathname, "/players/firebase-uid/matches.json");
  assert.equal(shallowUrl.searchParams.get("shallow"), "true");
  await assert.rejects(
    () =>
      client.getPath("players/firebase-uid/matches", {
        orderBy: "$key",
        shallow: true,
      }),
    FirebaseRtdbFailure,
  );
  assert.equal(requests.length, 1);
});

test("commits and aborts ETag-backed transactions", async () => {
  const responses = [
    jsonResponse({ value: 1 }, 200, { ETag: '"one"' }),
    jsonResponse({ value: 2 }),
    jsonResponse({ value: 2 }, 200, { ETag: '"two"' }),
  ];
  const requests: RequestInit[] = [];
  const repository = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "access-token",
    fetcher: async (_input, init) => {
      requests.push(init || {});
      const response = responses.shift();
      if (!response) throw new Error("missing response");
      return response;
    },
  });
  const committed = await repository.transactPath("key", (current) => ({
    value: { value: Number((current as { value: number }).value) + 1 },
    decision: "incremented",
  }));
  const aborted = await repository.transactPath("key", () => ({
    commit: false,
    decision: "unchanged",
  }));
  assert.deepEqual(committed, {
    committed: true,
    decision: "incremented",
    value: { value: 2 },
  });
  assert.deepEqual(aborted, {
    committed: false,
    decision: "unchanged",
    value: { value: 2 },
  });
  assert.equal(requests[1].method, "PUT");
  assert.equal(new Headers(requests[1].headers).get("If-Match"), '"one"');
});

test("propagates cancellation through transaction reads and writes", async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  const responses = [
    jsonResponse(null, 200, { ETag: '"one"' }),
    jsonResponse({ ok: true }),
  ];
  const client = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "access-token",
    fetcher: async (_input, init) => {
      assert.ok(init?.signal);
      signals.push(init.signal);
      const response = responses.shift();
      if (!response) throw new Error("missing response");
      return response;
    },
  });
  await client.transactPath(
    "matchTimerClaims/match",
    () => ({ value: { timer: "1;1000" } }),
    controller.signal,
  );
  controller.abort();
  assert.equal(signals.length, 2);
  assert.equal(
    signals.every((signal) => signal.aborted),
    true,
  );
});

test("retries conditional conflicts against fresh authoritative state", async () => {
  const values: unknown[] = [];
  const responses = [
    jsonResponse({ value: 1 }, 200, { ETag: '"one"' }),
    jsonResponse({ value: 2 }, 412, { ETag: '"two"' }),
    jsonResponse({ value: 2 }, 200, { ETag: '"two"' }),
    jsonResponse({ value: 3 }),
  ];
  const repository = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "access-token",
    fetcher: async () => {
      const response = responses.shift();
      if (!response) throw new Error("missing response");
      return response;
    },
  });
  const result = await repository.transactPath("key", (current) => {
    values.push(current);
    return {
      value: { value: Number((current as { value: number }).value) + 1 },
    };
  });
  assert.deepEqual(values, [{ value: 1 }, { value: 2 }]);
  assert.deepEqual(result.value, { value: 3 });
});

test("fails after transaction conflicts are exhausted", async () => {
  const repository = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "access-token",
    maxTransactionAttempts: 2,
    fetcher: async (_input, init) =>
      init?.method === "PUT"
        ? jsonResponse({}, 412)
        : jsonResponse({}, 200, { ETag: '"etag"' }),
  });
  await assert.rejects(
    () => repository.transactPath("key", () => ({ value: {} })),
    FirebaseRtdbFailure,
  );
});

test("fails closed on oversized and unavailable RTDB responses", async () => {
  const oversized = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "access-token",
    fetcher: async () =>
      new Response("{}", {
        headers: { "Content-Length": String(MAX_RTDB_BODY_BYTES + 1) },
      }),
  });
  const unavailable = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "access-token",
    fetcher: async () => {
      throw new Error("network unavailable");
    },
  });
  await assert.rejects(() => oversized.getPath("key"), FirebaseRtdbFailure);
  await assert.rejects(() => unavailable.getPath("key"), FirebaseRtdbFailure);
});
