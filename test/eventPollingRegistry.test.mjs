import assert from "node:assert/strict";
import test from "node:test";
import { eventSnapshotEtag } from "@mons/shared/events";

import {
  EVENT_POLL_BACKOFF_MS,
  EVENT_POLL_INTERVAL_MS,
  EVENT_SNAPSHOT_CACHE_CAPACITY,
  EVENT_SNAPSHOT_CACHE_TTL_MS,
  EventPollingRegistry,
} from "../src/connection/eventPollingRegistry.ts";
import { createPollingAuthTokenProvider } from "../src/connection/pollingAuthTokenProvider.ts";

const eventResponse = (revision = 1, eventId = "event-1") => ({
  ok: true,
  eventId,
  revision,
  event: { eventId, status: "scheduled", revision },
  prizeSelections: { "profile-1": "1092" },
});

const profileResponse = (revision = 1) => ({
  ok: true,
  profileId: "profile-1",
  revision,
  prizes: {},
});

const epoch = "12345678-1234-1234-1234-123456789abc";
const nextEpoch = "87654321-1234-1234-1234-123456789abc";
const bookmark = (revision, bookmarkEpoch = epoch) =>
  `mons-d1-v1:${bookmarkEpoch}:bookmark-${revision}`;

const seed = (revision = 1, eventId = "event-1", bookmarkEpoch = epoch) => ({
  snapshot: eventResponse(revision, eventId),
  etag: eventSnapshotEtag(eventId, revision),
  bookmark: bookmark(revision, bookmarkEpoch),
});

const modified = (value, revision = 1) => ({
  kind: "modified",
  value,
  etag: value.eventId
    ? eventSnapshotEtag(value.eventId, value.revision)
    : `etag-${revision}`,
  bookmark: value.eventId ? bookmark(revision) : `bookmark-${revision}`,
});

const eventNotModified = (revision = 1) => ({
  kind: "not-modified",
  etag: eventSnapshotEtag("event-1", revision),
  bookmark: bookmark(revision),
});

