import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_POLL_BACKOFF_MS,
  EVENT_POLL_INTERVAL_MS,
  EventPollingRegistry,
} from "../src/connection/eventPollingRegistry.ts";
import { createPollingAuthTokenProvider } from "../src/connection/pollingAuthTokenProvider.ts";

const eventResponse = (revision = 1) => ({
  ok: true,
  eventId: "event-1",
  revision,
  event: { eventId: "event-1", status: "scheduled", revision },
  prizeSelections: { "profile-1": "1092" },
});

const profileResponse = (revision = 1) => ({
  ok: true,
  profileId: "profile-1",
  revision,
  prizes: {},
});

const modified = (value, revision = 1) => ({
  kind: "modified",
  value,
  etag: `etag-${revision}`,
  bookmark: `bookmark-${revision}`,
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
  const responses = [modified(eventResponse(1), 1), notModified(2)];
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
  assert.equal(loads[1].options.etag, "etag-1");
  assert.equal(loads[1].options.bookmark, "bookmark-1");
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
  assert.equal(events.length, 2);
  assert.equal(prizes.length, 2);
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
