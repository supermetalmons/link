import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramRepository } from "../../../functions/telegram/deliveryEngine.js";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import {
  handleTelegramQueueMessage,
  infrastructureRetryDelaySeconds,
  logicalDelaySeconds,
  parseWagerSettlementRetryTask,
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
    FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
    FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
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
const unusedGameplayRepository = {} as GameplayRepository;

const wagerTask = {
  kind: "wager-settlement" as const,
  inviteId: "invite-1",
  matchId: "invite-1",
  operationId: "a".repeat(64),
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
          throw new Error("rtdb unavailable");
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

test("validates and processes durable wager settlement retries", async () => {
  assert.deepEqual(parseWagerSettlementRetryTask(wagerTask), wagerTask);
  assert.equal(
    parseWagerSettlementRetryTask({ ...wagerTask, extra: true }),
    null,
  );
  const queued = queueMessage(wagerTask);
  const resumed: unknown[] = [];
  await handleTelegramQueueMessage(
    queued.message,
    envWithQueue(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
    {
      createGameplay: () => unusedGameplayRepository,
      logger: { error() {}, info() {} },
      resumeSettlement: async (input, repository) => {
        resumed.push(input, repository);
        return "completed";
      },
    },
  );
  assert.equal(queued.acknowledgements(), 1);
  assert.deepEqual(queued.retries, []);
  assert.deepEqual(resumed, [wagerTask, unusedGameplayRepository]);
});

test("retries failed durable wager settlements", async () => {
  const queued = queueMessage(wagerTask, 3);
  await handleTelegramQueueMessage(
    queued.message,
    envWithQueue(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
    {
      createGameplay: () => unusedGameplayRepository,
      logger: { error() {}, info() {} },
      resumeSettlement: async () => {
        throw new Error("temporary");
      },
    },
  );
  assert.equal(queued.acknowledgements(), 0);
  assert.deepEqual(queued.retries, [{ delaySeconds: 4 }]);
});
