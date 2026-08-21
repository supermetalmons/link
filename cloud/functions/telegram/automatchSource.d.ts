export const TELEGRAM_AUTOMATCH_ROOT: "telegramAutomatches";
export const TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT: "telegramProjectionOutbox/automatch";
export const TELEGRAM_AUTOMATCH_VERSION: 2;

export interface AutomatchTelegramSourceInput {
  inviteId: string;
  timestamp: unknown;
}

export function getAutomatchTelegramSourcePath(inviteId: string): string;
export function getAutomatchTelegramProjectionOutboxPath(
  inviteId: string,
): string;
export function buildAutomatchTelegramProjectionOutboxUpdates(input: {
  inviteId: string;
  requestId: string;
  timestamp: unknown;
}): Record<string, unknown>;
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
