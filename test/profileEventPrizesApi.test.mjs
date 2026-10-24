import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import {
  isProfileEventPrizesResponse,
  MAX_PROFILE_EVENT_PRIZES_CURSOR_LENGTH,
  profileEventPrizesPageEtag,
} from "@mons/shared/event-prizes";
import { MAX_EVENT_READ_RESPONSE_BYTES } from "@mons/shared/events";

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

const { readProfileEventPrizesViaApi } =
  await import("../src/services/profileEventPrizesApi.ts");
const { GameplayApiError, GAMEPLAY_API_TIMEOUT_MS } =
  await import("../src/services/gameplayTransport.ts");
const { EventPollingRegistry } =
  await import("../src/connection/eventPollingRegistry.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");

const originalFetch = globalThis.fetch;
const epoch = "12345678-1234-1234-1234-123456789abc";
const nextEpoch = "87654321-1234-1234-1234-123456789abc";
const profileId = "profile-1";
const etag = (revision = 1, valueEpoch = epoch) =>
  profileEventPrizesPageEtag(valueEpoch, profileId, revision);
const bookmark = (sequence = 1, valueEpoch = epoch) =>
  `mons-d1-v1:${valueEpoch}:bookmark-${sequence}`;
const assignment = (eventId, extra = {}) => ({
  eventId,
  profileId,
  prizeId: "future-prize",
  place: 1,
  assignedAtMs: 10,
  ...extra,
});
const snapshot = (prizes = {}, revision = 1) => ({
  ok: true,
  profileId,
  revision,
  prizes,
});
const page = (prizes = {}, nextCursor = null, revision = 1) => ({
  ...snapshot(prizes, revision),
  nextCursor,
});
const response = (value, headers = {}) =>
  new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      ETag: etag(value.revision),
      "X-D1-Bookmark": bookmark(),
      ...headers,
    },
  });
const unchanged = (headers = {}) =>
  new Response(null, {
    status: 304,
    headers: { ETag: etag(), "X-D1-Bookmark": bookmark(), ...headers },
  });
