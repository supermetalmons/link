import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryEngine.js";
import {
  handleTelegramQueue,
  handleTelegramQueueMessage,
  infrastructureRetryDelaySeconds,
  logicalDelaySeconds,
} from "../src/telegramQueue.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const task = {
  schemaVersion: 1,
  dataEpoch: 1,
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

test("retries storage check failures without treating TypeError as a poison message", async () => {
  for (const failure of [
    new Error("storage-unavailable"),
    new TypeError("storage-unavailable"),
  ]) {
    const queued = queueMessage(task, 4);
    const errors: unknown[] = [];
    await handleTelegramQueueMessage(queued.message, TELEGRAM_TEST_ENV, {
      readStorageMode: async () => {
        throw failure;
      },
      createEngine: () => {
        throw new Error("unexpected-engine");
      },
      logger: {
        info() {},
        error: (entry: string) => errors.push(JSON.parse(entry)),
      },
      sleep: async () => {
        assert.fail("unexpected-pacing");
      },
    });
    assert.equal(queued.acknowledgements(), 0);
    assert.deepEqual(queued.retries, [{ delaySeconds: 8 }]);
    assert.deepEqual(errors, [
      {
        event: "telegram_queue_failed",
        messageKey: "unknown",
        code: "storage-unavailable",
        messageId: queued.message.id,
        attempts: 4,
      },
    ]);
  }
});

test("keeps valid frozen delivery tasks pending without processing or pacing", async () => {
  const queued = queueMessage(task);
  await handleTelegramQueueMessage(queued.message, TELEGRAM_TEST_ENV, {
    readStorageMode: async () => "frozen",
    createEngine: () => {
      assert.fail("unexpected-engine");
    },
    logger: { info() {}, error() {} },
    sleep: async () => {
      assert.fail("unexpected-pacing");
    },
  });
  assert.equal(queued.acknowledgements(), 0);
  assert.deepEqual(queued.retries, [{ delaySeconds: 60 }]);
});

test("continues a delivery batch after a storage binding failure", async () => {
  const failed = queueMessage(task, 3);
  const forwarded = queueMessage(wagerTask);
  const sent: unknown[] = [];
  const environment: Env = {
    ...TELEGRAM_TEST_ENV,
    get TELEGRAM_DB(): D1Database {
      throw new TypeError("binding-unavailable");
    },
    WAGER_SETTLEMENT_QUEUE: {
      ...TELEGRAM_TEST_ENV.WAGER_SETTLEMENT_QUEUE,
      send: async (body) => {
        sent.push(body);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  };
  await handleTelegramQueue(
    {
      queue: "mons-link-telegram-delivery-data1",
      messages: [failed.message, forwarded.message],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll() {
        assert.fail("unexpected-batch-ack");
      },
      retryAll() {
        assert.fail("unexpected-batch-retry");
      },
    },
    environment,
  );
  assert.equal(failed.acknowledgements(), 0);
  assert.deepEqual(failed.retries, [{ delaySeconds: 4 }]);
  assert.equal(forwarded.acknowledgements(), 1);
  assert.deepEqual(forwarded.retries, []);
  assert.deepEqual(sent, []);
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

test("rejects retired wager tasks without reading storage or dispatching another family", async () => {
  for (const body of [
    wagerTask,
    recoverableWagerTask,
    { ...wagerTask, extra: true },
  ]) {
    const queued = queueMessage(body);
    await handleTelegramQueueMessage(
      queued.message,
      forwardingEnvironment(async () => {
        assert.fail("unexpected-retired-wager-forward");
      }),
      forwardingDependencies,
    );
    assert.equal(queued.acknowledgements(), 1);
    assert.deepEqual(queued.retries, []);
  }
});
