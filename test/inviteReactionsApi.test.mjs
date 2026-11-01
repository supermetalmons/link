import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createInviteReactionSocketProtocols,
  getInviteReactionSocketUrl,
  InviteReactionApiError,
  REACTION_SEND_TIMEOUT_MS,
  sendInviteReactionViaApi,
} from "../src/services/inviteReactionsApi.ts";

const originalFetch = globalThis.fetch;
const reaction = (overrides = {}) => ({
  uuid: "00000000-0000-4000-8000-000000000001",
  matchId: "invite",
  kind: "yo",
  variation: 1,
  ...overrides,
});
/**
 * @param {unknown} [value]
 * @param {number} [status]
 */
const response = (value = { ok: true }, status = 200) =>
  new Response(JSON.stringify(value), { status });
/**
 * @template [T=void]
 * @returns {Pick<PromiseWithResolvers<T>, "promise" | "resolve">}
 */
const deferred = () => {
  /** @type {PromiseWithResolvers<T>} */
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("formats participant authentication as WebSocket subprotocols and rejects unsafe tokens without exposing them", () => {
  assert.deepEqual(
    createInviteReactionSocketProtocols("header.payload.signature"),
    ["mons-reactions-v2", "bearer.header.payload.signature", "mons-data-v1"],
  );
  for (const token of [
    "",
    "one.two",
    "one.two.three.four",
    "secret token.payload.sig",
    "secret,payload.sig.extra",
    "secret\r\n.payload.sig",
    "secret=.payload.sig",
    "x".repeat(4097),
    null,
  ]) {
    assert.throws(
      () =>
        Reflect.apply(createInviteReactionSocketProtocols, undefined, [token]),
      (error) => {
        assert.ok(error instanceof InviteReactionApiError);
        assert.equal(error.code, "invalid-reaction-socket-token");
        assert.equal(error.message, "invalid-reaction-socket-token");
        return true;
      },
    );
  }
});

test("sends voice and sticker payloads using authenticated HTTP independent of a socket", async () => {
  /**
   * @type {{ url: RequestInfo | URL; options: RequestInit | undefined; }[]}
   */
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response();
  };
  for (const kind of ["yo", "gg", "wahoo", "drop", "slurp", "sticker"]) {
    const value = reaction({
      kind,
      variation: kind === "sticker" ? 900316 : 1,
    });
    assert.deepEqual(
      await sendInviteReactionViaApi("invite", value, async () => "token"),
      { ok: true },
    );
    const call = calls.at(-1);
    assert.equal(
      required(call).url,
      "https://api.mons.link/invites/invite/reactions",
    );
    assert.equal(required(required(call).options).method, "POST");
    assert.equal(
      new Headers(required(required(call).options).headers).get(
        "Authorization",
      ),
      "Bearer token",
    );
    assert.equal(required(required(call).options).cache, "no-store");
    assert.deepEqual(
      parseRequestJson(required(required(call).options).body),
      value,
    );
    assert.equal(
      Object.hasOwn(
        parseRequestJson(required(required(call).options).body),
        "actorUid",
      ),
      false,
    );
  }
  assert.equal(
    getInviteReactionSocketUrl("invite"),
    "wss://api.mons.link/invites/invite/reactions/socket",
  );
});

test("refreshes auth exactly once after a 401 and reuses the same reaction UUID", async () => {
  /** @type {boolean[]} */
  const refreshes = [];
  /** @type {Array<BodyInit | null | undefined>} */
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(required(options).body);
    return bodies.length === 1 ? response({}, 401) : response();
  };
  const tokenProvider = async (/** @type {boolean} */ refresh) => {
    refreshes.push(refresh);
    return refresh ? "fresh" : "old";
  };
  await sendInviteReactionViaApi("invite", reaction(), tokenProvider);
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(bodies[0], bodies[1]);
  globalThis.fetch = async () => response({}, 401);
  await assert.rejects(
    sendInviteReactionViaApi("invite", reaction(), tokenProvider),
    { code: "http-401" },
  );
  assert.deepEqual(refreshes, [false, true, false, true]);
});

test("does not retry an ordinary server error or an uncertain network failure", async () => {
  for (const fail of [
    () => response({}, 503),
    () => {
      throw new Error("offline");
    },
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return fail();
    };
    await assert.rejects(
      sendInviteReactionViaApi("invite", reaction(), async () => "token"),
    );
    assert.equal(calls, 1);
  }
});

