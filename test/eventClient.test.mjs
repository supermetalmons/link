import { createTimerHandle } from "./fixtures/timerHandle.mjs";
import {
  required,
  canonicalEvent,
  canonicalParticipant,
} from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import { eventSnapshotEtag } from "@mons/shared/events";

registerTypeScriptTestHooks();

const { EventClient } = await import("../src/connection/eventClient.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");
const { createEventPrizeSelectionCoordinator } =
  await import("../src/ui/event/prizeSelectionCoordinator.ts");

const eventId = "NN3eRzoZo80";
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** @template [T=void] @returns {PromiseWithResolvers<T>} */
const deferred = () => {
  /** @type {PromiseWithResolvers<T>} */
  const pending = Promise.withResolvers();
  return {
    promise: pending.promise,
    resolve: pending.resolve,
    reject: pending.reject,
  };
};
/** @param {number} [revision] @param {Parameters<typeof canonicalEvent>[0]} [event] @returns {import("@mons/shared/events").EventSnapshotSeed & {snapshot: {event: import("@mons/shared/events").EventRecord}}} */
const seed = (revision = 1, event = {}) => ({
  snapshot: {
    ok: true,
    eventId,
    revision,
    event: canonicalEvent({ eventId, startAtMs: revision * 1000, ...event }),
    prizeSelections: {},
  },
  etag: eventSnapshotEtag(eventId, revision),
  bookmark: `mons-d1-v1:11111111-1111-4111-8111-111111111111:bookmark-${revision}`,
});

/**
 * @typedef {import("../src/connection/eventClient.ts").EventClientApi} ClientApi
 * @typedef {{[K in keyof ClientApi]?: (...args: Parameters<ClientApi[K]>) => ReturnType<ClientApi[K]> | Awaited<ReturnType<ClientApi[K]>>}} Handlers
 * @typedef {{ok: true, eventId: string, didChange?: boolean, event?: null, skipped?: true, reason?: string}} RawSyncResponse
 * @param {{api?: Handlers, rawSync?: () => RawSyncResponse | Promise<RawSyncResponse>, profileId?: string | null, fallbackLoginUid?: string | null}} [options]
 */
