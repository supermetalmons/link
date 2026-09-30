import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { eventSnapshotEtag } from "@mons/shared/events";

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

const { EventClient } = await import("../src/connection/eventClient.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");
const { createEventPrizeSelectionCoordinator } =
  await import("../src/ui/event/prizeSelectionCoordinator.ts");

const eventId = "NN3eRzoZo80";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const seed = (revision = 1, event = {}) => ({
  snapshot: {
    ok: true,
    eventId,
    revision,
    event: {
      eventId,
      status: "scheduled",
      startAtMs: revision * 1000,
      ...event,
    },
    prizeSelections: {},
  },
  etag: eventSnapshotEtag(eventId, revision),
  bookmark: `mons-d1-v1:11111111-1111-4111-8111-111111111111:bookmark-${revision}`,
});

function harness({
  api: handlers = {},
  profileId = "profile-2",
  fallbackLoginUid = null,
} = {}) {
  let now = 1000;
  let user = { uid: "login-2", getIdToken: async () => "token" };
  let published = seed();
  let timerId = 0;
  let navigationRefreshes = 0;
  const listeners = new Set();
  const timers = new Map();
  const calls = [];
  const defaults = {
    createEventViaApi: async () => ({
      ok: true,
      eventId,
      event: published.snapshot.event,
      eventSnapshot: published,
    }),
    readEventSnapshotViaApi: async () => ({
      kind: "modified",
      value: published.snapshot,
      etag: published.etag,
      bookmark: published.bookmark,
    }),
    syncEventStateViaApi: async () => ({
      ok: true,
      eventId,
      didChange: false,
      event: published.snapshot.event,
      eventSnapshot: published,
    }),
  };
  const api = Object.fromEntries(
    [
      "createEventViaApi",
      "joinEventViaApi",
      "leaveEventViaApi",
      "postponeEventStartViaApi",
      "removeEventParticipantViaApi",
      "disqualifyEventMatchWinnersViaApi",
      "syncEventStateViaApi",
      "toggleEventPrizeSelectionViaApi",
      "readEventSnapshotViaApi",
      "readProfileEventPrizesViaApi",
      "withdrawEventPrizeViaApi",
    ].map((name) => [
      name,
      async (...args) => {
        calls.push({ name, args });
        const provider = args[name === "withdrawEventPrizeViaApi" ? 3 : 1];
        provider.assertCurrentUser();
        const handler = handlers[name] ?? defaults[name];
        assert.ok(handler, `unexpected ${name}`);
        const result = await handler(...args);
        provider.assertCurrentUser();
        return result;
      },
    ]),
  );
  const provider = () => createUserBoundAuthTokenProvider(user, () => user);
  const client = new EventClient({
    getCurrentUser: () => user,
    onAuthStateChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureAuthenticated: async () => {},
    getUserBoundAuthTokenProvider: provider,
    createPollingAuthTokenProvider: provider,
    getLocalProfileId: () => profileId,
    getFallbackLoginUid: () => fallbackLoginUid,
    takeInitialEventBootstrap: () => null,
    api,
    now: () => now,
    setTimer(callback, delayMs) {
      const id = ++timerId;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    isVisible: () => true,
    addVisibilityListener: () => () => {},
    notifyNavigationGamesChanged: () => navigationRefreshes++,
  });
  return {
    client,
    calls,
    timers,
    callsTo: (name) => calls.filter((call) => call.name === name),
    advance: (ms) => (now += ms),
    navigationRefreshes: () => navigationRefreshes,
    changeAuth() {
      user = { ...user };
      for (const listener of listeners) listener();
    },
    async publish(value = seed()) {
      published = value;
      return client.createEvent(5);
    },
    async runNext(delayMs = 0) {
      const next = [...timers.entries()].find(
        ([, timer]) => timer.delayMs === delayMs,
      );
      assert.ok(next, `missing ${delayMs}ms timer`);
      const [id, timer] = next;
      timers.delete(id);
      now += delayMs;
      timer.callback();
      await settle();
    },
  };
}

test.beforeEach((t) => t.mock.method(console, "error", () => {}));

test("leave success and failure refresh the event and navigation", async () => {
  for (const succeeds of [true, false]) {
    const request = deferred();
    const h = harness({ api: { leaveEventViaApi: () => request.promise } });
    await h.publish();
    const freshness = [];
    const closeFreshness = h.client.subscribeToEventFreshness(
      eventId,
      (value) => freshness.push(value),
    );
    const close = h.client.subscribeToEvent(eventId, () => {});
    const pending = h.client.leaveEvent(eventId);
    await settle();
    if (succeeds) {
      const response = { ok: true, eventId, removedProfileId: "profile-2" };
      request.resolve(response);
      assert.deepEqual(await pending, response);
    } else {
      const rejected = assert.rejects(pending, /event-started/);
      request.reject(new Error("event-started"));
      await rejected;
    }
    assert.deepEqual(freshness, [false, true, false]);
    assert.equal(h.navigationRefreshes(), 2);
    await h.runNext();
    assert.equal(h.callsTo("readEventSnapshotViaApi").length, 1);
    close();
    closeFreshness();
  }
});

test("old leave completions cannot refresh the next authentication generation", async () => {
  for (const change of ["auth", "reset"]) {
    const request = deferred();
    const h = harness({ api: { leaveEventViaApi: () => request.promise } });
    await h.publish();
    const close = h.client.subscribeToEvent(eventId, () => {});
    const pending = h.client.leaveEvent(eventId);
    const completed =
      change === "auth"
        ? assert.rejects(pending, /authentication-changed/)
        : pending;
    await settle();
    if (change === "auth") h.changeAuth();
    else h.client.reset();
    const timers = [...h.timers.entries()];
    request.resolve({ ok: true, eventId, removedProfileId: "profile-2" });
    await completed;
    assert.equal(h.navigationRefreshes(), 1);
    assert.deepEqual([...h.timers.entries()], timers);
    close();
  }
});

function mutationHarness() {
  const requests = [];
  const events = new Map();
  const event = (id) => {
    if (!events.has(id))
      events.set(id, { member: true, selectedPrizeId: null });
    return events.get(id);
  };
  const transport = (operation, request) =>
    new Promise((resolve, reject) => {
      requests.push({
        operation,
        ...request,
        reject,
        resolve() {
          const state = event(request.eventId);
          const response = { ok: true, eventId: request.eventId };
          if (operation === "prize") {
            if (!state.member)
              return reject(new Error("participant-not-found"));
            state.selectedPrizeId =
              state.selectedPrizeId === request.prizeId
                ? null
                : request.prizeId;
            response.selectedPrizeId = state.selectedPrizeId;
          } else if (operation === "leave") {
            state.member = false;
            state.selectedPrizeId = null;
            response.removedProfileId = "profile-2";
          } else state.member = true;
          resolve(response);
        },
      });
    });
  const h = harness({
    api: {
      joinEventViaApi: (request) => transport("join", request),
      leaveEventViaApi: (request) => transport("leave", request),
      toggleEventPrizeSelectionViaApi: (request) => transport("prize", request),
    },
  });
  return { ...h, requests, event };
}

test("closing and reopening an event cannot let an old prize write overtake leaving", async () => {
  const h = mutationHarness();
  const coordinator = () =>
    createEventPrizeSelectionCoordinator({
      profileId: "profile-2",
      mutate: (prizeId) => h.client.toggleEventPrizeSelection(eventId, prizeId),
      onPendingChange: () => {},
      onSelectionsChange: () => {},
    });
  const old = coordinator();
  old.toggle("1092");
  old.toggle("1111");
  await settle();
  assert.equal(h.requests.length, 1);
  old.dispose();
  const reopened = coordinator();
  assert.equal(reopened.isPending(), false);
  const leaving = h.client.leaveEvent(eventId);
  await settle();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve();
  await settle();
  assert.deepEqual(
    h.requests.map(({ operation }) => operation),
    ["prize", "leave"],
  );
  h.requests[1].resolve();
  await leaving;
  assert.deepEqual(h.event(eventId), { member: false, selectedPrizeId: null });
  const joining = h.client.joinEvent(eventId);
  await settle();
  h.requests[2].resolve();
  await joining;
  assert.deepEqual(
    h.requests.map(({ operation }) => operation),
    ["prize", "leave", "join"],
  );
  assert.deepEqual(h.event(eventId), { member: true, selectedPrizeId: null });
  reopened.dispose();
});

test("failed event mutations release their queue without blocking other events", async () => {
  const h = mutationHarness();
  const failed = assert.rejects(
    h.client.toggleEventPrizeSelection(eventId, "1092"),
    /transport-failed/,
  );
  await settle();
  const leaving = h.client.leaveEvent(eventId);
  const joining = h.client.joinEvent("event-2");
  await settle();
  assert.deepEqual(
    h.requests.map(({ operation, eventId }) => [operation, eventId]),
    [
      ["prize", eventId],
      ["join", "event-2"],
    ],
  );
  h.requests[0].reject(new Error("transport-failed"));
  await failed;
  await settle();
  assert.equal(h.requests[2].operation, "leave");
  h.requests[2].resolve();
  await leaving;
  h.requests[1].resolve();
  await joining;
});

test("queued event mutations reject stale authentication before dispatch", async () => {
  const h = mutationHarness();
  const first = assert.rejects(
    h.client.toggleEventPrizeSelection(eventId, "1092"),
    /authentication-changed/,
  );
  await settle();
  const queued = [
    h.client.leaveEvent(eventId),
    h.client.joinEvent(eventId),
    h.client.toggleEventPrizeSelection(eventId, "1111"),
  ].map((pending) => assert.rejects(pending, /authentication-changed/));
  await settle();
  h.changeAuth();
  h.requests[0].resolve();
  await first;
  await Promise.all(queued);
  assert.equal(h.requests.length, 1);
  const next = h.client.joinEvent(eventId);
  await settle();
  h.requests[1].resolve();
  await next;
});

for (const preserveSnapshots of [false, true]) {
  test(`${preserveSnapshots ? "snapshot-preserving" : "full"} resets retain event mutation ordering`, async () => {
    const h = mutationHarness();
    const first = h.client.toggleEventPrizeSelection(eventId, "1092");
    await settle();
    if (preserveSnapshots) h.client.reset({ preserveSnapshots: true });
    else h.client.reset();
    const leaving = h.client.leaveEvent(eventId);
    await settle();
    assert.equal(h.requests.length, 1);
    h.requests[0].resolve();
    await first;
    await settle();
    assert.equal(h.requests[1].operation, "leave");
    h.requests[1].resolve();
    await leaving;
    assert.equal(h.event(eventId).member, false);
  });
}

test("sync skips empty IDs, deduplicates concurrent calls, and does not refresh navigation", async () => {
  const request = deferred();
  const h = harness({ api: { syncEventStateViaApi: () => request.promise } });
  assert.deepEqual(await h.client.syncEventState("  "), {
    ok: false,
    skipped: true,
    event: null,
  });
  const first = h.client.syncEventState(` ${eventId} `);
  const second = h.client.syncEventState(eventId);
  await settle();
  assert.equal(h.callsTo("syncEventStateViaApi").length, 1);
  assert.deepEqual(h.callsTo("syncEventStateViaApi")[0].args[0], { eventId });
  request.resolve({
    ok: true,
    eventId,
    didChange: false,
    event: seed().snapshot.event,
  });
  assert.deepEqual(await first, await second);
  assert.equal(h.navigationRefreshes(), 0);
});

test("sync cooldown follows the latest observed event status and clears when subscribers leave", async () => {
  const h = harness();
  await h.publish(seed(1, { createdByProfileId: "profile-2" }));
  const close = h.client.subscribeToEvent(eventId, () => {});
  await h.client.syncEventState(eventId);
  h.advance(1499);
  await h.client.syncEventState(eventId);
  assert.equal(h.callsTo("syncEventStateViaApi").length, 1);
  h.advance(1);
  await h.client.syncEventState(eventId);
  assert.equal(h.callsTo("syncEventStateViaApi").length, 2);
  await h.publish(
    seed(2, { status: "active", createdByProfileId: "profile-2" }),
  );
  h.advance(699);
  assert.equal((await h.client.syncEventState(eventId)).event.status, "active");
  assert.equal(h.callsTo("syncEventStateViaApi").length, 2);
  h.advance(1);
  await h.client.syncEventState(eventId);
  assert.equal(h.callsTo("syncEventStateViaApi").length, 3);
  close();
  const reopened = h.client.subscribeToEvent(eventId, () => {});
  await h.client.syncEventState(eventId);
  assert.equal(h.callsTo("syncEventStateViaApi").length, 4);
  reopened();
});

test("sync retries lock and rate limits twice with bounded delays", async () => {
  for (const reason of ["locked", "lock-lost", "rate-limited"]) {
    const h = harness({
      api: {
        syncEventStateViaApi: async () => ({
          ok: true,
          eventId,
          skipped: true,
          reason,
        }),
      },
    });
    const pending = h.client.syncEventState(eventId);
    await settle();
    assert.equal(h.callsTo("syncEventStateViaApi").length, 1);
    await h.runNext(150);
    assert.equal(h.callsTo("syncEventStateViaApi").length, 2);
    await h.runNext(300);
    const result = await pending;
    assert.equal(h.callsTo("syncEventStateViaApi").length, 3);
    assert.equal(result.reason, reason === "lock-lost" ? "locked" : reason);
    assert.equal(h.timers.size, 0);
  }
});

test("sync stops retrying on success and does not retry unrelated skips or failures", async () => {
  let calls = 0;
  const h = harness({
    api: {
      syncEventStateViaApi: async () =>
        ++calls === 1
          ? { ok: true, eventId, skipped: true, reason: "locked" }
          : {
              ok: true,
              eventId,
              didChange: true,
              event: seed().snapshot.event,
            },
    },
  });
  const pending = h.client.syncEventState(eventId);
  await settle();
  await h.runNext(150);
  assert.equal((await pending).didChange, true);
  assert.equal(calls, 2);
  assert.equal(h.timers.size, 0);
  for (const reason of ["not-participant", "other"]) {
    const skipped = harness({
      api: {
        syncEventStateViaApi: async () => ({
          ok: true,
          eventId,
          skipped: true,
          reason,
        }),
      },
    });
    assert.equal((await skipped.client.syncEventState(eventId)).skipped, true);
    assert.equal(skipped.callsTo("syncEventStateViaApi").length, 1);
    assert.equal(skipped.timers.size, 0);
  }
  const failed = harness({
    api: {
      syncEventStateViaApi: async () => {
        throw new Error("offline");
      },
    },
  });
  await assert.rejects(failed.client.syncEventState(eventId), /offline/);
  await assert.rejects(failed.client.syncEventState(eventId), /offline/);
  assert.equal(failed.callsTo("syncEventStateViaApi").length, 2);
});

test("sync allows creators and participants while skipping observed nonmembers", async () => {
  for (const [event, allowed] of [
    [{ createdByProfileId: "profile-2" }, true],
    [{ createdByLoginUid: "login-2" }, true],
    [{ participants: { "profile-2": {} } }, true],
    [{ createdByProfileId: "other", participants: {} }, false],
  ]) {
    const h = harness();
    await h.publish(seed(1, event));
    const close = h.client.subscribeToEvent(eventId, () => {});
    const result = await h.client.syncEventState(eventId);
    assert.equal(h.callsTo("syncEventStateViaApi").length, allowed ? 1 : 0);
    if (!allowed) assert.equal(result.reason, "not-participant");
    close();
  }
  const anonymousProfile = harness({ profileId: null });
  await anonymousProfile.publish();
  const close = anonymousProfile.client.subscribeToEvent(eventId, () => {});
  await anonymousProfile.client.syncEventState(eventId);
  assert.equal(anonymousProfile.callsTo("syncEventStateViaApi").length, 1);
  close();
});

test("old sync completions cannot seed or cool down the next subscription generation", async () => {
  const request = deferred();
  let calls = 0;
  const h = harness({
    api: {
      syncEventStateViaApi: async () =>
        ++calls === 1
          ? request.promise
          : {
              ok: true,
              eventId,
              didChange: true,
              event: seed(3).snapshot.event,
              eventSnapshot: seed(3),
            },
    },
  });
  const observed = [];
  const close = h.client.subscribeToEvent(eventId, (value) =>
    observed.push(value),
  );
  const old = h.client.syncEventState(eventId);
  await settle();
  h.client.reset();
  request.resolve({
    ok: true,
    eventId,
    didChange: true,
    event: seed(2).snapshot.event,
    eventSnapshot: seed(2),
  });
  await old;
  assert.deepEqual(observed, [null]);
  await h.client.syncEventState(eventId);
  assert.equal(calls, 2);
  assert.equal(observed.at(-1).startAtMs, 3000);
  close();
});

test("auth replacement rejects a pending sync and permits the new owner to retry", async () => {
  const request = deferred();
  let calls = 0;
  const h = harness({
    api: {
      syncEventStateViaApi: () =>
        ++calls === 1
          ? request.promise
          : { ok: true, eventId, didChange: false, event: null },
    },
  });
  const old = assert.rejects(
    h.client.syncEventState(eventId),
    /authentication-changed/,
  );
  await settle();
  h.changeAuth();
  request.resolve({ ok: true, eventId, didChange: false, event: null });
  await old;
  await h.client.syncEventState(eventId);
  assert.equal(calls, 2);
});
