import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { GAME_BOOTSTRAP_MAX_RESPONSE_BYTES } from "@mons/shared/game-bootstrap";

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
  GameBootstrapApiError,
  GAME_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  readGameBootstrapViaApi,
} = await import("../src/services/gameBootstrapApi.ts");

const originalFetch = globalThis.fetch;
const match = (/** @type {string} */ color, changes = {}) => ({
  schemaVersion: 1,
  version: 2,
  color,
  emojiId: 1,
  aura: "none",
  gameVariant: "Classic",
  fen: "initial",
  status: "active",
  flatMovesString: "",
  timer: { state: "idle" },
  ...changes,
});
const value = (snapshot = {}) => ({
  ok: true,
  schemaVersion: 1,
  metadata: {
    inviteId: "invite",
    revision: 1,
    hostId: "host",
    guestId: "guest",
    hostColor: "white",
    hostRematches: { state: "open", indices: [] },
    guestRematches: { state: "open", indices: [] },
    automatchStateHint: null,
    eventId: null,
    eventOwned: false,
  },
  viewer: { role: "host", actorUid: "host", automatchOperationId: null },
  hasPendingProposal: false,
  match: {
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
/** @param {unknown} [body] @param {number} [status] @param {HeadersInit} [headers] */
const response = (body = value(), status = 200, headers) =>
  new Response(JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
/** @template [T=string] @returns {PromiseWithResolvers<T>} */
const deferred = () => Promise.withResolvers();
const flush = () => new Promise((resolve) => setImmediate(resolve));
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("rejects invalid invite identifiers before fetching", async () => {
  globalThis.fetch = () => assert.fail("invalid invite reached fetch");
  await assert.rejects(readGameBootstrapViaApi("bad/invite"), {
    code: "invalid-invite",
  });
});

test("reads a bounded bootstrap and selects approved matches explicitly", async () => {
  /** @type {{ url: Parameters<typeof fetch>[0], options: RequestInit }[]} */
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options: required(options) });
    return response();
  };
  assert.deepEqual(
    await readGameBootstrapViaApi("invite", async () => "token"),
    value(),
  );
  await readGameBootstrapViaApi("invite", async () => "token", {
    selection: "approved",
  });
  assert.equal(
    required(calls[0]).url,
    "https://api.mons.link/invites/invite/bootstrap",
  );
  assert.equal(required(calls[0]).options.method, "GET");
  assert.equal(
    new Headers(required(calls[0]).options.headers).get("Authorization"),
    "Bearer token",
  );
  assert.equal(required(calls[0]).options.cache, "no-store");
  assert.equal(required(calls[0]).options.redirect, "error");
  assert.equal(
    required(calls[1]).url,
    "https://api.mons.link/invites/invite/bootstrap?selection=approved",
  );
});

test("refreshes auth exactly once for 401 and preserves the shared deadline", async () => {
  /** @type {(boolean | undefined)[]} */
  const refreshes = [];
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1 ? response({}, 401) : response();
  await readGameBootstrapViaApi("invite", async (refresh) => {
    refreshes.push(refresh);
    return "token";
  });
  assert.deepEqual(refreshes, [false, true]);
  globalThis.fetch = async () => response({}, 401);
  await assert.rejects(
    readGameBootstrapViaApi("invite", async () => "token"),
    { code: "http-401", status: 401 },
  );
});

test("keeps missing, forbidden, unavailable and rate-limit errors distinct and honors Retry-After", async (t) => {
  t.mock.method(Date, "now", () => Date.UTC(2026, 8, 7));
  for (const status of [404, 403, 503, 429]) {
    globalThis.fetch = async () =>
      response({}, status, { "Retry-After": "60" });
    await assert.rejects(readGameBootstrapViaApi("invite"), (error) => {
      assert.ok(error instanceof GameBootstrapApiError);
      assert.equal(error.code, `http-${status}`);
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 60_000);
      return true;
    });
  }
  globalThis.fetch = async () =>
    response({}, 503, { "Retry-After": "Mon, 07 Sep 2026 00:01:00 GMT" });
  await assert.rejects(readGameBootstrapViaApi("invite"), {
    retryAfterMs: 60_000,
  });
  globalThis.fetch = async () =>
    response({}, 503, { "Retry-After": "invalid" });
  await assert.rejects(readGameBootstrapViaApi("invite"), {
    retryAfterMs: undefined,
  });
});

test("rejects malformed, foreign or credential-bearing responses", async () => {
  for (const payload of [
    {},
    value({ inviteId: "other" }),
    value({ password: "secret" }),
    { ...value(), metadata: { ...value().metadata, inviteId: "other" } },
    value({ guestPlayerId: null }),
    value({ hostMatch: { ...match("white"), privateField: "secret" } }),
    { ...value(), wagers: {} },
  ]) {
    globalThis.fetch = async () => response(payload);
    await assert.rejects(readGameBootstrapViaApi("invite"), {
      code: "invalid-response",
    });
  }
});

