"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { event: eventFixture } = require("./fixtures/canonicalEvents");
const { createEventRuntime } = require("../runtime/events");

const {
  encodeEventUpdates,
} = require("../workers/api/test/eventLegacyFixtureCodec.ts");
const eventId = "NN3eRzoZo80";

/**
 * @typedef {Parameters<typeof createEventRuntime>[0]} Dependencies
 * @typedef {import("../runtime/shared/events").EventRecord} EventRecord
 * @typedef {import("./fixtures/canonicalEvents").EventPatch} EventPatch
 * @typedef {import("../runtime/eventReads").EventPrizeAssignmentRecord} Assignment
 */
/** @param {{lockedEvent: EventPatch, prizeSelections?: Record<string, string>, lockOwned?: boolean | ((checks: number) => boolean), trackLeaseChecks?: boolean, readMatchPairs?: Dependencies["readMatchPairs"], readProfileOwnershipSnapshot?: Dependencies["readProfileOwnershipSnapshot"], readEventPrizeWithdrawals?: NonNullable<Dependencies["readEventPrizeWithdrawals"]>, projectedPrizes?: Record<string, Assignment | null>}} input */
function createRuntime({
  lockedEvent,
  prizeSelections = {},
  lockOwned = true,
  trackLeaseChecks = false,
  readMatchPairs = () => assert.fail("unexpected match batch read"),
  readProfileOwnershipSnapshot = () => assert.fail("unexpected ownership read"),
  readEventPrizeWithdrawals = () => assert.fail("unexpected withdrawal read"),
  projectedPrizes = {},
}) {
  const snapshotEvent = eventFixture({ eventId, ...lockedEvent });
  /** @type {string[]} */
  const calls = [];
  let event = eventFixture({ eventId, startAtMs: 10_000 });
  /** @type {Record<string, unknown>[]} */
  const patches = [];
  /** @type {(readonly import("../runtime/eventCommands").EventCommand[])[]} */
  const plans = [];
  let leaseChecks = 0;
  /** @type {import("../runtime/eventCommands").EventRuntimeStore & {read(): never, readEventPrizeSelections(): never}} */
  const state = {
    read: () => assert.fail("unexpected generic event read"),
    transactEventSyncThrottle: () => assert.fail("unexpected sync throttle"),
    readEvent: async (candidateEventId) => {
      assert.equal(candidateEventId, eventId);
      calls.push("read");
      return structuredClone(event);
    },
    readEventSnapshot: async (candidateEventId) => {
      assert.equal(candidateEventId, eventId);
      calls.push("snapshot");
      return {
        event: structuredClone(snapshotEvent),
        eventId,
        prizeSelections: structuredClone(prizeSelections),
        revision: 1,
      };
    },
    readEventPrizeSelections: () =>
      assert.fail("snapshot already includes prize selections"),
    commitEventPlan: async (plan) => {
      const updates = encodeEventUpdates(plan);
      calls.push("write");
      patches.push(updates);
      plans.push(structuredClone(plan));
      for (const [key, value] of Object.entries(updates)) {
        const parts = key.split("/");
        if (parts[0] === "events") {
          assert.ok(parts[2]);
          Reflect.set(event, parts[2], value);
        }
      }
      event.updatedAtMs = 1_001;
    },
    transactProfileEventPrize: async (profileId, candidateEventId, update) => {
      assert.equal(candidateEventId, eventId);
      calls.push(`project:${profileId}`);
      const current = projectedPrizes[profileId] ?? null;
      const decision = update(current);
      if ("commit" in decision) return { committed: false, value: current };
      projectedPrizes[profileId] = decision.value;
      return { committed: true, value: decision.value };
    },
  };
  const runtime = createEventRuntime({
    state: state,
    eventLockManager: {
      acquireEventLockWithRetry: async () => {
        calls.push("lock");
        event = structuredClone(snapshotEvent);
        return {
          eventId,
          key: { kind: "event", id: eventId },
          lockId: "fixture-lock",
          ownerUid: "worker",
          lockRoot: "eventLocks",
        };
      },
      isEventLockStillOwned: async () => {
        leaseChecks += 1;
        if (trackLeaseChecks) calls.push("check");
        return typeof lockOwned === "function"
          ? lockOwned(leaseChecks)
          : lockOwned;
      },
      releaseEventLock: async () => {
        calls.push("release");
        return true;
      },
      startEventLockHeartbeat: () => () => {},
    },
    readMatchPair: () => assert.fail("unexpected single match read"),
    readMatchPairs,
    readProfileOwnershipSnapshot,
    readEventPrizeWithdrawals: async (candidateEventId) => {
      calls.push("withdrawals");
      return readEventPrizeWithdrawals(candidateEventId);
    },
    enqueueEventProgressTask: () => assert.fail("unexpected progress task"),
    now: () => 1_000,
    sleep: () => assert.fail("unexpected retry"),
  });
  return { runtime, calls, patches, plans };
}

