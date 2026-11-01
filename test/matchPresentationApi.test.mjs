import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  PRESENTATION_REQUEST_TIMEOUT_MS,
  MatchPresentationApiError,
  readMatchPresentationViaApi,
  updateMatchPresentationViaApi,
} from "../src/services/matchPresentationApi.ts";

const originalFetch = globalThis.fetch;
const presentation = (overrides = {}) => ({
  matchId: "invite",
  actorUid: "host",
  emojiId: 3,
  aura: "none",
  revision: 1,
  ...overrides,
});
/** @param {Partial<import("@mons/shared/match-presentation").UpdateMatchPresentationRequest>} [overrides] @returns {import("@mons/shared/match-presentation").UpdateMatchPresentationRequest} */
const request = (overrides = {}) => ({
  operationId: "00000000-0000-4000-8000-000000000001",
  expectedRevision: 0,
  emojiId: 3,
  aura: "none",
  ...overrides,
});
/**
 * @param {unknown} payload
 * @param {number} [status]
 */
const response = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status });
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

test("reads public and authenticated snapshots without leaking identity into the URL", async () => {
  /** @type {Array<{ url: RequestInfo | URL; options: RequestInit | undefined; }>} */
  const calls = [];
  const snapshot = {
    matchId: "invite",
    players: { host: presentation() },
  };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response({ ok: true, presentation: snapshot });
  };
  assert.deepEqual(await readMatchPresentationViaApi("invite", "invite"), {
    ok: true,
    presentation: snapshot,
  });
  await readMatchPresentationViaApi("invite", "invite", async () => "token");
  assert.equal(
    required(calls[0]).url,
    "https://api.mons.link/invites/invite/matches/invite/presentation",
  );
  assert.equal(required(required(calls[0]).options).method, "GET");
  assert.equal(required(required(calls[0]).options).body, undefined);
  assert.equal(
    new Headers(required(required(calls[0]).options).headers).get(
      "Authorization",
    ),
    null,
  );
  assert.equal(
    new Headers(required(required(calls[1]).options).headers).get(
      "Authorization",
    ),
    "Bearer token",
  );
  assert.equal(required(required(calls[1]).options).cache, "no-store");
  assert.equal(required(required(calls[1]).options).redirect, "error");
});

test("updates presentation with one token refresh and an unchanged operation", async () => {
  /**
   * @type {Array<RequestInit | undefined>}
   */
  const calls = [];
  /** @type {Array<boolean>} */
  const refreshes = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(options);
    return calls.length === 1
      ? response({}, 401)
      : response({ ok: true, presentation: presentation() });
  };
  const result = await updateMatchPresentationViaApi(
    "invite",
    "invite",
    request(),
    async (refresh) => {
      refreshes.push(refresh);
      return refresh ? "fresh" : "stale";
    },
  );
  assert.deepEqual(result, { ok: true, presentation: presentation() });
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(required(calls[0]).method, "POST");
  assert.equal(required(calls[0]).body, required(calls[1]).body);
  assert.deepEqual(parseRequestJson(required(calls[0]).body), request());
  assert.equal(
    new Headers(required(calls[1]).headers).get("Authorization"),
    "Bearer fresh",
  );
});

test("exposes canonical conflict state without replaying the update", async () => {
  let calls = 0;
  const current = presentation({ emojiId: 7, revision: 4 });
  globalThis.fetch = async () => {
    calls++;
    return response(
      { ok: false, error: "presentation-conflict", presentation: current },
      409,
    );
  };
  await assert.rejects(
    updateMatchPresentationViaApi(
      "invite",
      "invite",
      request(),
      async () => "token",
    ),
    (error) => {
      assert.ok(error instanceof MatchPresentationApiError);
      assert.equal(error.code, "presentation-conflict");
      assert.deepEqual(error.presentation, current);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("rejects invalid values, foreign matches, and path injection before authentication", async () => {
  let tokens = 0;
  const tokenProvider = async () => {
    tokens++;
    return "token";
  };
  for (const value of [
    request({ expectedRevision: -1 }),
    request({ operationId: "invalid" }),
    { ...request(), actorUid: "spoofed" },
    request({ emojiId: 3, aura: "rainbow" }),
  ]) {
    await assert.rejects(
      updateMatchPresentationViaApi("invite", "invite", value, tokenProvider),
      { code: "invalid-match-presentation" },
    );
  }
  /** @type {Array<[string, string]>} */
  const paths = [
    ["invite", "other"],
    ["invite", "invite/1"],
    ["invite", "invite01"],
    ["", ""],
    [" invite", " invite"],
  ];
  for (const [inviteId, matchId] of paths) {
    await assert.rejects(
      readMatchPresentationViaApi(inviteId, matchId, tokenProvider),
      { code: "invalid-match-presentation" },
    );
  }
  assert.equal(tokens, 0);
});

test("rejects foreign, malformed, and oversized successful responses", async () => {
  let canceled = false;
  for (const payload of [
    response({ ok: true, presentation: presentation({ matchId: "other" }) }),
    response({ ok: true, presentation: presentation({ revision: -1 }) }),
    response({ ok: true, presentation: presentation(), unexpected: true }),
    new Response("not-json"),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16385));
        },
        cancel() {
          canceled = true;
        },
      }),
    ),
  ]) {
    globalThis.fetch = async () => payload;
    await assert.rejects(
      updateMatchPresentationViaApi(
        "invite",
        "invite",
        request(),
        async () => "token",
      ),
      { code: "invalid-response" },
    );
  }
  assert.equal(canceled, true);
});

test("context cancellation prevents a late token from sending", async () => {
  /** @type {Pick<PromiseWithResolvers<string>, "promise" | "resolve">} */
  const token = deferred();
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response({ ok: true, presentation: presentation() });
  };
  const pending = updateMatchPresentationViaApi(
    "invite",
    "invite",
    request(),
    () => token.promise,
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });
  token.resolve("old-token");
  await flush();
  assert.equal(calls, 0);
});

test("one deadline bounds token lookup and ambiguous requests without retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Promise(() => {});
  };
  const pending = updateMatchPresentationViaApi(
    "invite",
    "invite",
    request(),
    async () => "token",
  );
  const rejection = assert.rejects(pending, { code: "timeout" });
  await flush();
  t.mock.timers.tick(PRESENTATION_REQUEST_TIMEOUT_MS);
  await rejection;
  assert.equal(calls, 1);
});

test("rejects changed auth during token acquisition and response consumption", async () => {
  /** @type {Pick<PromiseWithResolvers<string>, "promise" | "resolve">} */
  const token = deferred();
  let current = true;
  let fetches = 0;
  const provider = Object.assign(() => token.promise, {
    assertCurrentUser() {
      if (!current) throw new Error("authentication-changed");
    },
  });
  globalThis.fetch = async () => {
    fetches++;
    return response({ ok: true, presentation: presentation() });
  };
  const pending = updateMatchPresentationViaApi(
    "invite",
    "invite",
    request(),
    provider,
  );
  current = false;
  token.resolve("late-token");
  await assert.rejects(pending, /authentication-changed/);
  assert.equal(fetches, 0);
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
