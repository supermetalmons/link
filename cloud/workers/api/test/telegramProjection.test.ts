import { createTelegramRepository } from "../../../functions/telegram/repositoryCore.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import type {
  RatingProjectionRepository,
  RatingUpdateData,
} from "../src/gameplayRepository.ts";
import {
  automatchSweepTasks,
  handleTelegramProjectionMessage,
  processAutomatchTask,
  processRatingTask,
  projectionRetryDelaySeconds,
  sweepTelegramProjections,
} from "../src/telegramProjection.ts";
import {
  parseTelegramProjectionTask,
  type TelegramProjectionTask,
} from "../src/telegramProjectionTasks.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const PROJECTION_TEST_ENV = {
  ...TELEGRAM_TEST_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
    "worker@example.iam.gserviceaccount.com",
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} satisfies Env;

function rtdbState(initial: Record<string, unknown>) {
  const state = new Map(Object.entries(initial));
  const client: FirebaseRtdbClient = {
    async getPath(path) {
      return state.get(path) ?? null;
    },
    async patchRoot(updates) {
      for (const [path, value] of Object.entries(updates)) {
        state.set(path, value);
      }
    },
    async transactPath(path, updater) {
      const current = state.get(path) ?? null;
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
        throw new Error("invalid transaction output");
      }
      state.set(path, output.value);
      return {
        committed: true,
        decision: output.decision,
        value: output.value,
      };
    },
  };
  return {
    client,
    telegram: createTelegramRepository({
      getPath: client.getPath,
      transactPath: client.transactPath,
    }),
    read: (path: string) => state.get(path),
  };
}

function ratingUpdate(
  overrides: Partial<RatingUpdateData> = {},
): RatingUpdateData {
  return {
    inviteId: "auto_example",
    leaseExpiresAtMs: 1,
    matchId: "auto_example",
    opponentId: "opponent",
    opponentProfileId: "opponent-profile",
    ownerToken: "owner",
    playerId: "player",
    playerProfileId: "player-profile",
    shouldUpdateFebruaryChallenge: false,
    startedAtMs: 1,
    status: "done",
    completedAtMs: 200,
    eventId: "",
    eventOwned: false,
    isEventMatch: false,
    telegramDeliveryVersion: 2,
    telegramProjectionState: "pending",
    telegramProjectionUpdatedAtMs: 200,
    telegramProjectionVersion: 1,
    updateRatingMessage: "Alice 1510↑ Bob 1490↓ (7 - 3)",
    ...overrides,
  };
}

function ratingRepository(
  data: RatingUpdateData | null,
  marks: Array<{ state: string; reason?: string }>,
): RatingProjectionRepository {
  return {
    applyFebruaryChallengeReplay: async () => undefined,
    claimRatingTelegramProjection: async () => true,
    finalizeRatingUpdate: async () => ({ status: "lost" }),
    getRtdbPath: async () => null,
    listDueRatingTelegramProjections: async (updatedBeforeMs) =>
      data && (data.telegramProjectionUpdatedAtMs || 0) <= updatedBeforeMs
        ? [
            {
              operationId: "auto_example__auto_example",
              updateTime: "2026-08-21T00:00:00Z",
            },
          ]
        : [],
    markRatingTelegramProjection: async (
      _operationId,
      state,
      _updatedAtMs,
      reason,
    ) => {
      marks.push({ state, ...(reason ? { reason } : {}) });
    },
    patchRtdbRoot: async () => undefined,
    readProfileOwnershipSnapshot: async () => {
      throw new Error("unexpected-profile-ownership-read");
    },
    readRatingUpdate: async () => data,
    hasCompletedRatingUpdate: async () => data?.status === "done",
    tryAcquireRatingLease: async () => ({ status: "busy", data: null }),
  };
}

