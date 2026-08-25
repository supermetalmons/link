import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventTelegramProjectionRepository,
  getEventTelegramProjectionGenerationPath,
  getEventTelegramProjectionOutboxPath,
} from "../src/eventTelegramProjectionProducer.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function repository(
  patch: GameplayRepository["patchRtdbRoot"],
): GameplayRepository {
  return {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    findProfileId: async () => null,
    getGameplayProfile: async () => null,
    getMiningMaterials: async () => ({
      dust: 0,
      gum: 0,
      ice: 0,
      metal: 0,
      slime: 0,
    }),
    getMiningSnapshot: async () => null,
    getNavigationGame: async () => null,
    getRtdbPath: async () => null,
    patchRtdbRoot: patch,
    transactRtdbPath: async () => ({ committed: false, value: null }),
  };
}

test("event writes persist exact outboxes before enqueueing", async () => {
  const patches: Record<string, unknown>[] = [];
  const enqueued: Array<Record<string, string>> = [];
  let patchCompleted = false;
  let requestIndex = 0;
  const wrapped = createEventTelegramProjectionRepository(
    TELEGRAM_TEST_ENV,
    repository(async (updates) => {
      patches.push(updates);
      patchCompleted = true;
    }),
    {
      createRequestId: () => `request-${++requestIndex}`,
      enqueue: async (task) => {
        assert.equal(patchCompleted, true);
        enqueued.push(task);
      },
      now: () => 123,
    },
  );

  await wrapped.patchRtdbRoot({
    "events/event-b/status": "active",
    "events/event-a/updatedAtMs": 123,
    "events/event-b/updatedAtMs": 123,
    "invites/invite-1/status": "active",
  });

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
  assert.deepEqual(
    patches[0][getEventTelegramProjectionOutboxPath("event-a")],
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      firstQueuedAtMs: 123,
      updatedAtMs: 123,
    },
  );
  assert.deepEqual(
    patches[0][getEventTelegramProjectionGenerationPath("event-a")],
    { ".sv": { increment: 1 } },
  );
});

test("non-event writes pass through without projection work", async () => {
  const patches: Record<string, unknown>[] = [];
  let enqueues = 0;
  const wrapped = createEventTelegramProjectionRepository(
    TELEGRAM_TEST_ENV,
    repository(async (updates) => {
      patches.push(updates);
    }),
    {
      enqueue: async () => {
        enqueues++;
      },
    },
  );
  const updates = { "invites/invite-1/status": "active" };
  await wrapped.patchRtdbRoot(updates);
  assert.deepEqual(patches, [updates]);
  assert.equal(enqueues, 0);
});

test("enqueue failure leaves the committed marker recoverable", async () => {
  let persisted: Record<string, unknown> = {};
  const logs: string[] = [];
  const wrapped = createEventTelegramProjectionRepository(
    TELEGRAM_TEST_ENV,
    repository(async (updates) => {
      persisted = updates;
    }),
    {
      createRequestId: () => "request-1",
      enqueue: async () => {
        throw new Error("queue-unavailable");
      },
      logger: { error: (message) => logs.push(message) },
      now: () => 456,
    },
  );
  await wrapped.patchRtdbRoot({ "events/event-1/status": "active" });
  assert.deepEqual(persisted[getEventTelegramProjectionOutboxPath("event-1")], {
    schemaVersion: 1,
    status: "pending",
    requestId: "request-1",
    firstQueuedAtMs: 456,
    updatedAtMs: 456,
  });
  assert.equal(logs.length, 1);
});

test("scheduled dispatch does not hold the committed mutation open", async () => {
  let finishEnqueue: (() => void) | undefined;
  const enqueueBlocked = new Promise<void>((resolve) => {
    finishEnqueue = resolve;
  });
  const scheduled: Promise<void>[] = [];
  const wrapped = createEventTelegramProjectionRepository(
    TELEGRAM_TEST_ENV,
    repository(async () => undefined),
    {
      createRequestId: () => "request-1",
      enqueue: () => enqueueBlocked,
      now: () => 789,
      schedule: (work) => scheduled.push(work),
    },
  );
  await wrapped.patchRtdbRoot({ "events/event-1/status": "active" });
  assert.equal(scheduled.length, 1);
  finishEnqueue?.();
  await scheduled[0];
});
