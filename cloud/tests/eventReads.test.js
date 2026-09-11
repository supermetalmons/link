"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createEventRuntime } = require("../runtime/events");

const eventId = "NN3eRzoZo80";

function createRuntime({
  lockedEvent,
  prizeSelections = {},
  lockOwned = true,
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
      update: async (path, updates) => {
        assert.equal(path, "");
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
    readProfileOwnershipSnapshot: () =>
      assert.fail("unexpected ownership read"),
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
