import assert from "node:assert/strict";
import test from "node:test";
import { prepareEventProfileGameProjection } from "../src/eventProfileGameProjectionProducer.ts";
import { handleProfileGameProjectionMessage } from "../src/profileGameProjection.ts";
import {
  EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME,
  PROFILE_GAME_PROJECTION_QUEUE_NAME,
  type EventProfileGameProjectionTask,
} from "../src/profileGameProjectionTasks.ts";
import worker from "../src/workerHandler.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "./testEnv.ts";

const task: EventProfileGameProjectionTask = {
  kind: "event-profile-game-projection",
  eventId: "event-queue-isolation",
  requestId: "request-queue-isolation",
};

function delivery(body: unknown = task) {
  const outcomes: string[] = [];
  const retries: QueueRetryOptions[] = [];
  const message: Message<unknown> = {
    id: "message-1",
    attempts: 1,
    timestamp: new Date(0),
    body,
    ack: () => outcomes.push("ack"),
    retry: (options) => {
      outcomes.push("retry");
      retries.push(options || {});
    },
  };
  return { message, outcomes, retries };
}

function batch(
  queue: string,
  message: Message<unknown>,
): MessageBatch<unknown> {
  return {
    queue,
    messages: [message],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  };
}

const logger = { info: () => undefined, error: () => undefined };

test("event producers use the dedicated queue with unchanged task payloads", async () => {
  const sent: unknown[] = [];
  const prepared = await prepareEventProfileGameProjection(
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PROFILE_GAME_PROJECTION_QUEUE: {
        ...TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
        send: async (body) => {
          sent.push(body);
          return TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE.send();
        },
      },
      PROFILE_GAME_PROJECTION_QUEUE: {
        ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
        send: async () => {
          throw new Error("shared-archive-queue-unavailable");
        },
      },
    },
    [
      {
        kind: "event-field",
        eventId: task.eventId,
        field: "status",
        value: "active",
      },
    ],
    { readEvent: async () => null },
    { createRequestId: () => task.requestId, now: () => 100 },
  );
  assert.ok(prepared);
  assert.deepEqual(sent, []);
  await prepared.dispatch();
  assert.deepEqual(sent, [task]);
});

test("legacy event messages acknowledge only after dedicated forwarding succeeds", async () => {
  const tracked = delivery();
  const sending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const logs: string[] = [];
  const processing = handleProfileGameProjectionMessage(
    tracked.message,
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PROFILE_GAME_PROJECTION_QUEUE: {
        ...TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
        send: async (body) => {
          assert.deepEqual(body, task);
          sending.resolve();
          await release.promise;
          tracked.outcomes.push("sent");
          return TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE.send();
        },
      },
    },
    {
      forwardEventTasks: true,
      createStateRepository: () => {
        throw new Error("forwarding-must-not-read-event-state");
      },
      logger: {
        info: (value) => logs.push(String(value)),
        error: logger.error,
      },
    },
  );
  await sending.promise;
  assert.deepEqual(tracked.outcomes, []);
  release.resolve();
  await processing;
  assert.deepEqual(tracked.outcomes, ["sent", "ack"]);
  assert.deepEqual(tracked.retries, []);
  assert.ok(
    logs.some(
      (entry) => entry.includes(task.eventId) && entry.includes(task.requestId),
    ),
  );
});

test("legacy forwarding failures retry without acknowledging", async () => {
  const tracked = delivery();
  await handleProfileGameProjectionMessage(
    tracked.message,
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PROFILE_GAME_PROJECTION_QUEUE: {
        ...TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
        send: async () => {
          throw new Error("queue-unavailable");
        },
      },
    },
    { forwardEventTasks: true, logger },
  );
  assert.deepEqual(tracked.outcomes, ["retry"]);
  assert.equal(tracked.retries.length, 1);
});

test("Worker routes legacy events to forwarding and dedicated events to processing", async () => {
  const sent: unknown[] = [];
  const environment: Env = {
    ...TELEGRAM_TEST_ENV,
    EVENT_PROFILE_GAME_PROJECTION_QUEUE: {
      ...TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
      send: async (body) => {
        sent.push(body);
        return TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE.send();
      },
    },
  };
  const legacy = delivery();
  await worker.queue(
    batch(PROFILE_GAME_PROJECTION_QUEUE_NAME, legacy.message),
    environment,
  );
  assert.deepEqual(legacy.outcomes, ["ack"]);
  assert.deepEqual(sent, [task]);
  const dedicated = delivery();
  await worker.queue(
    batch(EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME, dedicated.message),
    environment,
  );
  assert.deepEqual(dedicated.outcomes, ["ack"]);
  assert.deepEqual(sent, [task]);
});

test("the dedicated event queue honors frozen profile and automatch controls", async () => {
  const frozenAutomatch: Env = {
    ...TELEGRAM_TEST_ENV,
    PROFILE_GAMES_DB: {
      ...TELEGRAM_TEST_ENV.PROFILE_GAMES_DB,
      prepare(query) {
        const base = TELEGRAM_TEST_ENV.PROFILE_GAMES_DB.prepare(query);
        if (!query.includes("automatch_runtime_control")) return base;
        const statement: D1PreparedStatement = {
          all: async <T>() => {
            const result = await base.all<T>();
            return {
              ...result,
              results: result.results.map((row) => ({
                ...row,
                state: "frozen",
              })),
            };
          },
          raw: base.raw.bind(base),
          run: base.run.bind(base),
          bind: () => statement,
          first: async <T>() =>
            ({
              ...(await base.first()),
              state: "frozen",
            }) as T,
        };
        return statement;
      },
      withSession() {
        return {
          prepare: this.prepare.bind(this),
          batch: this.batch.bind(this),
          getBookmark: () => null,
        };
      },
    },
  };
  for (const environment of [
    withProfileControl(TELEGRAM_TEST_ENV, "frozen"),
    frozenAutomatch,
  ]) {
    const tracked = delivery();
    await worker.queue(
      batch(EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME, tracked.message),
      environment,
    );
    assert.deepEqual(tracked.outcomes, ["retry"]);
    assert.deepEqual(tracked.retries, [{ delaySeconds: 300 }]);
  }
});

test("the dedicated event queue fails unreadable profile control closed", async () => {
  const tracked = delivery();
  await worker.queue(
    batch(EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME, tracked.message),
    {
      ...TELEGRAM_TEST_ENV,
      PROFILE_DB: {
        ...TELEGRAM_TEST_ENV.PROFILE_DB,
        prepare() {
          throw new Error("profile-control-unavailable");
        },
      },
    },
  );
  assert.deepEqual(tracked.outcomes, ["retry"]);
  assert.deepEqual(tracked.retries, [{ delaySeconds: 300 }]);
});

test("the dedicated event queue rejects unrelated work", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (value: unknown) => logs.push(String(value)));
  const tracked = delivery({
    kind: "rating-profile-game-projection",
    operationId: "invite-1__match-1",
  });
  await worker.queue(
    batch(EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME, tracked.message),
    TELEGRAM_TEST_ENV,
  );
  assert.deepEqual(tracked.outcomes, ["ack"]);
  assert.ok(
    logs.some((entry) =>
      entry.includes("event_profile_game_projection_queue_invalid_message"),
    ),
  );
});