const failure = (status, code, message) =>
  new Response(JSON.stringify({ ok: false, error: code, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const changed = () => failure(409, "aborted", "event-prizes-snapshot-changed");
const unauthorized = () =>
  failure(401, "unauthenticated", "authentication-required");
const unavailable = (error) =>
  error instanceof GameplayApiError && error.code === "unavailable";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function serve(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: new URL(url),
      ...init,
      headers: new Headers(init.headers),
    });
    assert.ok(responses.length > 0, "unexpected request");
    const next = responses.shift();
    return typeof next === "function" ? next() : next;
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("assembles all pages once with unknown assignment fields and final transport metadata", async () => {
  const first = assignment("event-A", { futureMetadata: { edition: 2 } });
  const second = assignment("event-a");
  const pending = deferred();
  const calls = serve([
    response(page({ "event-A": first }, "cursor-1"), {
      "X-D1-Bookmark": bookmark(2),
    }),
    () => pending.promise,
  ]);
  let settled = false;
  const read = readProfileEventPrizesViaApi(
    " profile-1 ",
    async () => "token",
    {
      etag: etag(0),
      bookmark: bookmark(1),
    },
  ).then((value) => {
    settled = true;
    return value;
  });
  await flush();
  assert.equal(settled, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.search, "?pagination=1");
  assert.equal(calls[0].headers.get("If-None-Match"), etag(0));
  assert.equal(calls[0].headers.get("X-D1-Bookmark"), bookmark(1));
  assert.equal(calls[1].url.searchParams.get("cursor"), "cursor-1");
  assert.equal(calls[1].headers.has("If-None-Match"), false);
  assert.equal(calls[1].headers.get("X-D1-Bookmark"), bookmark(2));
  assert.equal(calls[1].headers.get("Authorization"), "Bearer token");
  pending.resolve(
    response(page({ "event-a": second }), { "X-D1-Bookmark": bookmark(3) }),
  );
  const result = await read;
  assert.deepEqual(result, {
    kind: "modified",
    value: snapshot({ "event-A": first, "event-a": second }),
    etag: etag(),
    bookmark: bookmark(3),
  });
  assert.equal(isProfileEventPrizesResponse(result.value), true);
});

test("accepts a complete legacy first response during rollback", async () => {
  const value = snapshot({ "event-1": assignment("event-1") });
  const calls = serve([response(value, { ETag: 'W/"legacy-prizes-1"' })]);
  assert.deepEqual(
    await readProfileEventPrizesViaApi(profileId, async () => "token"),
    {
      kind: "modified",
      value,
      etag: 'W/"legacy-prizes-1"',
      bookmark: bookmark(),
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(isProfileEventPrizesResponse(page()), false);
});

test("accepts only a matching first-page conditional response", async () => {
  const calls = serve([unchanged({ "X-D1-Bookmark": bookmark(2) })]);
  assert.deepEqual(
    await readProfileEventPrizesViaApi(profileId, async () => "token", {
      etag: etag(),
      bookmark: bookmark(),
    }),
    { kind: "not-modified", etag: etag(), bookmark: bookmark(2) },
  );
  assert.equal(calls.length, 1);
  for (const [options, headers] of [
    [{}, {}],
    [{ etag: etag(0) }, {}],
    [{ etag: etag() }, { "X-D1-Bookmark": bookmark(2, nextEpoch) }],
  ]) {
    serve([unchanged(headers)]);
    await assert.rejects(
      readProfileEventPrizesViaApi(profileId, async () => "token", options),
      unavailable,
    );
  }
});

test("rejects invalid continuation metadata and partial legacy responses", async () => {
  const first = () =>
    response(page({ "event-1": assignment("event-1") }, "cursor-1"));
  const invalidResponses = [
    () => unchanged(),
    () => response(snapshot({ "event-2": assignment("event-2") })),
    () => response(page({ "event-1": assignment("event-1") })),
    () => response(page({ "event-2": assignment("event-2") }, "cursor-1")),
    () => response(page({}, "cursor-2")),
    () =>
      response(
        page(
          { "event-2": assignment("event-2") },
          "x".repeat(MAX_PROFILE_EVENT_PRIZES_CURSOR_LENGTH + 1),
        ),
      ),
    () => response(page({ "event-2": assignment("event-2") }, null, 2)),
    () =>
      response(page({ "event-2": assignment("event-2") }), { ETag: etag(2) }),
    () =>
      response(page({ "event-2": assignment("event-2") }), {
        ETag: etag(1, nextEpoch),
        "X-D1-Bookmark": bookmark(2, nextEpoch),
      }),
    () =>
      response(page({ "event-2": assignment("event-2") }), {
        "X-D1-Bookmark": "invalid",
      }),
    () => response({ ...page(), profileId: "profile-2" }),
    () =>
      response(
        page({ "event-2": assignment("event-2", { profileId: "profile-2" }) }),
      ),
    () => response(page({ "event-2": assignment("event-2") }), { ETag: "" }),
  ];
  for (const invalid of invalidResponses) {
    const calls = serve([first(), invalid()]);
    await assert.rejects(
      readProfileEventPrizesViaApi(profileId, async () => "token"),
      unavailable,
    );
    assert.equal(calls.length, 2);
  }
});

test("retains response byte limits for every page and cancels oversized bodies", async () => {
  let cancelled = false;
  const large = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_EVENT_READ_RESPONSE_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { ETag: etag(), "X-D1-Bookmark": bookmark() } },
  );
  serve([
    response(page({ "event-1": assignment("event-1") }, "cursor-1")),
    large,
  ]);
  await assert.rejects(
    readProfileEventPrizesViaApi(profileId, async () => "token"),
    unavailable,
  );
  assert.equal(cancelled, true);
});

test("assembles histories larger than one response without truncation", async () => {
  const first = assignment("first", { metadata: "a".repeat(350_000) });
  const last = assignment("last", { metadata: "b".repeat(350_000) });
  serve([response(page({ first }, "cursor-1")), response(page({ last }))]);
  const result = await readProfileEventPrizesViaApi(
    profileId,
    async () => "token",
  );
  assert.deepEqual(result.value, snapshot({ first, last }));
  assert.ok(
    JSON.stringify(result.value).length > MAX_EVENT_READ_RESPONSE_BYTES,
  );
});

test("restarts changed snapshots once from primary without retaining earlier prizes", async () => {
  const calls = serve([
    response(page({ stale: assignment("stale") }, "cursor-1")),
    changed(),
    response(page({ current: assignment("current") }, null, 2)),
  ]);
  const result = await readProfileEventPrizesViaApi(
    profileId,
    async () => "token",
    {
      etag: etag(0),
      bookmark: bookmark(),
    },
  );
  assert.deepEqual(
    result.value,
    snapshot({ current: assignment("current") }, 2),
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url.search, "?pagination=1");
  assert.equal(calls[2].headers.has("If-None-Match"), false);
  assert.equal(calls[2].headers.has("X-D1-Bookmark"), false);

  const repeated = serve([changed(), changed()]);
  await assert.rejects(
    readProfileEventPrizesViaApi(profileId, async () => "token"),
    (error) =>
      error instanceof GameplayApiError &&
      error.message === "event-prizes-snapshot-changed",
  );
  assert.equal(repeated.length, 2);
});

test("allows one authentication refresh across all pages and snapshot restarts", async () => {
  const forceRefresh = [];
  const token = async (force) => {
    forceRefresh.push(force);
    return "token";
  };
  const calls = serve([
    response(page({ first: assignment("first") }, "cursor-1")),
    unauthorized(),
    changed(),
    unauthorized(),
  ]);
  await assert.rejects(
    readProfileEventPrizesViaApi(profileId, token),
    (error) =>
      error instanceof GameplayApiError && error.code === "unauthenticated",
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(forceRefresh, [false, false, true, false]);
});

test("stops on user changes during a later-page response", async () => {
  const user = { uid: "one", getIdToken: async () => "token" };
  let currentUser = user;
  const calls = serve([
    response(page({ first: assignment("first") }, "cursor-1")),
    () => {
      currentUser = { ...user, uid: "two" };
      return response(page({ second: assignment("second") }, "cursor-2"));
    },
  ]);
  await assert.rejects(
    readProfileEventPrizesViaApi(
      profileId,
      createUserBoundAuthTokenProvider(user, () => currentUser),
    ),
    (error) =>
      error instanceof GameplayApiError && error.code === "unauthenticated",
  );
  assert.equal(calls.length, 2);
});

test("aborts stalled later-page bodies without returning partial history", async () => {
  const controller = new AbortController();
  let bodyCancelled = false;
  const calls = serve([
    response(page({ first: assignment("first") }, "cursor-1")),
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"ok":'));
        },
        cancel() {
          bodyCancelled = true;
        },
      }),
      { headers: { ETag: etag(), "X-D1-Bookmark": bookmark() } },
    ),
  ]);
  const read = readProfileEventPrizesViaApi(profileId, async () => "token", {
    signal: controller.signal,
  });
  await flush();
  controller.abort();
  await assert.rejects(
    read,
    (error) => error instanceof GameplayApiError && error.code === "aborted",
  );
  assert.equal(bodyCancelled, true);
  assert.equal(calls[1].signal.aborted, true);
});

