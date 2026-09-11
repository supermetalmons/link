import assert from "node:assert/strict";
import test from "node:test";
import {
  createFirebaseRtdbClient,
  FIREBASE_RTDB_SERVER_TIMESTAMP,
  FirebaseRtdbFailure,
  FirebaseRtdbPermissionDenied,
  firebaseRtdbIncrement,
  MAX_RTDB_BODY_BYTES,
} from "../test/legacyFirebaseRtdb.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
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

test("unscoped clients require credentials or an injected access token", async () => {
  const explicitOnlyEnv = new Proxy(env, {
    get(target, property, receiver) {
      if (String(property).includes("SERVICE_ACCOUNT")) {
        throw new Error("unexpected-service-account-access");
      }
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () =>
      createFirebaseRtdbClient(
        explicitOnlyEnv,
        {} as Parameters<typeof createFirebaseRtdbClient>[1],
      ),
    /missing-firebase-rtdb-credentials/,
  );
  let tokenRequests = 0;
  const client = createFirebaseRtdbClient(explicitOnlyEnv, {
    getAccessToken: async () => {
      tokenRequests++;
      return "injected-access-token";
    },
    fetcher: async (_input, init) => {
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer injected-access-token",
      );
      return jsonResponse(null);
    },
  });
  await client.getPath("players/actor/matches/invite-1");
  await client.getPath("players/opponent/matches/invite-1");
  assert.equal(tokenRequests, 1);
});

test("unscoped clients exchange only their explicitly supplied credentials", async () => {
  const { privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pem = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey));
  let exchanges = 0;
  const client = createFirebaseRtdbClient(env, {
    credentials: {
      email: "explicit@example.iam.gserviceaccount.com",
      privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${pem.toString("base64")}\n-----END PRIVATE KEY-----`,
    },
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") {
        exchanges++;
        const assertion = new URLSearchParams(String(init?.body)).get(
          "assertion",
        )!;
        const claims = JSON.parse(
          Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"),
        );
        assert.equal(claims.iss, "explicit@example.iam.gserviceaccount.com");
        assert.equal(
          claims.scope,
          "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
        );
        return jsonResponse({ access_token: "explicit-access-token" });
      }
      assert.equal(url.search, "");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer explicit-access-token",
      );
      return jsonResponse(null);
    },
  });
  await client.getPath("players/actor/matches/invite-1");
  await client.getPath("players/opponent/matches/invite-1");
  assert.equal(exchanges, 1);
});

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

test("persists transaction audit before sending the conditional write", async () => {
  const order: string[] = [];
  const repository = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "access-token",
    fetcher: async (_input, init) => {
      if (init?.method === "PUT") {
        order.push("put");
        return jsonResponse({ revision: 2 });
      }
      return jsonResponse({ revision: 1 }, 200, { ETag: '"one"' });
    },
  });
  const update = () => ({ value: { revision: 2 } });
  await assert.rejects(
    repository.transactPath("key", update, undefined, async () => {
      throw new Error("audit-unavailable");
    }),
    /audit-unavailable/,
  );
  assert.equal(order.length, 0);
  await repository.transactPath("key", update, undefined, async (attempt) => {
    assert.deepEqual(attempt, {
      current: { revision: 1 },
      proposed: { revision: 2 },
      etag: '"one"',
    });
    order.push("audit");
  });
  assert.deepEqual(order, ["audit", "put"]);
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

test("scoped surrender authenticates with gameplay OAuth and retries only the authorized match", async () => {
  const { privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pem = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey));
  const original = { status: "", fen: "first", flatMovesString: "", aura: "" };
  const moved = { ...original, fen: "second", flatMovesString: "move" };
  const responses = [
    jsonResponse(original, 200, { ETag: '"first"' }),
    jsonResponse(moved, 412),
    jsonResponse(moved, 200, { ETag: '"second"' }),
    jsonResponse({ ...moved, status: "surrendered" }),
  ];
  const requests: RequestInit[] = [];
  const scope = { playerId: "actor", matchId: "invite-1" };
  const client = createFirebaseRtdbClient(
    {
      ...env,
      GAMEPLAY_SERVICE_ACCOUNT_EMAIL:
        "gameplay@example.iam.gserviceaccount.com",
      GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pem.toString("base64")}\n-----END PRIVATE KEY-----`,
    },
    {
      scopedMatchSurrender: scope,
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "oauth2.googleapis.com") {
          const assertion = new URLSearchParams(String(init?.body)).get(
            "assertion",
          )!;
          const payload = JSON.parse(
            Buffer.from(assertion.split(".")[1], "base64url").toString(),
          );
          assert.equal(payload.iss, "gameplay@example.iam.gserviceaccount.com");
          assert.equal(url.search, "");
          return jsonResponse({ access_token: "gameplay-oauth" });
        }
        assert.equal(url.pathname, "/players/actor/matches/invite-1.json");
        assert.deepEqual(
          JSON.parse(url.searchParams.get("auth_variable_override")!),
          { uid: "actor", token: { workerSurrenderMatchId: "invite-1" } },
        );
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer gameplay-oauth",
        );
        requests.push(init || {});
        const response = responses.shift();
        assert.ok(response);
        return response;
      },
    },
  );
  scope.playerId = "other";
  scope.matchId = "other";
  const result = await client.transactPath(
    "players/actor/matches/invite-1",
    (current) => ({
      value: { ...(current as Record<string, unknown>), status: "surrendered" },
    }),
  );
  assert.equal(result.committed, true);
  assert.deepEqual(result.value, { ...moved, status: "surrendered" });
  assert.deepEqual(JSON.parse(String(requests[3].body)), result.value);
  assert.equal(new Headers(requests[3].headers).get("If-Match"), '"second"');
});

