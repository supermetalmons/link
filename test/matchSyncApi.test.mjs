import assert from "node:assert/strict";
import test from "node:test";
import { MATCH_SYNC_MAX_MESSAGE_BYTES } from "@mons/shared/match-sync";
import {
  createMatchSyncSocketProtocols,
  getMatchSyncSocketUrl,
  MatchSyncApiError,
  MATCH_SYNC_REQUEST_TIMEOUT_MS,
  readMatchSyncViaApi,
} from "../src/services/matchSyncApi.ts";

const originalFetch = globalThis.fetch;
const match = (color, changes = {}) => ({
  version: 2,
  color,
  emojiId: 1,
  aura: "",
  gameVariant: "Classic",
  fen: "initial",
  status: "",
  flatMovesString: "",
  timer: "",
  ...changes,
});
const value = (snapshot = {}) => ({
  ok: true,
  snapshot: {
    inviteId: "invite",
    matchId: "invite",
    revision: 1,
    hostPlayerId: "host",
    guestPlayerId: "guest",
    hostMatch: match("white"),
    guestMatch: match("black"),
    ...snapshot,
  },
});
const response = (body = value(), status = 200, headers) =>
  new Response(JSON.stringify(body), { status, headers });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("uses match sync-only socket protocol and keeps validated JWTs out of URLs", () => {
  assert.deepEqual(createMatchSyncSocketProtocols("header.payload.signature"), [
    "mons-match-sync-v1",
    "bearer.header.payload.signature",
  ]);
  assert.equal(
    getMatchSyncSocketUrl("invite", "invite"),
    "wss://api.mons.link/invites/invite/matches/invite/socket",
  );
  for (const token of [
    "",
    "one.two",
    "secret .payload.sig",
    "secret,.payload.sig",
    "x".repeat(4097),
    null,
  ]) {
    assert.throws(() => createMatchSyncSocketProtocols(token), {
      code: "invalid-match-sync-socket-token",
    });
  }
  assert.throws(() => getMatchSyncSocketUrl("bad/invite", "bad/invite"), {
    code: "invalid-invite",
  });
});

test("reads a bounded authenticated snapshot and permits public spectator reads", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response();
  };
  assert.deepEqual(
    await readMatchSyncViaApi("invite", "invite", async () => "token"),
    value(),
  );
  await readMatchSyncViaApi("invite", "invite");
  assert.equal(
    calls[0].url,
    "https://api.mons.link/invites/invite/matches/invite/snapshot",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer token");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[1].options.headers.Authorization, undefined);
});

test("refreshes auth exactly once for 401 and preserves the shared deadline", async () => {
  const refreshes = [];
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1 ? response({}, 401) : response();
  await readMatchSyncViaApi("invite", "invite", async (refresh) => {
    refreshes.push(refresh);
    return "token";
  });
  assert.deepEqual(refreshes, [false, true]);
  globalThis.fetch = async () => response({}, 401);
  await assert.rejects(
    readMatchSyncViaApi("invite", "invite", async () => "token"),
    { code: "http-401", status: 401 },
  );
});

test("keeps missing, forbidden, unavailable and rate-limit errors distinct and honors Retry-After", async (t) => {
  t.mock.method(Date, "now", () => Date.UTC(2026, 8, 7));
  for (const status of [404, 403, 503, 429]) {
    globalThis.fetch = async () =>
      response({}, status, { "Retry-After": "60" });
    await assert.rejects(readMatchSyncViaApi("invite", "invite"), (error) => {
      assert.ok(error instanceof MatchSyncApiError);
      assert.equal(error.code, `http-${status}`);
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 60_000);
      return true;
    });
  }
  globalThis.fetch = async () =>
    response({}, 503, { "Retry-After": "Mon, 07 Sep 2026 00:01:00 GMT" });
  await assert.rejects(readMatchSyncViaApi("invite", "invite"), {
    retryAfterMs: 60_000,
  });
  globalThis.fetch = async () =>
    response({}, 503, { "Retry-After": "invalid" });
  await assert.rejects(readMatchSyncViaApi("invite", "invite"), {
    retryAfterMs: undefined,
  });
});

test("rejects malformed, foreign or credential-bearing responses", async () => {
  for (const payload of [
    {},
    value({ inviteId: "other" }),
    value({ password: "secret" }),
    value({ matchId: "invite1" }),
    value({ guestPlayerId: null }),
    value({ hostMatch: { ...match("white"), privateField: "secret" } }),
    { ...value(), wagers: {} },
  ]) {
    globalThis.fetch = async () => response(payload);
    await assert.rejects(readMatchSyncViaApi("invite", "invite"), {
      code: "invalid-response",
    });
  }
});

test("bounds declared and streamed payloads and cancels oversized bodies", async () => {
  let canceled = 0;
  for (const headers of [
    { "Content-Length": String(MATCH_SYNC_MAX_MESSAGE_BYTES + 1) },
    {},
  ]) {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array(MATCH_SYNC_MAX_MESSAGE_BYTES + 1),
            );
          },
          cancel() {
            canceled++;
          },
        }),
        { headers },
      );
    await assert.rejects(readMatchSyncViaApi("invite", "invite"), {
      code: "invalid-response",
    });
  }
  assert.equal(canceled, 2);
});

test("aborts pending token lookup without a late request", async () => {
  const token = deferred();
  const controller = new AbortController();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return response();
  };
  const pending = readMatchSyncViaApi("invite", "invite", () => token.promise, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });
  token.resolve("old-token");
  await flush();
  assert.equal(fetches, 0);
});

test("one deadline bounds token refresh and rejects late tokens even before delayed timer callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const token = deferred();
  globalThis.fetch = async () => response({}, 401);
  const pending = readMatchSyncViaApi("invite", "invite", (refresh) =>
    refresh ? token.promise : Promise.resolve("old-token"),
  );
  const rejected = assert.rejects(pending, { code: "timeout" });
  await flush();
  t.mock.timers.tick(MATCH_SYNC_REQUEST_TIMEOUT_MS);
  await rejected;
  token.resolve("late-token");
  await flush();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const late = deferred();
  const delayed = readMatchSyncViaApi("invite", "invite", () => late.promise);
  now += MATCH_SYNC_REQUEST_TIMEOUT_MS;
  late.resolve("expired-token");
  await assert.rejects(delayed, { code: "timeout" });
});

test("aborts stalled response streams as well as the request", async () => {
  const controller = new AbortController();
  let canceled = false;
  let signal;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    return new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    );
  };
  const pending = readMatchSyncViaApi("invite", "invite", undefined, {
    signal: controller.signal,
  });
  await flush();
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });
  assert.equal(signal.aborted, true);
  assert.equal(canceled, true);
});

test("rejects auth-user replacement and cancels late response bodies", async () => {
  const request = deferred();
  let current = true;
  let canceled = false;
  const tokenProvider = Object.assign(async () => "token", {
    assertCurrentUser() {
      if (!current) throw new Error("authentication-changed");
    },
  });
  globalThis.fetch = () => request.promise;
  const pending = readMatchSyncViaApi("invite", "invite", tokenProvider);
  await flush();
  current = false;
  request.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    ),
  );
  await assert.rejects(pending, /authentication-changed/);
  assert.equal(canceled, true);
});
