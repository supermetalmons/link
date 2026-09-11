import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryEngine.js";
import { MAX_RECORD_KEY_BYTES } from "../src/recordKeys.ts";
import {
  handleTelegramQueueMessage,
  infrastructureRetryDelaySeconds,
  logicalDelaySeconds,
} from "../src/telegramQueue.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const task = {
  messageKey: "automatch:invite-1",
  revision: "revision-1",
  taskKind: "desired",
  retrySequence: 0,
  generation: "event-1",
};

function envWithQueue(send: Queue["send"]): Env {
  return {
    ...TELEGRAM_TEST_ENV,
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    HELIUS_RPC_API_KEY: "test-helius-key",
    NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    TELEGRAM_DELIVERY_QUEUE: {
      ...TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE,
      send,
    },
    X_CLIENT_ID: "test-x-client",
    X_CLIENT_SECRET: "test-x-secret",
  };
}

function queueMessage(body: unknown, attempts = 1) {
  let acknowledgements = 0;
  const retries: QueueRetryOptions[] = [];
  return {
    message: {
      id: "queue-message-1",
      timestamp: new Date(0),
      body,
      attempts,
      ack: () => {
        acknowledgements += 1;
      },
      retry: (options?: QueueRetryOptions) => {
        retries.push(options || {});
      },
    } satisfies Message<unknown>,
    acknowledgements: () => acknowledgements,
    retries,
  };
}

const unusedRepository = {} as TelegramRepository;

const wagerTask = {
  kind: "wager-settlement" as const,
  inviteId: "invite-1",
  matchId: "invite-1",
  operationId: "a".repeat(64),
};

const recoverableWagerTask = {
  ...wagerTask,
  resolution: {
    winnerUid: "host",
    winnerProfileId: "profile-host",
    loserUid: "guest",
    loserProfileId: "profile-guest",
  },
};

