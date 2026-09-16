"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createEventRuntime } = require("../runtime/events");

const {
  encodeEventUpdates,
} = require("../workers/api/src/eventCompatibilityCodec.ts");
const eventId = "NN3eRzoZo80";

function createRuntime({
  lockedEvent,
  prizeSelections = {},
  lockOwned = true,
  readMatchPairs = () => assert.fail("unexpected match batch read"),
  readProfileOwnershipSnapshot = () => assert.fail("unexpected ownership read"),
}) {
  const calls = [];
  let event = { status: "scheduled", startAtMs: 10_000 };
  const patches = [];
  const runtime = createEventRuntime({
    state: {
      read: () => assert.fail("unexpected generic event read"),
      readEvent: async (candidateEventId) => {
        assert.equal(candidateEventId, eventId);
        calls.push("read");
        return structuredClone(event);
      },
      readEventSnapshot: async (candidateEventId) => {
        assert.equal(candidateEventId, eventId);
        calls.push("snapshot");
        return {
          event: structuredClone(lockedEvent),
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
        for (const [key, value] of Object.entries(updates)) {
          const parts = key.split("/");
          if (parts[0] === "events") event[parts[2]] = value;
        }
        event.persistedRevision = 2;
      },
    },
    eventLockManager: {
      acquireEventLockWithRetry: async () => {
        calls.push("lock");
        event = structuredClone(lockedEvent);
        return { eventId };
      },
      isEventLockStillOwned: async () => lockOwned,
      releaseEventLock: async () => {
        calls.push("release");
        return true;
      },
      startEventLockHeartbeat: () => () => {},
    },
    readMatchPair: () => assert.fail("unexpected single match read"),
    readMatchPairs,
    readProfileOwnershipSnapshot,
    readEventPrizeWithdrawals: () => assert.fail("unexpected withdrawal read"),
    enqueueEventProgressTask: () => assert.fail("unexpected progress task"),
    now: () => 1_000,
    sleep: () => assert.fail("unexpected retry"),
  });
  return { runtime, calls, patches };
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

  assert.equal(result.event.status, "dismissed");
  assert.equal(result.event.persistedRevision, 2);
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
  assert.deepEqual(result.event, lockedEvent);
  assert.deepEqual(patches, []);
  assert.deepEqual(calls, ["read", "lock", "snapshot", "read", "release"]);
});

for (const status of ["active", "ended"]) {
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
                status: "active",
                inviteId: "event-match",
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
