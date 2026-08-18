import assert from "node:assert/strict";
import test from "node:test";
import {
  createFirebaseRtdbClient,
  createFirebaseRtdbRepository,
  FIREBASE_RTDB_SERVER_TIMESTAMP,
  FirebaseRtdbFailure,
  firebaseRtdbIncrement,
  MAX_RTDB_BODY_BYTES,
} from "../src/firebaseRtdb.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_DISABLE_X_VERIFY: "false",
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
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

test("reads Telegram state through authenticated bounded REST requests", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const repository = createFirebaseRtdbRepository(env, {
    getAccessToken: async () => "access-token",
    fetcher: async (input, init) => {
      requests.push({ input, init });
      return jsonResponse({ desired: { revision: "revision-1" } });
    },
  });
  assert.deepEqual(await repository.getMessage("automatch:invite-1"), {
    desired: { revision: "revision-1" },
  });
  assert.equal(
    String(requests[0].input),
    "https://mons-link-default-rtdb.firebaseio.com/telegramMessages/automatch%3Ainvite-1.json",
  );
  assert.equal(
    new Headers(requests[0].init?.headers).get("Authorization"),
    "Bearer access-token",
  );
});

test("encodes exact RTDB queries and silent multipath server-value updates", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
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
    await client.getPath("automatch", {
      orderBy: "uid",
      equalTo: "firebase-uid",
    }),
    { invite: { uid: "firebase-uid" } },
  );
  await client.patchRoot({
    "automatch/invite": null,
    "invites/invite/canceledAt": FIREBASE_RTDB_SERVER_TIMESTAMP,
    "telegramAutomatches/invite/generation": firebaseRtdbIncrement(1),
  });

  const queryUrl = new URL(String(requests[0].input));
  assert.equal(queryUrl.pathname, "/automatch.json");
  assert.equal(queryUrl.searchParams.get("orderBy"), '"uid"');
  assert.equal(queryUrl.searchParams.get("equalTo"), '"firebase-uid"');
  const patchUrl = new URL(String(requests[1].input));
  assert.equal(patchUrl.pathname, "/.json");
  assert.equal(patchUrl.searchParams.get("print"), "silent");
  assert.equal(requests[1].init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
    "automatch/invite": null,
    "invites/invite/canceledAt": { ".sv": "timestamp" },
    "telegramAutomatches/invite/generation": {
      ".sv": { increment: 1 },
    },
  });
  assert.equal(
    new Headers(requests[1].init?.headers).get("Authorization"),
    "Bearer access-token",
  );
  assert.throws(() => firebaseRtdbIncrement(Number.NaN), TypeError);
});

test("commits and aborts ETag-backed transactions", async () => {
  const responses = [
    jsonResponse({ value: 1 }, 200, { ETag: '"one"' }),
    jsonResponse({ value: 2 }),
    jsonResponse({ value: 2 }, 200, { ETag: '"two"' }),
  ];
  const requests: RequestInit[] = [];
  const repository = createFirebaseRtdbRepository(env, {
    getAccessToken: async () => "access-token",
    fetcher: async (_input, init) => {
      requests.push(init || {});
      const response = responses.shift();
      if (!response) throw new Error("missing response");
      return response;
    },
  });
  const committed = await repository.transactMessage("key", (current) => ({
    value: { value: Number((current as { value: number }).value) + 1 },
    decision: "incremented",
  }));
  const aborted = await repository.transactMessage("key", () => ({
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

test("retries conditional conflicts against fresh authoritative state", async () => {
  const values: unknown[] = [];
  const responses = [
    jsonResponse({ value: 1 }, 200, { ETag: '"one"' }),
    jsonResponse({ value: 2 }, 412, { ETag: '"two"' }),
    jsonResponse({ value: 2 }, 200, { ETag: '"two"' }),
    jsonResponse({ value: 3 }),
  ];
  const repository = createFirebaseRtdbRepository(env, {
    getAccessToken: async () => "access-token",
    fetcher: async () => {
      const response = responses.shift();
      if (!response) throw new Error("missing response");
      return response;
    },
  });
  const result = await repository.transactMessage("key", (current) => {
    values.push(current);
    return {
      value: { value: Number((current as { value: number }).value) + 1 },
    };
  });
  assert.deepEqual(values, [{ value: 1 }, { value: 2 }]);
  assert.deepEqual(result.value, { value: 3 });
});

test("fails after transaction conflicts are exhausted", async () => {
  const repository = createFirebaseRtdbRepository(env, {
    getAccessToken: async () => "access-token",
    maxTransactionAttempts: 2,
    fetcher: async (_input, init) =>
      init?.method === "PUT"
        ? jsonResponse({}, 412)
        : jsonResponse({}, 200, { ETag: '"etag"' }),
  });
  await assert.rejects(
    () => repository.transactMessage("key", () => ({ value: {} })),
    FirebaseRtdbFailure,
  );
});

test("fails closed on oversized and unavailable RTDB responses", async () => {
  const oversized = createFirebaseRtdbRepository(env, {
    getAccessToken: async () => "access-token",
    fetcher: async () =>
      new Response("{}", {
        headers: { "Content-Length": String(MAX_RTDB_BODY_BYTES + 1) },
      }),
  });
  const unavailable = createFirebaseRtdbRepository(env, {
    getAccessToken: async () => "access-token",
    fetcher: async () => {
      throw new Error("network unavailable");
    },
  });
  await assert.rejects(() => oversized.getMessage("key"), FirebaseRtdbFailure);
  await assert.rejects(
    () => unavailable.getMessage("key"),
    FirebaseRtdbFailure,
  );
});