function queueMessage(body: unknown, attempts = 1) {
  let acknowledgements = 0;
  const retries: QueueRetryOptions[] = [];
  return {
    message: {
      id: "projection-message",
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

test("projection tasks require exact safe payloads", () => {
  assert.deepEqual(
    parseTelegramProjectionTask({
      kind: "automatch-telegram-projection",
      inviteId: "auto_example",
      requestId: "request-1",
    }),
    {
      kind: "automatch-telegram-projection",
      inviteId: "auto_example",
      requestId: "request-1",
    },
  );
  assert.deepEqual(
    parseTelegramProjectionTask({
      kind: "rating-telegram-projection",
      operationId: "auto_example__auto_example",
    }),
    {
      kind: "rating-telegram-projection",
      operationId: "auto_example__auto_example",
    },
  );
  assert.deepEqual(
    parseTelegramProjectionTask({
      kind: "event-telegram-projection",
      eventId: "event-1",
      requestId: "request-1",
    }),
    {
      kind: "event-telegram-projection",
      eventId: "event-1",
      requestId: "request-1",
    },
  );
  assert.equal(
    parseTelegramProjectionTask({
      kind: "rating-telegram-projection",
      operationId: "unsafe/key",
    }),
    null,
  );
  assert.equal(
    parseTelegramProjectionTask({
      kind: "rating-telegram-projection",
      operationId: "valid",
      extra: true,
    }),
    null,
  );
  const longInviteId = `auto_${"a".repeat(395)}`;
  const longOperationId = `${longInviteId}__${longInviteId}`;
  assert.deepEqual(
    parseTelegramProjectionTask({
      kind: "rating-telegram-projection",
      operationId: longOperationId,
    }),
    {
      kind: "rating-telegram-projection",
      operationId: longOperationId,
    },
  );
  assert.equal(
    parseTelegramProjectionTask({
      kind: "rating-telegram-projection",
      operationId: "a".repeat(1_501),
    }),
    null,
  );
  assert.equal(
    parseTelegramProjectionTask({
      kind: "rating-telegram-projection",
      operationId: "\ud800",
    }),
    null,
  );
});

test("automatch projection persists desired state and clears its exact outbox", async () => {
  const task = {
    kind: "automatch-telegram-projection" as const,
    inviteId: "auto_example",
    requestId: "request-1",
  };
  const store = rtdbState({
    "telegramProjectionOutbox/automatch/auto_example": {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      updatedAtMs: 100,
    },
    "telegramAutomatches/auto_example": {
      version: 2,
      lifecycle: "matched",
      matchedText: "Alice vs. Bob https://mons.link/auto_example",
      matchedInstanceKey: "matched:auto_example",
      generation: 2,
    },
    "invites/auto_example": { guestId: "guest" },
  });
  const enqueued: Array<Record<string, string>> = [];
  assert.equal(
    await processAutomatchTask(
      task,
      store.client,
      async (input) => {
        enqueued.push(input);
        assert.notEqual(
          store.read("telegramProjectionOutbox/automatch/auto_example"),
          null,
        );
      },
      () => 200,
      store.telegram,
    ),
    "projected",
  );
  assert.equal(
    store.read("telegramProjectionOutbox/automatch/auto_example"),
    null,
  );
  const message = store.read(
    "telegramMessages/automatch:auto_example",
  ) as Record<string, Record<string, unknown>>;
  assert.equal(message.desired.operation, "send");
  assert.equal(message.automatchProjection.lifecycle, "matched");
  assert.deepEqual(enqueued, [
    {
      generation: `automatch:request-1:${message.desired.revision}`,
      messageKey: "automatch:auto_example",
      producer: "automatch-projection",
      revision: message.desired.revision as string,
    },
  ]);
});

test("automatch projection acknowledges stale work and dead-letters invalid sources", async () => {
  const stale = rtdbState({
    "telegramProjectionOutbox/automatch/auto_example": {
      schemaVersion: 1,
      status: "pending",
      requestId: "newer-request",
      updatedAtMs: 100,
    },
  });
  assert.equal(
    await processAutomatchTask(
      {
        kind: "automatch-telegram-projection",
        inviteId: "auto_example",
        requestId: "stale-request",
      },
      stale.client,
      async () => undefined,
      () => 200,
      stale.telegram,
    ),
    "stale",
  );

  const invalid = rtdbState({
    "telegramProjectionOutbox/automatch/auto_example": {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      updatedAtMs: 100,
    },
    "telegramAutomatches/auto_example": { version: 1 },
    "invites/auto_example": {},
  });
  assert.equal(
    await processAutomatchTask(
      {
        kind: "automatch-telegram-projection",
        inviteId: "auto_example",
        requestId: "request-1",
      },
      invalid.client,
      async () => undefined,
      () => 200,
      invalid.telegram,
    ),
    "dead",
  );
  assert.deepEqual(
    invalid.read("telegramProjectionOutbox/automatch/auto_example"),
    {
      schemaVersion: 1,
      status: "dead",
      requestId: "request-1",
      updatedAtMs: null,
      deadAtMs: 200,
      reason: "invalid-source",
    },
  );
});

test("rating projection merges once, projects the latest source, and completes", async () => {
  const store = rtdbState({
    "telegramAutomatches/auto_example": {
      version: 2,
      lifecycle: "matched",
      matchedText: "Alice vs. Bob https://mons.link/auto_example",
      matchedInstanceKey: "matched:auto_example",
      generation: 2,
    },
    "invites/auto_example": { guestId: "guest" },
  });
  const marks: Array<{ state: string; reason?: string }> = [];
  const repository = ratingRepository(ratingUpdate(), marks);
  const task = {
    kind: "rating-telegram-projection" as const,
    operationId: "auto_example__auto_example",
  };
  assert.equal(
    await processRatingTask(
      task,
      store.client,
      repository,
      async () => undefined,
      () => 300,
      store.telegram,
    ),
    "projected",
  );
  assert.deepEqual(marks, [{ state: "done" }]);
  const source = store.read("telegramAutomatches/auto_example") as Record<
    string,
    unknown
  >;
  assert.deepEqual(source.results, {
    auto_example: {
      text: "Alice 1510↑ Bob 1490↓ (7 - 3)",
      completedAtMs: 200,
    },
  });

  marks.length = 0;
  assert.equal(
    await processRatingTask(
      task,
      store.client,
      repository,
      async () => undefined,
      () => 400,
      store.telegram,
    ),
    "duplicate",
  );
  assert.deepEqual(marks, [{ state: "done" }]);
});

test("projection dispatch failures preserve pending recovery markers", async () => {
  const task = {
    kind: "automatch-telegram-projection" as const,
    inviteId: "auto_example",
    requestId: "request-1",
  };
  const store = rtdbState({
    "telegramProjectionOutbox/automatch/auto_example": {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      updatedAtMs: 100,
    },
    "telegramAutomatches/auto_example": {
      version: 2,
      lifecycle: "matched",
      matchedText: "Alice vs. Bob https://mons.link/auto_example",
      matchedInstanceKey: "matched:auto_example",
      generation: 2,
    },
    "invites/auto_example": { guestId: "guest" },
  });

  await assert.rejects(
    () =>
      processAutomatchTask(
        task,
        store.client,
        async () => {
          throw new Error("queue-unavailable");
        },
        () => 200,
        store.telegram,
      ),
    /queue-unavailable/,
  );
  assert.deepEqual(
    store.read("telegramProjectionOutbox/automatch/auto_example"),
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      updatedAtMs: 100,
    },
  );

  const marks: Array<{ state: string; reason?: string }> = [];
  await assert.rejects(
    () =>
      processRatingTask(
        {
          kind: "rating-telegram-projection",
          operationId: "auto_example__auto_example",
        },
        store.client,
        ratingRepository(ratingUpdate(), marks),
        async () => {
          throw new Error("queue-unavailable");
        },
        () => 300,
        store.telegram,
      ),
    /queue-unavailable/,
  );
  assert.deepEqual(marks, []);
});

test("projection queue acknowledges poison tasks and retries transient failures", async () => {
  const invalid = queueMessage({ nope: true });
  await handleTelegramProjectionMessage(invalid.message, PROJECTION_TEST_ENV, {
    logger: { error() {}, info() {} },
  });
  assert.equal(invalid.acknowledgements(), 1);
  assert.deepEqual(invalid.retries, []);

  const failed = queueMessage(
    {
      kind: "automatch-telegram-projection",
      inviteId: "auto_example",
      requestId: "request-1",
    },
    4,
  );
  await handleTelegramProjectionMessage(failed.message, PROJECTION_TEST_ENV, {
    createRtdb: () => {
      throw new Error("temporary");
    },
    logger: { error() {}, info() {} },
  });
  assert.equal(failed.acknowledgements(), 0);
  assert.deepEqual(failed.retries, [{ delaySeconds: 8 }]);
  assert.equal(projectionRetryDelaySeconds(100), 60);
});

test("scheduled recovery batches both pending outbox kinds", async () => {
  const batches: TelegramProjectionTask[][] = [];
  const queue = {
    ...TELEGRAM_TEST_ENV.TELEGRAM_PROJECTION_QUEUE,
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      batches.push(
        Array.from(messages).map(({ body }) => body as TelegramProjectionTask),
      );
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    },
  } satisfies Queue;
  const env = {
    ...PROJECTION_TEST_ENV,
    TELEGRAM_PROJECTION_QUEUE: queue,
  } satisfies Env;
  const marker = {
    schemaVersion: 1,
    status: "pending",
    requestId: "request-1",
    updatedAtMs: 100,
  };
  const store = rtdbState({
    "telegramProjectionOutbox/automatch/auto_example": marker,
  });
  const getPath = store.client.getPath;
  store.client.getPath = async (path, query) => {
    if (path !== "telegramProjectionOutbox/automatch") {
      return getPath(path, query);
    }
    assert.deepEqual(query, {
      orderBy: "updatedAtMs",
      startAt: 0,
      endAt: 600_000,
      limitToFirst: 10,
    });
    return {
      auto_example: {
        ...marker,
      },
    };
  };
  const marks: Array<{ state: string; reason?: string }> = [];
  const result = await sweepTelegramProjections(env, {
    createRtdb: () => store.client,
    createRating: () => ratingRepository(ratingUpdate(), marks),
    now: () => 600_000,
  });
  assert.deepEqual(result, { automatch: 1, event: 0, rating: 1 });
  assert.deepEqual(
    batches.flat().sort((left, right) => left.kind.localeCompare(right.kind)),
    [
      {
        kind: "automatch-telegram-projection",
        inviteId: "auto_example",
        requestId: "request-1",
      },
      {
        kind: "rating-telegram-projection",
        operationId: "auto_example__auto_example",
      },
    ],
  );
  assert.equal(
    automatchSweepTasks({ invalid: { status: "pending" } }).length,
    0,
  );
});

test("recovery takes current records and reports scan failures", async () => {
  const batches: TelegramProjectionTask[][] = [];
  const env = {
    ...PROJECTION_TEST_ENV,
    TELEGRAM_PROJECTION_QUEUE: {
      ...PROJECTION_TEST_ENV.TELEGRAM_PROJECTION_QUEUE,
      sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
        batches.push(
          Array.from(messages).map(
            ({ body }) => body as TelegramProjectionTask,
          ),
        );
        return {
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        };
      },
    },
  } satisfies Env;
  const logs: string[] = [];
  const failedRtdb = rtdbState({}).client;
  failedRtdb.getPath = async () => {
    throw new Error("rtdb-unavailable");
  };
  await assert.rejects(
    () =>
      sweepTelegramProjections(env, {
        createRtdb: () => failedRtdb,
        createRating: () => ratingRepository(ratingUpdate(), []),
        logger: { error: (message) => logs.push(message), info() {} },
        now: () => 600_000,
      }),
    /telegram-projection-sweep-failed/,
  );
  assert.equal(logs.length, 2);
  assert.deepEqual(batches.flat(), [
    {
      kind: "rating-telegram-projection",
      operationId: "auto_example__auto_example",
    },
  ]);

  batches.length = 0;
  const recentStore = rtdbState({
    "telegramProjectionOutbox/automatch/auto_example": {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      updatedAtMs: 599_999,
    },
  });
  const recentGetPath = recentStore.client.getPath;
  recentStore.client.getPath = async (path, query) =>
    path === "telegramProjectionOutbox/automatch"
      ? {
          auto_example: {
            schemaVersion: 1,
            status: "pending",
            requestId: "request-1",
            updatedAtMs: 599_999,
          },
        }
      : recentGetPath(path, query);
  const recovered = await sweepTelegramProjections(env, {
    createRtdb: () => recentStore.client,
    createRating: () => ratingRepository(null, []),
    now: () => 600_000,
  });
  assert.deepEqual(recovered, { automatch: 1, event: 0, rating: 0 });
  assert.deepEqual(batches.flat(), [
    {
      kind: "automatch-telegram-projection",
      inviteId: "auto_example",
      requestId: "request-1",
    },
  ]);
});

