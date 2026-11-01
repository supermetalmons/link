import assert from "node:assert/strict";
import test from "node:test";
import {
  retainEventProjectionOutbox,
  isEventProjectionPending,
} from "../../../runtime/eventProjectionOutboxRecords.js";
import { parseEventMutation } from "../../../runtime/eventCommandCodec.js";
import {
  repairEventProfileProjectionRecord,
  markInvalidEventTelegramProjectionRecord,
} from "../src/eventProjectionRecoveryRecords.ts";

const profile = {
  schemaVersion: 1,
  status: "pending",
  requestId: "request",
  lastQueuedAtMs: 100,
  cleanupOwnerProfileIds: { owner: true },
  reason: "joined",
};
const telegram = {
  schemaVersion: 1,
  status: "pending",
  requestId: "request",
  firstQueuedAtMs: 50,
  updatedAtMs: 100,
};

test("projection outbox models preserve complete pending and dead identities", () => {
  for (const [kind, pending] of [
    ["profile-game", profile],
    ["telegram", telegram],
  ] as const) {
    assert.equal(isEventProjectionPending(kind, pending), true);
    assert.deepEqual(retainEventProjectionOutbox(kind, pending), pending);
    const dead = {
      schemaVersion: 2,
      status: "dead",
      requestId: "request",
      reason: "invalid-record",
      deadAtMs: 200,
      sourceDigest: "a".repeat(64),
      originalRecord: pending,
    };
    assert.deepEqual(retainEventProjectionOutbox(kind, dead), dead);
    assert.equal(isEventProjectionPending(kind, dead), false);
    assert.deepEqual(
      parseEventMutation({
        kind:
          kind === "profile-game" ? "profile-game-outbox" : "telegram-outbox",
        eventId: "event",
        value: dead,
      }).value,
      dead,
    );
  }
});

test("unversioned roots, extensions, missing deadlines and malformed nested dead evidence reject", () => {
  for (const kind of ["profile-game", "telegram"] as const)
    for (const value of [
      null,
      [],
      {},
      false,
      { status: "pending", requestId: "request" },
      { ...(kind === "profile-game" ? profile : telegram), extension: true },
    ])
      assert.throws(
        () => retainEventProjectionOutbox(kind, value),
        /invalid-event-projection-outbox/,
      );
  assert.throws(
    () =>
      retainEventProjectionOutbox("telegram", {
        schemaVersion: 1,
        status: "pending",
        requestId: "request",
        updatedAtMs: 100,
      }),
    /invalid-event-projection-outbox/,
  );
  assert.throws(
    () =>
      retainEventProjectionOutbox("telegram", {
        ...telegram,
        firstQueuedAtMs: 101,
      }),
    /invalid-event-projection-outbox/,
  );
  assert.throws(
    () =>
      retainEventProjectionOutbox("profile-game", {
        ...profile,
        cleanupOwnerProfileIds: { owner: false },
      }),
    /invalid-event-projection-outbox/,
  );
  assert.throws(
    () =>
      retainEventProjectionOutbox("telegram", {
        schemaVersion: 2,
        status: "dead",
        requestId: "request",
        reason: "invalid-record",
        deadAtMs: 200,
        sourceDigest: "a".repeat(64),
        originalRecord: { ...telegram, requestId: "other" },
      }),
    /invalid-event-projection-outbox/,
  );
});

test("runtime recovery rejects malformed payloads instead of adapting retained arbitrary data", () => {
  assert.throws(
    () =>
      repairEventProfileProjectionRecord({ extra: true } as never, {
        eventId: "event",
        safeEventId: true,
        requestId: "request",
        nowMs: 200,
      }),
    /invalid-event-projection-outbox/,
  );
  assert.throws(
    () =>
      markInvalidEventTelegramProjectionRecord(
        { status: "pending", updatedAtMs: 100 } as never,
        "event",
        200,
      ),
    /invalid-event-projection-outbox/,
  );
  assert.deepEqual(
    repairEventProfileProjectionRecord(
      retainEventProjectionOutbox("profile-game", profile),
      { eventId: "event", safeEventId: true, requestId: "next", nowMs: 200 },
    ),
    { commit: false, decision: "changed" },
  );
});