test("uses one deadline across pages, restart, and token acquisition", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const laterToken = deferred();
  let tokenCalls = 0;
  const calls = serve([
    response(page({ first: assignment("first") }, "cursor-1")),
    changed(),
  ]);
  const token = async () => {
    tokenCalls++;
    if (tokenCalls === 1) t.mock.timers.tick(10_000);
    if (tokenCalls === 2) t.mock.timers.tick(10_000);
    if (tokenCalls === 3) return laterToken.promise;
    return "token";
  };
  const read = readProfileEventPrizesViaApi(profileId, token);
  await flush();
  assert.equal(tokenCalls, 3);
  const rejection = assert.rejects(
    read,
    (error) =>
      unavailable(error) && error.message === "Gameplay request timed out.",
  );
  t.mock.timers.tick(GAMEPLAY_API_TIMEOUT_MS - 20_000);
  await rejection;
  laterToken.resolve("token");
  await flush();
  assert.equal(calls.length, 2);
});

test("keeps the previous complete polling snapshot until every replacement page succeeds", async () => {
  const timers = new Map();
  let timerId = 0;
  const pending = deferred();
  const calls = serve([
    response(page({ old: assignment("old") })),
    response(page({ partial: assignment("partial") }, "cursor-1", 2)),
    failure(503, "unavailable", "temporarily-unavailable"),
    response(page({ next: assignment("next") }, "cursor-2", 3)),
    () => pending.promise,
  ]);
  const registry = new EventPollingRegistry({
    addVisibilityListener: () => () => {},
    clearTimer: (id) => timers.delete(id),
    isVisible: () => true,
    loadEvent: async () => {
      throw new Error("unexpected-event-read");
    },
    loadProfilePrizes: (id, options) =>
      readProfileEventPrizesViaApi(id, async () => "token", options),
    setTimer(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
  });
  const updates = [];
  const errors = [];
  const unsubscribe = registry.subscribeToProfileEventPrizes(
    profileId,
    (value) => updates.push(value),
    (error) => errors.push(error),
  );
  const runNext = async () => {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.callback();
    await flush();
  };
  await runNext();
  await runNext();
  assert.deepEqual(updates, [snapshot({ old: assignment("old") })]);
  assert.equal(errors.length, 1);
  await runNext();
  assert.equal(updates.length, 1);
  assert.equal(calls[3].headers.get("If-None-Match"), etag(1));
  assert.equal(calls[3].headers.get("X-D1-Bookmark"), bookmark(1));
  pending.resolve(
    response(page({ last: assignment("last") }, null, 3), {
      "X-D1-Bookmark": bookmark(5),
    }),
  );
  await flush();
  assert.deepEqual(updates, [
    snapshot({ old: assignment("old") }),
    snapshot({ next: assignment("next"), last: assignment("last") }, 3),
  ]);
  unsubscribe();
  assert.equal(timers.size, 0);
});

test("drops an in-flight paginated read after polling invalidation, hiding, reset, or unsubscribe", async () => {
  for (const action of ["invalidate", "hide", "reset", "unsubscribe"]) {
    const timers = new Map();
    let timerId = 0;
    let visible = true;
    let onVisibility = () => {};
    const pending = deferred();
    const calls = serve([
      response(page({ first: assignment("first") }, "cursor-1")),
      () => pending.promise,
    ]);
    const registry = new EventPollingRegistry({
      addVisibilityListener: (listener) => {
        onVisibility = listener;
        return () => {};
      },
      clearTimer: (id) => timers.delete(id),
      isVisible: () => visible,
      loadEvent: async () => {
        throw new Error("unexpected-event-read");
      },
      loadProfilePrizes: (id, options) =>
        readProfileEventPrizesViaApi(id, async () => "token", options),
      setTimer(callback) {
        const id = ++timerId;
        timers.set(id, callback);
        return id;
      },
    });
    const updates = [];
    const errors = [];
    const unsubscribe = registry.subscribeToProfileEventPrizes(
      profileId,
      (value) => updates.push(value),
      (error) => errors.push(error),
    );
    const [id, callback] = timers.entries().next().value;
    timers.delete(id);
    callback();
    await flush();
    assert.equal(calls.length, 2);
    if (action === "invalidate") registry.invalidateProfileEventPrizes();
    if (action === "reset") registry.reset();
    if (action === "unsubscribe") unsubscribe();
    if (action === "hide") {
      visible = false;
      onVisibility();
    }
    assert.equal(calls[1].signal.aborted, true);
    pending.resolve(response(page({ last: assignment("last") })));
    await flush();
    assert.deepEqual(updates, action === "reset" ? [snapshot({}, 0)] : []);
    assert.deepEqual(errors, []);
    assert.equal(calls.length, 2);
    unsubscribe();
  }
});
