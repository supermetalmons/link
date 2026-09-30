// Generated from src/telegram/automatchSource.ts. Run npm run generate:runtime.
import type {
  GameSessionChange,
  SessionTimestamp,
  SessionCounter,
} from "../gameSessionChanges.js";
export interface AutomatchTelegramSourceInput {
  inviteId: string;
  timestamp: SessionTimestamp;
}
declare const TELEGRAM_AUTOMATCH_VERSION = 2;
declare const TELEGRAM_AUTOMATCH_ROOT = "telegramAutomatches";
declare const TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT =
  "telegramProjectionOutbox/automatch";
declare const buildAutomatchTelegramProjectionChanges: (input: {
  inviteId: string;
  requestId: string;
  timestamp: SessionTimestamp;
}) => GameSessionChange[];
declare const buildPendingAutomatchTelegramSource: (
  input: AutomatchTelegramSourceInput & {
    waitingText: string;
    canceledText: string;
  },
) => Record<string, unknown>;
declare const buildMatchedAutomatchTelegramChanges: (
  input: AutomatchTelegramSourceInput & {
    matchedText: string;
    generation: SessionCounter;
  },
) => GameSessionChange[];
declare const buildAutomatchTelegramLifecycleChanges: (
  input: AutomatchTelegramSourceInput & {
    lifecycle: "canceled" | "matched";
    generation: SessionCounter;
  },
) => GameSessionChange[];
export {
  TELEGRAM_AUTOMATCH_ROOT,
  TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT,
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionChanges,
  buildAutomatchTelegramLifecycleChanges,
  buildMatchedAutomatchTelegramChanges,
  buildPendingAutomatchTelegramSource,
};
