import {
  createGameplayRepository,
  createRatingRepository,
  type RatingProfileGameProjectionRepository,
} from "./gameplayRepository.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  createProfileGameProjectionRuntime,
  type ProfileGameProjectionRuntime,
} from "./profileGameProjectionRepository.ts";
import {
  parseProfileGameProjectionTask,
  PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
  type ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";

const PROFILE_GAME_PROJECTION_SWEEP_LIMIT = 100;
const PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY = 10;
const MAX_PROFILE_GAME_PROJECTION_RETRY_DELAY_SECONDS = 60;

type ProfileGameProjectionLogger = Pick<Console, "error" | "info">;

export type ProfileGameProjectionDependencies = {
  createRating?: (env: Env) => RatingProfileGameProjectionRepository;
  createRuntime?: (env: Env) => ProfileGameProjectionRuntime;
  logger?: ProfileGameProjectionLogger;
  now?: () => number;
};

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

export async function processRatingProfileGameProjection(
  operationId: string,
  rating: RatingProfileGameProjectionRepository,
  runtime: ProfileGameProjectionRuntime,
  now: () => number,
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
    const rating = (
      dependencies.createRating ||
      ((workerEnv: Env) =>
        createRatingRepository(workerEnv, createGameplayRepository(workerEnv)))
    )(env);
    const runtime = (
      dependencies.createRuntime || createProfileGameProjectionRuntime
    )(env);
    const status = await processRatingProfileGameProjection(
      task.operationId,
      rating,
      runtime,
      now,
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
  const rating = createRatingRepository(env, createGameplayRepository(env));
  const runtime = createProfileGameProjectionRuntime(env);
  for (const message of batch.messages) {
    await handleProfileGameProjectionMessage(message, env, {
      createRating: () => rating,
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

export async function sweepProfileGameProjections(
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

export async function handleProfileGameProjectionSweep(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  const enqueued = await sweepProfileGameProjections(env);
  console.info(
    JSON.stringify({
      event: "profile_game_projection_sweep_completed",
      enqueued,
    }),
  );
}

export {
  MAX_PROFILE_GAME_PROJECTION_RETRY_DELAY_SECONDS,
  PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY,
  PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  sendProfileGameProjectionTasks,
  validRatingProjectionRecord,
};
