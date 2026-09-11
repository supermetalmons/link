import { createTestWagerReservationRuntime } from "./wagerFrozenTestUtils.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RECORD_KEY_BYTES } from "../src/recordKeys.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import {
  handleWagerSettlementQueueMessage as handleWagerSettlementQueueMessageImpl,
  parseWagerSettlementRetryTask,
  WAGER_SETTLEMENT_RETRY_DELAY_SECONDS,
} from "../src/wagerSettlementQueue.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function handleWagerSettlementQueueMessage(
  message: Parameters<typeof handleWagerSettlementQueueMessageImpl>[0],
  env: Parameters<typeof handleWagerSettlementQueueMessageImpl>[1],
  dependencies: Parameters<
    typeof handleWagerSettlementQueueMessageImpl
  >[2] = {},
) {
  return handleWagerSettlementQueueMessageImpl(message, env, {
    createWagerReservations: (_env, repository) =>
      createTestWagerReservationRuntime(repository),
    ...dependencies,
  });
}

function envWithQueue(send: Queue["send"]): Env {
  return {
    ...TELEGRAM_TEST_ENV,
    WAGER_SETTLEMENT_QUEUE: {
      ...TELEGRAM_TEST_ENV.WAGER_SETTLEMENT_QUEUE,
      send,
    },
    get TELEGRAM_DB(): D1Database {
      throw new Error("unexpected-telegram-db");
    },
    get TELEGRAM_DELIVERY_QUEUE(): Queue {
      throw new Error("unexpected-telegram-queue");
    },
    get TELEGRAM_BOT_TOKEN(): string {
      throw new Error("unexpected-telegram-token");
    },
    get TELEGRAM_EXTRA_CHAT_ID(): string {
      throw new Error("unexpected-telegram-chat");
    },
  } as Env;
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

test("validates and processes durable wager settlement retries without Telegram pacing", async (context) => {
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
        winnerUid: "w".repeat(MAX_RECORD_KEY_BYTES + 1),
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
  context.mock.method(globalThis, "setTimeout", () => {
    throw new Error("unexpected-telegram-pacing");
  });
  const queued = queueMessage(recoverableWagerTask);
  const resumed: unknown[] = [];
  await handleWagerSettlementQueueMessage(
    queued.message,
    envWithQueue(TELEGRAM_TEST_ENV.WAGER_SETTLEMENT_QUEUE.send),
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
  assert.equal(resumed.length, 2);
  assert.deepEqual(resumed[0], recoverableWagerTask);
  assert.equal(
    typeof (resumed[1] as GameplayRepository).wagerFrozen?.transact,
    "function",
  );
});

test("acknowledges malformed wager retry tasks", async () => {
  const invalidTasks = [
    null,
    [],
    { kind: "unrelated-task" },
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
        winnerUid: "w".repeat(MAX_RECORD_KEY_BYTES + 1),
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
    await handleWagerSettlementQueueMessage(
      queued.message,
      envWithQueue(TELEGRAM_TEST_ENV.WAGER_SETTLEMENT_QUEUE.send),
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
    await handleWagerSettlementQueueMessage(
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
    await handleWagerSettlementQueueMessage(
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
  await handleWagerSettlementQueueMessage(
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
  await handleWagerSettlementQueueMessage(
    queued.message,
    envWithQueue(async (body, options) => {
      deferred.push({ body, options });
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    }),
    {
      classifySettlement: async () => {
        throw new Error("state-unavailable");
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
  await handleWagerSettlementQueueMessage(
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
  await handleWagerSettlementQueueMessage(
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
  await handleWagerSettlementQueueMessage(
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
  await handleWagerSettlementQueueMessage(
    pending.message,
    envWithQueue(TELEGRAM_TEST_ENV.WAGER_SETTLEMENT_QUEUE.send),
    dependencies,
  );
  assert.equal(pending.acknowledgements(), 1);
  assert.deepEqual(pending.retries, []);
  assert.deepEqual(deferred, []);
});