test("acknowledges processed tasks and preserves one-second pacing", async () => {
  const queued = queueMessage(task);
  const sleeps: number[] = [];
  await handleTelegramQueueMessage(
    queued.message,
    envWithQueue(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
    {
      createRepository: () => unusedRepository,
      createEngine: () => ({
        reconcile: async () => ({ status: "settled" }),
      }),
      logger: { error() {}, info() {} },
      now: () => 10_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    },
  );
  assert.equal(queued.acknowledgements(), 1);
  assert.deepEqual(queued.retries, []);
  assert.deepEqual(sleeps, [1_000]);
});

test("acks invalid poison messages and retries infrastructure failures", async () => {
  const invalid = queueMessage({ nope: true });
  const failed = queueMessage(task, 4);
  const dependencies = {
    createRepository: () => unusedRepository,
    logger: { error() {}, info() {} },
    now: () => 10_000,
    sleep: async () => undefined,
  };
  await handleTelegramQueueMessage(
    invalid.message,
    envWithQueue(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
    dependencies,
  );
  await handleTelegramQueueMessage(
    failed.message,
    envWithQueue(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
    {
      ...dependencies,
      createEngine: () => ({
        reconcile: async () => {
          throw new Error("state unavailable");
        },
      }),
    },
  );
  assert.equal(invalid.acknowledgements(), 1);
  assert.deepEqual(invalid.retries, []);
  assert.equal(failed.acknowledgements(), 0);
  assert.deepEqual(failed.retries, [{ delaySeconds: 8 }]);
});

test("retries failures for the valid message key named invalid", async () => {
  const queued = queueMessage({ ...task, messageKey: "invalid" }, 2);
  await handleTelegramQueueMessage(
    queued.message,
    envWithQueue(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
    {
      createRepository: () => unusedRepository,
      createEngine: () => ({
        reconcile: async () => {
          throw new TypeError("retryable failure");
        },
      }),
      logger: { error() {}, info() {} },
      now: () => 10_000,
      sleep: async () => undefined,
    },
  );
  assert.equal(queued.acknowledgements(), 0);
  assert.deepEqual(queued.retries, [{ delaySeconds: 2 }]);
});

test("treats unscheduled logical retries as infrastructure failures", async () => {
  const queued = queueMessage(task);
  await handleTelegramQueueMessage(
    queued.message,
    envWithQueue(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
    {
      createRepository: () => unusedRepository,
      createEngine: () => ({
        reconcile: async () => ({ status: "retryable" }),
      }),
      logger: { error() {}, info() {} },
      now: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.equal(queued.acknowledgements(), 0);
  assert.deepEqual(queued.retries, [{ delaySeconds: 1 }]);
});

test("calculates bounded logical and infrastructure delays", () => {
  assert.equal(logicalDelaySeconds(10_001, 10_000), 1);
  assert.equal(logicalDelaySeconds(9_000, 10_000), 0);
  assert.equal(logicalDelaySeconds(200_000_000, 0), 86_400);
  assert.equal(infrastructureRetryDelaySeconds(1), 1);
  assert.equal(infrastructureRetryDelaySeconds(7), 60);
  assert.equal(infrastructureRetryDelaySeconds(100), 60);
});

function forwardingEnvironment(send: Queue["send"]): Env {
  return {
    ...envWithQueue(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
    WAGER_SETTLEMENT_QUEUE: {
      ...TELEGRAM_TEST_ENV.WAGER_SETTLEMENT_QUEUE,
      send,
    },
    get PROFILE_DB(): D1Database {
      throw new Error("unexpected-profile-db");
    },
    get TELEGRAM_DB(): D1Database {
      throw new Error("unexpected-telegram-db");
    },
    get TELEGRAM_BOT_TOKEN(): string {
      throw new Error("unexpected-telegram-token");
    },
  };
}

const forwardingDependencies = {
  createRepository: (): TelegramRepository => {
    throw new Error("unexpected-telegram-repository");
  },
  logger: { error() {}, info() {} },
  sleep: async () => {
    throw new Error("unexpected-telegram-pacing");
  },
};

test("forwards legacy wager tasks unchanged before acknowledging without Telegram work", async () => {
  for (const body of [wagerTask, recoverableWagerTask]) {
    const queued = queueMessage(body);
    const forwarded: Array<{ body: unknown; options?: QueueSendOptions }> = [];
    await handleTelegramQueueMessage(
      queued.message,
      forwardingEnvironment(async (task, options) => {
        assert.equal(queued.acknowledgements(), 0);
        forwarded.push({ body: task, options });
        return {
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        };
      }),
      forwardingDependencies,
    );
    assert.deepEqual(forwarded, [{ body, options: undefined }]);
    assert.equal(queued.acknowledgements(), 1);
    assert.deepEqual(queued.retries, []);
  }
});

test("retries the original wager message when forwarding fails", async () => {
  const queued = queueMessage(recoverableWagerTask, 4);
  await handleTelegramQueueMessage(
    queued.message,
    forwardingEnvironment(async () => {
      throw new Error("wager-queue-unavailable");
    }),
    forwardingDependencies,
  );
  assert.equal(queued.acknowledgements(), 0);
  assert.deepEqual(queued.retries, [{ delaySeconds: 8 }]);
});

test("preserves the settlement identity if forwarding succeeds but acknowledgement is lost", async () => {
  const first = queueMessage(recoverableWagerTask);
  const replay = queueMessage(structuredClone(recoverableWagerTask), 2);
  const forwarded: unknown[] = [];
  const environment = forwardingEnvironment(async (body) => {
    forwarded.push(structuredClone(body));
    return {
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    };
  });
  first.message.ack = () => {
    throw new Error("acknowledgement-lost");
  };
  await handleTelegramQueueMessage(
    first.message,
    environment,
    forwardingDependencies,
  );
  await handleTelegramQueueMessage(
    replay.message,
    environment,
    forwardingDependencies,
  );
  assert.deepEqual(first.retries, [{ delaySeconds: 1 }]);
  assert.equal(replay.acknowledgements(), 1);
  assert.deepEqual(replay.retries, []);
  assert.deepEqual(forwarded, [recoverableWagerTask, recoverableWagerTask]);
});

test("acknowledges malformed legacy wagers without forwarding them", async () => {
  const errors: unknown[] = [];
  for (const body of [
    { ...wagerTask, extra: true },
    { ...wagerTask, inviteId: "invite/child" },
    { ...wagerTask, matchId: "m".repeat(MAX_RECORD_KEY_BYTES + 1) },
    {
      ...recoverableWagerTask,
      resolution: { ...recoverableWagerTask.resolution, winnerUid: "" },
    },
  ]) {
    const queued = queueMessage(body);
    await handleTelegramQueueMessage(
      queued.message,
      forwardingEnvironment(async () => {
        assert.fail("malformed task forwarded");
      }),
      {
        ...forwardingDependencies,
        logger: { info() {}, error: (entry) => errors.push(entry) },
      },
    );
    assert.equal(queued.acknowledgements(), 1);
    assert.deepEqual(queued.retries, []);
  }
  assert.equal(errors.length, 4);
});
