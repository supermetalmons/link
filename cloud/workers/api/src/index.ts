import { handleRequest } from "./router.ts";
import { handleTelegramBridge } from "./telegramBridge.ts";
import {
  handleTelegramQueue,
  type TelegramTaskPayload,
} from "./telegramQueue.ts";

export { extractIdFromJsonUri } from "./helius.ts";
export type { ProviderFetch } from "./provider.ts";
export { handleRequest };

export function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (new URL(request.url).pathname === "/internal/telegram/delivery") {
    return handleTelegramBridge(request, env);
  }
  return handleRequest(request, env, {}, ctx);
}

export default {
  fetch: handleFetch,
  queue: handleTelegramQueue,
} satisfies ExportedHandler<Env, TelegramTaskPayload>;
