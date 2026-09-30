// Generated from src/telegram/queueBridge.ts. Run npm run generate:runtime.
import type { TelegramFetch } from "./client.js";
declare const TELEGRAM_COMMAND_BRIDGE_URL =
  "https://api.mons.link/internal/telegram/command";
declare const TELEGRAM_BRIDGE_TIMEOUT_MS = 5000;
declare const signTelegramBridgeRequest: ({
  body,
  secret,
  timestamp,
}: {
  body: string;
  secret: string;
  timestamp: string;
}) => string;
declare const sendTelegramCommand: (
  command: unknown,
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
export {
  TELEGRAM_BRIDGE_TIMEOUT_MS,
  TELEGRAM_COMMAND_BRIDGE_URL,
  sendTelegramCommand,
  signTelegramBridgeRequest,
};
