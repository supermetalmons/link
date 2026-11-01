import assert from "node:assert/strict";
import test from "node:test";
import { prepareEventProfileGameProjection } from "../src/eventProfileGameProjectionProducer.ts";
import { handleProfileGameProjectionMessage as handleQueueMessage } from "../src/profileGameProjection/queue.ts";
import { createEventProfileGameProjectionState } from "../src/eventProfileGameProjectionState.ts";
import {
  EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME,
  PROFILE_GAME_PROJECTION_QUEUE_NAME,
  type EventProfileGameProjectionTask,
} from "../src/profileGameProjectionTasks.ts";
import worker from "../src/workerHandler.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "./testEnv.ts";
import { queueEnvelope, parseQueueEnvelope } from "../src/queueEnvelope.ts";
import { parseProfileGameProjectionTask } from "../src/profileGameProjectionTasks.ts";

const task: EventProfileGameProjectionTask = {
  kind: "event-profile-game-projection",
  eventId: "event-queue-isolation",
  requestId: "request-queue-isolation",
};

function sentPayload(value: unknown) {
  const envelope = parseQueueEnvelope(
    value,
    "EVENT_PROFILE_GAME_PROJECTION_QUEUE",
  );
  assert.ok(envelope);
  const payload = parseProfileGameProjectionTask(envelope.payload);
  assert.ok(payload);
  return payload;
}

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
): Parameters<typeof worker.queue>[0] {
  const payload = parseProfileGameProjectionTask(message.body);
  if (!payload) throw new Error("invalid test queue payload");
  return {
    queue,
    messages: [
      {
        ...message,
        body: queueEnvelope(
          queue === EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME
            ? "EVENT_PROFILE_GAME_PROJECTION_QUEUE"
            : "PROFILE_GAME_PROJECTION_QUEUE",
          payload,
        ),
      },
    ],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  };
}

const logger = { info: () => undefined, error: () => undefined };

test("event projection state avoids constructing profile gameplay dependencies", async () => {
  const state = createEventProfileGameProjectionState({
    ...TELEGRAM_TEST_ENV,
    get PROFILE_DB(): D1Database {
      throw new Error("event-state-must-not-construct-profile-gameplay");
    },
  });
  assert.equal(await state.readEvent(task.eventId), null);
  assert.deepEqual(await state.readInviteMetadataMany([]), []);
  const aborted = AbortSignal.abort(new Error("projection-aborted"));
  await assert.rejects(
    state.readInviteMetadataMany([], aborted),
    /projection-aborted/,
  );
});

test("event messages use their narrow state without unrelated dependencies", async () => {
  const tracked = delivery();
  const logs: unknown[] = [];
  let reads = 0;
  const unrelatedDependency = () => {
    throw new Error("unexpected-non-event-dependency");
  };
  await handleQueueMessage(tracked.message, TELEGRAM_TEST_ENV, {
    createEventStateRepository: () => ({
      ...createEventProfileGameProjectionState(TELEGRAM_TEST_ENV),
      readEventProfileGameProjectionOutbox: async (eventId) => {
        assert.equal(eventId, task.eventId);
        reads++;
        return null;
      },
    }),
    createEventRuntime: () => ({
      reconcileEventProjection: unrelatedDependency,
    }),
    createStateRepository: unrelatedDependency,
    createRuntime: unrelatedDependency,
    createRating: unrelatedDependency,
    createLocks: unrelatedDependency,
    createProfileLinkJobs: unrelatedDependency,
    logger: {
      info: (value) => logs.push(JSON.parse(String(value))),
      error: logger.error,
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(tracked.outcomes, ["ack"]);
  assert.deepEqual(tracked.retries, []);
  assert.deepEqual(logs, [
    {
      event: "profile_game_projection_queue_processed",
      kind: task.kind,
      eventId: task.eventId,
      requestId: task.requestId,
      status: "stale",
      messageId: tracked.message.id,
      attempts: tracked.message.attempts,
    },
  ]);
});

test("event producers use the dedicated queue with unchanged task payloads", async () => {
  const sent: unknown[] = [];
  const prepared = await prepareEventProfileGameProjection(
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PROFILE_GAME_PROJECTION_QUEUE: {
        ...TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
        send: async (body) => {
          sent.push(sentPayload(body));
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

test("Worker rejects misrouted events and processes the dedicated event queue", async () => {
  const sent: unknown[] = [];
  const environment: Env = {
    ...TELEGRAM_TEST_ENV,
    EVENT_PROFILE_GAME_PROJECTION_QUEUE: {
      ...TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
      send: async (body) => {
        sent.push(sentPayload(body));
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
  assert.deepEqual(sent, []);
  const dedicated = delivery();
  await worker.queue(
    batch(EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME, dedicated.message),
    environment,
  );
  assert.deepEqual(dedicated.outcomes, ["ack"]);
  assert.deepEqual(sent, []);
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