test("sync uses the locked event and selections snapshot and rereads after committing", async () => {
  const { runtime, calls, patches } = createRuntime({
    lockedEvent: { status: "scheduled", startAtMs: 500, participants: {} },
    prizeSelections: { "departed-player": "1092" },
  });
  const result = await runtime.runEventSyncState({
    eventId,
    requesterUid: "worker",
    enforceParticipantGate: false,
    enforceThrottle: false,
    syncLog: {},
  });

  assert.ok(result.event);
  assert.equal(result.event.status, "dismissed");
  assert.equal(result.event.updatedAtMs, 1_001);
  assert.ok(patches[0]);
  assert.equal(patches[0][`eventPrizeSelections/${eventId}`], null);
  assert.deepEqual(calls, [
    "read",
    "lock",
    "snapshot",
    "write",
    "read",
    "release",
  ]);
});

test("sync discards a stale planned transition when the event lock is lost", async () => {
  /** @type {EventPatch} */
  const lockedEvent = { status: "scheduled", startAtMs: 500, participants: {} };
  const { runtime, calls, patches } = createRuntime({
    lockedEvent,
    lockOwned: false,
  });
  const result = await runtime.runEventSyncState({
    eventId,
    requesterUid: "worker",
    enforceParticipantGate: false,
    enforceThrottle: false,
    syncLog: {},
  });

  assert.equal(result.reason, "locked");
  assert.deepEqual(result.event, eventFixture({ eventId, ...lockedEvent }));
  assert.deepEqual(patches, []);
  assert.deepEqual(calls, ["read", "lock", "snapshot", "read", "release"]);
});

for (const status of /** @type {const} */ (["active", "ended"])) {
  test(`${status} sync does not commit when a round batch read fails`, async () => {
    const failure = new Error("match-state-source-changed");
    let batches = 0;
    const { runtime, calls, patches } = createRuntime({
      lockedEvent: {
        status,
        participants: {},
        rounds: {
          0: {
            matches: {
              "0_0": {
                status: "pending",
                inviteId: "event-match",
                hostProfileId: "host-profile",
                guestProfileId: "guest-profile",
                hostLoginUid: "host-login",
                guestLoginUid: "guest-login",
              },
            },
          },
        },
      },
      readProfileOwnershipSnapshot: async () => ({
        canonicalProfileIdByProfileId: new Map(),
        loginOwnerByUid: new Map(),
        loginUidsByProfileId: new Map(),
        profileById: new Map(),
      }),
      readMatchPairs: async (inputs) => {
        batches += 1;
        assert.equal(inputs.length, 1);
        throw failure;
      },
    });

    await assert.rejects(
      runtime.runEventSyncState({
        eventId,
        requesterUid: "worker",
        enforceParticipantGate: false,
        enforceThrottle: false,
        syncLog: {},
      }),
      failure,
    );
    assert.equal(batches, 1);
    assert.deepEqual(patches, []);
    assert.deepEqual(calls, ["read", "lock", "snapshot", "release"]);
  });
}

/** @param {"active" | "ended"} status */
function completedFinalEvent(status) {
  const ended = status === "ended";
  return eventFixture({
    eventId,
    status,
    currentRoundIndex: 0,
    endedAtMs: ended ? 500 : null,
    winnerProfileId: ended ? "p1" : null,
    winnerDisplayName: ended ? "P1" : null,
    prizeSelectionsLockedAtMs: ended ? 500 : null,
    participants: Object.fromEntries(
      ["p1", "p2"].map((profileId, index) => [
        profileId,
        {
          profileId,
          loginUid: `${profileId}-login`,
          displayName: profileId.toUpperCase(),
          joinedAtMs: index,
          state: "active",
        },
      ]),
    ),
    rounds: {
      0: {
        status: ended ? "completed" : "active",
        completedAtMs: ended ? 500 : null,
        matches: {
          "0_0": {
            status: "host",
            resolvedAtMs: 500,
            hostProfileId: "p1",
            guestProfileId: "p2",
            winnerProfileId: "p1",
            loserProfileId: "p2",
          },
        },
      },
    },
  });
}

/** @param {number} assignedAtMs @returns {Record<string, Assignment>} */
function prizeAssignments(assignedAtMs) {
  return Object.fromEntries(
    ["p1", "p2"].map((profileId, index) => [
      String(index + 1),
      {
        eventId,
        profileId,
        place: index === 0 ? 1 : 2,
        prizeId: index === 0 ? "1514" : "1092",
        assignedAtMs,
      },
    ]),
  );
}

