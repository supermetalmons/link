import assert from "node:assert/strict";
import test from "node:test";
import {
  PRESENTATION_REQUEST_TIMEOUT_MS,
  readMatchPresentationViaApi,
  updateMatchPresentationViaApi,
} from "../src/services/matchPresentationApi.ts";

const originalFetch = globalThis.fetch;
const presentation = (overrides = {}) => ({
  matchId: "invite",
  actorUid: "host",
  emojiId: 3,
  aura: "",
  revision: 1,
  ...overrides,
});
const request = (overrides = {}) => ({
  operationId: "00000000-0000-4000-8000-000000000001",
  expectedRevision: 0,
  emojiId: 3,
  aura: "",
  ...overrides,
});
const response = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("reads public and authenticated snapshots without leaking identity into the URL", async () => {
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
    calls[0].url,
    "https://api.mons.link/invites/invite/matches/invite/presentation",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, "Bearer token");
  assert.equal(calls[1].options.cache, "no-store");
  assert.equal(calls[1].options.redirect, "error");
});

test("updates presentation with one token refresh and an unchanged operation", async () => {
  const calls = [];
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
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(JSON.parse(calls[0].body), request());
  assert.equal(calls[1].headers.Authorization, "Bearer fresh");
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
    request({ actorUid: "spoofed" }),
    request({ emojiId: 3, aura: "rainbow" }),
  ]) {
    await assert.rejects(
      updateMatchPresentationViaApi("invite", "invite", value, tokenProvider),
      { code: "invalid-match-presentation" },
    );
  }
  for (const [inviteId, matchId] of [
    ["invite", "other"],
    ["invite", "invite/1"],
    ["invite", "invite01"],
    ["", ""],
    [" invite", " invite"],
  ]) {
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