const notModified = (revision = 1) => ({
  kind: "not-modified",
  etag: `etag-${revision}`,
  bookmark: `bookmark-${revision}`,
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function harness({
  loadEvent = async () => modified(eventResponse()),
  loadProfilePrizes = async () => modified(profileResponse()),
  onEventIdle = () => undefined,
} = {}) {
  let nowMs = 0;
  let nextTimerId = 1;
  let visible = true;
  let visibilityListener = () => undefined;
  let visibilityListenersAdded = 0;
  let visibilityListenersRemoved = 0;
  const idleEventIds = [];
  const timers = new Map();
  const registry = new EventPollingRegistry({
    addVisibilityListener(listener) {
      visibilityListener = listener;
      visibilityListenersAdded += 1;
      return () => {
        visibilityListener = () => undefined;
        visibilityListenersRemoved += 1;
      };
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    isVisible: () => visible,
    loadEvent,
    loadProfilePrizes,
    now: () => nowMs,
    onEventIdle: (eventId) => {
      idleEventIds.push(eventId);
      onEventIdle(eventId);
    },
    setTimer(callback, delayMs) {
      const timer = nextTimerId++;
      timers.set(timer, { callback, delayMs });
      return timer;
    },
  });
  return {
    registry,
    timers,
    idleEventIds,
    advanceTime: (milliseconds) => {
      nowMs += milliseconds;
    },
    visibilityCounts: () => ({
      added: visibilityListenersAdded,
      removed: visibilityListenersRemoved,
    }),
    setVisible(value) {
      visible = value;
      visibilityListener();
    },
    async runNext() {
      const next = timers.entries().next().value;
      assert.ok(next);
      timers.delete(next[0]);
      next[1].callback();
      await new Promise((resolve) => setImmediate(resolve));
      return next[1].delayMs;
    },
  };
}

test("mutation guards follow only their event and are released when requests finish", async () => {
  const { registry } = harness();
  let isCurrent;
  await registry.withEventMutation("event-1", async (current) => {
    isCurrent = current;
    registry.invalidateEvent("event-2");
    assert.equal(current(), true);
  });
  registry.invalidateEvent("event-1");
  assert.equal(isCurrent(), true);
  await assert.rejects(
    registry.withEventMutation("event-1", async (current) => {
      isCurrent = current;
      throw new Error("mutation-failed");
    }),
    /mutation-failed/,
  );
  registry.invalidateEvent("event-1");
  assert.equal(isCurrent(), true);
});

test("reset and an old completion cannot remove a new mutation guard", async () => {
  const { registry } = harness();
  const pending = deferred();
  const old = registry.withEventMutation("event-1", async (current) => {
    await pending.promise;
    assert.equal(current(), false);
  });
  registry.reset();
  await registry.withEventMutation("event-1", async (current) => {
    pending.resolve();
    await old;
    registry.invalidateEvent("event-1");
    assert.equal(current(), false);
  });
});

test("polling authentication binds lazily and stops after cancellation", async () => {
  const authentication = deferred();
  const controller = new AbortController();
  let authenticationCalls = 0;
  let providerCalls = 0;
  const provider = createPollingAuthTokenProvider({
    ensureAuthenticated: () => {
      authenticationCalls += 1;
      return authentication.promise;
    },
    getUserBoundProvider: () => {
      providerCalls += 1;
      return Object.assign(async () => "token", {
        assertCurrentUser: () => undefined,
      });
    },
    isSessionCurrent: () => true,
    signal: controller.signal,
  });
  assert.equal(authenticationCalls, 0);
  const pendingToken = provider(false);
  assert.equal(authenticationCalls, 1);

  controller.abort();
  authentication.resolve();

  await assert.rejects(pendingToken, /authentication-changed/);
  assert.equal(providerCalls, 0);
});

test("polling authentication reuses one current-user-bound provider", async () => {
  let current = true;
  let authenticationCalls = 0;
  let providerCalls = 0;
  let assertionCalls = 0;
  const forceRefreshValues = [];
  const provider = createPollingAuthTokenProvider({
    ensureAuthenticated: async () => {
      authenticationCalls += 1;
    },
    getUserBoundProvider: () => {
      providerCalls += 1;
      return Object.assign(
        async (forceRefresh) => {
          forceRefreshValues.push(forceRefresh);
          return "token";
        },
        {
          assertCurrentUser: () => {
            assertionCalls += 1;
            if (!current) throw new Error("authentication-changed");
          },
        },
      );
    },
    isSessionCurrent: () => current,
  });

  assert.equal(await provider(false), "token");
  assert.equal(await provider(true), "token");
  provider.assertCurrentUser();
  assert.equal(authenticationCalls, 1);
  assert.equal(providerCalls, 1);
  assert.equal(assertionCalls, 1);
  assert.deepEqual(forceRefreshValues, [false, true]);

  current = false;
  assert.throws(() => provider.assertCurrentUser(), /authentication-changed/);
  await assert.rejects(provider(false), /authentication-changed/);
});

test("shares one event poll across event and selection subscribers", async () => {
  const loads = [];
  const responses = [modified(eventResponse(1), 1), eventNotModified(1)];
  const polling = harness({
    loadEvent: async (eventId, options) => {
      loads.push({ eventId, options });
      return responses.shift();
    },
  });
  const events = [];
  const selections = [];
  const unsubscribeEvent = polling.registry.subscribeToEvent(
    "event-1",
    (value) => events.push(value),
  );
  const unsubscribeSelections =
    polling.registry.subscribeToEventPrizeSelections("event-1", (value) =>
      selections.push(value),
    );

  assert.equal(polling.timers.size, 1);
  assert.equal(await polling.runNext(), 0);
  assert.equal(loads.length, 1);
  assert.deepEqual(events, [eventResponse(1).event]);
  assert.deepEqual(selections, [eventResponse(1).prizeSelections]);
  assert.equal([...polling.timers.values()][0].delayMs, EVENT_POLL_INTERVAL_MS);

  const cachedEvents = [];
  const unsubscribeCached = polling.registry.subscribeToEvent(
    "event-1",
    (value) => cachedEvents.push(value),
  );
  assert.deepEqual(cachedEvents, [eventResponse(1).event]);
  assert.equal(polling.timers.size, 1);
  await polling.runNext();
  assert.equal(loads.length, 2);
  assert.equal(loads[1].options.etag, eventSnapshotEtag("event-1", 1));
  assert.equal(loads[1].options.bookmark, bookmark(1));
  assert.equal(events.length, 1);
  assert.equal(selections.length, 1);

  unsubscribeCached();
  unsubscribeEvent();
  assert.equal(polling.timers.size, 1);
  assert.deepEqual(polling.idleEventIds, []);
  unsubscribeSelections();
  assert.equal(polling.timers.size, 0);
  assert.deepEqual(polling.idleEventIds, ["event-1"]);
  assert.deepEqual(polling.visibilityCounts(), { added: 1, removed: 1 });
});

test("polls one canonical profile-prize resource and resets its bookmark on invalidation", async () => {
  const loads = [];
  const responses = [modified(profileResponse(1), 1), notModified(2)];
  const polling = harness({
    loadProfilePrizes: async (profileId, options) => {
      loads.push({ profileId, options });
      return responses.shift();
    },
  });
  const firstUpdates = [];
  const secondUpdates = [];
  const unsubscribeFirst = polling.registry.subscribeToProfileEventPrizes(
    "profile-1",
    (value) => firstUpdates.push(value),
  );
  await polling.runNext();
  const unsubscribeSecond = polling.registry.subscribeToProfileEventPrizes(
    "profile-1",
    (value) => secondUpdates.push(value),
  );
  assert.deepEqual(secondUpdates, [profileResponse(1)]);
  assert.equal(polling.timers.size, 1);

  polling.registry.invalidateProfileEventPrizes();
  assert.equal([...polling.timers.values()][0].delayMs, 0);
  await polling.runNext();
  assert.equal(loads[1].profileId, "profile-1");
  assert.equal(loads[1].options.etag, "etag-1");
  assert.equal(loads[1].options.bookmark, null);
  assert.equal(firstUpdates.length, 1);
  assert.equal(secondUpdates.length, 1);

  unsubscribeFirst();
  unsubscribeSecond();
  assert.equal(polling.timers.size, 0);
});

test("rejects a mismatched profile before caching its read metadata", async () => {
  const loads = [];
  const responses = [
    modified({ ...profileResponse(1), profileId: "profile-2" }, 1),
    notModified(2),
  ];
  const polling = harness({
    loadProfilePrizes: async (profileId, options) => {
      loads.push({ profileId, options });
      return responses.shift();
    },
  });
  const errors = [];
  const updates = [];
  polling.registry.subscribeToProfileEventPrizes(
    "profile-1",
    (value) => updates.push(value),
    (error) => errors.push(error.message),
  );

  await polling.runNext();
  assert.deepEqual(errors, ["profile-event-prizes-owner-mismatch"]);
  assert.deepEqual(updates, []);
  assert.equal(loads[0].profileId, "profile-1");

  await polling.runNext();
  assert.equal(loads[1].options.etag, null);
  assert.equal(loads[1].options.bookmark, null);
  assert.deepEqual(updates, []);
});

test("uses capped backoff and reports one error per failure streak", async () => {
  let attempts = 0;
  const polling = harness({
    loadEvent: async () => {
      attempts += 1;
      if (attempts <= EVENT_POLL_BACKOFF_MS.length) {
        throw new Error(`failure-${attempts}`);
      }
      if (attempts === EVENT_POLL_BACKOFF_MS.length + 1) {
        return modified(eventResponse(2), 2);
      }
      throw new Error("new-streak");
    },
  });
  const errors = [];
  const updates = [];
  polling.registry.subscribeToEvent(
    "event-1",
    (value) => updates.push(value),
    (error) => errors.push(error.message),
  );

  for (const expectedDelay of EVENT_POLL_BACKOFF_MS) {
    await polling.runNext();
    assert.equal([...polling.timers.values()][0].delayMs, expectedDelay);
  }
  assert.equal(errors.length, 1);
  await polling.runNext();
  assert.equal(updates.length, 1);
  assert.equal([...polling.timers.values()][0].delayMs, EVENT_POLL_INTERVAL_MS);
  await polling.runNext();
  assert.deepEqual(errors, ["failure-1", "new-streak"]);
  assert.equal(
    [...polling.timers.values()][0].delayMs,
    EVENT_POLL_BACKOFF_MS[0],
  );
});

test("delivers the current failure to a late subscriber without cached data", async () => {
  let attempts = 0;
  const polling = harness({
    loadEvent: async () => {
      attempts += 1;
      throw new Error(`failure-${attempts}`);
    },
  });
  const firstErrors = [];
  const lateErrors = [];
  const unsubscribeFirst = polling.registry.subscribeToEvent(
    "event-1",
    () => undefined,
    (error) => firstErrors.push(error.message),
  );

  await polling.runNext();
  assert.deepEqual(firstErrors, ["failure-1"]);
  const unsubscribeLate = polling.registry.subscribeToEvent(
    "event-1",
    () => undefined,
    (error) => lateErrors.push(error.message),
  );
  assert.deepEqual(lateErrors, ["failure-1"]);

  await polling.runNext();
  assert.deepEqual(firstErrors, ["failure-1"]);
  assert.deepEqual(lateErrors, ["failure-1"]);
  unsubscribeFirst();
  unsubscribeLate();
});

test("delivers cached data instead of an active failure to a late subscriber", async () => {
  let attempts = 0;
  const polling = harness({
    loadEvent: async () => {
      attempts += 1;
      if (attempts === 1) return modified(eventResponse(1), 1);
      throw new Error("temporary-failure");
    },
  });
  const firstErrors = [];
  const unsubscribeFirst = polling.registry.subscribeToEvent(
    "event-1",
    () => undefined,
    (error) => firstErrors.push(error.message),
  );
  await polling.runNext();
  await polling.runNext();
  assert.deepEqual(firstErrors, ["temporary-failure"]);

  const cachedUpdates = [];
  const lateErrors = [];
  const unsubscribeLate = polling.registry.subscribeToEvent(
    "event-1",
    (value) => cachedUpdates.push(value),
    (error) => lateErrors.push(error.message),
  );
  assert.deepEqual(cachedUpdates, [eventResponse(1).event]);
  assert.deepEqual(lateErrors, []);

  unsubscribeFirst();
  unsubscribeLate();
});

test("never overlaps and fences an invalidated in-flight event read", async () => {
  const first = deferred();
  let calls = 0;
  let firstSignal;
  const polling = harness({
    loadEvent: async (_eventId, options) => {
      calls += 1;
      if (calls === 1) {
        firstSignal = options.signal;
        return first.promise;
      }
      return modified(eventResponse(2), 2);
    },
  });
  const updates = [];
  polling.registry.subscribeToEvent("event-1", (value) => updates.push(value));
  await polling.runNext();
  assert.equal(calls, 1);
  polling.registry.invalidateEvent("event-1");
  assert.equal(firstSignal.aborted, true);
  assert.equal(calls, 1);

  first.resolve(modified(eventResponse(1), 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, []);
  assert.equal([...polling.timers.values()][0].delayMs, 0);
  await polling.runNext();
  assert.equal(calls, 2);
  assert.deepEqual(updates, [eventResponse(2).event]);
});

test("isolates subscriber callback failures", async () => {
  const polling = harness();
  const selections = [];
  let callbackErrors = 0;
  polling.registry.subscribeToEvent(
    "event-1",
    () => {
      throw new Error("subscriber-failed");
    },
    () => {
      callbackErrors += 1;
      throw new Error("error-handler-failed");
    },
  );
  polling.registry.subscribeToEventPrizeSelections("event-1", (value) =>
    selections.push(value),
  );

  await polling.runNext();

  assert.equal(callbackErrors, 1);
  assert.deepEqual(selections, [eventResponse().prizeSelections]);
  assert.equal([...polling.timers.values()][0].delayMs, EVENT_POLL_INTERVAL_MS);
});

test("reset preserves mounted subscribers and starts fresh reads", async () => {
  const eventLoads = [];
  const profileLoads = [];
  const polling = harness({
    loadEvent: async (_eventId, options) => {
      eventLoads.push(options);
      return modified(eventResponse(eventLoads.length), eventLoads.length);
    },
    loadProfilePrizes: async (_profileId, options) => {
      profileLoads.push(options);
      return modified(
        profileResponse(profileLoads.length),
        profileLoads.length,
      );
    },
  });
  const events = [];
  const prizes = [];
  polling.registry.subscribeToEvent("event-1", (value) => events.push(value));
  polling.registry.subscribeToProfileEventPrizes("profile-1", (value) =>
    prizes.push(value),
  );
  const originalToken = polling.registry.getEventSubscriptionToken("event-1");
  await polling.runNext();
  await polling.runNext();

  polling.registry.reset();
  const resetToken = polling.registry.getEventSubscriptionToken("event-1");
  assert.notEqual(resetToken, originalToken);
  assert.equal(
    polling.registry.isEventSubscriptionTokenCurrent("event-1", originalToken),
    false,
  );
  assert.equal(
    polling.registry.isEventSubscriptionTokenCurrent("event-1", resetToken),
    true,
  );
  assert.equal(polling.timers.size, 2);
  await polling.runNext();
  await polling.runNext();

  assert.equal(eventLoads.length, 2);
  assert.equal(profileLoads.length, 2);
  assert.equal(eventLoads[1].etag, null);
  assert.equal(eventLoads[1].bookmark, null);
  assert.equal(profileLoads[1].etag, null);
  assert.equal(profileLoads[1].bookmark, null);
  assert.deepEqual(events, [
    eventResponse(1).event,
    null,
    eventResponse(2).event,
  ]);
  assert.deepEqual(prizes, [
    profileResponse(1),
    profileResponse(0),
    profileResponse(2),
  ]);
});

test("aborts while hidden and resumes immediately", async () => {
  const first = deferred();
  const second = deferred();
  const signals = [];
  let calls = 0;
  const polling = harness({
    loadEvent: async (_eventId, options) => {
      calls += 1;
      signals.push(options.signal);
      return calls === 1 ? first.promise : second.promise;
    },
  });
  const updates = [];
  const unsubscribe = polling.registry.subscribeToEvent("event-1", (value) =>
    updates.push(value),
  );
  await polling.runNext();
  polling.setVisible(false);
  assert.equal(signals[0].aborted, true);
  first.resolve(modified(eventResponse(1), 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polling.timers.size, 0);
  assert.deepEqual(updates, []);

  polling.setVisible(true);
  assert.equal([...polling.timers.values()][0].delayMs, 0);
  await polling.runNext();
  second.resolve(modified(eventResponse(2), 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [eventResponse(2).event]);
  assert.equal([...polling.timers.values()][0].delayMs, EVENT_POLL_INTERVAL_MS);

  unsubscribe();
  assert.equal(polling.timers.size, 0);
});

test("notifies idle once and fences a stale entry lifecycle", async () => {
  const first = deferred();
  let calls = 0;
  const latestEvents = new Map([["event-1", eventResponse(1).event]]);
  const cooldowns = new Map([["event-1", { responseAtMs: 1 }]]);
  const inFlight = new Map([["event-1", first.promise]]);
  const polling = harness({
    loadEvent: async () => {
      calls += 1;
      return calls === 1 ? first.promise : modified(eventResponse(2), 2);
    },
    onEventIdle: (eventId) => {
      latestEvents.delete(eventId);
      cooldowns.delete(eventId);
      inFlight.delete(eventId);
    },
  });
  const staleUpdates = [];
  const unsubscribeStale = polling.registry.subscribeToEvent(
    "event-1",
    (value) => staleUpdates.push(value),
  );
  const staleToken = polling.registry.getEventSubscriptionToken("event-1");
  await polling.runNext();

  unsubscribeStale();
  assert.deepEqual(polling.idleEventIds, ["event-1"]);
  assert.equal(latestEvents.has("event-1"), false);
  assert.equal(cooldowns.has("event-1"), false);
  assert.equal(inFlight.has("event-1"), false);
  assert.equal(
    polling.registry.isEventSubscriptionTokenCurrent("event-1", staleToken),
    false,
  );

  const freshUpdates = [];
  const unsubscribeFresh = polling.registry.subscribeToEvent(
    "event-1",
    (value) => freshUpdates.push(value),
  );
  const freshToken = polling.registry.getEventSubscriptionToken("event-1");
  assert.notEqual(freshToken, staleToken);
  const retainedResponses = new Map();
  const retain = (token, value) => {
    if (polling.registry.isEventSubscriptionTokenCurrent("event-1", token)) {
      retainedResponses.set("event-1", value);
    }
  };
  retain(staleToken, "stale");
  retain(freshToken, "fresh");
  assert.equal(retainedResponses.get("event-1"), "fresh");
  first.resolve(modified(eventResponse(1), 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(staleUpdates, []);
  assert.deepEqual(freshUpdates, []);

  await polling.runNext();
  assert.deepEqual(freshUpdates, [eventResponse(2).event]);
  unsubscribeFresh();
  assert.deepEqual(polling.idleEventIds, ["event-1", "event-1"]);
});

test("reopens retained snapshots synchronously and revalidates before marking them fresh", async () => {
  const loads = [];
  const polling = harness({
    loadEvent: async (_eventId, options) => {
      loads.push(options);
      return loads.length === 1
        ? modified(eventResponse(1))
        : eventNotModified(1);
    },
  });
  const freshness = [];
  const unsubscribeFreshness = polling.registry.subscribeToEventFreshness(
    "event-1",
    (value) => freshness.push(value),
  );
  const first = polling.registry.subscribeToEvent("event-1", () => undefined);
  await polling.runNext();
  first();
  assert.deepEqual(freshness, [false, true, false]);
  assert.equal(polling.timers.size, 0);
  assert.deepEqual(polling.visibilityCounts(), { added: 1, removed: 1 });

  const updates = [];
  const second = polling.registry.subscribeToEvent("event-1", (value) =>
    updates.push(value),
  );
  assert.deepEqual(updates, [eventResponse(1).event]);
  assert.equal(loads.length, 1);
  assert.equal([...polling.timers.values()][0].delayMs, 0);
  await polling.runNext();
  assert.equal(loads[1].etag, eventSnapshotEtag("event-1", 1));
  assert.equal(loads[1].bookmark, bookmark(1));
  assert.deepEqual(freshness, [false, true, false, true]);
  assert.equal(updates.length, 1);
  second();
  unsubscribeFreshness();
});

test("retains at most eight inactive snapshots using close and adoption recency", () => {
  const polling = harness();
  for (let index = 1; index <= EVENT_SNAPSHOT_CACHE_CAPACITY; index += 1) {
    polling.registry.adoptEventSnapshot(
      `event-${index}`,
      seed(1, `event-${index}`),
    );
  }
  const touch = polling.registry.subscribeToEvent("event-1", () => undefined);
  touch();
  polling.registry.adoptEventSnapshot("event-9", seed(1, "event-9"));
  const retained = [];
  const evicted = [];
  const closeRetained = polling.registry.subscribeToEvent("event-1", (value) =>
    retained.push(value),
  );
  const closeEvicted = polling.registry.subscribeToEvent("event-2", (value) =>
    evicted.push(value),
  );
  assert.equal(retained.length, 1);
  assert.equal(evicted.length, 0);
  closeRetained();
  closeEvicted();
});

test("expires inactive snapshots after five minutes without expiring active subscriptions", async () => {
  const polling = harness();
  polling.registry.adoptEventSnapshot("event-1", seed());
  const active = polling.registry.subscribeToEvent("event-1", () => undefined);
  polling.registry.adoptEventSnapshot("event-2", seed(1, "event-2"));
  polling.advanceTime(EVENT_SNAPSHOT_CACHE_TTL_MS);
  const expired = [];
  const stillActive = [];
  const closeExpired = polling.registry.subscribeToEvent("event-2", (value) =>
    expired.push(value),
  );
  const closeActive = polling.registry.subscribeToEvent("event-1", (value) =>
    stillActive.push(value),
  );
  assert.deepEqual(expired, []);
  assert.deepEqual(stillActive, [eventResponse().event]);
  closeExpired();
  closeActive();
  active();
});

test("fresh seeds render before subscription and skip only the redundant initial read", async () => {
  let calls = 0;
  const polling = harness({
    loadEvent: async () => {
      calls += 1;
      return eventNotModified(3);
    },
  });
  assert.equal(polling.registry.adoptEventSnapshot("event-1", seed(3)), true);
  assert.equal(polling.timers.size, 0);
  const freshness = [];
  polling.registry.subscribeToEventFreshness("event-1", (value) =>
    freshness.push(value),
  );
  const updates = [];
  const close = polling.registry.subscribeToEvent("event-1", (value) =>
    updates.push(value),
  );
  assert.deepEqual(updates, [eventResponse(3).event]);
  assert.deepEqual(freshness, [false, true]);
  assert.equal(calls, 0);
  assert.equal([...polling.timers.values()][0].delayMs, EVENT_POLL_INTERVAL_MS);
  await polling.runNext();
  assert.equal(calls, 1);
  close();

  polling.registry.adoptEventSnapshot("event-2", seed(1, "event-2"));
  polling.advanceTime(EVENT_POLL_INTERVAL_MS);
  const staleFreshness = [];
  polling.registry.subscribeToEventFreshness("event-2", (value) =>
    staleFreshness.push(value),
  );
  const closeStale = polling.registry.subscribeToEvent(
    "event-2",
    () => undefined,
  );
  assert.equal([...polling.timers.values()][0].delayMs, 0);
  assert.deepEqual(staleFreshness, [false]);
  closeStale();
});

for (const staleResult of [
  modified(eventResponse(2), 2),
  eventNotModified(1),
]) {
  test(`adoption fences an older in-flight ${staleResult.kind} response and its validators`, async () => {
    const oldRead = deferred();
    const loads = [];
    const polling = harness({
      loadEvent: async (_eventId, options) => {
        loads.push(options);
        if (loads.length === 1) return modified(eventResponse(1));
        if (loads.length === 2) return oldRead.promise;
        return eventNotModified(3);
      },
    });
    const updates = [];
    const close = polling.registry.subscribeToEvent("event-1", (value) =>
      updates.push(value),
    );
    await polling.runNext();
    await polling.runNext();
    polling.registry.adoptEventSnapshot("event-1", seed(3));
    assert.equal(loads[1].signal.aborted, true);
    assert.deepEqual(updates, [eventResponse(1).event, eventResponse(3).event]);
    oldRead.resolve(staleResult);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      [...polling.timers.values()][0].delayMs,
      EVENT_POLL_INTERVAL_MS,
    );
    await polling.runNext();
    assert.equal(loads[2].etag, eventSnapshotEtag("event-1", 3));
    assert.equal(loads[2].bookmark, bookmark(3));
    assert.equal(updates.length, 2);
    close();
  });
}

test("snapshot revisions stay monotonic within an epoch and retired epochs cannot return", () => {
  const polling = harness();
  const generation = polling.registry.getGeneration();
  polling.registry.adoptEventSnapshot("event-1", seed(7), generation);
  assert.equal(
    polling.registry.adoptEventSnapshot("event-1", seed(6), generation),
    true,
  );
  const updates = [];
  const close = polling.registry.subscribeToEvent("event-1", (value) =>
    updates.push(value),
  );
  assert.deepEqual(updates, [eventResponse(7).event]);
  assert.equal(polling.registry.adoptEventSnapshot("event-1", seed(6)), true);
  assert.equal(
    polling.registry.adoptEventSnapshot(
      "event-1",
      seed(1, "event-1", nextEpoch),
    ),
    true,
  );
  assert.equal(polling.registry.adoptEventSnapshot("event-1", seed(8)), true);
  assert.deepEqual(updates, [eventResponse(7).event, eventResponse(1).event]);
  close();
  polling.registry.adoptEventSnapshot("event-1", seed(9));
  const reopened = [];
  polling.registry.subscribeToEvent("event-1", (value) =>
    reopened.push(value),
  )();
  assert.deepEqual(reopened, [eventResponse(1).event]);
});

test("authoritative missing responses clear displayed data and are never retained", async () => {
  const absent = {
    ok: true,
    eventId: "event-1",
    revision: 0,
    event: null,
    prizeSelections: {},
  };
  const polling = harness({ loadEvent: async () => modified(absent, 0) });
  polling.registry.adoptEventSnapshot("event-1", seed(4));
  const events = [];
  const selections = [];
  const closeEvent = polling.registry.subscribeToEvent("event-1", (value) =>
    events.push(value),
  );
  const closeSelections = polling.registry.subscribeToEventPrizeSelections(
    "event-1",
    (value) => selections.push(value),
  );
  await polling.runNext();
  assert.deepEqual(events, [eventResponse(4).event, null]);
  assert.deepEqual(selections, [eventResponse(4).prizeSelections, {}]);
  closeEvent();
  closeSelections();
  const reopened = [];
  polling.registry.subscribeToEvent("event-1", (value) =>
    reopened.push(value),
  )();
  assert.deepEqual(reopened, []);
});

test("invalidation evicts inactive snapshots and marks active snapshots stale", () => {
  const polling = harness();
  polling.registry.adoptEventSnapshot("event-1", seed());
  polling.registry.invalidateEvent("event-1");
  const updates = [];
  const close = polling.registry.subscribeToEvent("event-1", (value) =>
    updates.push(value),
  );
  assert.deepEqual(updates, []);
  const freshness = [];
  polling.registry.subscribeToEventFreshness("event-1", (value) =>
    freshness.push(value),
  );
  polling.registry.adoptEventSnapshot("event-1", seed());
  polling.registry.invalidateEvent("event-1");
  assert.deepEqual(freshness, [false, true, false]);
  close();
  const reopened = [];
  polling.registry.subscribeToEvent("event-1", (value) =>
    reopened.push(value),
  )();
  assert.deepEqual(reopened, []);
});

test("reset clears cached and displayed snapshots and rejects previous-generation work", async () => {
  const oldRead = deferred();
  const polling = harness({ loadEvent: async () => oldRead.promise });
  const previousGeneration = polling.registry.getGeneration();
  polling.registry.adoptEventSnapshot("event-1", seed());
  polling.registry.adoptEventSnapshot("event-2", seed(1, "event-2"));
  const updates = [];
  const selections = [];
  polling.registry.subscribeToEvent("event-1", (value) => updates.push(value));
  polling.registry.subscribeToEventPrizeSelections("event-1", (value) =>
    selections.push(value),
  );
  const freshness = [];
  polling.registry.subscribeToEventFreshness("event-1", (value) =>
    freshness.push(value),
  );
  await polling.runNext();
  polling.registry.reset();
  assert.deepEqual(updates, [eventResponse().event, null]);
  assert.deepEqual(selections, [eventResponse().prizeSelections, {}]);
  assert.deepEqual(freshness, [true, false]);
  assert.equal(
    polling.registry.adoptEventSnapshot("event-1", seed(9), previousGeneration),
    false,
  );
  oldRead.resolve(modified(eventResponse(8), 8));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [eventResponse().event, null]);
  const inactive = [];
  polling.registry.subscribeToEvent("event-2", (value) =>
    inactive.push(value),
  )();
  assert.deepEqual(inactive, []);
});

test("rejects invalid or mismatched seeds without disturbing the current snapshot", () => {
  const polling = harness();
  polling.registry.adoptEventSnapshot("event-1", seed(3));
  for (const candidate of [
    seed(4, "event-2"),
    { ...seed(4), etag: "bad-etag" },
    { ...seed(4), bookmark: "bad-bookmark" },
  ]) {
    assert.equal(
      polling.registry.adoptEventSnapshot("event-1", candidate),
      false,
    );
  }
  const updates = [];
  polling.registry.subscribeToEvent("event-1", (value) =>
    updates.push(value),
  )();
  assert.deepEqual(updates, [eventResponse(3).event]);
});

test("an epoch-changing 304 forces a full read before cached data becomes fresh", async () => {
  const loads = [];
  const polling = harness({
    loadEvent: async (_eventId, options) => {
      loads.push(options);
      return loads.length === 1
        ? { ...eventNotModified(4), bookmark: bookmark(4, nextEpoch) }
        : { ...modified(eventResponse(1)), bookmark: bookmark(1, nextEpoch) };
    },
  });
  polling.registry.adoptEventSnapshot("event-1", seed(4));
  polling.advanceTime(EVENT_POLL_INTERVAL_MS);
  const updates = [];
  const freshness = [];
  polling.registry.subscribeToEventFreshness("event-1", (value) =>
    freshness.push(value),
  );
  polling.registry.subscribeToEvent("event-1", (value) => updates.push(value));
  await polling.runNext();
  assert.deepEqual(freshness, [false]);
  assert.equal([...polling.timers.values()][0].delayMs, 0);
  await polling.runNext();
  assert.equal(loads[1].etag, null);
  assert.equal(loads[1].bookmark, null);
  assert.deepEqual(updates, [eventResponse(4).event, eventResponse(1).event]);
  assert.deepEqual(freshness, [false, true]);
});

test("opening and closing without validation cannot extend the snapshot age", async () => {
  const polling = harness();
  let close;
  close = polling.registry.subscribeToEvent("event-1", () => close());
  await polling.runNext();
  polling.advanceTime(EVENT_SNAPSHOT_CACHE_TTL_MS - 1);
  const cached = [];
  polling.registry.subscribeToEvent("event-1", (value) => cached.push(value))();
  assert.deepEqual(cached, [eventResponse().event]);
  polling.advanceTime(1);
  assert.equal(polling.registry.getEventSnapshot("event-1"), null);
  const expired = [];
  polling.registry.subscribeToEvent("event-1", (value) =>
    expired.push(value),
  )();
  assert.deepEqual(expired, []);
});

test("a reentrant adoption cannot deliver the older outer snapshot to later subscribers", async () => {
  const polling = harness();
  polling.registry.subscribeToEvent("event-1", (value) => {
    if (value?.revision === 1)
      polling.registry.adoptEventSnapshot("event-1", seed(2));
  });
  const laterUpdates = [];
  polling.registry.subscribeToEvent("event-1", (value) =>
    laterUpdates.push(value),
  );
  await polling.runNext();
  assert.deepEqual(laterUpdates, [eventResponse(2).event]);
  assert.deepEqual(
    polling.registry.getEventSnapshot("event-1"),
    eventResponse(2),
  );
});

test("a reentrant reset prevents later subscribers from receiving the previous owner's snapshot", async () => {
  const polling = harness();
  polling.registry.subscribeToEvent("event-1", (value) => {
    if (value) polling.registry.reset();
  });
  const laterUpdates = [];
  polling.registry.subscribeToEvent("event-1", (value) =>
    laterUpdates.push(value),
  );
  await polling.runNext();
  assert.deepEqual(laterUpdates, [null]);
  assert.equal(polling.registry.getEventSnapshot("event-1"), null);
});
