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
    const status = await recover(task.profileId);
    if (status === "continued") {
      await env.AUTH_RECOVERY_QUEUE.send(task, { delaySeconds: 0 });
    }
    if (status === "done" || status === "continued") {
      ackQueueMessage(message, {
        entry: {
          event: "auth_recovery_queue_processed",
          profileId: task.profileId,
          status,
        },
        level: "info",
        logger,
      });
    } else {
      retryQueueMessage(message, RETRY_DELAY_SECONDS, {
        entry: {
          event: "auth_recovery_queue_retrying",
          profileId: task.profileId,
          status,
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
