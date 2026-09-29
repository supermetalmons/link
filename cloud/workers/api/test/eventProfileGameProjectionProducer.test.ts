import assert from "node:assert/strict";
import test from "node:test";
import type { EventCommand } from "../../../runtime/eventCommands.js";
import { decodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import { prepareEventProfileGameProjection } from "../src/eventProfileGameProjectionProducer.ts";
import type { EventProfileGameProjectionTask } from "../src/profileGameProjectionTasks.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

test("event preparation emits sparse outbox fields and deduplicated cleanup owners", async () => {
  const enqueued: EventProfileGameProjectionTask[] = [];
  const prepared = await prepareEventProfileGameProjection(
    TELEGRAM_TEST_ENV,
    [
      {
        kind: "event-participant",
        eventId: "event-1",
        profileId: "source-profile",
        value: null,
      },
      {
        kind: "event-field",
        eventId: "event-1",
        field: "updatedAtMs",
        value: 123,
      },
    ],
    {
      readEvent: async (eventId) => {
        assert.equal(eventId, "event-1");
        return {
          participants: {
            source: { profileId: "source-profile" },
            target: { profileId: "target-profile" },
            duplicate: { profileId: "source-profile" },
          },
        };
      },
    },
    {
      createRequestId: () => "request-1",
      enqueue: async (task) => {
        enqueued.push(task);
      },
      now: () => 123,
    },
  );

  assert.ok(prepared);
  assert.deepEqual(prepared.commands, [
    {
      kind: "profile-game-outbox-field",
      eventId: "event-1",
      field: "schemaVersion",
      value: 1,
    },
    {
      kind: "profile-game-outbox-field",
      eventId: "event-1",
      field: "status",
      value: "pending",
    },
    {
      kind: "profile-game-outbox-field",
      eventId: "event-1",
      field: "requestId",
      value: "request-1",
    },
    {
      kind: "profile-game-outbox-field",
      eventId: "event-1",
      field: "lastQueuedAtMs",
      value: 123,
    },
    {
      kind: "profile-game-outbox-field",
      eventId: "event-1",
      field: "reason",
      value: null,
    },
    {
      kind: "profile-game-outbox-field",
      eventId: "event-1",
      field: "deadAtMs",
      value: null,
    },
    {
      kind: "profile-game-outbox-cleanup",
      eventId: "event-1",
      profileId: "source-profile",
      value: true,
    },
    {
      kind: "profile-game-outbox-cleanup",
      eventId: "event-1",
      profileId: "target-profile",
      value: true,
    },
  ]);
  assert.deepEqual(enqueued, []);
  await prepared.dispatch();
  assert.deepEqual(enqueued, [
    {
      kind: "event-profile-game-projection",
      eventId: "event-1",
      requestId: "request-1",
    },
  ]);
});

test("event replacement and deletion preserve accumulated cleanup children", async () => {
  let previousOwner = "owner-a";
  let requestIndex = 0;
  const prepare = (updates: readonly EventCommand[]) =>
    prepareEventProfileGameProjection(
      TELEGRAM_TEST_ENV,
      updates,
      {
        readEvent: async () => ({
          participants: { owner: { profileId: previousOwner } },
        }),
      },
      {
        createRequestId: () => `request-${++requestIndex}`,
        now: () => 456,
      },
    );
  const first = await prepare([
    { kind: "event", eventId: "event-1", value: { participants: {} } },
  ]);
  previousOwner = "owner-b";
  const second = await prepare(decodeEventUpdates({ "events/event-1": null }));
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(
    first.commands.filter(
      (command) => command.kind === "profile-game-outbox-cleanup",
    ),
    [
      {
        kind: "profile-game-outbox-cleanup",
        eventId: "event-1",
        profileId: "owner-a",
        value: true,
      },
    ],
  );
  assert.deepEqual(
    second.commands.filter(
      (command) => command.kind === "profile-game-outbox-cleanup",
    ),
    [
      {
        kind: "profile-game-outbox-cleanup",
        eventId: "event-1",
        profileId: "owner-b",
        value: true,
      },
    ],
  );
  assert.ok(
    [...first.commands, ...second.commands].every(
      (command) =>
        command.kind === "profile-game-outbox-field" ||
        command.kind === "profile-game-outbox-cleanup",
    ),
  );
});

test("irrelevant commands prepare no profile game projection work", async () => {
  const updates: EventCommand[] = [
    { kind: "invite", inviteId: "invite-1", value: { status: "active" } },
    { kind: "event-round", eventId: "event-1", roundKey: "0", value: {} },
  ];
  const prepared = await prepareEventProfileGameProjection(
    TELEGRAM_TEST_ENV,
    updates,
    { readEvent: async () => assert.fail("unexpected event read") },
    {
      createRequestId: () => assert.fail("unexpected request id"),
      now: () => assert.fail("unexpected clock read"),
      enqueue: async () => assert.fail("unexpected enqueue"),
    },
  );
  assert.equal(prepared, null);
});

test("dispatch sorts and deduplicates events and logs enqueue failures", async () => {
  const reads: string[] = [];
  const enqueued: EventProfileGameProjectionTask[] = [];
  const logs: string[] = [];
  let requestIndex = 0;
  const prepared = await prepareEventProfileGameProjection(
    TELEGRAM_TEST_ENV,
    [
      {
        kind: "event-field",
        eventId: "event-b",
        field: "status",
        value: "active",
      },
      {
        kind: "event-field",
        eventId: "event-a",
        field: "status",
        value: "active",
      },
      {
        kind: "event-participant",
        eventId: "event-b",
        profileId: "owner",
        value: null,
      },
    ],
    {
      readEvent: async (eventId) => {
        reads.push(eventId);
        return null;
      },
    },
    {
      createRequestId: () => `request-${++requestIndex}`,
      enqueue: async (task) => {
        enqueued.push(task);
        if (task.eventId === "event-a") throw new Error("queue-unavailable");
      },
      logger: { error: (message) => logs.push(String(message)) },
      now: () => 789,
    },
  );
  assert.ok(prepared);
  const commands = structuredClone(prepared.commands);
  await prepared.dispatch();
  assert.deepEqual(reads, ["event-a", "event-b"]);
  assert.deepEqual(enqueued, [
    {
      kind: "event-profile-game-projection",
      eventId: "event-a",
      requestId: "request-1",
    },
    {
      kind: "event-profile-game-projection",
      eventId: "event-b",
      requestId: "request-2",
    },
  ]);
  assert.deepEqual(prepared.commands, commands);
  assert.deepEqual(
    logs.map((message) => JSON.parse(message)),
    [
      {
        event: "event_profile_game_projection_enqueue_failed",
        kind: "event-profile-game-projection",
        eventId: "event-a",
        requestId: "request-1",
        outcome: "failed",
      },
    ],
  );
});