test("rejects invalid payloads and foreign matches before obtaining a token", async () => {
  let tokens = 0;
  const tokenProvider = async () => {
    tokens++;
    return "token";
  };
  for (const value of [
    reaction({ matchId: "other" }),
    reaction({ variation: 999 }),
    reaction({ kind: "unknown" }),
    reaction({ actorUid: "spoofed" }),
  ]) {
    await assert.rejects(
      sendInviteReactionViaApi("invite", value, tokenProvider),
      { code: "invalid-reaction" },
    );
  }
  assert.equal(tokens, 0);
});

test("aborts while waiting for a token and never sends after that token resolves", async () => {
  /** @type {Pick<PromiseWithResolvers<string>, "promise" | "resolve">} */
  const token = deferred();
  const controller = new AbortController();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return response();
  };
  const pending = sendInviteReactionViaApi(
    "invite",
    reaction(),
    () => token.promise,
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });
  token.resolve("late-token");
  await flush();
  assert.equal(fetches, 0);
  await assert.rejects(
    sendInviteReactionViaApi("invite", reaction(), async () => "token", {
      signal: controller.signal,
    }),
    { code: "aborted" },
  );
});

test("rejects auth-user replacement during token acquisition", async () => {
  /** @type {Pick<PromiseWithResolvers<string>, "promise" | "resolve">} */
  const token = deferred();
  let current = true;
  let fetches = 0;
  const provider = Object.assign(() => token.promise, {
    assertCurrentUser: () => {
      if (!current) throw new Error("authentication-changed");
    },
  });
  globalThis.fetch = async () => {
    fetches++;
    return response();
  };
  const pending = sendInviteReactionViaApi("invite", reaction(), provider);
  current = false;
  token.resolve("old-token");
  await assert.rejects(pending, /authentication-changed/);
  assert.equal(fetches, 0);
});

test("one five-second deadline covers token lookup and the refresh attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  /** @type {Pick<PromiseWithResolvers<string>, "promise" | "resolve">} */
  const token = deferred();
  /** @type {Array<boolean>} */
  /** @type {boolean[]} */
  const refreshes = [];
  globalThis.fetch = async () => response({}, 401);
  const pending = sendInviteReactionViaApi("invite", reaction(), (refresh) => {
    refreshes.push(refresh);
    return refresh ? token.promise : Promise.resolve("old");
  });
  const rejection = assert.rejects(pending, { code: "timeout" });
  await flush();
  assert.deepEqual(refreshes, [false, true]);
  t.mock.timers.tick(REACTION_SEND_TIMEOUT_MS);
  await rejection;
  token.resolve("late-fresh-token");
  await flush();
});

test("does not send after the deadline when the timeout callback is delayed", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  /** @type {Pick<PromiseWithResolvers<string>, "promise" | "resolve">} */
  const token = deferred();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return response();
  };
  const pending = sendInviteReactionViaApi(
    "invite",
    reaction(),
    () => token.promise,
  );
  const rejection = assert.rejects(pending, { code: "timeout" });
  now += REACTION_SEND_TIMEOUT_MS + 1;
  token.resolve("late-token");
  await rejection;
  assert.equal(fetches, 0);
});

test("cancels a response that arrives after the auth user changes", async () => {
  /** @type {Pick<PromiseWithResolvers<Response>, "promise" | "resolve">} */
  const request = deferred();
  let current = true;
  let canceled = false;
  const provider = Object.assign(async () => "token", {
    assertCurrentUser: () => {
      if (!current) throw new Error("authentication-changed");
    },
  });
  globalThis.fetch = () => request.promise;
  const pending = sendInviteReactionViaApi("invite", reaction(), provider);
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

test("context teardown cancels an active HTTP send", async () => {
  const controller = new AbortController();
  /** @type {AbortSignal | null | undefined} */
  let requestSignal;
  globalThis.fetch = async (_url, options) => {
    requestSignal = required(options).signal;
    return new Promise(() => {});
  };
  const pending = sendInviteReactionViaApi(
    "invite",
    reaction(),
    async () => "token",
    { signal: controller.signal },
  );
  await flush();
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });
  assert.equal(required(requestSignal).aborted, true);
});

test("bounds streamed responses and rejects malformed successful responses", async () => {
  let canceled = false;
  const oversized = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4097));
      },
      cancel() {
        canceled = true;
      },
    }),
  );
  for (const value of [
    response({ ok: false }),
    response({ ok: true, extra: true }),
    new Response("not-json"),
    oversized,
  ]) {
    globalThis.fetch = async () => value;
    await assert.rejects(
      sendInviteReactionViaApi("invite", reaction(), async () => "token"),
      { code: "invalid-response" },
    );
  }
  assert.equal(canceled, true);
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