test("bounds declared and streamed payloads and cancels oversized bodies", async () => {
  let canceled = 0;
  for (const headers of [
    { "Content-Length": String(GAME_BOOTSTRAP_MAX_RESPONSE_BYTES + 1) },
    {},
  ]) {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array(GAME_BOOTSTRAP_MAX_RESPONSE_BYTES + 1),
            );
          },
          cancel() {
            canceled++;
          },
        }),
        { headers },
      );
    await assert.rejects(readGameBootstrapViaApi("invite"), {
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
  const pending = readGameBootstrapViaApi("invite", () => token.promise, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });
  required(token.resolve)("old-token");
  await flush();
  assert.equal(fetches, 0);
});

test("one deadline bounds token refresh and rejects late tokens even before delayed timer callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const token = deferred();
  globalThis.fetch = async () => response({}, 401);
  const pending = readGameBootstrapViaApi("invite", (refresh) =>
    refresh ? token.promise : Promise.resolve("old-token"),
  );
  const rejected = assert.rejects(pending, { code: "timeout" });
  await flush();
  t.mock.timers.tick(GAME_BOOTSTRAP_REQUEST_TIMEOUT_MS);
  await rejected;
  required(token.resolve)("late-token");
  await flush();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const late = deferred();
  const delayed = readGameBootstrapViaApi("invite", () => late.promise);
  now += GAME_BOOTSTRAP_REQUEST_TIMEOUT_MS;
  required(late.resolve)("expired-token");
  await assert.rejects(delayed, { code: "timeout" });
});

test("aborts stalled response streams as well as the request", async () => {
  const controller = new AbortController();
  let canceled = false;
  /** @type {{ signal?: AbortSignal | null | undefined }} */
  const captured = {};
  globalThis.fetch = async (_url, options) => {
    captured.signal = required(options).signal;
    return new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    );
  };
  const pending = readGameBootstrapViaApi("invite", undefined, {
    signal: controller.signal,
  });
  await flush();
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });
  assert.equal(required(captured.signal).aborted, true);
  assert.equal(canceled, true);
});

test("rejects auth-user replacement and cancels late response bodies", async () => {
  /** @type {PromiseWithResolvers<Response>} */
  const request = deferred();
  let current = true;
  let canceled = false;
  const tokenProvider = Object.assign(async () => "token", {
    assertCurrentUser() {
      if (!current) throw new Error("authentication-changed");
    },
  });
  globalThis.fetch = () => request.promise;
  const pending = readGameBootstrapViaApi("invite", tokenProvider);
  await flush();
  current = false;
  required(request.resolve)(
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

test("public 401 reads stop after one request and cancel unread error bodies", async () => {
  let calls = 0;
  let canceled = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      new ReadableStream({
        cancel() {
          canceled++;
          return new Promise(() => {});
        },
      }),
      { status: 401, headers: { "Retry-After": "2" } },
    );
  };
  await assert.rejects(readGameBootstrapViaApi("invite"), (error) => {
    assert.ok(error instanceof GameBootstrapApiError);
    assert.equal(error.code, "http-401");
    assert.equal(error.status, 401);
    assert.equal(error.retryAfterMs, 2_000);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(canceled, 1);
});

test("validates identifiers before abort without starting token lookup or fetch", async () => {
  let tokens = 0;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return response();
  };
  await assert.rejects(
    readGameBootstrapViaApi(
      "invite",
      async () => {
        tokens++;
        return "token";
      },
      { signal: AbortSignal.abort() },
    ),
    { name: "GameBootstrapApiError", code: "aborted" },
  );
  await assert.rejects(
    readGameBootstrapViaApi("bad/invite", undefined, {
      signal: AbortSignal.abort(),
    }),
    { name: "GameBootstrapApiError", code: "invalid-invite" },
  );
  assert.equal(tokens, 0);
  assert.equal(fetches, 0);
});

test("preserves raw token and network failures without retrying", async () => {
  for (const stage of ["token", "fetch"]) {
    const failure = new TypeError(`${stage} unavailable`);
    let tokens = 0;
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      throw failure;
    };
    await assert.rejects(
      readGameBootstrapViaApi("invite", async () => {
        tokens++;
        if (stage === "token") throw failure;
        return "token";
      }),
      (error) => error === failure,
    );
    assert.equal(tokens, 1);
    assert.equal(fetches, stage === "fetch" ? 1 : 0);
  }
});
