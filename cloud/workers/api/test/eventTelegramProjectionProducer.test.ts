import assert from "node:assert/strict";
import test from "node:test";
import { prepareEventTelegramProjection } from "../src/eventTelegramProjectionProducer.ts";
import type { EventTelegramProjectionTask } from "../src/telegramProjectionTasks.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

test("event preparation emits exact outboxes and generations for sorted unique events", async () => {
  const enqueued: EventTelegramProjectionTask[] = [];
  let requestIndex = 0;
  const prepared = prepareEventTelegramProjection(
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
        field: "updatedAtMs",
        value: 123,
      },
      {
        kind: "event-field",
        eventId: "event-b",
        field: "updatedAtMs",
        value: 123,
      },
      { kind: "invite", inviteId: "invite-1", value: { status: "active" } },
    ],
    {
      createRequestId: () => `request-${++requestIndex}`,
      enqueue: async (task) => {
        enqueued.push(task);
      },
      now: () => 123,
    },
  );

  assert.ok(prepared);
  assert.deepEqual(prepared.commands, [
    {
      kind: "telegram-outbox",
      eventId: "event-a",
      value: {
        schemaVersion: 1,
        status: "pending",
        requestId: "request-1",
        firstQueuedAtMs: 123,
        updatedAtMs: 123,
      },
    },
    {
      kind: "telegram-generation",
      eventId: "event-a",
      value: 1,
      increment: true,
    },
    {
      kind: "telegram-outbox",
      eventId: "event-b",
      value: {
        schemaVersion: 1,
        status: "pending",
        requestId: "request-2",
        firstQueuedAtMs: 123,
        updatedAtMs: 123,
      },
    },
    {
      kind: "telegram-generation",
      eventId: "event-b",
      value: 1,
      increment: true,
    },
  ]);
  assert.deepEqual(enqueued, []);
  await prepared.dispatch();
  assert.deepEqual(enqueued, [
    {
      kind: "event-telegram-projection",
      eventId: "event-a",
      requestId: "request-1",
    },
    {
      kind: "event-telegram-projection",
      eventId: "event-b",
      requestId: "request-2",
    },
  ]);
});

test("non-event commands prepare no telegram projection work", () => {
  const prepared = prepareEventTelegramProjection(
    TELEGRAM_TEST_ENV,
    [{ kind: "invite", inviteId: "invite-1", value: { status: "active" } }],
    {
      createRequestId: () => assert.fail("unexpected request id"),
      now: () => assert.fail("unexpected clock read"),
      enqueue: async () => assert.fail("unexpected enqueue"),
    },
  );
  assert.equal(prepared, null);
});

test("dispatch logs enqueue failure without altering recovery commands or skipping other events", async () => {
  const enqueued: EventTelegramProjectionTask[] = [];
  const logs: string[] = [];
  let requestIndex = 0;
  const prepared = prepareEventTelegramProjection(
    TELEGRAM_TEST_ENV,
    [
      {
        kind: "event-field",
        eventId: "event-a",
        field: "status",
        value: "active",
      },
      {
        kind: "event-field",
        eventId: "event-b",
        field: "status",
        value: "active",
      },
    ],
    {
      createRequestId: () => `request-${++requestIndex}`,
      enqueue: async (task) => {
        enqueued.push(task);
        if (task.eventId === "event-a") throw new Error("queue-unavailable");
      },
      logger: { error: (message) => logs.push(String(message)) },
      now: () => 456,
    },
  );
  assert.ok(prepared);
  const commands = structuredClone(prepared.commands);
  await prepared.dispatch();
  assert.deepEqual(enqueued, [
    {
      kind: "event-telegram-projection",
      eventId: "event-a",
      requestId: "request-1",
    },
    {
      kind: "event-telegram-projection",
      eventId: "event-b",
      requestId: "request-2",
    },
  ]);
  assert.deepEqual(prepared.commands, commands);
  assert.deepEqual(
    logs.map((message) => JSON.parse(message)),
    [{ event: "event_telegram_projection_enqueue_failed", eventId: "event-a" }],
  );
});