test("recovery sends successful claims before reporting claim failures", async () => {
  const batches: TelegramProjectionTask[][] = [];
  const env = {
    ...PROJECTION_TEST_ENV,
    TELEGRAM_PROJECTION_QUEUE: {
      ...PROJECTION_TEST_ENV.TELEGRAM_PROJECTION_QUEUE,
      sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
        batches.push(
          Array.from(messages).map(
            ({ body }) => body as TelegramProjectionTask,
          ),
        );
        return {
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        };
      },
    },
  } satisfies Env;
  const marker = {
    schemaVersion: 1,
    status: "pending",
    requestId: "request-1",
    updatedAtMs: 100,
  };
  const store = rtdbState({
    "telegramProjectionOutbox/automatch/auto_bad": marker,
    "telegramProjectionOutbox/automatch/auto_good": marker,
  });
  const getPath = store.client.getPath;
  store.client.getPath = async (path, query) =>
    path === "telegramProjectionOutbox/automatch"
      ? { auto_bad: marker, auto_good: marker }
      : getPath(path, query);
  const transactPath = store.client.transactPath;
  store.client.transactPath = async (path, updater, signal) => {
    if (path.endsWith("/auto_bad")) {
      throw new Error("claim-failed");
    }
    return transactPath(path, updater, signal);
  };
  const logs: string[] = [];
  await assert.rejects(
    () =>
      sweepTelegramProjections(env, {
        createRtdb: () => store.client,
        createRating: () => ratingRepository(null, []),
        logger: { error: (message) => logs.push(message), info() {} },
        now: () => 600_000,
      }),
    /telegram-projection-sweep-failed/,
  );
  assert.deepEqual(batches.flat(), [
    {
      kind: "automatch-telegram-projection",
      inviteId: "auto_good",
      requestId: "request-1",
    },
  ]);
  assert.equal(
    (
      store.read("telegramProjectionOutbox/automatch/auto_good") as {
        updatedAtMs: number;
      }
    ).updatedAtMs,
    600_000,
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /claim-failed/);
});

