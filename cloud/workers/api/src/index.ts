import { handleRequest } from "./router.ts";
import {
  EVENT_PRIZE_ANNOUNCEMENT_PATH,
  handleEventPrizeAnnouncement,
} from "./eventPrizeAnnouncement.ts";
import { handleTelegramBridge } from "./telegramBridge.ts";
import {
  handleTelegramQueue,
  type TelegramTaskPayload,
  type WagerSettlementRetryTask,
} from "./telegramQueue.ts";

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

export default {
  fetch: handleFetch,
  queue: handleTelegramQueue,
} satisfies ExportedHandler<
  Env,
  TelegramTaskPayload | WagerSettlementRetryTask
>;
