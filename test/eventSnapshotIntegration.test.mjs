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

const { SessionAuth } = await import("../src/session/sessionAuth.ts");
const { createInitialEventBootstrap } =
  await import("../src/services/initialEventBootstrap.ts");
const { EVENT_POLL_INTERVAL_MS } =
  await import("../src/connection/eventPollingRegistry.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");
const { GAMEPLAY_API_TIMEOUT_MS } =
  await import("../src/services/gameplayApi.ts");
const { EventClient } = await import("../src/connection/eventClient.ts");
const { mapDatabaseEventRecord } =
  await import("../src/connection/eventMappers.ts");
const { eventSnapshotEtag } = await import("@mons/shared/events");
const { createEventPrizeSelectionCoordinator } =
  await import("../src/ui/event/prizeSelectionCoordinator.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const route = () => ({
  mode: "event",
  path: "event/NN3eRzoZo80",
  inviteId: null,
  snapshotId: null,
  eventId: "NN3eRzoZo80",
  autojoin: false,
});
const seed = (revision = 1) => ({
  snapshot: {
    ok: true,
    eventId: "NN3eRzoZo80",
    revision,
    event: mapDatabaseEventRecord(
      {
        eventId: "NN3eRzoZo80",
        status: "scheduled",
        startAtMs: revision * 1000,
      },
      "NN3eRzoZo80",
    ),
    prizeSelections: {
      "profile-a": ["1092", "1111", "1514"][(revision - 1) % 3],
    },
  },
  etag: eventSnapshotEtag("NN3eRzoZo80", revision),
  bookmark: `mons-d1-v1:11111111-1111-4111-8111-111111111111:bookmark-${revision}`,
});
const modified = (value = seed()) => ({
  kind: "modified",
  value: value.snapshot,
  etag: value.etag,
  bookmark: value.bookmark,
});

function fixture({
  restored = false,
  enrichment = true,
  eventRead,
  postponeEvent,
  createEvent,
  syncEvent,
  authenticate,
} = {}) {
  const session = {
    sessionId: crypto.randomUUID(),
    uid: restored ? "a".repeat(28) : null,
    refreshSecret: "refresh",
    revokeSecret: "revoke",
  };
  let state = {
    initialized: true,
    generation: crypto.randomUUID(),
    revision: 1,
    revocations: [],
    session: restored ? session : null,
  };
  const gate = deferred();
  const dispatched = deferred();
  const authRequests = [];
  const readRequests = [];
  const takeRequests = [];
  const timers = new Map();
  let timerId = 0;
  const tokenRequest = async (session, target) => {
    authRequests.push(target);
    dispatched.resolve();
    await gate.promise;
    return {
      ok: true,
      uid: "a".repeat(28),
      sessionId: session.sessionId,
      accessToken: "token-a",
      accessExpiresAtMs: 1_300_000,
      accessDeadlineMs: 1_300_000,
      ...(target && enrichment
        ? { eventBootstrap: { ...target, result: seed() } }
        : {}),
    };
  };
  const auth = new SessionAuth({
    store: {
      async update(change) {
        state = structuredClone(change(structuredClone(state)));
        return state;
      },
    },
    api: {
      create: tokenRequest,
      refresh: tokenRequest,
      revoke: async () => {},
    },
    now: () => 1_000_000,
    createSession: () => session,
    newGeneration: () => crypto.randomUUID(),
  });
  const read = async (eventId, provider, options) => {
    readRequests.push({ eventId, options });
    await provider(false);
    provider.assertCurrentUser();
    return eventRead ? eventRead(eventId, options) : modified();
  };
  const bootstrap = createInitialEventBootstrap({
    auth,
    read,
    route,
    subscribeRoute: () => () => {},
  });
  let creationSeed = seed();
  const ensureAuthenticated = async () => {
    if (authenticate) return authenticate();
    await auth.authStateReady();
    if (!auth.currentUser) await auth.signInAnonymously();
  };
  const tokenProvider = () =>
    createUserBoundAuthTokenProvider(auth.currentUser, () => auth.currentUser);
  const connection = new EventClient({
    getCurrentUser: () => auth.currentUser,
    onAuthStateChanged: (listener) => auth.onAuthStateChanged(listener),
    ensureAuthenticated,
    getUserBoundAuthTokenProvider: tokenProvider,
    createPollingAuthTokenProvider: tokenProvider,
    getLocalProfileId: () => "profile-a",
    getFallbackLoginUid: () => null,
    takeInitialEventBootstrap: (...args) => {
      takeRequests.push(args);
      return bootstrap.take(...args);
    },
    api: {
      readEventSnapshotViaApi: read,
      readProfileEventPrizesViaApi: async () =>
        assert.fail("unexpected profile read"),
      postponeEventStartViaApi: postponeEvent,
      createEventViaApi: async () =>
        createEvent
          ? createEvent()
          : {
              ok: true,
              eventId: "NN3eRzoZo80",
              event: creationSeed.snapshot.event,
              eventSnapshot: creationSeed,
            },
      syncEventStateViaApi: syncEvent,
      toggleEventPrizeSelectionViaApi: async ({ eventId, prizeId }) => ({
        ok: true,
        eventId,
        selectedPrizeId: prizeId,
      }),
    },
    now: () => Date.now(),
    addVisibilityListener: () => () => {},
    clearTimer: (id) => timers.delete(id),
    isVisible: () => true,
    setTimer(callback, delayMs) {
      const id = ++timerId;
      timers.set(id, { callback, delayMs });
      return id;
    },
    notifyNavigationGamesChanged: () => {},
  });
  return {
    auth,
    bootstrap,
    connection,
    timers,
    async create(value) {
      creationSeed = value;
      return connection.createEvent(5);
    },
    currentEvent() {
      let event;
      connection.subscribeToEvent("NN3eRzoZo80", (value) => (event = value))();
      return event;
    },
    authRequests,
    readRequests,
    takeRequests,
    gate,
    dispatched,
    async runNext(delayMs) {
      const next =
        delayMs === undefined
          ? [...timers.entries()].sort((a, b) => a[1].delayMs - b[1].delayMs)[0]
          : [...timers.entries()].find(
              ([, timer]) => timer.delayMs === delayMs,
            );
      assert.ok(next, `missing timer ${delayMs ?? "next"}`);
      const [id, timer] = next;
      timers.delete(id);
      timer.callback();
      await flush();
      return timer.delayMs;
    },
  };
}

