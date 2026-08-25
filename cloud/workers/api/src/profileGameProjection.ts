import {
  createGameplayRepository,
  createRatingRepository,
  type GameplayRepository,
  type RatingProfileGameProjectionRepository,
} from "./gameplayRepository.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT,
  getAutomatchProfileGameProjectionLockPath,
  getAutomatchProfileGameProjectionOutboxPath,
  parseAutomatchProfileGameProjectionOutbox,
} from "./profileGameProjectionOutbox.ts";
import {
  createProfileGameProjectionRuntime,
  type ProfileGameProjectionRuntime,
} from "./profileGameProjectionRepository.ts";
import {
  parseProfileGameProjectionTask,
  PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
  type AutomatchProfileGameProjectionTask,
  type ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";

const PROFILE_GAME_PROJECTION_SWEEP_LIMIT = 100;
const PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY = 10;
const MAX_PROFILE_GAME_PROJECTION_RETRY_DELAY_SECONDS = 60;
const PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS = 5 * 60 * 1_000;
const AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_MS = 15 * 60 * 1_000;
const PROFILE_GAME_PROJECTION_LOCK_RELEASE_ATTEMPTS = 3;

type ProfileGameProjectionLogger = Pick<Console, "error" | "info">;
type ProfileGameProjectionRtdb = Pick<
  GameplayRepository,
  "getRtdbPath" | "transactRtdbPath"
>;

type ProfileGameProjectionLock = {
  inviteId: string;
  requestId?: string;
};

export type ProfileGameProjectionDependencies = {
  createRating?: (env: Env) => RatingProfileGameProjectionRepository;
  createRtdb?: (env: Env) => ProfileGameProjectionRtdb;
  createRequestId?: () => string;
  createRuntime?: (env: Env) => ProfileGameProjectionRuntime;
  logger?: ProfileGameProjectionLogger;
  now?: () => number;
};

type AutomatchSweepCandidate = {
  lastQueuedAtMs: number;
  task: AutomatchProfileGameProjectionTask;
};

type AutomatchSweepEntry =
  | { kind: "candidate"; value: AutomatchSweepCandidate }
  | { inviteId: string; kind: "invalid" };

export type ProfileGameProjectionSweepResult = {
  automatch: number;
  rating: number;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validRatingProjectionRecord(
  operationId: string,
  update: Awaited<
    ReturnType<RatingProfileGameProjectionRepository["readRatingUpdate"]>
  >,
): update is NonNullable<typeof update> {
  return Boolean(
    update &&
    update.profileGameProjectionVersion ===
      PROFILE_GAME_PROJECTION_SCHEMA_VERSION &&
    Number.isSafeInteger(update.completedAtMs) &&
    (update.completedAtMs || 0) > 0 &&
    isSafeFirebaseKey(update.inviteId) &&
    isSafeFirebaseKey(update.matchId) &&
    operationId === `${update.inviteId}__${update.matchId}`,
  );
}

export function profileGameProjectionRetryDelaySeconds(
  attempts: number,
): number {
  const exponent = Math.max(0, Math.min(6, attempts - 1));
  return Math.min(
    MAX_PROFILE_GAME_PROJECTION_RETRY_DELAY_SECONDS,
    2 ** exponent,
  );
}

async function acquireProfileGameProjectionLock(
  lock: ProfileGameProjectionLock,
  ownerId: string,
  rtdb: ProfileGameProjectionRtdb,
  nowMs: number,
): Promise<void> {
  const value = {
    ownerId,
    ...(lock.requestId ? { requestId: lock.requestId } : {}),
    expiresAtMs: nowMs + AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_MS,
  };
  const result = await rtdb.transactRtdbPath(
    getAutomatchProfileGameProjectionLockPath(lock.inviteId),
    (current) => {
      const record = toRecord(current);
      const expiresAtMs = record?.expiresAtMs;
      if (
        typeof record?.ownerId === "string" &&
        typeof expiresAtMs === "number" &&
        Number.isFinite(expiresAtMs) &&
        expiresAtMs > nowMs
      ) {
        return { commit: false, decision: "busy" };
      }
      return {
        value,
        decision: "acquired",
      };
    },
  );
  if (!result.committed) {
    throw new Error("profile-game-projection-lock-busy");
  }
}

async function releaseProfileGameProjectionLock(
  lock: ProfileGameProjectionLock,
  ownerId: string,
  rtdb: ProfileGameProjectionRtdb,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < PROFILE_GAME_PROJECTION_LOCK_RELEASE_ATTEMPTS;
    attempt++
  ) {
    try {
      await rtdb.transactRtdbPath(
        getAutomatchProfileGameProjectionLockPath(lock.inviteId),
        (current) =>
          toRecord(current)?.ownerId === ownerId
            ? { value: null, decision: "released" }
            : { commit: false, decision: "not-owner" },
      );
      return;
    } catch (error) {
      if (attempt === PROFILE_GAME_PROJECTION_LOCK_RELEASE_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
}

export async function settleAutomatchProfileGameProjectionOutbox(
  task: AutomatchProfileGameProjectionTask,
  rtdb: ProfileGameProjectionRtdb,
): Promise<boolean> {
  const result = await rtdb.transactRtdbPath(
    getAutomatchProfileGameProjectionOutboxPath(task.inviteId),
    (current) => {
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return { value: null, decision: "cleared" };
    },
  );
  return result.committed;
}

export async function processAutomatchProfileGameProjection(
  task: AutomatchProfileGameProjectionTask,
  rtdb: ProfileGameProjectionRtdb,
  runtime: ProfileGameProjectionRuntime,
  ownerId: string = crypto.randomUUID(),
  now: () => number = Date.now,
): Promise<"projected" | "stale" | "superseded"> {
  await acquireProfileGameProjectionLock(task, ownerId, rtdb, now());
  try {
    const outbox = parseAutomatchProfileGameProjectionOutbox(
      await rtdb.getRtdbPath(
        getAutomatchProfileGameProjectionOutboxPath(task.inviteId),
      ),
    );
    if (!outbox || outbox.requestId !== task.requestId) {
      return "stale";
    }
    await runtime.recomputeInviteProjection(task.inviteId, "automatch-queue", {
      eventTimestampMs: outbox.sourceUpdatedAtMs,
    });
    return (await settleAutomatchProfileGameProjectionOutbox(task, rtdb))
      ? "projected"
      : "superseded";
  } finally {
    await releaseProfileGameProjectionLock(task, ownerId, rtdb);
  }
}

function automatchSweepEntries(value: unknown): AutomatchSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([inviteId, raw]) => {
    const outbox = parseAutomatchProfileGameProjectionOutbox(raw);
    return outbox && isSafeFirebaseKey(inviteId)
      ? {
          kind: "candidate",
          value: {
            lastQueuedAtMs: outbox.lastQueuedAtMs,
            task: {
              kind: "automatch-profile-game-projection",
              inviteId,
              requestId: outbox.requestId,
            },
          },
        }
      : { inviteId, kind: "invalid" };
  });
}

async function claimAutomatchSweepCandidate(
  rtdb: ProfileGameProjectionRtdb,
  candidate: AutomatchSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await rtdb.transactRtdbPath(
    getAutomatchProfileGameProjectionOutboxPath(candidate.task.inviteId),
    (current) => {
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.lastQueuedAtMs !== candidate.lastQueuedAtMs ||
        outbox.lastQueuedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: { ...toRecord(current), lastQueuedAtMs: nowMs },
        decision: "claimed",
      };
    },
  );
  return result.committed;
}

type InvalidAutomatchSweepResult =
  | { kind: "changed" }
  | { kind: "removed" }
  | { kind: "repaired"; task: AutomatchProfileGameProjectionTask };

async function repairInvalidAutomatchSweepEntry(
  rtdb: ProfileGameProjectionRtdb,
  inviteId: string,
  nowMs: number,
  createRequestId: () => string,
): Promise<InvalidAutomatchSweepResult> {
  const safeInviteId = isSafeFirebaseKey(inviteId);
  const requestId = safeInviteId ? createRequestId() : "";
  const result = await rtdb.transactRtdbPath(
    getAutomatchProfileGameProjectionOutboxPath(inviteId),
    (current) => {
      const record = toRecord(current);
      if (
        current === null ||
        current === undefined ||
        (record &&
          parseAutomatchProfileGameProjectionOutbox(current) &&
          isSafeFirebaseKey(inviteId))
      ) {
        return { commit: false, decision: "changed" };
      }
      if (!safeInviteId) {
        return { value: null, decision: "removed-invalid" };
      }
      const sourceUpdatedAtMs = record?.sourceUpdatedAtMs;
      return {
        value: {
          schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
          status: "pending",
          requestId,
          sourceUpdatedAtMs:
            typeof sourceUpdatedAtMs === "number" &&
            Number.isFinite(sourceUpdatedAtMs) &&
            sourceUpdatedAtMs >= 0
              ? Math.floor(sourceUpdatedAtMs)
              : nowMs,
          lastQueuedAtMs: nowMs,
        },
        decision: "repaired-invalid",
      };
    },
  );
  if (!result.committed) {
    return { kind: "changed" };
  }
  return safeInviteId
    ? {
        kind: "repaired",
        task: {
          kind: "automatch-profile-game-projection",
          inviteId,
          requestId,
        },
      }
    : { kind: "removed" };
}

async function collectSuccessfulClaims<T>(
  items: readonly T[],
  claim: (item: T) => Promise<boolean>,
): Promise<{ claimed: T[]; failure: Error | null }> {
  const claimed: T[] = [];
  let failure: Error | null = null;
  for (const item of items) {
    try {
      if (await claim(item)) {
        claimed.push(item);
      }
    } catch (error) {
      failure ||=
        error instanceof Error
          ? error
          : new Error("profile-game-projection-claim-failed");
    }
  }
  return { claimed, failure };
}

export async function processRatingProfileGameProjection(
  operationId: string,
  rating: RatingProfileGameProjectionRepository,
  runtime: ProfileGameProjectionRuntime,
  now: () => number,
  rtdb: ProfileGameProjectionRtdb,
  ownerId: string = crypto.randomUUID(),
): Promise<"dead" | "done" | "stale"> {
  const update = await rating.readRatingUpdate(operationId);
  if (!update || update.profileGameProjectionState !== "pending") {
    return "stale";
  }
  if (!validRatingProjectionRecord(operationId, update)) {
    await rating.markRatingProfileGameProjection(
      operationId,
      "dead",
      now(),
      "invalid-record",
    );
    return "dead";
  }
  const lock = { inviteId: update.inviteId };
  await acquireProfileGameProjectionLock(lock, ownerId, rtdb, now());
  try {
    if (
      (await rating.getRtdbPath(
        `invites/${update.inviteId}/matchesRatingUpdates/${update.matchId}`,
      )) !== true
    ) {
      throw new Error("profile-game-projection-marker-pending");
    }
    await runtime.recomputeInviteProjection(
      update.inviteId,
      "invite-match-rating-updated",
      {
        eventTimestampMs: update.completedAtMs,
        latestMatchIdHint: update.matchId,
      },
    );
  } finally {
    await releaseProfileGameProjectionLock(lock, ownerId, rtdb);
  }
  await rating.markRatingProfileGameProjection(operationId, "done", now());
  return "done";
}

export async function handleProfileGameProjectionMessage(
  message: Message<unknown>,
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<void> {
  const logger = dependencies.logger || console;
  const task = parseProfileGameProjectionTask(message.body);
  if (!task) {
    message.ack();
    logger.error(
      JSON.stringify({
        event: "profile_game_projection_queue_invalid_message",
      }),
    );
    return;
  }
  const now = dependencies.now || Date.now;
  try {
    const ownerId = crypto.randomUUID();
    const runtime = (
      dependencies.createRuntime || createProfileGameProjectionRuntime
    )(env);
    const status =
      task.kind === "automatch-profile-game-projection"
        ? await processAutomatchProfileGameProjection(
            task,
            (
              dependencies.createRtdb ||
              ((workerEnv: Env) => createGameplayRepository(workerEnv))
            )(env),
            runtime,
            ownerId,
            now,
          )
        : await processRatingProfileGameProjection(
            task.operationId,
            (
              dependencies.createRating ||
              ((workerEnv: Env) =>
                createRatingRepository(
                  workerEnv,
                  createGameplayRepository(workerEnv),
                ))
            )(env),
            runtime,
            now,
            (
              dependencies.createRtdb ||
              ((workerEnv: Env) => createGameplayRepository(workerEnv))
            )(env),
            ownerId,
          );
    message.ack();
    logger.info(
      JSON.stringify({
        event: "profile_game_projection_queue_processed",
        kind: task.kind,
        status,
      }),
    );
  } catch (error) {
    message.retry({
      delaySeconds: profileGameProjectionRetryDelaySeconds(message.attempts),
    });
    logger.error(
      JSON.stringify({
        event: "profile_game_projection_queue_failed",
        kind: task.kind,
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

export async function handleProfileGameProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const rtdb = createGameplayRepository(env);
  const rating = createRatingRepository(env, rtdb);
  const runtime = createProfileGameProjectionRuntime(env, { rtdb });
  for (const message of batch.messages) {
    await handleProfileGameProjectionMessage(message, env, {
      createRating: () => rating,
      createRtdb: () => rtdb,
      createRuntime: () => runtime,
    });
  }
}

async function sendProfileGameProjectionTasks(
  queue: Queue<ProfileGameProjectionTask>,
  tasks: ProfileGameProjectionTask[],
): Promise<void> {
  for (let index = 0; index < tasks.length; index += 100) {
    await queue.sendBatch(
      tasks.slice(index, index + 100).map((task) => ({ body: task })),
    );
  }
}

async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const current = index++;
        await worker(items[current]);
      }
    },
  );
  await Promise.all(runners);
}

export async function sweepRatingProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const rating = (
    dependencies.createRating ||
    ((workerEnv: Env) =>
      createRatingRepository(workerEnv, createGameplayRepository(workerEnv)))
  )(env);
  const nowMs = now();
  const records = await rating.listDueRatingProfileGameProjections(
    nowMs,
    PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  );
  const tasks: ProfileGameProjectionTask[] = [];
  let firstFailure: unknown;
  await forEachConcurrent(
    records,
    PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY,
    async (record) => {
      try {
        const claimed = await rating.claimRatingProfileGameProjection(
          record.operationId,
          record.updateTime,
          nowMs,
        );
        if (!claimed) {
          return;
        }
        if (
          record.version !== PROFILE_GAME_PROJECTION_SCHEMA_VERSION ||
          !isSafeFirebaseKey(record.inviteId) ||
          !isSafeFirebaseKey(record.matchId) ||
          record.operationId !== `${record.inviteId}__${record.matchId}`
        ) {
          await rating.markRatingProfileGameProjection(
            record.operationId,
            "dead",
            now(),
            "invalid-recovery-marker",
          );
          return;
        }
        await rating.patchRtdbRoot({
          [`invites/${record.inviteId}/matchesRatingUpdates/${record.matchId}`]: true,
        });
        tasks.push({
          kind: "rating-profile-game-projection",
          operationId: record.operationId,
        });
      } catch (error) {
        firstFailure ||= error;
        logger.error(
          JSON.stringify({
            event: "profile_game_projection_recovery_record_failed",
            operationId: record.operationId,
          }),
        );
      }
    },
  );
  await sendProfileGameProjectionTasks(
    env.PROFILE_GAME_PROJECTION_QUEUE,
    tasks,
  );
  if (firstFailure) {
    throw firstFailure;
  }
  return tasks.length;
}

export async function sweepAutomatchProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const nowMs = now();
  const dueBeforeMs = nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS;
  const rtdb = (
    dependencies.createRtdb ||
    ((workerEnv: Env) => createGameplayRepository(workerEnv))
  )(env);
  const [dueValue, malformedValue] = await Promise.all([
    rtdb.getRtdbPath(AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT, {
      orderBy: "lastQueuedAtMs",
      endAt: dueBeforeMs,
      limitToFirst: PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    }),
    rtdb.getRtdbPath(AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT, {
      orderBy: "lastQueuedAtMs",
      startAt: "",
      limitToFirst: PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    }),
  ]);
  const entries = [
    ...automatchSweepEntries(dueValue),
    ...automatchSweepEntries(malformedValue),
  ];
  const invalidInviteIds = entries.flatMap((entry) =>
    entry.kind === "invalid" ? [entry.inviteId] : [],
  );
  let invalidFailure: Error | null = null;
  const repairedTasks: AutomatchProfileGameProjectionTask[] = [];
  let invalidRemoved = 0;
  for (const inviteId of invalidInviteIds) {
    try {
      const result = await repairInvalidAutomatchSweepEntry(
        rtdb,
        inviteId,
        nowMs,
        createRequestId,
      );
      if (result.kind === "repaired") {
        repairedTasks.push(result.task);
      } else if (result.kind === "removed") {
        invalidRemoved++;
      }
    } catch (error) {
      invalidFailure ||=
        error instanceof Error
          ? error
          : new Error("profile-game-projection-invalid-record-failed");
    }
  }
  if (repairedTasks.length > 0 || invalidRemoved > 0) {
    logger.error(
      JSON.stringify({
        event: "profile_game_projection_invalid_outboxes_recovered",
        repaired: repairedTasks.length,
        removed: invalidRemoved,
      }),
    );
  }
  const candidates = entries.flatMap((entry) =>
    entry.kind === "candidate" ? [entry.value] : [],
  );
  const claims = await collectSuccessfulClaims(candidates, (candidate) =>
    claimAutomatchSweepCandidate(rtdb, candidate, nowMs),
  );
  const tasks: ProfileGameProjectionTask[] = [
    ...repairedTasks,
    ...claims.claimed.map(({ task }) => task),
  ];
  await sendProfileGameProjectionTasks(
    env.PROFILE_GAME_PROJECTION_QUEUE,
    tasks,
  );
  if (claims.failure) {
    throw claims.failure;
  }
  if (invalidFailure) {
    throw invalidFailure;
  }
  return tasks.length;
}

