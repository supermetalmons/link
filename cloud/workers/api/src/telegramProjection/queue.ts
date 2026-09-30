import { ackQueueMessage, retryQueueMessage } from "../queueMessage.ts";
import { createEventGameplayRepository } from "../eventRepository.ts";
import { createGameplayRepository } from "../gameplayRepository.ts";
import { createRatingRepository } from "../ratingRepository.ts";
import { parseTelegramProjectionTask } from "../telegramProjectionTasks.ts";
import {
  enqueueInitialTelegramDelivery,
  type InitialTelegramDelivery,
} from "../telegramDeliveryTasks.ts";
import {
  createD1TelegramAnnouncementRepository,
  createD1TelegramRepository,
  readTelegramStorageMode,
} from "../telegramD1.ts";
import { processEventProjectionTask } from "../eventTelegramProjection.ts";
import { projectionRetryDelaySeconds } from "./policy.ts";
import { processAutomatchTask, processRatingTask } from "./processing.ts";
import type { ProjectionDependencies } from "./types.ts";

export async function handleTelegramProjectionMessage(
  message: Message<unknown>,
  env: Env,
  dependencies: ProjectionDependencies = {},
): Promise<void> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const task = parseTelegramProjectionTask(message.body);
  if (!task) {
    ackQueueMessage(message, {
      entry: { event: "telegram_projection_queue_invalid_message" },
      level: "error",
      logger,
    });
    return;
  }
  const createStateRepository =
    dependencies.createStateRepository ||
    ((workerEnv: Env) => createEventGameplayRepository(workerEnv));
  const enqueueDelivery =
    dependencies.enqueueDelivery ||
    ((input: InitialTelegramDelivery) =>
      enqueueInitialTelegramDelivery(env, input));
  try {
    const storageMode = await (
      dependencies.readStorageMode || readTelegramStorageMode
    )(env.TELEGRAM_DB);
    if (storageMode === "frozen") {
      retryQueueMessage(message, 60, {
        entry: { event: "telegram_projection_queue_frozen" },
        level: "info",
        logger,
      });
      return;
    }
    const state = createStateRepository(env);
    const createRating =
      dependencies.createRating ||
      ((workerEnv: Env) =>
        createRatingRepository(
          workerEnv.PROFILE_DB,
          createGameplayRepository(workerEnv),
          state,
        ));
    const telegram = dependencies.createTelegram
      ? dependencies.createTelegram(env)
      : createD1TelegramRepository(env.TELEGRAM_DB, { now });
    let status: string;
    if (task.kind === "automatch-telegram-projection") {
      status = await processAutomatchTask(
        task,
        state,
        enqueueDelivery,
        now,
        telegram,
      );
    } else if (task.kind === "event-telegram-projection") {
      status = await processEventProjectionTask(
        task,
        state,
        createRating(env),
        enqueueDelivery,
        now,
        telegram,
        {
          repository: dependencies.createAnnouncements
            ? dependencies.createAnnouncements(env)
            : createD1TelegramAnnouncementRepository(env.TELEGRAM_DB),
          chatId: env.TELEGRAM_EXTRA_CHAT_ID.trim(),
        },
      );
    } else {
      status = await processRatingTask(
        task,
        state,
        createRating(env),
        enqueueDelivery,
        now,
        telegram,
      );
    }
    ackQueueMessage(message, {
      entry: {
        event: "telegram_projection_queue_processed",
        kind: task.kind,
        status,
      },
      level: "info",
      logger,
    });
  } catch (error) {
    retryQueueMessage(message, projectionRetryDelaySeconds(message.attempts), {
      entry: {
        event: "telegram_projection_queue_failed",
        kind: task.kind,
        code: error instanceof Error ? error.message : "unknown",
      },
      level: "error",
      logger,
    });
  }
}

export async function handleTelegramProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const state = createEventGameplayRepository(env);
  const rating = createRatingRepository(env.PROFILE_DB, state, state);
  for (const message of batch.messages) {
    await handleTelegramProjectionMessage(message, env, {
      createStateRepository: () => state,
      createRating: () => rating,
    });
  }
}
