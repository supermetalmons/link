import { handleRequest } from "./router.ts";
import {
  EVENT_PRIZE_ANNOUNCEMENT_PATH,
  handleEventPrizeAnnouncement,
} from "./eventPrizeAnnouncement.ts";
import { handleTelegramBridge } from "./telegramBridge.ts";
import {
  AUTH_RECOVERY_QUEUE_NAME,
  handleAuthRecoverySweep,
  handleAuthRecoveryQueue,
  type AuthRecoveryTask,
} from "./authRecovery.ts";
import {
  handleTelegramQueueMessage,
  parseWagerSettlementRetryTask,
  type TelegramTaskPayload,
  type WagerSettlementRetryTask,
} from "./telegramQueue.ts";
import {
  handleTelegramProjectionQueue,
  handleTelegramProjectionSweep,
} from "./telegramProjection.ts";
import {
  TELEGRAM_PROJECTION_QUEUE_NAME,
  type TelegramProjectionTask,
} from "./telegramProjectionTasks.ts";
import { sweepEventProgress } from "./eventProgress.ts";
import {
  handleProfileGameProjectionQueue,
  handleProfileGameProjectionSweep,
} from "./profileGameProjection.ts";
import {
  PROFILE_GAME_PROJECTION_QUEUE_NAME,
  type ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import { sweepGameSessionMutationReceipts } from "./gameSessionMutations.ts";
import { sweepExpiredAuthState } from "./authStateD1.ts";
import {
  handleTelegramCommand,
  TELEGRAM_COMMAND_PATH,
} from "./telegramCommand.ts";
import { profileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";

export { extractIdFromJsonUri } from "./helius.ts";
export type { ProviderFetch } from "./provider.ts";
export { handleRequest };

export function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === EVENT_PRIZE_ANNOUNCEMENT_PATH) {
    return handleEventPrizeAnnouncement(request, env);
  }
  if (pathname === "/internal/telegram/delivery") {
    return handleTelegramBridge(request, env);
  }
  if (pathname === TELEGRAM_COMMAND_PATH) {
    return handleTelegramCommand(request, env);
  }
  return handleRequest(request, env, {}, ctx);
}

type ScheduledTasks = {
  authRecovery: () => Promise<unknown>;
  authState: () => Promise<unknown>;
  eventProgress: () => Promise<unknown>;
  gameSessionReceipts: () => Promise<unknown>;
  profileGameProjection: () => Promise<unknown>;
  telegramProjection: () => Promise<unknown>;
};

const PROFILE_WRITES_QUEUE_RETRY_DELAY_SECONDS = 5 * 60;

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  overrides: Partial<ScheduledTasks> = {},
): Promise<void> {
  const profileWritesEnabled = profileBackgroundMutationsEnabled(env);
  const tasks: ScheduledTasks = {
    authRecovery: () => handleAuthRecoverySweep(controller, env),
    authState: () =>
      sweepExpiredAuthState(env.AUTH_STATE_DB, controller.scheduledTime),
    eventProgress: () => sweepEventProgress(env),
    gameSessionReceipts: () =>
      sweepGameSessionMutationReceipts(env, {
        now: () => controller.scheduledTime,
      }),
    profileGameProjection: () =>
      handleProfileGameProjectionSweep(controller, env),
    telegramProjection: () => handleTelegramProjectionSweep(controller, env),
    ...overrides,
  };
  const runProfileTask = async (task: () => Promise<unknown>) => {
    if (await profileWritesEnabled) {
      await task();
    }
  };
  const results = await Promise.allSettled([
    runProfileTask(tasks.authRecovery),
    runProfileTask(tasks.eventProgress),
    runProfileTask(tasks.profileGameProjection),
    runProfileTask(tasks.telegramProjection),
    tasks.gameSessionReceipts(),
    tasks.authState(),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
}

function retryQueueMessages(batch: MessageBatch<unknown>): void {
  for (const message of batch.messages) {
    message.retry({
      delaySeconds: PROFILE_WRITES_QUEUE_RETRY_DELAY_SECONDS,
    });
  }
}

async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  if (
    batch.queue === AUTH_RECOVERY_QUEUE_NAME ||
    batch.queue === PROFILE_GAME_PROJECTION_QUEUE_NAME ||
    batch.queue === TELEGRAM_PROJECTION_QUEUE_NAME
  ) {
    if (!(await profileBackgroundMutationsEnabled(env))) {
      retryQueueMessages(batch);
      return;
    }
  }
  if (batch.queue === AUTH_RECOVERY_QUEUE_NAME) {
    return handleAuthRecoveryQueue(batch, env);
  }
  if (batch.queue === TELEGRAM_PROJECTION_QUEUE_NAME) {
    return handleTelegramProjectionQueue(batch, env);
  }
  if (batch.queue === PROFILE_GAME_PROJECTION_QUEUE_NAME) {
    return handleProfileGameProjectionQueue(batch, env);
  }
  let profileBackgroundEnabled: Promise<boolean> | null = null;
  for (const message of batch.messages) {
    if (parseWagerSettlementRetryTask(message.body)) {
      profileBackgroundEnabled ||= profileBackgroundMutationsEnabled(env);
      if (!(await profileBackgroundEnabled)) {
        message.retry({
          delaySeconds: PROFILE_WRITES_QUEUE_RETRY_DELAY_SECONDS,
        });
        continue;
      }
    }
    await handleTelegramQueueMessage(message, env);
  }
}

export default {
  fetch: handleFetch,
  queue: handleQueue,
  scheduled(controller, env) {
    return handleScheduled(controller, env);
  },
} satisfies ExportedHandler<
  Env,
  | AuthRecoveryTask
  | ProfileGameProjectionTask
  | TelegramTaskPayload
  | WagerSettlementRetryTask
  | TelegramProjectionTask
>;
