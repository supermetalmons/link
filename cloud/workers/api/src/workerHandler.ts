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
  handleTelegramQueue,
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
  return handleRequest(request, env, {}, ctx);
}

async function handleScheduled(
  controller: ScheduledController,
  env: Env,
): Promise<void> {
  const results = await Promise.allSettled([
    handleAuthRecoverySweep(controller, env),
    sweepEventProgress(env),
    handleTelegramProjectionSweep(controller, env),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
}

export default {
  fetch: handleFetch,
  queue(batch, env) {
    if (batch.queue === AUTH_RECOVERY_QUEUE_NAME) {
      return handleAuthRecoveryQueue(batch, env);
    }
    if (batch.queue === TELEGRAM_PROJECTION_QUEUE_NAME) {
      return handleTelegramProjectionQueue(batch, env);
    }
    return handleTelegramQueue(batch, env);
  },
  scheduled: handleScheduled,
} satisfies ExportedHandler<
  Env,
  | AuthRecoveryTask
  | TelegramTaskPayload
  | WagerSettlementRetryTask
  | TelegramProjectionTask
>;