export async function sweepProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<ProfileGameProjectionSweepResult> {
  const [automatch, rating] = await Promise.allSettled([
    sweepAutomatchProfileGameProjections(env, dependencies),
    sweepRatingProfileGameProjections(env, dependencies),
  ]);
  const failures = [automatch, rating].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (
    failures.length > 0 ||
    automatch.status === "rejected" ||
    rating.status === "rejected"
  ) {
    throw new AggregateError(failures, "profile-game-projection-sweep-failed");
  }
  return {
    automatch: automatch.value,
    rating: rating.value,
  };
}

export async function handleProfileGameProjectionSweep(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  const enqueued = await sweepProfileGameProjections(env);
  console.info(
    JSON.stringify({
      event: "profile_game_projection_sweep_completed",
      enqueued: enqueued.automatch + enqueued.rating,
      automatchEnqueued: enqueued.automatch,
      ratingEnqueued: enqueued.rating,
    }),
  );
}

export {
  MAX_PROFILE_GAME_PROJECTION_RETRY_DELAY_SECONDS,
  PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY,
  PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS,
  PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  acquireProfileGameProjectionLock,
  automatchSweepEntries,
  claimAutomatchSweepCandidate,
  releaseProfileGameProjectionLock,
  repairInvalidAutomatchSweepEntry,
  sendProfileGameProjectionTasks,
  validRatingProjectionRecord,
};
