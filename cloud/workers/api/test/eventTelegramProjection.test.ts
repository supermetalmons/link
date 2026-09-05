import assert from "node:assert/strict";
import test from "node:test";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import {
  processEventProjectionTask,
  sweepEventTelegramProjections,
} from "../src/eventTelegramProjection.ts";
import {
  getEventTelegramProjectionGenerationPath,
  getEventTelegramProjectionOutboxPath,
} from "../src/eventTelegramProjectionProducer.ts";
import type {
  RatingProjectionRepository,
  RatingUpdateData,
} from "../src/gameplayRepository.ts";
import type { TelegramProjectionTask } from "../src/telegramProjectionTasks.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function store(initial: Record<string, unknown>) {
  const values = new Map(Object.entries(initial));
  const client: FirebaseRtdbClient = {
    async getPath(path) {
      return values.get(path) ?? null;
    },
    async patchRoot(updates) {
      for (const [path, value] of Object.entries(updates)) {
        values.set(path, value);
      }
    },
    async transactPath(path, updater) {
      const current = values.get(path) ?? null;
      const output = updater(current) as
        | { commit: false; decision?: string }
        | { value: unknown; decision?: string };
      if ("commit" in output && output.commit === false) {
        return {
          committed: false,
          decision: output.decision,
          value: current,
        };
      }
      if (!("value" in output)) {
        throw new Error("invalid-transaction-output");
      }
      values.set(path, output.value);
      return {
        committed: true,
        decision: output.decision,
        value: output.value,
      };
    },
  };
  return {
    client,
    read: (path: string) => values.get(path) ?? null,
    write: (path: string, value: unknown) => values.set(path, value),
  };
}

function ratingRepository(): RatingProjectionRepository {
  return {
    applyFebruaryChallengeReplay: async () => undefined,
    claimRatingTelegramProjection: async () => false,
    finalizeRatingUpdate: async () => ({ status: "lost" }),
    getRtdbPath: async () => null,
    listDueRatingTelegramProjections: async () => [],
    markRatingTelegramProjection: async () => undefined,
    patchRtdbRoot: async () => undefined,
    readProfileOwnershipSnapshot: async () => {
      throw new Error("unexpected-profile-ownership-read");
    },
    readRatingUpdate: async (): Promise<RatingUpdateData | null> => null,
    hasCompletedRatingUpdate: async () => false,
    tryAcquireRatingLease: async () => ({ status: "busy", data: null }),
  };
}

const task = {
  kind: "event-telegram-projection" as const,
  eventId: "event-1",
  requestId: "request-1",
};

const marker = {
  schemaVersion: 1,
  status: "pending",
  requestId: "request-1",
  firstQueuedAtMs: 100,
  updatedAtMs: 100,
};

function scheduledEvent() {
  return {
    telegramDeliveryVersion: 2,
    announceOnTelegram: true,
    status: "scheduled",
    startAtMs: Date.UTC(2026, 7, 26, 17),
    participants: {},
    rounds: {},
  };
}

test("event projection persists desired state before delivery and clears its outbox", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
    "events/event-1": scheduledEvent(),
  });
  const deliveries: Array<Record<string, string>> = [];
  assert.equal(
    await processEventProjectionTask(
      task,
      state.client,
      ratingRepository(),
      async (input) => {
        assert.ok(state.read(`telegramMessages/${input.messageKey}/desired`));
        assert.equal(state.read("eventTelegramProjections/event-1"), null);
        deliveries.push(input);
      },
      () => Date.UTC(2026, 7, 25, 12),
    ),
    "projected",
  );
  assert.equal(
    state.read(getEventTelegramProjectionOutboxPath(task.eventId)),
    null,
  );
  assert.ok(state.read("eventTelegramProjections/event-1"));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].producer, "event-projection");
  assert.equal(state.read("eventTelegramProjectionLocks/event-1"), null);
});