test("scoped surrender rejects invalid scopes, escaped paths, root writes and other mutations", async () => {
  const path = "players/actor/matches/invite-1";
  let requests = 0;
  const options = {
    getAccessToken: async () => "gameplay-oauth",
    fetcher: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      assert.notEqual(init?.method, "PUT");
      return jsonResponse(
        { status: "", fen: "first", presentation: { aura: "" } },
        200,
        { ETag: '"first"' },
      );
    },
  };
  for (const scope of [
    null,
    { playerId: "", matchId: "invite-1" },
    { playerId: "actor/other", matchId: "invite-1" },
    { playerId: "actor", matchId: "" },
    { playerId: "actor", matchId: " invite-1" },
    { playerId: "actor", matchId: "invite/other" },
  ]) {
    assert.throws(
      () =>
        createFirebaseRtdbClient(env, {
          ...options,
          scopedMatchSurrender: scope as { playerId: string; matchId: string },
        }),
      /invalid-match-surrender-scope/,
    );
  }
  const client = createFirebaseRtdbClient(env, {
    ...options,
    scopedMatchSurrender: { playerId: "actor", matchId: "invite-1" },
  });
  for (const otherPath of [
    "",
    `${path}/status`,
    `/${path}`,
    `${path}/`,
    "players/other/matches/invite-1",
  ]) {
    await assert.rejects(client.getPath(otherPath), /outside-scope/);
    await assert.rejects(
      client.transactPath(otherPath, () => ({ value: "surrendered" })),
      /outside-scope/,
    );
  }
  await assert.rejects(
    client.patchRoot({ [`${path}/status`]: "surrendered" }),
    /multipath-write-forbidden/,
  );
  assert.equal(requests, 0);
  for (const mutate of [
    (current: Record<string, unknown>) => ({ ...current, status: "" }),
    (current: Record<string, unknown>) => ({
      ...current,
      status: "surrendered",
      fen: "other",
    }),
    () => null,
    (current: Record<string, unknown>) => {
      current.fen = "other";
      return { ...current, status: "surrendered" };
    },
    (current: Record<string, unknown>) => {
      (current.presentation as Record<string, unknown>).aura = "forged";
      return { ...current, status: "surrendered" };
    },
  ]) {
    await assert.rejects(
      client.transactPath(path, (current) => ({
        value: mutate(current as Record<string, unknown>),
      })),
      /must-only-change-status/,
    );
  }
});

