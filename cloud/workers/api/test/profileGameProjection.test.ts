import assert from "node:assert/strict";
import test from "node:test";
import type {
  RatingProfileGameProjectionRepository,
  RatingUpdateData,
} from "../src/gameplayRepository.ts";
import {
  claimAutomatchSweepCandidate,
  handleProfileGameProjectionMessage,
  processAutomatchProfileGameProjection,
  processRatingProfileGameProjection,
  profileGameProjectionRetryDelaySeconds,
  sweepAutomatchProfileGameProjections,
  sweepRatingProfileGameProjections,
} from "../src/profileGameProjection.ts";
import {
  buildAutomatchProfileGameProjectionOutboxUpdates,
  parseAutomatchProfileGameProjectionOutbox,
} from "../src/profileGameProjectionOutbox.ts";
import type { ProfileGameProjectionRuntime } from "../src/profileGameProjectionRepository.ts";
import {
  parseProfileGameProjectionTask,
  PROFILE_GAME_PROJECTION_QUEUE_NAME,
  type AutomatchProfileGameProjectionTask,
  type ProfileGameProjectionTask,
} from "../src/profileGameProjectionTasks.ts";
import worker from "../src/workerHandler.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const operationId = "auto_aaaaaaaaaaa__auto_aaaaaaaaaaa";

function ratingUpdate(
  overrides: Partial<RatingUpdateData> = {},
): RatingUpdateData {
  return {
    completedAtMs: 200,
    inviteId: "auto_aaaaaaaaaaa",
    leaseExpiresAtMs: 1,
    matchId: "auto_aaaaaaaaaaa",
    opponentId: "opponent",
    opponentProfileId: "opponent-profile",
    ownerToken: "owner",
    playerId: "player",
    playerProfileId: "player-profile",
    profileGameProjectionState: "pending",
    profileGameProjectionUpdatedAtMs: 200,
    profileGameProjectionVersion: 1,
    shouldUpdateFebruaryChallenge: false,
    startedAtMs: 1,
    status: "done",
    ...overrides,
  };
}

function ratingRepository(
  data: RatingUpdateData | null,
  state: {
    marker?: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  },
): RatingProfileGameProjectionRepository {
  return {
    applyFebruaryChallengeReplay: async () => undefined,
    claimRatingProfileGameProjection: async () => true,
    finalizeRatingUpdate: async () => ({ status: "lost" }),
    getRatingProfile: async () => null,
    getRtdbPath: async () => state.marker ?? null,
    listDueRatingProfileGameProjections: async () => [],
    markRatingProfileGameProjection: async (
      _operationId,
      projectionState,
      _updatedAtMs,
      reason,
    ) => {
      state.marks.push({
        state: projectionState,
        ...(reason ? { reason } : {}),
      });
    },
    patchRtdbRoot: async (updates) => {
      state.patches.push(updates);
    },
    readRatingUpdate: async () => data,
    tryAcquireRatingLease: async () => ({ status: "busy", data: null }),
  };
}

function runtime(
  calls: Array<{
    inviteId: string;
    options: Record<string, unknown>;
    reason: string;
  }>,
): ProfileGameProjectionRuntime {
  return {
    async recomputeInviteProjection(inviteId, reason, options = {}) {
      calls.push({ inviteId, reason, options });
      return {
        inviteId,
        ok: true,
        reason,
        skipped: 0,
        sourceCleanupSafe: true,
      };
    },
  };
}

function queueMessage<Body>(body: Body, attempts = 1) {
  let acknowledgements = 0;
  const retries: QueueRetryOptions[] = [];
  return {
    acknowledgements: () => acknowledgements,
    message: {
      id: "profile-game-projection-message",
      timestamp: new Date(0),
      body,
      attempts,
      ack: () => {
        acknowledgements += 1;
      },
      retry: (options?: QueueRetryOptions) => {
        retries.push(options || {});
      },
    } satisfies Message<Body>,
    retries,
  };
}

function automatchOutbox(
  requestId = "request-1",
  sourceUpdatedAtMs = 100,
  lastQueuedAtMs = 200,
) {
  return {
    schemaVersion: 1,
    status: "pending",
    requestId,
    sourceUpdatedAtMs,
    lastQueuedAtMs,
  };
}

function automatchTask(
  requestId = "request-1",
): AutomatchProfileGameProjectionTask {
  return {
    kind: "automatch-profile-game-projection",
    inviteId: "auto_aaaaaaaaaaa",
    requestId,
  };
}

