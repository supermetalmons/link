import assert from "node:assert/strict";
import test from "node:test";
import { INVITE_METADATA_MAX_MESSAGE_BYTES } from "@mons/shared/invite-metadata";
import {
  createInviteMetadataSocketProtocols,
  getInviteMetadataSocketUrl,
  InviteMetadataApiError,
  INVITE_METADATA_REQUEST_TIMEOUT_MS,
  readInviteMetadataViaApi,
} from "../src/services/inviteMetadataApi.ts";

const originalFetch = globalThis.fetch;
const value = (snapshot = {}, viewer = {}) => ({
  ok: true,
  snapshot: {
    inviteId: "invite",
    revision: 1,
    hostId: "host",
    guestId: null,
    hostColor: "white",
    hostRematches: "",
    guestRematches: "",
    automatchStateHint: null,
    eventId: null,
    eventOwned: false,
    ...snapshot,
  },
  viewer: {
    role: "host",
    actorUid: "host",
    automatchOperationId: null,
    ...viewer,
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

test("uses metadata-only socket protocol and keeps validated JWTs out of URLs", () => {
  assert.deepEqual(
    createInviteMetadataSocketProtocols("header.payload.signature"),
    ["mons-invite-metadata-v1", "bearer.header.payload.signature"],
  );
  assert.equal(
    getInviteMetadataSocketUrl("invite"),
    "wss://api.mons.link/invites/invite/metadata/socket",
  );
  for (const token of [
    "",
    "one.two",
    "secret .payload.sig",
    "secret,.payload.sig",
    "x".repeat(4097),
    null,
  ]) {
    assert.throws(() => createInviteMetadataSocketProtocols(token), {
      code: "invalid-metadata-socket-token",
    });
  }
  assert.throws(() => getInviteMetadataSocketUrl("bad/invite"), {
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
    await readInviteMetadataViaApi("invite", async () => "token"),
    value(),
  );
  await readInviteMetadataViaApi("invite");
  assert.equal(calls[0].url, "https://api.mons.link/invites/invite/metadata");
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
  await readInviteMetadataViaApi("invite", async (refresh) => {
    refreshes.push(refresh);
    return "token";
  });
  assert.deepEqual(refreshes, [false, true]);
  globalThis.fetch = async () => response({}, 401);
  await assert.rejects(
    readInviteMetadataViaApi("invite", async () => "token"),
    { code: "http-401", status: 401 },
  );
});

test("keeps missing, forbidden, unavailable and rate-limit errors distinct and honors Retry-After", async (t) => {
  t.mock.method(Date, "now", () => Date.UTC(2026, 8, 7));
  for (const status of [404, 403, 503, 429]) {
    globalThis.fetch = async () =>
      response({}, status, { "Retry-After": "60" });
    await assert.rejects(readInviteMetadataViaApi("invite"), (error) => {
      assert.ok(error instanceof InviteMetadataApiError);
      assert.equal(error.code, `http-${status}`);
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 60_000);
      return true;
    });
  }
  globalThis.fetch = async () =>
    response({}, 503, { "Retry-After": "Mon, 07 Sep 2026 00:01:00 GMT" });
  await assert.rejects(readInviteMetadataViaApi("invite"), {
    retryAfterMs: 60_000,
  });
  globalThis.fetch = async () =>
    response({}, 503, { "Retry-After": "invalid" });
  await assert.rejects(readInviteMetadataViaApi("invite"), {
    retryAfterMs: undefined,
  });
});

test("rejects malformed, foreign or credential-bearing responses", async () => {
  for (const payload of [
    {},
    value({ inviteId: "other" }),
    value({ password: "secret" }),
    value({}, { actorUid: "intruder" }),
    { ...value(), wagers: {} },
  ]) {
    globalThis.fetch = async () => response(payload);
    await assert.rejects(readInviteMetadataViaApi("invite"), {
      code: "invalid-response",
    });
  }
});

test("bounds declared and streamed payloads and cancels oversized bodies", async () => {
  let canceled = 0;
  for (const headers of [
    { "Content-Length": String(INVITE_METADATA_MAX_MESSAGE_BYTES + 1) },
    {},
  ]) {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array(INVITE_METADATA_MAX_MESSAGE_BYTES + 1),
            );
          },
          cancel() {
            canceled++;
          },
        }),
        { headers },
      );
    await assert.rejects(readInviteMetadataViaApi("invite"), {
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
  const pending = readInviteMetadataViaApi("invite", () => token.promise, {
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
  const pending = readInviteMetadataViaApi("invite", (refresh) =>
    refresh ? token.promise : Promise.resolve("old-token"),
  );
  const rejected = assert.rejects(pending, { code: "timeout" });
  await flush();
  t.mock.timers.tick(INVITE_METADATA_REQUEST_TIMEOUT_MS);
  await rejected;
  token.resolve("late-token");
  await flush();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const late = deferred();
  const delayed = readInviteMetadataViaApi("invite", () => late.promise);
  now += INVITE_METADATA_REQUEST_TIMEOUT_MS;
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
  const pending = readInviteMetadataViaApi("invite", undefined, {
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
  const pending = readInviteMetadataViaApi("invite", tokenProvider);
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
