import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    )
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { createInitialEventBootstrap } =
  await import("../src/services/initialEventBootstrap.ts");
const { SessionAuth } = await import("../src/session/sessionAuth.ts");
const { eventSnapshotEtag } = await import("@mons/shared/events");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const eventRoute = (eventId = "event-a") => ({
  mode: "event",
  path: `event/${eventId}`,
  inviteId: null,
  snapshotId: null,
  eventId,
  autojoin: false,
});
const seed = () => ({
  snapshot: {
    ok: true,
    eventId: "event-a",
    revision: 1,
    event: { eventId: "event-a", status: "scheduled" },
    prizeSelections: {},
  },
  etag: eventSnapshotEtag("event-a", 1),
  bookmark: "mons-d1-v1:11111111-1111-4111-8111-111111111111:bookmark-1",
});
const readResponse = () => ({
  kind: "modified",
  value: seed().snapshot,
  etag: seed().etag,
  bookmark: seed().bookmark,
});

function fixture({
  combined = false,
  anonymous = false,
  route = eventRoute(),
} = {}) {
  const preparation = deferred();
  const response = deferred();
  const user = {
    uid: "a".repeat(28),
    sessionId: "session-a",
    generation: "generation-a",
    getIdToken: async () => "token",
  };
  const requests = [];
  const preparations = [];
  const authListeners = new Set();
  const routeListeners = new Set();
  const auth = {
    currentUser: anonymous ? null : user,
    async prepareInitialEvent(eventId, options) {
      preparations.push({ eventId, options });
      options.onSessionBound?.(user);
      if (combined) return preparation.promise;
      return { user, bootstrap: null };
    },
    onAuthStateChanged(listener) {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
  };
  const bootstrap = createInitialEventBootstrap({
    auth,
    route: () => route,
    subscribeRoute(listener) {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
    async read(eventId, tokenProvider, options) {
      requests.push({ eventId, options });
      tokenProvider.assertCurrentUser();
      return response.promise;
    },
  });
  return {
    bootstrap,
    user,
    auth,
    preparations,
    requests,
    preparation,
    response,
    authListeners,
    routeListeners,
    start: () => bootstrap.start(route),
    navigate(next) {
      route = next;
      routeListeners.forEach((listener) => listener(route));
    },
    changeUser(next) {
      auth.currentUser = next;
      authListeners.forEach((listener) => listener(next));
    },
  };
}

test("early event GET is consumed once before or after completion", async () => {
  for (const completedFirst of [false, true]) {
    const h = fixture();
    h.start();
    h.start();
    await flush();
    assert.equal(h.requests.length, 1);
    const result = readResponse();
    if (completedFirst) {
      h.response.resolve(result);
      await flush();
    }
    const taken = h.bootstrap.take("event-a", h.user);
    assert.ok(taken);
    assert.equal(h.bootstrap.take("event-a", h.user), null);
    assert.equal(h.authListeners.size, 0);
    assert.equal(h.routeListeners.size, 0);
    h.response.resolve(result);
    assert.equal(await taken.promise, result);
    assert.equal(h.requests.length, 1);
  }
});

test("inline seed avoids a GET and is adoptable when the first anonymous user is published", async () => {
  const h = fixture({ combined: true, anonymous: true });
  h.start();
  h.changeUser(h.user);
  const taken = h.bootstrap.take("event-a", h.user);
  assert.ok(taken);
  h.preparation.resolve({ user: h.user, bootstrap: seed() });
  assert.deepEqual(await taken.promise, readResponse());
  assert.equal(h.requests.length, 0);
  assert.equal(h.bootstrap.take("event-a", h.user), null);
});

test("real anonymous session creation publishes one consumable event seed without a refresh or GET", async () => {
  let state = {
    initialized: true,
    generation: crypto.randomUUID(),
    revision: 1,
    revocations: [],
    session: null,
  };
  const requests = [];
  const auth = new SessionAuth({
    store: {
      async update(change) {
        state = structuredClone(change(structuredClone(state)));
        return state;
      },
    },
    api: {
      async create(session, target) {
        requests.push(target);
        return {
          ok: true,
          uid: "a".repeat(28),
          sessionId: session.sessionId,
          accessToken: "token-a",
          accessExpiresAtMs: 1_300_000,
          accessDeadlineMs: 1_300_000,
          eventBootstrap: { ...target, result: seed() },
        };
      },
      async refresh() {
        assert.fail("unexpected refresh");
      },
      async revoke() {},
    },
    now: () => 1_000_000,
    createSession: () => ({
      sessionId: crypto.randomUUID(),
      uid: null,
      refreshSecret: "refresh",
      revokeSecret: "revoke",
    }),
    newGeneration: () => crypto.randomUUID(),
  });
  const bootstrap = createInitialEventBootstrap({
    auth,
    route: eventRoute,
    subscribeRoute: () => () => {},
    read: async () => assert.fail("unexpected event GET"),
  });
  let taken;
  const unsubscribe = auth.onAuthStateChanged((user) => {
    if (user) taken = bootstrap.take("event-a", user);
  });
  try {
    bootstrap.start(eventRoute());
    await auth.signInAnonymously();
    assert.ok(taken);
    assert.deepEqual(await taken.promise, readResponse());
    assert.deepEqual(requests, [{ eventId: "event-a" }]);
    assert.equal(bootstrap.take("event-a", auth.currentUser), null);
    assert.equal("eventBootstrap" in auth.access, false);
  } finally {
    unsubscribe();
  }
});

test("legacy, malformed and failed enrichments fall back to one ordinary GET", async () => {
  for (const bootstrap of [
    null,
    {},
    { ok: false, status: 503 },
    { ok: false, status: 429 },
  ]) {
    const h = fixture({ combined: true });
    h.start();
    h.preparation.resolve({ user: h.user, bootstrap });
    await flush();
    assert.equal(h.requests.length, 1);
    const taken = h.bootstrap.take("event-a", h.user);
    h.response.resolve(readResponse());
    assert.deepEqual(await taken.promise, readResponse());
    assert.equal(h.requests.length, 1);
  }
});

test("leaving the event discards even a completed result and returning cannot reuse it", async () => {
  const h = fixture();
  h.start();
  await flush();
  h.response.resolve(readResponse());
  await flush();
  h.navigate(eventRoute("event-b"));
  h.navigate(eventRoute());
  assert.equal(h.bootstrap.take("event-a", h.user), null);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.authListeners.size, 0);
  assert.equal(h.routeListeners.size, 0);
});

test("same-UID session replacement cannot adopt an anonymous pending result", async () => {
  for (const notify of [false, true]) {
    const h = fixture({ combined: true, anonymous: true });
    h.start();
    const replacement = { ...h.user, generation: "next-generation" };
    if (notify) h.changeUser(replacement);
    else h.auth.currentUser = replacement;
    assert.equal(h.bootstrap.take("event-a", replacement), null);
    assert.equal(h.preparations[0].options.signal.aborted, true);
    h.preparation.resolve({ user: h.user, bootstrap: seed() });
    await flush();
    assert.equal(h.requests.length, 0);
  }
});

test("adopted requests remain fenced by caller abort, route and auth ownership", async () => {
  for (const change of ["abort", "route", "auth"]) {
    const h = fixture();
    h.start();
    await flush();
    const taken = h.bootstrap.take("event-a", h.user);
    const rejected = assert.rejects(
      taken.promise,
      /canceled|authentication-changed/,
    );
    if (change === "abort") taken.abort();
    else if (change === "route") h.navigate(eventRoute("event-b"));
    else h.changeUser({ ...h.user });
    h.response.resolve(readResponse());
    await rejected;
  }
});

test("an early GET failure is adopted rather than duplicated immediately", async () => {
  const h = fixture();
  h.start();
  await flush();
  h.response.reject(new Error("unavailable"));
  await flush();
  const taken = h.bootstrap.take("event-a", h.user);
  assert.ok(taken);
  await assert.rejects(taken.promise, /unavailable/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.authListeners.size, 0);
  assert.equal(h.routeListeners.size, 0);
});

test("non-invite event overlays start early, while game invite bootstrap keeps priority", async () => {
  for (const route of [
    { ...eventRoute(), mode: "home", path: "" },
    { ...eventRoute(), mode: "snapshot", snapshotId: "snapshot-a" },
  ]) {
    const h = fixture({ route });
    h.start();
    await flush();
    assert.equal(h.requests.length, 1);
    h.response.resolve(readResponse());
    await h.bootstrap.take("event-a", h.user).promise;
  }
  for (const route of [
    { ...eventRoute(), eventId: null },
    { ...eventRoute(), mode: "invite", inviteId: "game-a" },
  ]) {
    const h = fixture({ route });
    h.start();
    await flush();
    assert.equal(h.preparations.length, 0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.bootstrap.take("event-a", h.user), null);
  }
});