for (const restored of [false, true]) {
  test(`${restored ? "restored" : "anonymous"} auth reset preserves pending bootstrap for the event poller`, async () => {
    const h = fixture({ restored });
    const events = [];
    const selections = [];
    h.bootstrap.start(route());
    const unsubscribe = h.connection.subscribeToEvent("NN3eRzoZo80", (event) =>
      events.push(event),
    );
    const unsubscribeSelections = h.connection.subscribeToEventPrizeSelections(
      "NN3eRzoZo80",
      (value) => selections.push(value),
    );
    assert.equal(await h.runNext(), 0);
    await h.dispatched.promise;
    assert.equal(h.authRequests.length, 1);
    h.gate.resolve();
    await flush();
    if (!events.some((event) => event !== null)) await h.runNext();
    assert.deepEqual(events.filter(Boolean), [seed().snapshot.event]);
    assert.deepEqual(
      selections.filter((value) => Object.keys(value).length),
      [seed().snapshot.prizeSelections],
    );
    assert.equal(h.readRequests.length, 0);
    assert.deepEqual(h.authRequests, [{ eventId: "NN3eRzoZo80" }]);
    assert.equal([...h.timers.values()][0].delayMs, EVENT_POLL_INTERVAL_MS);
    unsubscribe();
    unsubscribeSelections();
    assert.equal(h.timers.size, 0);
  });
}

test("a legacy session response yields one shared early event GET for both modal subscribers", async () => {
  const h = fixture({ enrichment: false });
  const events = [];
  h.bootstrap.start(route());
  const unsubscribe = h.connection.subscribeToEvent("NN3eRzoZo80", (value) =>
    events.push(value),
  );
  const unsubscribeSelections = h.connection.subscribeToEventPrizeSelections(
    "NN3eRzoZo80",
    () => {},
  );
  await h.runNext();
  await h.dispatched.promise;
  h.gate.resolve();
  await flush();
  if (!events.some(Boolean)) await h.runNext();
  assert.equal(h.authRequests.length, 1);
  assert.equal(h.readRequests.length, 1);
  assert.deepEqual(events.filter(Boolean), [seed().snapshot.event]);
  unsubscribe();
  unsubscribeSelections();
});

test("a create response seeded before opening displays immediately without another GET", async () => {
  const h = fixture();
  h.gate.resolve();
  await h.auth.signInAnonymously();
  assert.deepEqual((await h.create(seed(2))).event, seed(2).snapshot.event);
  const events = [];
  const fresh = [];
  const unsubscribeFreshness = h.connection.subscribeToEventFreshness(
    "NN3eRzoZo80",
    (value) => fresh.push(value),
  );
  const unsubscribe = h.connection.subscribeToEvent("NN3eRzoZo80", (value) =>
    events.push(value),
  );
  assert.deepEqual(events, [seed(2).snapshot.event]);
  assert.deepEqual(fresh, [false, true]);
  assert.ok([...h.timers.values()][0].delayMs > 0);
  assert.equal(h.readRequests.length, 0);
  unsubscribe();
  unsubscribeFreshness();
  h.connection.reset({ preserveSnapshots: true });
  const reopened = [];
  const close = h.connection.subscribeToEvent("NN3eRzoZo80", (value) =>
    reopened.push(value),
  );
  assert.deepEqual(reopened, [seed(2).snapshot.event]);
  assert.equal([...h.timers.values()][0].delayMs, 0);
  assert.equal(h.readRequests.length, 0);
  close();
});

