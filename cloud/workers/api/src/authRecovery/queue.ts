import { ackQueueMessage, retryQueueMessage } from "../queueMessage.ts";
import { parseAuthRecoveryTask, RETRY_DELAY_SECONDS } from "./jobs.ts";
import { createAuthRecoveryService } from "./processing.ts";

export async function handleAuthRecoveryMessage(
  message: Message<unknown>,
  env: Env,
  recover = (profileId: string) =>
    createAuthRecoveryService(env).recoverProfile(profileId),
  logger: Pick<Console, "error" | "info"> = console,
): Promise<void> {
  const task = parseAuthRecoveryTask(message.body);
  if (!task) {
    ackQueueMessage(message, {
      entry: { event: "auth_recovery_queue_invalid_message" },
      level: "error",
      logger,
    });
    return;
  }
  try {
    if (await recover(task.profileId)) {
      ackQueueMessage(message, {
        entry: {
          event: "auth_recovery_queue_processed",
          profileId: task.profileId,
        },
        level: "info",
        logger,
      });
    } else {
      retryQueueMessage(message, RETRY_DELAY_SECONDS, {
        entry: {
          event: "auth_recovery_queue_retrying",
          profileId: task.profileId,
        },
        level: "info",
        logger,
      });
    }
  } catch (error) {
    retryQueueMessage(message, RETRY_DELAY_SECONDS, {
      entry: {
        event: "auth_recovery_queue_failed",
        profileId: task.profileId,
        code: error instanceof Error ? error.message : "unknown",
      },
      level: "error",
      logger,
    });
  }
}

export async function handleAuthRecoveryQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await handleAuthRecoveryMessage(message, env);
  }
}