test("missing events clear work without creating Telegram messages", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
  });
  let deliveries = 0;
  assert.equal(
    await processEventProjectionTask(
      task,
      state.client,
      ratingRepository(),
      async () => void deliveries++,
      () => 200,
    ),
    "missing",
  );
  assert.equal(deliveries, 0);
  assert.equal(
    state.read(getEventTelegramProjectionOutboxPath(task.eventId)),
    null,
  );
});

test("a successor marker survives completion of older work", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
    "events/event-1": scheduledEvent(),
  });
  await processEventProjectionTask(
    task,
    state.client,
    ratingRepository(),
    async () => {
      state.write(getEventTelegramProjectionOutboxPath(task.eventId), {
        ...marker,
        requestId: "request-2",
        updatedAtMs: 200,
      });
    },
    () => 200,
  );
  assert.deepEqual(
    state.read(getEventTelegramProjectionOutboxPath(task.eventId)),
    {
      ...marker,
      requestId: "request-2",
      updatedAtMs: 200,
    },
  );
});

test("projection lock contention is retryable", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
    "events/event-1": scheduledEvent(),
    "eventTelegramProjectionLocks/event-1": {
      lockId: "foreign",
      ownerUid: "foreign",
      expiresAtMs: Date.now() + 60_000,
    },
  });
  await assert.rejects(
    () =>
      processEventProjectionTask(
        task,
        state.client,
        ratingRepository(),
        async () => undefined,
        Date.now,
      ),
    /event-telegram-lock-busy/,
  );
});

test("a newer generation fences stale desired and state commits", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
    [getEventTelegramProjectionGenerationPath(task.eventId)]: 1,
    "events/event-1": scheduledEvent(),
    "eventTelegramProjections/event-1": {
      eventTelegramProjectionGuard: { generation: 2 },
    },
    "telegramMessages/event:event-1:upcoming/desired": {
      eventTelegramProjectionGuard: { generation: 2 },
      revision: "newer",
    },
  });
  let deliveries = 0;
  assert.equal(
    await processEventProjectionTask(
      task,
      state.client,
      ratingRepository(),
      async () => void deliveries++,
      () => 200,
    ),
    "superseded",
  );
  assert.equal(deliveries, 0);
  assert.equal(
    (
      state.read("telegramMessages/event:event-1:upcoming/desired") as {
        revision: string;
      }
    ).revision,
    "newer",
  );
});

test("event sweep claims valid markers and dead-letters malformed records", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath("event-1")]: marker,
    [getEventTelegramProjectionOutboxPath("event-bad")]: {
      status: "pending",
      updatedAtMs: 100,
    },
  });
  const getPath = state.client.getPath;
  state.client.getPath = async (path, query) => {
    if (path === "telegramProjectionOutbox/event") {
      assert.deepEqual(query, {
        orderBy: "updatedAtMs",
        startAt: 0,
        endAt: 200,
        limitToFirst: 100,
      });
      return {
        "event-1": marker,
        "event-bad": { status: "pending", updatedAtMs: 100 },
      };
    }
    return getPath(path, query);
  };
  const batches: TelegramProjectionTask[][] = [];
  const queue = {
    ...TELEGRAM_TEST_ENV.TELEGRAM_PROJECTION_QUEUE,
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      batches.push(
        Array.from(messages).map(({ body }) => body as TelegramProjectionTask),
      );
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  } satisfies Queue<TelegramProjectionTask>;
  assert.equal(
    await sweepEventTelegramProjections(queue, state.client, 200),
    1,
  );
  assert.deepEqual(batches.flat(), [task]);
  assert.deepEqual(
    state.read(getEventTelegramProjectionOutboxPath("event-1")),
    { ...marker, updatedAtMs: 200 },
  );
  assert.deepEqual(
    state.read(getEventTelegramProjectionOutboxPath("event-bad")),
    {
      status: "dead",
      reason: "invalid-record",
      updatedAtMs: null,
      deadAtMs: 200,
    },
  );
});