test("scoped surrender does not create missing matches or alter its validated body in an audit hook", async () => {
  const path = "players/actor/matches/invite-1";
  const original = { fen: "first", flatMovesString: "", status: "" };
  let missing = true;
  const client = createFirebaseRtdbClient(env, {
    scopedMatchSurrender: { playerId: "actor", matchId: "invite-1" },
    getAccessToken: async () => "gameplay-oauth",
    fetcher: async (_input, init) => {
      if (init?.method === "PUT") {
        const value = JSON.parse(String(init.body));
        assert.deepEqual(value, { ...original, status: "surrendered" });
        return jsonResponse(value);
      }
      return jsonResponse(missing ? null : original, 200, { ETag: '"one"' });
    },
  });
  await assert.rejects(
    client.transactPath(path, () => ({
      value: { ...original, status: "surrendered" },
    })),
    /must-only-change-status/,
  );
  missing = false;
  const result = await client.transactPath(
    path,
    (current) => ({
      value: { ...(current as Record<string, unknown>), status: "surrendered" },
    }),
    undefined,
    async ({ proposed }) => {
      (proposed as Record<string, unknown>).fen = "forged";
    },
  );
  assert.deepEqual(result.value, { ...original, status: "surrendered" });
});

test("scoped surrender distinguishes rules denial from expired credentials and provider failures", async () => {
  for (const [status, error, denied] of [
    [401, "Permission denied", true],
    [403, "Permission denied.", true],
    [401, "Invalid auth token", false],
    [403, "Service account access denied", false],
    [503, "Permission denied", false],
  ] as const) {
    let reads = 0;
    const client = createFirebaseRtdbClient(env, {
      scopedMatchSurrender: { playerId: "actor", matchId: "invite-1" },
      getAccessToken: async () => "gameplay-oauth",
      fetcher: async (_input, init) => {
        if (init?.method !== "PUT" && reads++ === 0) {
          return jsonResponse({ fen: "first", status: "" }, 200, {
            ETag: '"one"',
          });
        }
        return jsonResponse({ error }, status);
      },
    });
    const check = (failure: unknown) => {
      assert.ok(failure instanceof FirebaseRtdbFailure);
      assert.equal(failure instanceof FirebaseRtdbPermissionDenied, denied);
      return true;
    };
    await assert.rejects(
      client.transactPath("players/actor/matches/invite-1", (current) => ({
        value: {
          ...(current as Record<string, unknown>),
          status: "surrendered",
        },
      })),
      check,
    );
    await assert.rejects(
      client.getPath("players/actor/matches/invite-1"),
      check,
    );
  }
});

