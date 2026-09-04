import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramRepository } from "../../../functions/telegram/deliveryEngine.js";
import { MAX_FIREBASE_KEY_BYTES } from "../src/firebaseKeys.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import {
  handleTelegramQueueMessage,
  infrastructureRetryDelaySeconds,
  logicalDelaySeconds,
  parseWagerSettlementRetryTask,
  WAGER_SETTLEMENT_RETRY_DELAY_SECONDS,
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
    FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
      "worker@example.iam.gserviceaccount.com",
    FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
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
  assert.deepEqual(
    parseWagerSettlementRetryTask(recoverableWagerTask),
    recoverableWagerTask,
  );
  assert.equal(
    parseWagerSettlementRetryTask({ ...wagerTask, extra: true }),
    null,
  );
  assert.equal(
    parseWagerSettlementRetryTask({
      ...recoverableWagerTask,
      resolution: { ...recoverableWagerTask.resolution, extra: true },
    }),
    null,
  );
  assert.equal(
    parseWagerSettlementRetryTask({
      ...recoverableWagerTask,
      resolution: { ...recoverableWagerTask.resolution, winnerUid: "" },
    }),
    null,
  );
  assert.equal(
    parseWagerSettlementRetryTask({
      ...recoverableWagerTask,
      resolution: { ...recoverableWagerTask.resolution, winnerUid: " host" },
    }),
    null,
  );
  for (const invalid of [
    { ...recoverableWagerTask, inviteId: "invite/child" },
    { ...recoverableWagerTask, matchId: `invite${String.fromCharCode(1)}` },
    {
      ...recoverableWagerTask,
      resolution: {
        ...recoverableWagerTask.resolution,
        winnerUid: "w".repeat(MAX_FIREBASE_KEY_BYTES + 1),
      },
    },
    {
      ...recoverableWagerTask,
      resolution: {
        ...recoverableWagerTask.resolution,
        loserUid: "guest#unsafe",
      },
    },
  ]) {
    assert.equal(parseWagerSettlementRetryTask(invalid), null);
  }
  const queued = queueMessage(recoverableWagerTask);
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
  assert.deepEqual(resumed, [recoverableWagerTask, unusedGameplayRepository]);
});