function applyRtdbTransaction(
  current: unknown,
  updater: (value: unknown) => unknown,
): { committed: boolean; decision?: string; value: unknown } {
  const output = updater(current) as {
    commit?: false;
    decision?: string;
    value?: unknown;
  };
  return output.commit === false
    ? { committed: false, decision: output.decision, value: current }
    : { committed: true, decision: output.decision, value: output.value };
}

function projectionLockRtdb(values = new Map<string, unknown>()) {
  return {
    getRtdbPath: async (path: string) => values.get(path),
    transactRtdbPath: async (
      path: string,
      updater: (current: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(values.get(path), updater);
      if (result.committed) {
        values.set(path, result.value);
      }
      return result;
    },
  };
}

test("profile game projection tasks require exact safe payloads", () => {
  assert.deepEqual(
    parseProfileGameProjectionTask(automatchTask()),
    automatchTask(),
  );
  assert.equal(
    parseProfileGameProjectionTask({ ...automatchTask(), extra: true }),
    null,
  );
  assert.equal(
    parseProfileGameProjectionTask({
      ...automatchTask(),
      inviteId: "unsafe/path",
    }),
    null,
  );
  assert.equal(
    parseProfileGameProjectionTask({
      ...automatchTask(),
      requestId: "unsafe/path",
    }),
    null,
  );
  assert.deepEqual(
    parseProfileGameProjectionTask({
      kind: "rating-profile-game-projection",
      operationId,
    }),
    { kind: "rating-profile-game-projection", operationId },
  );
  assert.equal(
    parseProfileGameProjectionTask({
      kind: "rating-profile-game-projection",
      operationId,
      extra: true,
    }),
    null,
  );
  assert.equal(
    parseProfileGameProjectionTask({
      kind: "rating-profile-game-projection",
      operationId: "unsafe/path",
    }),
    null,
  );
});

test("automatch outboxes preserve source and recovery timestamps", () => {
  assert.deepEqual(
    buildAutomatchProfileGameProjectionOutboxUpdates({
      inviteId: "auto_aaaaaaaaaaa",
      requestId: "request-1",
      timestamp: 100,
    }),
    {
      "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa": automatchOutbox(
        "request-1",
        100,
        100,
      ),
    },
  );
  assert.deepEqual(
    parseAutomatchProfileGameProjectionOutbox(automatchOutbox()),
    automatchOutbox(),
  );
  for (const invalid of [
    null,
    { ...automatchOutbox(), status: "dead" },
    { ...automatchOutbox(), requestId: "unsafe/path" },
    { ...automatchOutbox(), sourceUpdatedAtMs: null },
    { ...automatchOutbox(), lastQueuedAtMs: Number.NaN },
  ]) {
    assert.equal(parseAutomatchProfileGameProjectionOutbox(invalid), null);
  }
});

test("automatch projection uses the immutable source timestamp and exact-clears", async () => {
  const path = "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa";
  const values = new Map<string, unknown>([[path, automatchOutbox()]]);
  const calls: Array<{
    inviteId: string;
    options: Record<string, unknown>;
    reason: string;
  }> = [];
  const rtdb = {
    getRtdbPath: async (requestedPath: string) => values.get(requestedPath),
    transactRtdbPath: async (
      requestedPath: string,
      updater: (current: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(values.get(requestedPath), updater);
      if (result.committed) {
        values.set(requestedPath, result.value);
      }
      return result;
    },
  };
  assert.equal(
    await processAutomatchProfileGameProjection(
      automatchTask(),
      rtdb,
      runtime(calls),
    ),
    "projected",
  );
  assert.deepEqual(calls, [
    {
      inviteId: "auto_aaaaaaaaaaa",
      reason: "automatch-queue",
      options: { eventTimestampMs: 100 },
    },
  ]);
  assert.equal(values.get(path), null);

  values.set(path, automatchOutbox("request-new", 300, 300));
  assert.equal(
    await processAutomatchProfileGameProjection(
      automatchTask(),
      rtdb,
      runtime(calls),
    ),
    "stale",
  );
  assert.equal(calls.length, 1);
});

test("automatch projection serializes newer work behind the current invite", async () => {
  const outboxPath = "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa";
  const values = new Map<string, unknown>([[outboxPath, automatchOutbox()]]);
  let projection = "initial";
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const rtdb = {
    getRtdbPath: async (path: string) => values.get(path),
    transactRtdbPath: async (
      path: string,
      updater: (current: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(values.get(path), updater);
      if (result.committed) {
        values.set(path, result.value);
      }
      return result;
    },
  };
  const first = processAutomatchProfileGameProjection(
    automatchTask(),
    rtdb,
    {
      recomputeInviteProjection: async () => {
        firstStarted?.();
        await firstBlocked;
        projection = "canceled";
        return {
          inviteId: "auto_aaaaaaaaaaa",
          ok: true,
          reason: "automatch-queue",
          skipped: 0,
          sourceCleanupSafe: true,
        };
      },
    },
    "owner-a",
    () => 100,
  );
  await started;
  values.set(outboxPath, automatchOutbox("request-new", 300, 300));
  await assert.rejects(
    () =>
      processAutomatchProfileGameProjection(
        automatchTask("request-new"),
        rtdb,
        runtime([]),
        "owner-b",
        () => 200,
      ),
    /lock-busy/,
  );
  releaseFirst?.();
  assert.equal(await first, "superseded");
  assert.equal(
    await processAutomatchProfileGameProjection(
      automatchTask("request-new"),
      rtdb,
      {
        recomputeInviteProjection: async () => {
          projection = "matched";
          return {
            inviteId: "auto_aaaaaaaaaaa",
            ok: true,
            reason: "automatch-queue",
            skipped: 0,
            sourceCleanupSafe: true,
          };
        },
      },
      "owner-b",
      () => 300,
    ),
    "projected",
  );
  assert.equal(projection, "matched");
  assert.equal(values.get(outboxPath), null);
});

test("rating projection uses deterministic completion inputs and completes once", async () => {
  const calls: Array<{
    inviteId: string;
    options: Record<string, unknown>;
    reason: string;
  }> = [];
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  const status = await processRatingProfileGameProjection(
    operationId,
    ratingRepository(ratingUpdate(), state),
    runtime(calls),
    () => 300,
    projectionLockRtdb(),
  );
  assert.equal(status, "done");
  assert.deepEqual(calls, [
    {
      inviteId: "auto_aaaaaaaaaaa",
      reason: "invite-match-rating-updated",
      options: {
        eventTimestampMs: 200,
        latestMatchIdHint: "auto_aaaaaaaaaaa",
      },
    },
  ]);
  assert.deepEqual(state.marks, [{ state: "done" }]);

  assert.equal(
    await processRatingProfileGameProjection(
      operationId,
      ratingRepository(
        ratingUpdate({ profileGameProjectionState: "done" }),
        state,
      ),
      runtime(calls),
      () => 400,
      projectionLockRtdb(),
    ),
    "stale",
  );
  assert.equal(calls.length, 1);
});

test("rating projection does not re-enter an active projection lock", async () => {
  const values = new Map<string, unknown>();
  const rtdb = projectionLockRtdb(values);
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const first = processRatingProfileGameProjection(
    operationId,
    ratingRepository(ratingUpdate(), state),
    {
      recomputeInviteProjection: async () => {
        firstStarted?.();
        await firstBlocked;
        return {
          inviteId: "auto_aaaaaaaaaaa",
          ok: true,
          reason: "invite-match-rating-updated",
          skipped: 0,
          sourceCleanupSafe: true,
        };
      },
    },
    () => 100,
    rtdb,
    "owner-a",
  );
  await started;
  await assert.rejects(
    () =>
      processRatingProfileGameProjection(
        operationId,
        ratingRepository(ratingUpdate(), state),
        runtime([]),
        () => 200,
        rtdb,
        "owner-a",
      ),
    /lock-busy/,
  );
  releaseFirst?.();
  assert.equal(await first, "done");
  assert.equal(
    values.get("profileGameProjectionLocks/automatch/auto_aaaaaaaaaaa"),
    null,
  );
});

test("rating projection retries lock release before marking completion", async () => {
  let current: unknown = null;
  let failRelease = true;
  let releaseAttempts = 0;
  const rtdb = {
    getRtdbPath: async () => null,
    transactRtdbPath: async (
      _path: string,
      updater: (value: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(current, updater);
      if (result.committed && result.value === null) {
        releaseAttempts++;
        if (failRelease) {
          failRelease = false;
          throw new Error("release-failed");
        }
      }
      if (result.committed) {
        current = result.value;
      }
      return result;
    },
  };
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  const calls: Array<{
    inviteId: string;
    options: Record<string, unknown>;
    reason: string;
  }> = [];
  assert.equal(
    await processRatingProfileGameProjection(
      operationId,
      ratingRepository(ratingUpdate(), state),
      runtime(calls),
      () => 100,
      rtdb,
      "owner-a",
    ),
    "done",
  );
  assert.equal(current, null);
  assert.equal(releaseAttempts, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(state.marks, [{ state: "done" }]);
});

test("rating projection dead-letters invalid records and retries missing markers", async () => {
  const invalidState = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  assert.equal(
    await processRatingProfileGameProjection(
      operationId,
      ratingRepository(
        ratingUpdate({ profileGameProjectionVersion: 2 }),
        invalidState,
      ),
      runtime([]),
      () => 300,
      projectionLockRtdb(),
    ),
    "dead",
  );
  assert.deepEqual(invalidState.marks, [
    { state: "dead", reason: "invalid-record" },
  ]);

  const missingState = { marker: null, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  await assert.rejects(
    () =>
      processRatingProfileGameProjection(
        operationId,
        ratingRepository(ratingUpdate(), missingState),
        runtime([]),
        () => 300,
        projectionLockRtdb(),
      ),
    /marker-pending/,
  );
  assert.deepEqual(missingState.marks, []);
});

test("profile game projection Queue acknowledges poison and retries transient work", async () => {
  const invalid = queueMessage({ invalid: true });
  await handleProfileGameProjectionMessage(invalid.message, TELEGRAM_TEST_ENV, {
    logger: { error() {}, info() {} },
  });
  assert.equal(invalid.acknowledgements(), 1);
  assert.deepEqual(invalid.retries, []);

  const failed = queueMessage(
    { kind: "rating-profile-game-projection", operationId },
    4,
  );
  await handleProfileGameProjectionMessage(failed.message, TELEGRAM_TEST_ENV, {
    createRating: () => {
      throw new Error("temporary");
    },
    logger: { error() {}, info() {} },
  });
  assert.equal(failed.acknowledgements(), 0);
  assert.deepEqual(failed.retries, [{ delaySeconds: 8 }]);
  assert.equal(profileGameProjectionRetryDelaySeconds(100), 60);
});

test("automatch Queue retries transient work without settling its outbox", async () => {
  const failed = queueMessage(automatchTask(), 3);
  const outboxPath = "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa";
  const values = new Map<string, unknown>([[outboxPath, automatchOutbox()]]);
  let transactions = 0;
  await handleProfileGameProjectionMessage(failed.message, TELEGRAM_TEST_ENV, {
    createRtdb: () => ({
      getRtdbPath: async (path) => values.get(path),
      transactRtdbPath: async (path, updater) => {
        transactions++;
        const result = applyRtdbTransaction(values.get(path), updater);
        if (result.committed) {
          values.set(path, result.value);
        }
        return result;
      },
    }),
    createRuntime: () => ({
      recomputeInviteProjection: async () => {
        throw new Error("temporary-projection-failure");
      },
    }),
    logger: { error() {}, info() {} },
  });
  assert.equal(failed.acknowledgements(), 0);
  assert.deepEqual(failed.retries, [{ delaySeconds: 4 }]);
  assert.equal(transactions, 2);
  assert.deepEqual(values.get(outboxPath), automatchOutbox());
});

test("profile game projection Queue keeps exhausted infrastructure work pending", async () => {
  const exhausted = queueMessage(
    { kind: "rating-profile-game-projection", operationId },
    100,
  );
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  await handleProfileGameProjectionMessage(
    exhausted.message,
    TELEGRAM_TEST_ENV,
    {
      createRating: () => ratingRepository(ratingUpdate(), state),
      createRtdb: () => projectionLockRtdb(),
      createRuntime: () => ({
        recomputeInviteProjection: async () => {
          throw new Error("persistent-failure");
        },
      }),
      logger: { error() {}, info() {} },
      now: () => 300,
    },
  );
  assert.equal(exhausted.acknowledgements(), 0);
  assert.deepEqual(exhausted.retries, [{ delaySeconds: 60 }]);
  assert.deepEqual(state.marks, []);
});

test("Worker Queue routing selects the profile game projection consumer", async () => {
  const invalid = queueMessage({
    kind: "rating-profile-game-projection",
    operationId: "unsafe/path",
  } satisfies ProfileGameProjectionTask);
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (message) => {
    logs.push(String(message));
  };
  try {
    await worker.queue?.(
      {
        messages: [invalid.message],
        queue: PROFILE_GAME_PROJECTION_QUEUE_NAME,
        metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
        ackAll() {},
        retryAll() {},
      },
      TELEGRAM_TEST_ENV,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(invalid.acknowledgements(), 1);
  assert.equal(
    logs.some((entry) =>
      entry.includes("profile_game_projection_queue_invalid_message"),
    ),
    true,
  );
});

test("scheduled recovery claims, repairs, and batches valid projection records", async () => {
  const batches: ProfileGameProjectionTask[][] = [];
  const queue = {
    ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      batches.push(
        Array.from(messages).map(
          ({ body }) => body as ProfileGameProjectionTask,
        ),
      );
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    },
  } satisfies Queue;
  const env = {
    ...TELEGRAM_TEST_ENV,
    PROFILE_GAME_PROJECTION_QUEUE: queue,
  } satisfies Env;
  const state = { marker: null, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  const rating = ratingRepository(ratingUpdate(), state);
  rating.listDueRatingProfileGameProjections = async (
    updatedBeforeMs,
    limit,
  ) => {
    assert.equal(updatedBeforeMs, 600_000);
    assert.equal(limit, 100);
    return [
      {
        inviteId: "auto_aaaaaaaaaaa",
        matchId: "auto_aaaaaaaaaaa",
        operationId,
        updateTime: "2026-08-25T00:00:00Z",
        version: 1,
      },
      {
        inviteId: "bad",
        matchId: "bad",
        operationId: "mismatch",
        updateTime: "2026-08-25T00:00:01Z",
        version: 1,
      },
    ];
  };
  const claims: string[] = [];
  rating.claimRatingProfileGameProjection = async (claimedOperationId) => {
    claims.push(claimedOperationId);
    return true;
  };

  assert.equal(
    await sweepRatingProfileGameProjections(env, {
      createRating: () => rating,
      logger: { error() {}, info() {} },
      now: () => 600_000,
    }),
    1,
  );
  assert.deepEqual(claims.sort(), ["mismatch", operationId].sort());
  assert.deepEqual(state.patches, [
    {
      "invites/auto_aaaaaaaaaaa/matchesRatingUpdates/auto_aaaaaaaaaaa": true,
    },
  ]);
  assert.deepEqual(state.marks, [
    { state: "dead", reason: "invalid-recovery-marker" },
  ]);
  assert.deepEqual(batches.flat(), [
    { kind: "rating-profile-game-projection", operationId },
  ]);
});

test("scheduled recovery bounds concurrent claims", async () => {
  const rating = ratingRepository(null, {
    marker: null,
    marks: [],
    patches: [],
  });
  rating.listDueRatingProfileGameProjections = async () =>
    Array.from({ length: 25 }, (_, index) => ({
      inviteId: `auto_${String(index).padStart(11, "a")}`,
      matchId: `auto_${String(index).padStart(11, "a")}`,
      operationId: `operation-${index}`,
      updateTime: `update-${index}`,
      version: 1,
    }));
  let active = 0;
  let maximum = 0;
  rating.claimRatingProfileGameProjection = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return false;
  };
  assert.equal(
    await sweepRatingProfileGameProjections(TELEGRAM_TEST_ENV, {
      createRating: () => rating,
      now: () => 600_000,
    }),
    0,
  );
  assert.equal(maximum, 10);
});

test("automatch recovery claims due outboxes, repairs poison, and preserves source time", async () => {
  const batches: ProfileGameProjectionTask[][] = [];
  const logs: string[] = [];
  const queue = {
    ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      batches.push(
        Array.from(messages).map(
          ({ body }) => body as ProfileGameProjectionTask,
        ),
      );
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    },
  } satisfies Queue;
  const values = new Map<string, unknown>([
    ["auto_aaaaaaaaaaa", automatchOutbox("request-1", 50, 100)],
    ["auto_bbbbbbbbbbb", { ...automatchOutbox("unsafe/path", 60, 200) }],
    [
      "auto_ccccccccccc",
      {
        schemaVersion: 1,
        status: "pending",
        requestId: "request-3",
        sourceUpdatedAtMs: 70,
      },
    ],
    ["auto_ddddddddddd", "invalid"],
    [
      "auto_eeeeeeeeeee",
      { ...automatchOutbox("request-5", 80, 200), lastQueuedAtMs: "bad" },
    ],
    [
      "auto_fffffffffff",
      {
        ...automatchOutbox("request-6", 90, 200),
        lastQueuedAtMs: { invalid: true },
      },
    ],
  ]);
  const rtdb = {
    getRtdbPath: async (path: string, query?: Record<string, unknown>) => {
      assert.equal(path, "profileGameProjectionOutbox/automatch");
      if (query?.endAt === 300_000) {
        return Object.fromEntries(
          [...values].filter(
            ([inviteId]) =>
              inviteId !== "auto_eeeeeeeeeee" &&
              inviteId !== "auto_fffffffffff",
          ),
        );
      }
      assert.deepEqual(query, {
        orderBy: "lastQueuedAtMs",
        startAt: "",
        limitToFirst: 100,
      });
      return Object.fromEntries(
        [...values].filter(
          ([inviteId]) =>
            inviteId === "auto_eeeeeeeeeee" || inviteId === "auto_fffffffffff",
        ),
      );
    },
    transactRtdbPath: async (
      path: string,
      updater: (current: unknown) => unknown,
    ) => {
      const inviteId = path.split("/").at(-1) || "";
      const result = applyRtdbTransaction(values.get(inviteId), updater);
      if (result.committed) {
        values.set(inviteId, result.value);
      }
      return result;
    },
  };
  const requestIds = [
    "repair-1",
    "repair-2",
    "repair-3",
    "repair-4",
    "repair-5",
  ];
  assert.equal(
    await sweepAutomatchProfileGameProjections(
      {
        ...TELEGRAM_TEST_ENV,
        PROFILE_GAME_PROJECTION_QUEUE: queue,
      },
      {
        createRequestId: () => requestIds.shift() || "unexpected",
        createRtdb: () => rtdb,
        logger: { error: (message) => logs.push(String(message)), info() {} },
        now: () => 600_000,
      },
    ),
    6,
  );
  assert.deepEqual(batches.flat(), [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_bbbbbbbbbbb",
      requestId: "repair-1",
    },
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_ccccccccccc",
      requestId: "repair-2",
    },
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_ddddddddddd",
      requestId: "repair-3",
    },
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_eeeeeeeeeee",
      requestId: "repair-4",
    },
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_fffffffffff",
      requestId: "repair-5",
    },
    automatchTask(),
  ]);
  assert.deepEqual(values.get("auto_aaaaaaaaaaa"), {
    ...automatchOutbox("request-1", 50, 100),
    lastQueuedAtMs: 600_000,
  });
  assert.deepEqual(
    values.get("auto_bbbbbbbbbbb"),
    automatchOutbox("repair-1", 60, 600_000),
  );
  assert.deepEqual(
    values.get("auto_ccccccccccc"),
    automatchOutbox("repair-2", 70, 600_000),
  );
  assert.deepEqual(
    values.get("auto_ddddddddddd"),
    automatchOutbox("repair-3", 600_000, 600_000),
  );
  assert.deepEqual(
    values.get("auto_eeeeeeeeeee"),
    automatchOutbox("repair-4", 80, 600_000),
  );
  assert.deepEqual(
    values.get("auto_fffffffffff"),
    automatchOutbox("repair-5", 90, 600_000),
  );
  assert.equal(
    logs.some(
      (entry) =>
        entry.includes("profile_game_projection_invalid_outboxes_recovered") &&
        entry.includes('"repaired":5') &&
        entry.includes('"removed":0'),
    ),
    true,
  );
});

test("automatch recovery claims an outbox only once", async () => {
  let current: unknown = automatchOutbox("request-1", 50, 100);
  const rtdb = {
    getRtdbPath: async () => current,
    transactRtdbPath: async (
      _path: string,
      updater: (value: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(current, updater);
      if (result.committed) {
        current = result.value;
      }
      return result;
    },
  };
  const candidate = {
    lastQueuedAtMs: 100,
    task: automatchTask(),
  };
  assert.deepEqual(
    await Promise.all([
      claimAutomatchSweepCandidate(rtdb, candidate, 600_000),
      claimAutomatchSweepCandidate(rtdb, candidate, 600_000),
    ]),
    [true, false],
  );
  assert.deepEqual(current, {
    ...automatchOutbox("request-1", 50, 100),
    lastQueuedAtMs: 600_000,
  });
});
