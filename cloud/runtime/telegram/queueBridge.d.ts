// Generated from src/telegram/queueBridge.ts. Run npm run generate:runtime.
import type { ApiRequest } from "../shared/api-contracts.js";
import type { TelegramFetch } from "./client.js";
declare const sendTelegramCommand: (
  command: ApiRequest<"POST /internal/telegram/command">,
  {
    bridgeUrl,
    fetchImpl,
    now,
    secret,
    timeoutMs,
  }?: {
    bridgeUrl?: string;
    fetchImpl?: TelegramFetch;
    now?: () => number;
    secret?: string;
    timeoutMs?: number;
  },
) => Promise<unknown>;
export { sendTelegramCommand };
