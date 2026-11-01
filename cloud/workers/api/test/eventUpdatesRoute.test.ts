import assert from "node:assert/strict";
import test from "node:test";
import { APPLICATION_DATA_SOCKET_PROTOCOL } from "@mons/shared/data-contract";
import { EVENT_UPDATES_SOCKET_PROTOCOL } from "@mons/shared/events";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  handleEventUpdatesRoute,
  type EventUpdatesRouteDependencies,
} from "../src/eventUpdatesRoute.ts";
import { handleRequest } from "../src/router.ts";
import { socketTestIdentity } from "./socketTestSession.ts";
import { applicationRequest, TELEGRAM_TEST_ENV } from "./testEnv.ts";

const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ2aWV3ZXIifQ.signature";
const ctx = { waitUntil: (_work: Promise<unknown>) => undefined };

function request(
  path = "/events/event-one/socket",
  headers: Record<string, string> = {},
  method = "GET",
): Request {
  return applicationRequest(`https://api.mons.link${path}`, {
    method,
    headers: {
      Origin: "https://mons.link",
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `${EVENT_UPDATES_SOCKET_PROTOCOL}, ${APPLICATION_DATA_SOCKET_PROTOCOL}, bearer.${token}`,
      "CF-Connecting-IP": "192.0.2.1",
      ...headers,
    },
  });
}

function setup() {
  const calls = { auth: 0, limits: [] as string[], requests: [] as Request[] };
  const identity = socketTestIdentity("event-viewer");
  const env: Env = {
    ...TELEGRAM_TEST_ENV,
    REACTION_RATE_LIMITER: {
      async limit({ key }: { key: string }) {
        calls.limits.push(key);
        return { success: true };
      },
    },
  };
  const dependencies: EventUpdatesRouteDependencies = {
    async verifyIdentity(incoming) {
      calls.auth++;
      assert.equal(incoming.headers.get("Authorization"), `Bearer ${token}`);
      return identity;
    },
    room: {
      async fetch(incoming) {
        calls.requests.push(incoming);
        return new Response("upgraded");
      },
    },
  };
  return {
    calls,
    env,
    identity,
    dependencies,
    handle: (incoming = request()) =>
      handleEventUpdatesRoute(incoming, env, ctx, dependencies),
  };
}

test("event subscriptions authenticate viewers without requiring event participation", async () => {
  const state = setup();
  const response = await state.handle(
    request("/events/event-one/socket", {
      "X-Mons-Event-Id": "other-event",
      "X-Mons-Event-User": "other-user",
      "X-Mons-Session-Id": "other-session",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(state.calls.auth, 1);
  assert.deepEqual(state.calls.limits, ["event-connect:identity:event-viewer"]);
  const forwarded = state.calls.requests[0]!;
  assert.equal(forwarded.url, "https://events.internal/events/socket");
  assert.equal(forwarded.headers.get("X-Mons-Event-Id"), "event-one");
  assert.equal(forwarded.headers.get("X-Mons-Event-User"), state.identity.uid);
  assert.equal(forwarded.headers.get("X-Mons-Session-Id"), state.identity.sid);
  assert.equal(
    forwarded.headers.get("X-Mons-Session-Expires-At"),
    String(state.identity.authExpiresAtMs),
  );
  assert.equal(forwarded.headers.get("Authorization"), null);
  assert.equal(
    forwarded.headers.get("Sec-WebSocket-Protocol"),
    EVENT_UPDATES_SOCKET_PROTOCOL,
  );
});

test("event subscriptions encode safe non-ASCII event and identity headers", async () => {
  const state = setup();
  state.identity.uid = "viewer-👾";
  assert.equal(
    (
      await state.handle(
        request(`/events/${encodeURIComponent("event-👾")}/socket`),
      )
    ).status,
    200,
  );
  assert.equal(
    state.calls.requests[0]!.headers.get("X-Mons-Event-Id"),
    encodeURIComponent("event-👾"),
  );
  assert.equal(
    state.calls.requests[0]!.headers.get("X-Mons-Event-User"),
    encodeURIComponent(state.identity.uid),
  );
});

test("event subscription preflight is routed without authentication or room access", async () => {
  const state = setup();
  const response = await handleRequest(
    request(undefined, {}, "OPTIONS"),
    state.env,
    { eventUpdates: state.dependencies },
    ctx,
  );
  assert.equal(response.status, 204);
  assert.deepEqual(state.calls, { auth: 0, limits: [], requests: [] });
});

for (const [name, incoming, status] of [
  [
    "missing token",
    request(undefined, {
      "Sec-WebSocket-Protocol": `${EVENT_UPDATES_SOCKET_PROTOCOL}, ${APPLICATION_DATA_SOCKET_PROTOCOL}`,
    }),
    401,
  ],
  ["missing origin", request(undefined, { Origin: "" }), 403],
  [
    "foreign origin",
    request(undefined, { Origin: "https://evil.invalid" }),
    403,
  ],
  [
    "wrong protocol",
    request(undefined, {
      "Sec-WebSocket-Protocol": `wrong, ${APPLICATION_DATA_SOCKET_PROTOCOL}, bearer.${token}`,
    }),
    400,
  ],
  ["query parameters", request("/events/event-one/socket?token=private"), 400],
  ["invalid event", request("/events/event%2Fone/socket"), 400],
  ["malformed encoding", request("/events/%ZZ/socket"), 400],
  ["missing upgrade", request(undefined, { Upgrade: "" }), 426],
  ["wrong method", request(undefined, {}, "POST"), 405],
] as const) {
  test(`event subscription rejects ${name} before room access`, async () => {
    const state = setup();
    assert.equal((await state.handle(incoming)).status, status);
    assert.equal(state.calls.requests.length, 0);
    assert.equal(state.calls.auth, 0);
  });
}

test("revoked or expired sessions fail closed before opening an event room", async () => {
  const state = setup();
  state.dependencies.verifyIdentity = async () => {
    throw new AuthApiFailure(401, "unauthenticated", "authentication-required");
  };
  assert.equal((await state.handle()).status, 401);
  assert.equal(state.calls.requests.length, 0);
  assert.equal(state.calls.limits.length, 0);
});

test("event connection rate limits and unavailable rooms preserve HTTP failures", async () => {
  const state = setup();
  state.env.REACTION_RATE_LIMITER.limit = async () => ({ success: false });
  const limited = await state.handle();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(state.calls.requests.length, 0);
  state.env.REACTION_RATE_LIMITER.limit = async () => ({ success: true });
  state.dependencies.room = {
    fetch: async () => {
      throw new Error("room-failed");
    },
  };
  assert.equal((await state.handle()).status, 503);
});

test("router selects the event subscription handler under the existing application gate", async () => {
  const state = setup();
  const response = await handleRequest(
    request(),
    state.env,
    { eventUpdates: state.dependencies },
    ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(state.calls.requests.length, 1);
});