test("acknowledges malformed wager retry tasks", async () => {
  const invalidTasks = [
    {
      ...recoverableWagerTask,
      resolution: { ...recoverableWagerTask.resolution, loserProfileId: "" },
    },
    { ...recoverableWagerTask, inviteId: "invite/child" },
    { ...recoverableWagerTask, matchId: `invite${String.fromCharCode(31)}` },
    {
      ...recoverableWagerTask,
      resolution: {
        ...recoverableWagerTask.resolution,
        winnerUid: "w".repeat(MAX_FIREBASE_KEY_BYTES + 1),
      },
    },
    {
      ...recoverableWagerTask,
      resolution: {
        ...recoverableWagerTask.resolution,
        loserUid: "guest[unsafe",
      },
    },
  ];
  let controlReads = 0;
  let repositoryCreates = 0;
  for (const invalidTask of invalidTasks) {
    const queued = queueMessage(invalidTask);
    await handleTelegramQueueMessage(
      queued.message,
      envWithQueue(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
      {
        createGameplay: () => {
          repositoryCreates += 1;
          return unusedGameplayRepository;
        },
        logger: { error() {}, info() {} },
        profileMutationsEnabled: async () => {
          controlReads += 1;
          return true;
        },
      },
    );
    assert.equal(queued.acknowledgements(), 1);
    assert.deepEqual(queued.retries, []);
  }
  assert.equal(controlReads, 0);
  assert.equal(repositoryCreates, 0);
});

test("acks completed and stale wagers while control is frozen or unreadable", async () => {
  const cases = [
    { status: "completed" as const, controlUnavailable: false },
    { status: "stale" as const, controlUnavailable: true },
  ];
  for (const { status, controlUnavailable } of cases) {
    const queued = queueMessage(wagerTask);
    const deferred: unknown[] = [];
    await handleTelegramQueueMessage(
      queued.message,
      envWithQueue(async (body) => {
        deferred.push(body);
        return {
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        };
      }),
      {
        classifySettlement: async () => status,
        createGameplay: () => unusedGameplayRepository,
        logger: { error() {}, info() {} },
        profileMutationsEnabled: async () => {
          if (controlUnavailable) throw new Error("control-unavailable");
          return false;
        },
        resumeSettlement: async () => {
          throw new Error("unexpected-resume");
        },
      },
    );
    assert.equal(queued.acknowledgements(), 1);
    assert.deepEqual(queued.retries, []);
    assert.deepEqual(deferred, []);
  }
});

test("durably defers pending and unclaimed wagers while writes are disabled", async () => {
  for (const status of ["pending", "unclaimed"] as const) {
    const queued = queueMessage(recoverableWagerTask);
    const deferred: Array<{ body: unknown; options?: QueueSendOptions }> = [];
    await handleTelegramQueueMessage(
      queued.message,
      envWithQueue(async (body, options) => {
        deferred.push({ body, options });
        return {
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        };
      }),
      {
        classifySettlement: async () => status,
        createGameplay: () => unusedGameplayRepository,
        logger: { error() {}, info() {} },
        profileMutationsEnabled: async () => false,
      },
    );
    assert.equal(queued.acknowledgements(), 1);
    assert.deepEqual(queued.retries, []);
    assert.deepEqual(deferred, [
      {
        body: recoverableWagerTask,
        options: { delaySeconds: WAGER_SETTLEMENT_RETRY_DELAY_SECONDS },
      },
    ]);
  }
});

test("defers a wager that freezes at a settlement write boundary", async () => {
  const queued = queueMessage(recoverableWagerTask);
  const deferred: Array<{ body: unknown; options?: QueueSendOptions }> = [];
  let controlReads = 0;
  await handleTelegramQueueMessage(
    queued.message,
    envWithQueue(async (body, options) => {
      deferred.push({ body, options });
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    }),
    {
      createGameplay: () => unusedGameplayRepository,
      logger: { error() {}, info() {} },
      profileMutationsEnabled: async () => {
        controlReads += 1;
        return controlReads === 1;
      },
      resumeSettlement: async (_task, _repository, _now, assertAllowed) => {
        await assertAllowed?.();
        return "completed";
      },
    },
  );
  assert.equal(controlReads, 2);
  assert.equal(queued.acknowledgements(), 1);
  assert.deepEqual(queued.retries, []);
  assert.deepEqual(deferred, [
    {
      body: recoverableWagerTask,
      options: { delaySeconds: WAGER_SETTLEMENT_RETRY_DELAY_SECONDS },
    },
  ]);
});

test("durably defers wagers when frozen-state classification is unavailable", async () => {
  const queued = queueMessage(recoverableWagerTask);
  const deferred: Array<{ body: unknown; options?: QueueSendOptions }> = [];
  await handleTelegramQueueMessage(
    queued.message,
    envWithQueue(async (body, options) => {
      deferred.push({ body, options });
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    }),
    {
      classifySettlement: async () => {
        throw new Error("rtdb-unavailable");
      },
      createGameplay: () => unusedGameplayRepository,
      logger: { error() {}, info() {} },
      profileMutationsEnabled: async () => false,
    },
  );
  assert.equal(queued.acknowledgements(), 1);
  assert.deepEqual(queued.retries, []);
  assert.deepEqual(deferred, [
    {
      body: recoverableWagerTask,
      options: { delaySeconds: WAGER_SETTLEMENT_RETRY_DELAY_SECONDS },
    },
  ]);
});

test("falls back to Queue retry when durable wager deferral fails", async () => {
  const queued = queueMessage(recoverableWagerTask);
  await handleTelegramQueueMessage(
    queued.message,
    envWithQueue(async () => {
      throw new Error("queue-unavailable");
    }),
    {
      classifySettlement: async () => "pending",
      createGameplay: () => unusedGameplayRepository,
      logger: { error() {}, info() {} },
      profileMutationsEnabled: async () => false,
    },
  );
  assert.equal(queued.acknowledgements(), 0);
  assert.deepEqual(queued.retries, [
    { delaySeconds: WAGER_SETTLEMENT_RETRY_DELAY_SECONDS },
  ]);
});

test("acks terminal wager cancellations without requeueing", async () => {
  const queued = queueMessage(wagerTask, 3);
  const deferred: Array<{ body: unknown; options?: QueueSendOptions }> = [];
  await handleTelegramQueueMessage(
    queued.message,
    envWithQueue(async (body, options) => {
      deferred.push({ body, options });
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    }),
    {
      createGameplay: () => unusedGameplayRepository,
      logger: { error() {}, info() {} },
      profileMutationsEnabled: async () => true,
      resumeSettlement: async () => "completed",
    },
  );
  assert.equal(queued.acknowledgements(), 1);
  assert.deepEqual(queued.retries, []);
  assert.deepEqual(deferred, []);
});

test("retries an active wager failure and later completes it", async () => {
  const unclaimed = queueMessage(recoverableWagerTask, 3);
  const pending = queueMessage(recoverableWagerTask, 4);
  const deferred: unknown[] = [];
  let claimed = false;
  const dependencies = {
    createGameplay: () => unusedGameplayRepository,
    logger: { error() {}, info() {} },
    profileMutationsEnabled: async () => true,
    resumeSettlement: async () => {
      if (!claimed) throw new Error("wager-settlement-unclaimed");
      return "completed" as const;
    },
  };
  await handleTelegramQueueMessage(
    unclaimed.message,
    envWithQueue(async (body) => {
      deferred.push(body);
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    }),
    dependencies,
  );
  assert.equal(unclaimed.acknowledgements(), 0);
  assert.deepEqual(unclaimed.retries, [{ delaySeconds: 4 }]);
  claimed = true;
  await handleTelegramQueueMessage(
    pending.message,
    envWithQueue(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
    dependencies,
  );
  assert.equal(pending.acknowledgements(), 1);
  assert.deepEqual(pending.retries, []);
  assert.deepEqual(deferred, []);
});