test("recovery removes malformed markers from the timestamp index", async () => {
  const records = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [
      " ".repeat(index + 1),
      {
        schemaVersion: 1,
        status: "pending",
        requestId: "request-1",
        updatedAtMs: 100,
      },
    ]),
  );
  const store = rtdbState(
    Object.fromEntries(
      Object.entries(records).map(([inviteId, record]) => [
        `telegramProjectionOutbox/automatch/${inviteId}`,
        record,
      ]),
    ),
  );
  const getPath = store.client.getPath;
  store.client.getPath = async (path, query) =>
    path === "telegramProjectionOutbox/automatch"
      ? records
      : getPath(path, query);
  const result = await sweepTelegramProjections(PROJECTION_TEST_ENV, {
    createRtdb: () => store.client,
    createRating: () => ratingRepository(null, []),
    now: () => 600_000,
  });
  assert.deepEqual(result, { automatch: 0, event: 0, rating: 0 });
  for (const inviteId of Object.keys(records)) {
    const record = store.read(
      `telegramProjectionOutbox/automatch/${inviteId}`,
    ) as Record<string, unknown>;
    assert.equal(record.status, "dead");
    assert.equal(record.reason, "invalid-record");
    assert.equal(record.updatedAtMs, null);
    assert.equal(record.deadAtMs, 600_000);
  }
});

test("recovery claims bounded pages sequentially", async () => {
  const rating = ratingRepository(null, []);
  let activeClaims = 0;
  let maxActiveClaims = 0;
  rating.listDueRatingTelegramProjections = async (_updatedBeforeMs, limit) => {
    assert.equal(limit, 10);
    return Array.from({ length: limit }, (_, index) => ({
      operationId: `operation-${index}`,
      updateTime: `update-${index}`,
    }));
  };
  rating.claimRatingTelegramProjection = async () => {
    activeClaims++;
    maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
    await Promise.resolve();
    activeClaims--;
    return false;
  };
  assert.deepEqual(
    await sweepTelegramProjections(PROJECTION_TEST_ENV, {
      createRtdb: () => rtdbState({}).client,
      createRating: () => rating,
      now: () => 600_000,
    }),
    { automatch: 0, event: 0, rating: 0 },
  );
  assert.equal(maxActiveClaims, 1);
});
