export const TELEGRAM_AUTOMATCH_ROOT: "telegramAutomatches";
export const TELEGRAM_AUTOMATCH_VERSION: 2;

export interface AutomatchTelegramSourceInput {
  inviteId: string;
  timestamp: unknown;
}

export function getAutomatchTelegramSourcePath(inviteId: string): string;
export function buildPendingAutomatchTelegramSource(
  input: AutomatchTelegramSourceInput & {
    waitingText: string;
    canceledText: string;
  },
): Record<string, unknown>;
export function buildMatchedAutomatchTelegramUpdates(
  input: AutomatchTelegramSourceInput & {
    matchedText: string;
    generation: unknown;
  },
): Record<string, unknown>;
export function buildAutomatchTelegramLifecycleUpdates(
  input: AutomatchTelegramSourceInput & {
    lifecycle: "canceled" | "matched";
    generation: unknown;
  },
): Record<string, unknown>;