test("a delayed postpone snapshot preserves a newer acknowledged prize while restarting its primary refresh", async () => {
  const postpone = deferred();
  const primaryRead = deferred();
  const replacementRead = deferred();
  let reads = 0;
  const h = fixture({
    eventRead: () =>
      ++reads === 1 ? primaryRead.promise : replacementRead.promise,
    postponeEvent: () => postpone.promise,
  });
  h.gate.resolve();
  await h.auth.signInAnonymously();
  const initial = seed(1);
  initial.snapshot.prizeSelections = {};
  await h.create(initial);
  const selections = [];
  const coordinator = createEventPrizeSelectionCoordinator({
    profileId: "profile-a",
    onPendingChange: () => {},
    onSelectionsChange: (value) => selections.push(value),
    mutate: (prizeId) =>
      h.connection.toggleEventPrizeSelection("NN3eRzoZo80", prizeId),
  });
  const unsubscribe = h.connection.subscribeToEventPrizeSelections(
    "NN3eRzoZo80",
    coordinator.receiveAuthoritative,
  );
  const pendingPostpone = h.connection.postponeEventStart("NN3eRzoZo80", 5);
  await flush();
  coordinator.toggle("1092");
  await flush();
  await h.runNext();
  assert.deepEqual(selections.at(-1), { "profile-a": "1092" });
  assert.equal(h.readRequests[0].options.bookmark, null);
  const older = seed(2);
  older.snapshot.prizeSelections = {};
  postpone.resolve({
    ok: true,
    eventId: "NN3eRzoZo80",
    event: older.snapshot.event,
    eventSnapshot: older,
    postponeByMinutes: 5,
    startAtMs: 2000,
  });
  await pendingPostpone;
  await flush();
  assert.deepEqual(selections.at(-1), { "profile-a": "1092" });
  assert.equal(h.readRequests[0].options.signal.aborted, true);
  assert.equal(await h.runNext(), 0);
  assert.equal(h.readRequests.length, 2);
  assert.equal(h.readRequests[1].options.bookmark, null);
  const latest = seed(3);
  latest.snapshot.prizeSelections = { "profile-a": "1092" };
  replacementRead.resolve(modified(latest));
  await flush();
  assert.equal(h.currentEvent().startAtMs, 3000);
  primaryRead.resolve(modified(older));
  await flush();
  assert.equal(h.currentEvent().startAtMs, 3000);
  assert.deepEqual(selections.at(-1), { "profile-a": "1092" });
  unsubscribe();
  coordinator.dispose();
});

for (const withSnapshot of [false, true]) {
  test(`a postponed event receives a primary refresh after an overlapping prize refresh completes (${withSnapshot ? "rejected seed" : "legacy response"})`, async () => {
    const postpone = deferred();
    const beforePostpone = seed(2);
    beforePostpone.snapshot.event = seed(1).snapshot.event;
    beforePostpone.snapshot.prizeSelections = { "profile-a": "1092" };
    const afterPostpone = seed(3);
    afterPostpone.snapshot.prizeSelections = { "profile-a": "1092" };
    let committed = false;
    const h = fixture({
      eventRead: (_eventId, options) =>
        modified(
          committed && options.bookmark === null
            ? afterPostpone
            : beforePostpone,
        ),
      postponeEvent: () => postpone.promise,
    });
    h.gate.resolve();
    await h.auth.signInAnonymously();
    await h.create(seed(1));
    const events = [];
    const unsubscribe = h.connection.subscribeToEvent("NN3eRzoZo80", (value) =>
      events.push(value),
    );
    const pendingPostpone = h.connection.postponeEventStart("NN3eRzoZo80", 5);
    await flush();
    await h.connection.toggleEventPrizeSelection("NN3eRzoZo80", "1092");
    assert.equal(await h.runNext(), 0);
    assert.equal(h.currentEvent().startAtMs, 1000);
    committed = true;
    postpone.resolve({
      ok: true,
      eventId: "NN3eRzoZo80",
      event: afterPostpone.snapshot.event,
      ...(withSnapshot ? { eventSnapshot: afterPostpone } : {}),
      postponeByMinutes: 5,
      startAtMs: 3000,
    });
    await pendingPostpone;
    assert.deepEqual(events.at(-1), beforePostpone.snapshot.event);
    assert.equal(await h.runNext(), 0);
    assert.equal(h.readRequests.length, 2);
    assert.equal(h.readRequests[1].options.bookmark, null);
    assert.deepEqual(events.at(-1), afterPostpone.snapshot.event);
    const selections = [];
    const closeSelections = h.connection.subscribeToEventPrizeSelections(
      "NN3eRzoZo80",
      (value) => selections.push(value),
    );
    assert.deepEqual(selections.at(-1), { "profile-a": "1092" });
    closeSelections();
    unsubscribe();
  });
}

