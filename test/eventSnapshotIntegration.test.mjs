import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

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
const { EventPollingRegistry, EVENT_POLL_INTERVAL_MS } =
  await import("../src/connection/eventPollingRegistry.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");
const { GameplayApiError, GAMEPLAY_API_TIMEOUT_MS } =
  await import("../src/services/gameplayApi.ts");
const { eventSnapshotEtag } = await import("@mons/shared/events");
const { createEventPrizeSelectionCoordinator } =
  await import("../src/ui/event/prizeSelectionCoordinator.ts");

const source = ts.createSourceFile(
  "connection.ts",
  readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
);
const methods = [
  "loadEventSnapshot",
  "synchronizeEventAuthOwner",
  "clearEventSyncCaches",
  "clearEventSyncCacheForId",
  "applyEventMutationSnapshot",
  "postponeEventStart",
  "subscribeToEvent",
  "subscribeToEventFreshness",
  "getUserBoundAuthTokenProvider",
  "commitEventSyncResponse",
  "readCachedEventSyncResponse",
].map((name) => {
  const method = declaration.members.find(
    (member) => member.name?.getText(source) === name,
  );
  assert.ok(method, `missing Connection.${name}`);
  return method.getText(source);
});
const { outputText } = ts.transpileModule(
  `class Connection { ${methods.join("\n")} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);

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
  path: "event/event-a",
  inviteId: null,
  snapshotId: null,
  eventId: "event-a",
  autojoin: false,
});
const seed = (revision = 1) => ({
  snapshot: {
    ok: true,
    eventId: "event-a",
    revision,
    event: {
      eventId: "event-a",
      status: "scheduled",
      startAtMs: revision * 1000,
    },
    prizeSelections: { "profile-a": String(revision) },
  },
  etag: eventSnapshotEtag("event-a", revision),
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
  const dependencies = {
    createUserBoundAuthTokenProvider,
    GameplayApiError,
    GAMEPLAY_API_TIMEOUT_MS,
    takeInitialEventBootstrap: (...args) => {
      takeRequests.push(args);
      return bootstrap.take(...args);
    },
    readEventSnapshotViaApi: read,
    postponeEventStartViaApi: postponeEvent,
  };
  const Connection = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn Connection;`,
  )(...Object.values(dependencies));
  const connection = new Connection();
  const registry = new EventPollingRegistry({
    addVisibilityListener: () => () => {},
    clearTimer: (id) => timers.delete(id),
    isVisible: () => true,
    loadEvent: (eventId, options) =>
      connection.loadEventSnapshot(eventId, options),
    loadProfilePrizes: async () => assert.fail("unexpected profile read"),
    onEventIdle: (eventId) => connection.clearEventSyncCacheForId(eventId),
    setTimer(callback, delayMs) {
      const id = ++timerId;
      timers.set(id, { callback, delayMs });
      return id;
    },
  });
  Object.assign(connection, {
    auth,
    eventAuthUser: auth.currentUser,
    eventPollingRegistry: registry,
    inFlightEventSyncById: new Map(),
    eventSyncCooldownCacheById: new Map(),
    latestObservedEventById: new Map(),
    mapDatabaseEventRecord: (value) => value,
    getEventSyncCooldownMs: () => 10_000,
    notifyNavigationGamesChanged: () => {},
    async ensureAuthenticated() {
      await auth.authStateReady();
      if (!auth.currentUser) await auth.signInAnonymously();
    },
  });
  auth.onAuthStateChanged(() => connection.synchronizeEventAuthOwner());
  return {
    auth,
    bootstrap,
    connection,
    registry,
    timers,
    authRequests,
    readRequests,
    takeRequests,
    gate,
    dispatched,
    async runNext() {
      const [id, timer] = timers.entries().next().value;
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
    const unsubscribe = h.connection.subscribeToEvent("event-a", (event) =>
      events.push(event),
    );
    const unsubscribeSelections = h.registry.subscribeToEventPrizeSelections(
      "event-a",
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
    assert.deepEqual(h.authRequests, [{ eventId: "event-a" }]);
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
  const unsubscribe = h.connection.subscribeToEvent("event-a", (value) =>
    events.push(value),
  );
  const unsubscribeSelections = h.registry.subscribeToEventPrizeSelections(
    "event-a",
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
  const generation = h.registry.getGeneration();
  assert.deepEqual(
    h.connection.applyEventMutationSnapshot("event-a", seed(2), generation),
    seed(2).snapshot.event,
  );
  const events = [];
  const fresh = [];
  const unsubscribeFreshness = h.connection.subscribeToEventFreshness(
    "event-a",
    (value) => fresh.push(value),
  );
  const unsubscribe = h.connection.subscribeToEvent("event-a", (value) =>
    events.push(value),
  );
  assert.deepEqual(events, [seed(2).snapshot.event]);
  assert.deepEqual(fresh, [false, true]);
  assert.ok([...h.timers.values()][0].delayMs > 0);
  assert.equal(h.readRequests.length, 0);
  unsubscribe();
  unsubscribeFreshness();
  h.connection.clearEventSyncCaches(false);
  const reopened = [];
  const close = h.connection.subscribeToEvent("event-a", (value) =>
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
  h.registry.adoptEventSnapshot("event-a", initial);
  const selections = [];
  const coordinator = createEventPrizeSelectionCoordinator({
    profileId: "profile-a",
    onPendingChange: () => {},
    onSelectionsChange: (value) => selections.push(value),
    mutate: async () => {
      h.registry.invalidateEvent("event-a");
      return "1092";
    },
  });
  const unsubscribe = h.registry.subscribeToEventPrizeSelections(
    "event-a",
    coordinator.receiveAuthoritative,
  );
  const pendingPostpone = h.connection.postponeEventStart("event-a", 5);
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
    eventId: "event-a",
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
  assert.equal(h.registry.getEventSnapshot("event-a").revision, 3);
  primaryRead.resolve(modified(older));
  await flush();
  assert.equal(h.registry.getEventSnapshot("event-a").revision, 3);
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
    h.registry.adoptEventSnapshot("event-a", seed(1));
    const events = [];
    const unsubscribe = h.connection.subscribeToEvent("event-a", (value) =>
      events.push(value),
    );
    const pendingPostpone = h.connection.postponeEventStart("event-a", 5);
    await flush();
    h.registry.invalidateEvent("event-a");
    assert.equal(await h.runNext(), 0);
    assert.equal(h.registry.getEventSnapshot("event-a").revision, 2);
    committed = true;
    postpone.resolve({
      ok: true,
      eventId: "event-a",
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
    assert.deepEqual(h.registry.getEventSnapshot("event-a").prizeSelections, {
      "profile-a": "1092",
    });
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
  h.registry.adoptEventSnapshot("event-a", seed(1));
  const unsubscribe = h.connection.subscribeToEvent("event-a", () => {});
  const pendingPostpone = h.connection.postponeEventStart("event-a", 5);
  await flush();
  h.connection.clearEventSyncCaches();
  assert.equal(await h.runNext(), 0);
  const timer = [...h.timers.entries()][0];
  postpone.resolve({
    ok: true,
    eventId: "event-a",
    event: seed(2).snapshot.event,
    eventSnapshot: seed(2),
    postponeByMinutes: 5,
    startAtMs: 2000,
  });
  await pendingPostpone;
  assert.equal(h.registry.getEventSnapshot("event-a").revision, 4);
  assert.equal(h.readRequests.length, 1);
  assert.deepEqual([...h.timers.entries()], [timer]);
  assert.equal(timer[1].delayMs, EVENT_POLL_INTERVAL_MS);
  unsubscribe();
});

test("late legacy sync data cannot replace an already-observed newer event", async () => {
  const h = fixture();
  h.gate.resolve();
  await h.auth.signInAnonymously();
  const events = [];
  const unsubscribe = h.connection.subscribeToEvent("event-a", (value) =>
    events.push(value),
  );
  const generation = h.registry.getGeneration();
  h.connection.applyEventMutationSnapshot("event-a", seed(3), generation);
  h.connection.commitEventSyncResponse(
    "event-a",
    { ok: true, didChange: true, event: seed(1).snapshot.event },
    h.registry.getEventSubscriptionToken("event-a"),
  );
  assert.deepEqual(
    h.connection.latestObservedEventById.get("event-a"),
    seed(3).snapshot.event,
  );
  assert.deepEqual(
    h.connection.readCachedEventSyncResponse("event-a", Date.now()).event,
    seed(3).snapshot.event,
  );
  h.connection.clearEventSyncCaches(false);
  assert.deepEqual(
    h.connection.applyEventMutationSnapshot("event-a", seed(2), generation),
    seed(3).snapshot.event,
  );
  assert.deepEqual(events, [seed(3).snapshot.event]);
  unsubscribe();
});

test("auth reset rejects pending mutation seeds even when the same event stays mounted", async () => {
  const h = fixture();
  h.gate.resolve();
  await h.auth.signInAnonymously();
  const events = [];
  const unsubscribe = h.connection.subscribeToEvent("event-a", (value) =>
    events.push(value),
  );
  const generation = h.registry.getGeneration();
  h.connection.applyEventMutationSnapshot("event-a", seed(), generation);
  h.connection.clearEventSyncCaches();
  assert.equal(
    h.connection.applyEventMutationSnapshot("event-a", seed(2), generation),
    undefined,
  );
  assert.deepEqual(events, [seed().snapshot.event, null]);
  unsubscribe();
});

test(
  "aborting an event read while shared authentication stalls promptly releases the poller",
  { timeout: 1000 },
  async () => {
    const h = fixture();
    const authentication = deferred();
    h.connection.ensureAuthenticated = () => authentication.promise;
    const controller = new AbortController();
    const pending = h.connection.loadEventSnapshot("event-a", {
      signal: controller.signal,
    });
    const rejected = assert.rejects(pending, { code: "aborted" });
    controller.abort();
    await rejected;
    assert.equal(h.takeRequests.length, 0);
    assert.equal(h.readRequests.length, 0);
    authentication.resolve();
    await flush();
    assert.equal(h.takeRequests.length, 0);
    assert.equal(h.readRequests.length, 0);
  },
);

test("event read deadline includes authentication without canceling shared authentication", async (t) => {
  const h = fixture();
  const authentication = deferred();
  h.connection.ensureAuthenticated = () => authentication.promise;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = h.connection.loadEventSnapshot("event-a", {});
  const rejected = assert.rejects(pending, { code: "unavailable" });
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(h.takeRequests.length, 0);
  assert.equal(h.readRequests.length, 0);
  authentication.resolve();
  await flush();
  assert.equal(h.takeRequests.length, 0);
  assert.equal(h.readRequests.length, 0);
});