/** @param {EventRecord} lockedEvent @param {Partial<Parameters<typeof createRuntime>[0]>} [options] */
function prizeRuntime(lockedEvent, options = {}) {
  const profileIds = Object.keys(lockedEvent.participants);
  return createRuntime({
    lockedEvent,
    prizeSelections: { p1: "1514", p2: "1092" },
    trackLeaseChecks: true,
    readEventPrizeWithdrawals: async () => ({}),
    readProfileOwnershipSnapshot: async () => ({
      canonicalProfileIdByProfileId: new Map(profileIds.map((id) => [id, id])),
      loginOwnerByUid: new Map(
        profileIds.map((id) => [`${id}-login`, { profileId: id, revision: 1 }]),
      ),
      loginUidsByProfileId: new Map(
        profileIds.map((id) => [id, [`${id}-login`]]),
      ),
      profileById: new Map(),
    }),
    ...options,
  });
}

/** @param {import("../runtime/events").EventRuntime} runtime */
const synchronize = (runtime) =>
  runtime.runEventSyncState({
    eventId,
    requesterUid: "worker",
    enforceParticipantGate: false,
    enforceThrottle: false,
    syncLog: {},
  });

test("active completion preserves command order before prize projection and cleanup", async () => {
  const memory = prizeRuntime(completedFinalEvent("active"));
  const result = await synchronize(memory.runtime);
  assert.ok(memory.plans[0]);
  assert.deepEqual(
    memory.plans[0].map((command) =>
      "field" in command ? command.field : undefined,
    ),
    [
      "prizeSelectionsLockedAtMs",
      "prizeAssignments",
      "status",
      "endedAtMs",
      "winnerProfileId",
      "winnerDisplayName",
      "rounds",
      "participants",
      "updatedAtMs",
    ],
  );
  assert.ok(result.event);
  assert.equal(result.event.status, "ended");
  assert.equal(result.event.endedAtMs, 1_000);
  assert.deepEqual(result.event.prizeAssignments, prizeAssignments(1_000));
  assert.equal(result.event.thirdPlaceMatch, null);
  assert.deepEqual(memory.calls, [
    "read",
    "lock",
    "snapshot",
    "check",
    "write",
    "check",
    "withdrawals",
    "project:p1",
    "project:p2",
    "check",
    "withdrawals",
    "read",
    "release",
  ]);
});

test("unchanged ended events still repair prize projections without rewriting assignments", async () => {
  const event = completedFinalEvent("ended");
  event.prizeAssignments = prizeAssignments(500);
  const memory = prizeRuntime(event);
  const result = await synchronize(memory.runtime);
  assert.equal(result.didChange, true);
  assert.deepEqual(memory.plans, []);
  assert.deepEqual(result.event, event);
  assert.deepEqual(memory.calls, [
    "read",
    "lock",
    "snapshot",
    "check",
    "withdrawals",
    "project:p1",
    "project:p2",
    "check",
    "withdrawals",
    "read",
    "release",
  ]);
});

test("ended prize repair preserves the original completion time and terminal fields", async () => {
  const event = completedFinalEvent("ended");
  event.prizeSelectionsLockedAtMs = null;
  const memory = prizeRuntime(event);
  const result = await synchronize(memory.runtime);
  assert.ok(memory.plans[0]);
  assert.deepEqual(
    memory.plans[0].map((command) =>
      "field" in command ? command.field : undefined,
    ),
    ["prizeSelectionsLockedAtMs", "prizeAssignments", "updatedAtMs"],
  );
  assert.ok(result.event);
  assert.equal(result.event.prizeSelectionsLockedAtMs, 500);
  assert.deepEqual(result.event.prizeAssignments, prizeAssignments(500));
  assert.deepEqual(result.event.participants, event.participants);
  assert.deepEqual(result.event.rounds, event.rounds);
});

for (const failedCheck of [1, 2, 3]) {
  test(`active sync stops after losing its lease at write stage ${failedCheck}`, async () => {
    const memory = prizeRuntime(completedFinalEvent("active"), {
      lockOwned: (check) => check !== failedCheck,
    });
    if (failedCheck === 1) {
      const result = await synchronize(memory.runtime);
      assert.equal(result.reason, "locked");
      assert.equal(memory.plans.length, 0);
    } else {
      await assert.rejects(
        synchronize(memory.runtime),
        failedCheck === 2
          ? /Event lock expired while projecting prizes/
          : /Event lock expired while cleaning prize projections/,
      );
      assert.equal(memory.plans.length, 1);
    }
    assert.equal(
      memory.calls.filter((call) => call === "withdrawals").length,
      failedCheck === 3 ? 1 : 0,
    );
    assert.equal(
      memory.calls.filter((call) => call.startsWith("project:")).length,
      failedCheck === 3 ? 2 : 0,
    );
    assert.equal(memory.calls.at(-1), "release");
  });
}
