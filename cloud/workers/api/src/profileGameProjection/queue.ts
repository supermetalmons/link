import { ackQueueMessage, retryQueueMessage } from "../queueMessage.ts";
import { createGameplayRepository } from "../gameplayRepository.ts";
import { createRatingRepository } from "../ratingRepository.ts";
import {
  createEventGameplayRepository,
  createEventProgressOutboxWriter,
} from "../eventRepository.ts";
import {
  createEventProfileGameProjectionRuntime,
  createProfileGameProjectionRuntime,
} from "../profileGameProjectionRepository.ts";
import { parseProfileGameProjectionTask } from "../profileGameProjectionTasks.ts";
import { createProfileLinkProjectionRuntime } from "../profileLinkProfileGameProjection.ts";
import {
  createProfileGameProjectionLockStore,
  ProfileGameProjectionLockFailure,
} from "../profileGameProjectionLocksD1.ts";
import { createProfileLinkCatchupStore } from "../profileLinkCatchupD1.ts";
import {
  processAutomatchProfileGameProjection,
  processEventProfileGameProjection,
  processProfileLinkProfileGameProjection,
  processRatingProfileGameProjection,
} from "./processing.ts";
import { profileGameProjectionRetryDelaySeconds } from "./policy.ts";
import type { ProfileGameProjectionQueueDependencies } from "./types.ts";

export async function handleProfileGameProjectionMessage(
  message: Message<unknown>,
  env: Env,
  dependencies: ProfileGameProjectionQueueDependencies = {},
): Promise<void> {
  const logger = dependencies.logger || console;
  const task = parseProfileGameProjectionTask(message.body);
  if (!task) {
    ackQueueMessage(message, {
      entry: {
        event: "profile_game_projection_queue_invalid_message",
      },
      level: "error",
      logger,
    });
    return;
  }
  const now = dependencies.now || Date.now;
  const taskContext = {
    kind: task.kind,
    ...("eventId" in task ? { eventId: task.eventId } : {}),
    ...("inviteId" in task ? { inviteId: task.inviteId } : {}),
    ...("requestId" in task ? { requestId: task.requestId } : {}),
    ...("operationId" in task ? { operationId: task.operationId } : {}),
  };
  try {
    if (
      task.kind === "event-profile-game-projection" &&
      dependencies.forwardEventTasks
    ) {
      await env.EVENT_PROFILE_GAME_PROJECTION_QUEUE.send(task);
      ackQueueMessage(message, {
        entry: {
          event: "profile_game_projection_queue_processed",
          ...taskContext,
          status: "forwarded",
        },
        level: "info",
        logger,
      });
      return;
    }
    const ownerId = crypto.randomUUID();
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
    let status: string;
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
      if (status === "continued") {
        await env.PROFILE_GAME_PROJECTION_QUEUE.send(task);
      }
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
      if (status === "continued") {
        await env.PROFILE_GAME_PROJECTION_QUEUE.send(task);
      }
    } else if (task.kind === "event-profile-game-projection") {
      status = await processEventProfileGameProjection(
        task,
        state,
        (
          dependencies.createEventRuntime ||
          createEventProfileGameProjectionRuntime
        )(env),
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
    ackQueueMessage(message, {
      entry: {
        event: "profile_game_projection_queue_processed",
        ...taskContext,
        status,
      },
      level: "info",
      logger,
    });
  } catch (error) {
    retryQueueMessage(
      message,
      profileGameProjectionRetryDelaySeconds(message.attempts),
      {
        entry: {
          event: "profile_game_projection_queue_failed",
          ...taskContext,
          status: "retrying",
          ...(error instanceof ProfileGameProjectionLockFailure
            ? { lockScope: error.scope }
            : {}),
          code: error instanceof Error ? error.message : "unknown",
        },
        level: "error",
        logger,
      },
    );
  }
}

async function handleProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  forwardEventTasks: boolean,
): Promise<void> {
  const state = createEventGameplayRepository(env);
  const rating = createRatingRepository(env.PROFILE_DB, state, state);
  const runtime = createProfileGameProjectionRuntime(env, { state });
  const eventRuntime = createEventProfileGameProjectionRuntime(env, { state });
  const locks = createProfileGameProjectionLockStore(env.PROFILE_GAMES_DB);
  for (const message of batch.messages) {
    if (
      !forwardEventTasks &&
      parseProfileGameProjectionTask(message.body)?.kind !==
        "event-profile-game-projection"
    ) {
      ackQueueMessage(message, {
        entry: {
          event: "event_profile_game_projection_queue_invalid_message",
        },
        level: "error",
        logger: console,
      });
      continue;
    }
    await handleProfileGameProjectionMessage(message, env, {
      forwardEventTasks,
      createLocks: () => locks,
      createEventRuntime: () => eventRuntime,
      createRating: () => rating,
      createStateRepository: () => state,
      createRuntime: () => runtime,
    });
  }
}

export async function handleProfileGameProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  await handleProjectionQueue(batch, env, true);
}

export async function handleEventProfileGameProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  await handleProjectionQueue(batch, env, false);
}