test("a postpone completion from an earlier auth generation cannot restart the current owner's reads", async () => {
  const postpone = deferred();
  const h = fixture({
    eventRead: () => modified(seed(4)),
    postponeEvent: () => postpone.promise,
  });
  h.gate.resolve();
  await h.auth.signInAnonymously();
  await h.create(seed(1));
  const unsubscribe = h.connection.subscribeToEvent("NN3eRzoZo80", () => {});
  const pendingPostpone = h.connection.postponeEventStart("NN3eRzoZo80", 5);
  await flush();
  h.connection.reset();
  assert.equal(await h.runNext(), 0);
  const timer = [...h.timers.entries()][0];
  postpone.resolve({
    ok: true,
    eventId: "NN3eRzoZo80",
    event: seed(2).snapshot.event,
    eventSnapshot: seed(2),
    postponeByMinutes: 5,
    startAtMs: 2000,
  });
  await pendingPostpone;
  assert.equal(h.currentEvent().startAtMs, 4000);
  assert.equal(h.readRequests.length, 1);
  assert.deepEqual([...h.timers.entries()], [timer]);
  assert.equal(timer[1].delayMs, EVENT_POLL_INTERVAL_MS);
  unsubscribe();
});

test("late legacy sync data cannot replace an already-observed newer event", async () => {
  const sync = deferred();
  const h = fixture({ syncEvent: () => sync.promise });
  h.gate.resolve();
  await h.auth.signInAnonymously();
  const events = [];
  const unsubscribe = h.connection.subscribeToEvent("NN3eRzoZo80", (value) =>
    events.push(value),
  );
  const pending = h.connection.syncEventState("NN3eRzoZo80");
  await flush();
  await h.create(seed(3));
  sync.resolve({ ok: true, didChange: true, event: seed(1).snapshot.event });
  await pending;
  assert.deepEqual(
    (await h.connection.syncEventState("NN3eRzoZo80")).event,
    seed(3).snapshot.event,
  );
  h.connection.reset({ preserveSnapshots: true });
  await h.create(seed(2));
  assert.deepEqual(events, [seed(3).snapshot.event]);
  unsubscribe();
});

test("auth reset rejects pending mutation seeds even when the same event stays mounted", async () => {
  const creation = deferred();
  const h = fixture({ createEvent: () => creation.promise });
  h.gate.resolve();
  await h.auth.signInAnonymously();
  const events = [];
  const unsubscribe = h.connection.subscribeToEvent("NN3eRzoZo80", (value) =>
    events.push(value),
  );
  await h.runNext();
  const pending = h.connection.createEvent(5);
  await flush();
  h.connection.reset();
  creation.resolve({
    ok: true,
    eventId: "NN3eRzoZo80",
    event: seed(2).snapshot.event,
    eventSnapshot: seed(2),
  });
  await pending;
  assert.deepEqual(events, [seed().snapshot.event, null]);
  unsubscribe();
});

test("closing an event while shared authentication stalls promptly releases the poller", async () => {
  const authentication = deferred();
  const h = fixture({ authenticate: () => authentication.promise });
  const unsubscribe = h.connection.subscribeToEvent("NN3eRzoZo80", () => {});
  await h.runNext();
  unsubscribe();
  await flush();
  assert.equal(h.timers.size, 0);
  assert.equal(h.takeRequests.length, 0);
  assert.equal(h.readRequests.length, 0);
  authentication.resolve();
  await flush();
  assert.equal(h.takeRequests.length, 0);
  assert.equal(h.readRequests.length, 0);
});

test("event read deadline includes authentication without canceling shared authentication", async () => {
  const authentication = deferred();
  const h = fixture({ authenticate: () => authentication.promise });
  const errors = [];
  const unsubscribe = h.connection.subscribeToEvent(
    "NN3eRzoZo80",
    () => {},
    (error) => errors.push(error),
  );
  await h.runNext();
  await h.runNext(GAMEPLAY_API_TIMEOUT_MS);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "unavailable");
  assert.equal(h.takeRequests.length, 0);
  assert.equal(h.readRequests.length, 0);
  authentication.resolve();
  await flush();
  assert.equal(h.takeRequests.length, 0);
  assert.equal(h.readRequests.length, 0);
  unsubscribe();
});