test("scoped moves use gameplay OAuth and retry ETag conflicts without losing concurrent fields", async () => {
  const { privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pem = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey));
  const original = {
    fen: "first",
    flatMovesString: "before",
    gameVariant: "Classic",
    timer: "timer",
    status: "",
    emojiId: 2,
    aura: "seed",
    sessionCreation: { operation: "created" },
    extra: { untouched: true },
  };
  const concurrent = { ...original, timer: "new-timer", status: "surrendered" };
  const expected = {
    ...concurrent,
    fen: "next",
    flatMovesString: "before-next",
  };
  const responses = [
    jsonResponse(original, 200, { ETag: '"first"' }),
    jsonResponse(concurrent, 412),
    jsonResponse(concurrent, 200, { ETag: '"second"' }),
    jsonResponse(expected),
  ];
  const writes: RequestInit[] = [];
  const client = createFirebaseRtdbClient(
    {
      ...env,
      GAMEPLAY_SERVICE_ACCOUNT_EMAIL:
        "gameplay@example.iam.gserviceaccount.com",
      GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pem.toString("base64")}\n-----END PRIVATE KEY-----`,
    },
    {
      scopedMatchMove: { playerId: "actor", matchId: "invite-1" },
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "oauth2.googleapis.com") {
          const assertion = new URLSearchParams(String(init?.body)).get(
            "assertion",
          )!;
          const payload = JSON.parse(
            Buffer.from(assertion.split(".")[1], "base64url").toString(),
          );
          assert.equal(payload.iss, "gameplay@example.iam.gserviceaccount.com");
          return jsonResponse({ access_token: "gameplay-oauth" });
        }
        assert.equal(url.pathname, "/players/actor/matches/invite-1.json");
        assert.deepEqual(
          JSON.parse(url.searchParams.get("auth_variable_override")!),
          {
            uid: "actor",
            token: { workerMoveMatchId: "invite-1" },
          },
        );
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer gameplay-oauth",
        );
        if (init?.method === "PUT") writes.push(init);
        return responses.shift()!;
      },
    },
  );
  const result = await client.transactPath(
    "players/actor/matches/invite-1",
    (current) => ({
      decision: "applied",
      value: {
        ...(current as Record<string, unknown>),
        fen: "next",
        flatMovesString: "before-next",
      },
    }),
  );
  assert.equal(result.committed, true);
  assert.deepEqual(result.value, expected);
  assert.equal(writes.length, 2);
  assert.equal(new Headers(writes[0].headers).get("If-Match"), '"first"');
  assert.equal(new Headers(writes[1].headers).get("If-Match"), '"second"');
  assert.deepEqual(JSON.parse(String(writes[1].body)), expected);
});

test("scoped moves reject invalid or competing scopes and all out-of-scope paths", async () => {
  let reads = 0;
  const scope = { playerId: "actor", matchId: "invite-1" };
  for (const invalid of [
    null,
    {},
    { playerId: "", matchId: "invite-1" },
    { playerId: "actor", matchId: " ../invite" },
    { playerId: "actor", matchId: "invite/1" },
  ]) {
    assert.throws(
      () =>
        createFirebaseRtdbClient(env, {
          scopedMatchMove: invalid as typeof scope,
        }),
      /invalid-match-move-scope/,
    );
  }
  assert.throws(
    () =>
      createFirebaseRtdbClient(env, {
        scopedMatchSurrender: scope,
        scopedMatchMove: scope,
      }),
    /conflicting-match-write-scopes/,
  );
  const client = createFirebaseRtdbClient(env, {
    scopedMatchMove: scope,
    getAccessToken: async () => "token",
    fetcher: async () => {
      reads++;
      throw new Error("unexpected-fetch");
    },
  });
  for (const path of [
    "",
    "players/actor/matches",
    "players/other/matches/invite-1",
    "players/actor/matches/other",
    "players/actor/matches/invite-1/fen",
    "/players/actor/matches/invite-1",
  ]) {
    await assert.rejects(client.getPath(path), /match-move-path-outside-scope/);
    await assert.rejects(
      client.transactPath(path, () => null),
      /match-move-path-outside-scope/,
    );
  }
  await assert.rejects(
    client.patchRoot({ "players/actor/matches/invite-1/fen": "next" }),
    /match-move-multipath-write-forbidden/,
  );
  assert.equal(reads, 0);
});

test("scoped moves cannot create matches, change unrelated fields or replace an existing variant", async () => {
  const original = {
    fen: "first",
    flatMovesString: "before",
    gameVariant: "Classic",
    timer: "timer",
    status: "",
    emojiId: 2,
    aura: "seed",
    version: 2,
    color: "white",
    sessionCreation: { operation: "created" },
    extra: { untouched: true },
  };
  let writes = 0;
  let stored: unknown = original;
  const client = createFirebaseRtdbClient(env, {
    scopedMatchMove: { playerId: "actor", matchId: "invite-1" },
    getAccessToken: async () => "token",
    fetcher: async (_input, init) => {
      if (init?.method === "PUT") writes++;
      return jsonResponse(stored, 200, { ETag: '"etag"' });
    },
  });
  const path = "players/actor/matches/invite-1";
  for (const [key, value] of [
    ["status", "surrendered"],
    ["timer", ""],
    ["emojiId", 3],
    ["aura", ""],
    ["version", 1],
    ["color", "black"],
    ["sessionCreation", {}],
    ["extra", {}],
    ["gameVariant", "Other"],
    ["fen", ""],
    ["flatMovesString", 10],
    ["unexpected", true],
  ] as const) {
    await assert.rejects(
      client.transactPath(path, (current) => ({
        value: {
          ...(current as Record<string, unknown>),
          fen: "next",
          flatMovesString: "before-next",
          [key]: value,
        },
      })),
      /match-move-must-only-change-move-fields/,
    );
  }
  for (const key of [
    "status",
    "timer",
    "emojiId",
    "aura",
    "version",
    "color",
    "sessionCreation",
    "extra",
    "gameVariant",
  ]) {
    await assert.rejects(
      client.transactPath(path, (current) => {
        const value = {
          ...(current as Record<string, unknown>),
          fen: "next",
          flatMovesString: "before-next",
        } as Record<string, unknown>;
        delete value[key];
        return { value };
      }),
      /match-move-must-only-change-move-fields/,
    );
  }
  await assert.rejects(
    client.transactPath(path, (current) => {
      const value = current as typeof original;
      value.extra.untouched = false;
      return {
        value: { ...value, fen: "next", flatMovesString: "before-next" },
      };
    }),
    /match-move-must-only-change-move-fields/,
  );
  assert.equal(original.extra.untouched, true);
  stored = null;
  await assert.rejects(
    client.transactPath(path, () => ({ value: original })),
    /match-move-must-only-change-move-fields/,
  );
  assert.equal(writes, 0);
});

test("scoped moves fill missing legacy fields and freeze the validated body before hooks", async () => {
  for (const gameVariant of [undefined, ""]) {
    const original = {
      fen: "first",
      ...(gameVariant === undefined ? {} : { gameVariant }),
    };
    const expected = {
      ...original,
      gameVariant: "Classic",
      fen: "next",
      flatMovesString: "next",
    };
    const client = createFirebaseRtdbClient(env, {
      scopedMatchMove: { playerId: "actor", matchId: "invite-1" },
      getAccessToken: async () => "token",
      fetcher: async (_input, init) => {
        if (init?.method === "PUT") {
          assert.deepEqual(JSON.parse(String(init.body)), expected);
          return jsonResponse(expected);
        }
        return jsonResponse(original, 200, { ETag: '"etag"' });
      },
    });
    const result = await client.transactPath(
      "players/actor/matches/invite-1",
      (current) => ({
        decision: "applied",
        value: {
          ...(current as Record<string, unknown>),
          gameVariant: "Classic",
          fen: "next",
          flatMovesString: "next",
        },
      }),
      undefined,
      async ({ current, proposed }) => {
        (current as Record<string, unknown>).status = "mutated";
        (proposed as Record<string, unknown>).status = "mutated";
      },
    );
    assert.deepEqual(result.value, expected);
  }
});

test("scoped moves replay without PUT and distinguish rules denial from provider failures", async () => {
  const path = "players/actor/matches/invite-1";
  let requests = 0;
  const replay = createFirebaseRtdbClient(env, {
    scopedMatchMove: { playerId: "actor", matchId: "invite-1" },
    getAccessToken: async () => "token",
    fetcher: async (_input, init) => {
      requests++;
      assert.notEqual(init?.method, "PUT");
      return jsonResponse({ fen: "next", flatMovesString: "move" }, 200, {
        ETag: '"etag"',
      });
    },
  });
  const result = await replay.transactPath(path, () => ({
    commit: false,
    decision: "already-applied",
  }));
  assert.equal(result.committed, false);
  assert.equal(result.decision, "already-applied");
  assert.equal(requests, 1);
  for (const [status, error, expected] of [
    [401, "Permission denied", FirebaseRtdbPermissionDenied],
    [403, "Permission denied.", FirebaseRtdbPermissionDenied],
    [401, "Auth token is expired", FirebaseRtdbFailure],
    [500, "Internal error", FirebaseRtdbFailure],
  ] as const) {
    const client = createFirebaseRtdbClient(env, {
      scopedMatchMove: { playerId: "actor", matchId: "invite-1" },
      getAccessToken: async () => "token",
      fetcher: async () => jsonResponse({ error }, status),
    });
    await assert.rejects(
      client.transactPath(path, () => null),
      (value) => {
        assert.equal((value as Error).constructor, expected);
        return true;
      },
    );
  }
});
