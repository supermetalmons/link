import { queueFor } from "../queueProducers.ts";
import { ackQueueMessage, retryQueueMessage } from "../queueMessage.ts";
import { parseProfileGameProjectionTask } from "../profileGameProjectionTasks.ts";
import { ProfileGameProjectionLockFailure } from "../profileGameProjectionLocksD1.ts";
import { profileGameProjectionRetryDelaySeconds } from "./policy.ts";
import type { ProfileGameProjectionQueueDependencies } from "./types.ts";
import {
  createProfileGameProjectionBatchDependencies,
  createEventProfileGameProjectionBatchDependencies,
  runProfileGameProjectionTask,
} from "./taskRunner.ts";

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
      await queueFor(env, "EVENT_PROFILE_GAME_PROJECTION_QUEUE").send(task);
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
    const status = await runProfileGameProjectionTask(
      task,
      env,
      dependencies,
      now,
      logger,
    );
    if (status === "continued") {
      await queueFor(env, "PROFILE_GAME_PROJECTION_QUEUE").send(task);
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

export async function handleProfileGameProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const dependencies = createProfileGameProjectionBatchDependencies(env);
  for (const message of batch.messages) {
    await handleProfileGameProjectionMessage(message, env, dependencies);
  }
}

export async function handleEventProfileGameProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const dependencies = createEventProfileGameProjectionBatchDependencies(env);
  for (const message of batch.messages) {
    if (
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
    await handleProfileGameProjectionMessage(message, env, dependencies);
  }
}
