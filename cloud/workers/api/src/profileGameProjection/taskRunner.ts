import { createGameplayRepository } from "../gameplayRepository.ts";
import { createRatingRepository } from "../ratingRepository.ts";
import {
  createEventGameplayRepository,
  createEventProgressOutboxWriter,
} from "../eventRepository.ts";
import { createEventProfileGameProjectionState } from "../eventProfileGameProjectionState.ts";
import {
  createEventProfileGameProjectionRuntime,
  createProfileGameProjectionRuntime,
} from "../profileGameProjectionRepository.ts";
import type { ProfileGameProjectionTask } from "../profileGameProjectionTasks.ts";
import { createProfileLinkProjectionRuntime } from "../profileLinkProfileGameProjection.ts";
import { createProfileGameProjectionLockStore } from "../profileGameProjectionLocksD1.ts";
import { createProfileLinkCatchupStore } from "../profileLinkCatchupD1.ts";
import {
  processAutomatchProfileGameProjection,
  processEventProfileGameProjection,
  processProfileLinkProfileGameProjection,
  processRatingProfileGameProjection,
} from "./processing.ts";
import type {
  ProfileGameProjectionLogger,
  ProfileGameProjectionQueueDependencies,
} from "./types.ts";

type ProfileGameProjectionTaskOutcome = Awaited<
  ReturnType<
    | typeof processAutomatchProfileGameProjection
    | typeof processEventProfileGameProjection
    | typeof processProfileLinkProfileGameProjection
    | typeof processRatingProfileGameProjection
  >
>;

export async function runProfileGameProjectionTask(
  task: ProfileGameProjectionTask,
  env: Env,
  dependencies: ProfileGameProjectionQueueDependencies,
  now: () => number,
  logger: ProfileGameProjectionLogger,
): Promise<ProfileGameProjectionTaskOutcome> {
  const ownerId = crypto.randomUUID();
  let status: ProfileGameProjectionTaskOutcome;
  if (task.kind === "event-profile-game-projection") {
    status = await processEventProfileGameProjection(
      task,
      (
        dependencies.createEventStateRepository ||
        dependencies.createStateRepository ||
        createEventProfileGameProjectionState
      )(env),
      (
        dependencies.createEventRuntime ||
        createEventProfileGameProjectionRuntime
      )(env),
      ownerId,
      now,
    );
  } else {
    const state = (
      dependencies.createStateRepository ||
      ((workerEnv: Env) => createEventGameplayRepository(workerEnv))
    )(env);
    const runtime = (
      dependencies.createRuntime || createProfileGameProjectionRuntime
    )(env);
    const locks = (
      dependencies.createLocks ||
      ((workerEnv: Env) =>
        createProfileGameProjectionLockStore(workerEnv.PROFILE_GAMES_DB))
    )(env);
    if (task.kind === "automatch-profile-game-projection") {
      status = await processAutomatchProfileGameProjection(
        task,
        state,
        runtime,
        locks,
        ownerId,
        now,
        logger,
      );
    } else if (task.kind === "profile-link-profile-game-projection") {
      status = await processProfileLinkProfileGameProjection(
        task,
        (
          dependencies.createProfileLinkJobs ||
          ((workerEnv: Env) =>
            createProfileLinkCatchupStore(workerEnv.PROFILE_DB))
        )(env),
        async (input) => {
          if (dependencies.processProfileLink) {
            return dependencies.processProfileLink(input);
          }
          const linkLogger = {
            error(event: string, context?: unknown) {
              logger.error(JSON.stringify({ event, context }));
            },
            info(event: string, context?: unknown) {
              logger.info(JSON.stringify({ event, context }));
            },
          };
          return createProfileLinkProjectionRuntime(env, {
            logger: linkLogger,
            now,
            projection: runtime,
            state,
            withInviteProjectionLock: input.withInviteProjectionLock,
          }).process(input);
        },
        locks,
        ownerId,
        now,
      );
    } else {
      status = await processRatingProfileGameProjection(
        task.operationId,
        (
          dependencies.createRating ||
          ((workerEnv: Env) =>
            createRatingRepository(
              workerEnv.PROFILE_DB,
              createGameplayRepository(workerEnv),
              createEventProgressOutboxWriter(workerEnv.EVENT_DB),
            ))
        )(env),
        runtime,
        now,
        locks,
        ownerId,
      );
    }
  }
  return status;
}

export function createProfileGameProjectionBatchDependencies(
  env: Env,
): ProfileGameProjectionQueueDependencies {
  const state = createEventGameplayRepository(env);
  const rating = createRatingRepository(env.PROFILE_DB, state, state);
  const runtime = createProfileGameProjectionRuntime(env, { state });
  const locks = createProfileGameProjectionLockStore(env.PROFILE_GAMES_DB);
  return {
    createLocks: () => locks,
    createRating: () => rating,
    createStateRepository: () => state,
    createRuntime: () => runtime,
  };
}

export function createEventProfileGameProjectionBatchDependencies(
  env: Env,
): ProfileGameProjectionQueueDependencies {
  const state = createEventProfileGameProjectionState(env);
  const eventRuntime = createEventProfileGameProjectionRuntime(env, { state });
  return {
    createEventRuntime: () => eventRuntime,
    createEventStateRepository: () => state,
  };
}