function harness({
  api: handlers = {},
  rawSync,
  profileId = "profile-2",
  fallbackLoginUid = null,
} = {}) {
  let now = 1000;
  let user = {
    sessionId: "session-2",
    generation: "generation-2",
    uid: "login-2",
    getIdToken: async () => "token",
  };
  let published = seed();
  let navigationRefreshes = 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {Map<ReturnType<typeof createTimerHandle>, {callback: () => void, delayMs: number}>} */
  const timers = new Map();
  /** @type {{name: keyof ClientApi, args: unknown[]}[]} */
  const calls = [];
  /** @type {Handlers} */
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
  /** @template {keyof ClientApi} K @param {K} name */
  const wrap =
    (name) =>
    /** @param {Parameters<ClientApi[K]>} args @returns {Promise<Awaited<ReturnType<ClientApi[K]>>>} */
    async (...args) => {
      calls.push({ name, args });
      const provider = args[name === "withdrawEventPrizeViaApi" ? 3 : 1];
      assert.ok(
        typeof provider === "function" &&
          "assertCurrentUser" in provider &&
          typeof provider.assertCurrentUser === "function",
      );
      provider.assertCurrentUser();
      const handler =
        (name === "syncEventStateViaApi" ? rawSync : undefined) ??
        handlers[name] ??
        defaults[name];
      assert.ok(handler, `unexpected ${name}`);
      /** @type {Awaited<ReturnType<ClientApi[K]>>} */
      const result = await Reflect.apply(handler, undefined, args);
      provider.assertCurrentUser();
      return result;
    };
  const api = {
    createEventViaApi: wrap("createEventViaApi"),
    joinEventViaApi: wrap("joinEventViaApi"),
    leaveEventViaApi: wrap("leaveEventViaApi"),
    postponeEventStartViaApi: wrap("postponeEventStartViaApi"),
    removeEventParticipantViaApi: wrap("removeEventParticipantViaApi"),
    disqualifyEventMatchWinnersViaApi: wrap(
      "disqualifyEventMatchWinnersViaApi",
    ),
    syncEventStateViaApi: wrap("syncEventStateViaApi"),
    toggleEventPrizeSelectionViaApi: wrap("toggleEventPrizeSelectionViaApi"),
    readEventSnapshotViaApi: wrap("readEventSnapshotViaApi"),
    readProfileEventPrizesViaApi: wrap("readProfileEventPrizesViaApi"),
    withdrawEventPrizeViaApi: wrap("withdrawEventPrizeViaApi"),
  };
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
      const id = createTimerHandle();
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
    callsTo: (/** @type {keyof ClientApi} */ name) =>
      calls.filter((call) => call.name === name),
    advance: (/** @type {number} */ ms) => (now += ms),
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

test.beforeEach(() => test.mock.method(console, "error", () => {}));

test("leave success and failure refresh the event and navigation", async () => {
  for (const succeeds of [true, false]) {
    /** @type {PromiseWithResolvers<import("@mons/shared/events").LeaveEventResponse>} */
    const request = deferred();
    const h = harness({ api: { leaveEventViaApi: () => request.promise } });
    await h.publish();
    /** @type {(boolean)[]} */
    const freshness = [];
    const closeFreshness = h.client.subscribeToEventFreshness(
      eventId,
      (value) => freshness.push(value),
    );
    const close = h.client.subscribeToEvent(eventId, () => {});
    const pending = h.client.leaveEvent(eventId);
    await settle();
    if (succeeds) {
      /** @type {import("@mons/shared/events").LeaveEventResponse} */
      const response = { ok: true, eventId, removedProfileId: "profile-2" };
      required(request.resolve)(response);
      assert.deepEqual(await pending, response);
    } else {
      const rejected = assert.rejects(pending, /event-started/);
      required(request.reject)(new Error("event-started"));
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
    /** @type {PromiseWithResolvers<import("@mons/shared/events").LeaveEventResponse>} */
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
    required(request.resolve)({
      ok: true,
      eventId,
      removedProfileId: "profile-2",
    });
    await completed;
    assert.equal(h.navigationRefreshes(), 1);
    assert.deepEqual([...h.timers.entries()], timers);
    close();
  }
});

function mutationHarness() {
  /** @typedef {{member: boolean, selectedPrizeId: import("@mons/shared/event-prizes").EventPrizeId | null}} MutationState */
  /** @type {{operation: string, eventId: string, prizeId?: string, reject: (reason: unknown) => void, resolve: () => void}[]} */
  const requests = [];
  /** @type {Map<string, MutationState>} */
  const events = new Map();
  /** @param {string} id */
  const event = (id) => {
    if (!events.has(id))
      events.set(id, { member: true, selectedPrizeId: null });
    return required(events.get(id));
  };
  /** @template T @param {string} operation @param {{eventId: string, prizeId?: string}} request @param {(state: MutationState) => T} complete @returns {Promise<T>} */
  const transport = (operation, request, complete) =>
    new Promise((resolve, reject) => {
      requests.push({
        operation,
        ...request,
        reject,
        resolve() {
          try {
            resolve(complete(event(request.eventId)));
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  const h = harness({
    api: {
      joinEventViaApi: (request) =>
        transport("join", request, (state) => {
          state.member = true;
          return {
            ok: true,
            eventId: request.eventId,
            participant: {
              ...canonicalParticipant({ profileId: "profile-2" }),
              loginUid: "login-2",
              state: "active",
              eliminatedRoundIndex: null,
              eliminatedByProfileId: null,
            },
          };
        }),
      leaveEventViaApi: (request) =>
        transport("leave", request, (state) => {
          state.member = false;
          state.selectedPrizeId = null;
          return {
            ok: true,
            eventId: request.eventId,
            removedProfileId: "profile-2",
          };
        }),
      toggleEventPrizeSelectionViaApi: (request) =>
        transport("prize", request, (state) => {
          if (!state.member) throw new Error("participant-not-found");
          state.selectedPrizeId =
            state.selectedPrizeId === request.prizeId ? null : request.prizeId;
          return {
            ok: true,
            eventId: request.eventId,
            selectedPrizeId: state.selectedPrizeId,
          };
        }),
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
  required(h.requests[0]).resolve();
  await settle();
  assert.deepEqual(
    h.requests.map(({ operation }) => operation),
    ["prize", "leave"],
  );
  required(h.requests[1]).resolve();
  await leaving;
  assert.deepEqual(h.event(eventId), { member: false, selectedPrizeId: null });
  const joining = h.client.joinEvent(eventId);
  await settle();
  required(h.requests[2]).resolve();
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
  required(h.requests[0]).reject(new Error("transport-failed"));
  await failed;
  await settle();
  assert.equal(required(h.requests[2]).operation, "leave");
  required(h.requests[2]).resolve();
  await leaving;
  required(h.requests[1]).resolve();
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
  required(h.requests[0]).resolve();
  await first;
  await Promise.all(queued);
  assert.equal(h.requests.length, 1);
  const next = h.client.joinEvent(eventId);
  await settle();
  required(h.requests[1]).resolve();
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
    required(h.requests[0]).resolve();
    await first;
    await settle();
    assert.equal(required(h.requests[1]).operation, "leave");
    required(h.requests[1]).resolve();
    await leaving;
    assert.equal(h.event(eventId).member, false);
  });
}

test("sync skips empty IDs, deduplicates concurrent calls, and does not refresh navigation", async () => {
  /** @type {PromiseWithResolvers<Awaited<ReturnType<ClientApi["syncEventStateViaApi"]>>>} */
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
  assert.deepEqual(required(h.callsTo("syncEventStateViaApi")[0]).args[0], {
    eventId,
  });
  required(request.resolve)({
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
  assert.equal(
    required((await h.client.syncEventState(eventId)).event).status,
    "active",
  );
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
  for (const reason of /** @type {const} */ ([
    "locked",
    "locked",
    "rate-limited",
  ])) {
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
    assert.equal(result.reason, reason === "locked" ? "locked" : reason);
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
      rawSync: async () => ({ ok: true, eventId, skipped: true, reason }),
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
  for (const [
    event,
    allowed,
  ] of /** @type {[Parameters<typeof canonicalEvent>[0], boolean][]} */ ([
    [{ createdByProfileId: "profile-2" }, true],
    [{ createdByLoginUid: "login-2" }, true],
    [{ participants: { "profile-2": {} } }, true],
    [{ createdByProfileId: "other", participants: {} }, false],
  ])) {
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
  /** @type {PromiseWithResolvers<Awaited<ReturnType<ClientApi["syncEventStateViaApi"]>>>} */
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
  /** @type {(import("@mons/shared/events").EventRecord | null)[]} */
  const observed = [];
  const latestObserved = () => observed.at(-1);
  const close = h.client.subscribeToEvent(eventId, (value) =>
    observed.push(value),
  );
  const old = h.client.syncEventState(eventId);
  await settle();
  h.client.reset();
  required(request.resolve)({
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
  assert.equal(required(latestObserved()).startAtMs, 3000);
  close();
});

test("auth replacement rejects a pending sync and permits the new owner to retry", async () => {
  /** @type {PromiseWithResolvers<RawSyncResponse>} */
  const request = deferred();
  let calls = 0;
  const h = harness({
    rawSync: () =>
      ++calls === 1
        ? request.promise
        : { ok: true, eventId, didChange: false, event: null },
  });
  const old = assert.rejects(
    h.client.syncEventState(eventId),
    /authentication-changed/,
  );
  await settle();
  h.changeAuth();
  required(request.resolve)({
    ok: true,
    eventId,
    didChange: false,
    event: null,
  });
  await old;
  await h.client.syncEventState(eventId);
  assert.equal(calls, 2);
});

test("match completion waits for an earlier sync, bypasses its cooldown, and deduplicates across navigation", async () => {
  const earlier = deferred();
  let calls = 0;
  const h = harness({
    api: {
      syncEventStateViaApi: async () => {
        if (++calls === 1) await earlier.promise;
        return {
          ok: true,
          eventId,
          didChange: true,
          event: seed(calls).snapshot.event,
          eventSnapshot: seed(calls),
        };
      },
    },
  });
  const close = h.client.subscribeToEvent(eventId, () => {});
  const ordinary = h.client.syncEventState(eventId);
  await settle();
  const first = h.client.syncEventStateAfterMatch(eventId, "match-1");
  const duplicate = h.client.syncEventStateAfterMatch(eventId, "match-1");
  await settle();
  assert.equal(calls, 1);
  close();
  h.client.reset({ preserveSnapshots: true });
  earlier.resolve();
  await ordinary;
  assert.deepEqual(await first, await duplicate);
  assert.equal(calls, 2);
  assert.equal(
    (await h.client.syncEventStateAfterMatch(eventId, "match-1")).ok,
    true,
  );
  assert.equal(calls, 2);
  await h.client.syncEventStateAfterMatch(eventId, "match-2");
  assert.equal(calls, 3);
});

test("match completion retries contention beyond the event throttle and allows recovery after failure", async () => {
  let calls = 0;
  const h = harness({
    api: {
      syncEventStateViaApi: async () => {
        calls++;
        return calls <= 3
          ? { ok: true, eventId, skipped: true, reason: "rate-limited" }
          : {
              ok: true,
              eventId,
              didChange: true,
              event: seed(2).snapshot.event,
              eventSnapshot: seed(2),
            };
      },
    },
  });
  const pending = h.client.syncEventStateAfterMatch(eventId, "match-1");
  await settle();
  await h.runNext(550);
  await h.runNext(1000);
  assert.equal((await pending).skipped, true);
  assert.equal(calls, 3);
  assert.equal(
    (await h.client.syncEventStateAfterMatch(eventId, "match-1")).ok,
    true,
  );
  assert.equal(calls, 4);
});

test("match completion cannot dispatch for a replaced session while waiting for an earlier sync", async () => {
  const earlier = deferred();
  const h = harness({
    api: {
      syncEventStateViaApi: async () => {
        await earlier.promise;
        return {
          ok: true,
          eventId,
          didChange: false,
          event: seed().snapshot.event,
        };
      },
    },
  });
  const ordinary = assert.rejects(
    h.client.syncEventState(eventId),
    /authentication-changed/,
  );
  await settle();
  const completion = assert.rejects(
    h.client.syncEventStateAfterMatch(eventId, "match-1"),
    /request-aborted/,
  );
  h.changeAuth();
  earlier.resolve();
  await Promise.all([ordinary, completion]);
  assert.equal(h.callsTo("syncEventStateViaApi").length, 1);
  await h.client.syncEventStateAfterMatch(eventId, "match-1");
  assert.equal(h.callsTo("syncEventStateViaApi").length, 2);
});

test("match completion uses server participation checks for linked profiles and retains retryability after transport failure", async () => {
  let calls = 0;
  const h = harness({
    profileId: "linked-profile",
    api: {
      syncEventStateViaApi: async () => {
        if (++calls === 1) throw new Error("offline");
        return {
          ok: true,
          eventId,
          didChange: true,
          event: seed(2).snapshot.event,
          eventSnapshot: seed(2),
        };
      },
    },
  });
  await h.publish(seed(1, { createdByProfileId: "another-profile" }));
  const close = h.client.subscribeToEvent(eventId, () => {});
  await assert.rejects(
    h.client.syncEventStateAfterMatch(eventId, "match-1"),
    /offline/,
  );
  await h.client.syncEventStateAfterMatch(eventId, "match-1");
  assert.equal(calls, 2);
  close();
});
