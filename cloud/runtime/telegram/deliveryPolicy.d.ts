// Generated from src/telegram/deliveryPolicy.ts. Run npm run generate:runtime.
import type {
  TelegramDeliveryErrorState,
  TelegramLocalRetryBarrier,
  TelegramRetryFailure,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
declare const TELEGRAM_SAFE_RETRY_WINDOW_MS: number;
declare const TELEGRAM_SAFE_RETRY_MAX_DELAY_MS = 60000;
declare const createTelegramLocalRetryBarrier: (
  initialRetryNotBeforeMs?: number,
) => TelegramLocalRetryBarrier;
declare const normalizeAttempts: (value: unknown) => number;
declare const normalizeTimestamp: (value: unknown) => number;
declare const normalizeRetrySequence: (value: unknown) => number;
declare const resolveRetryDeadlineAtMs: (value: unknown) => number;
declare const buildSafeRetryState: ({
  current,
  result,
  nowMs,
}: {
  current: unknown;
  result?: TelegramRetryFailure | null;
  nowMs: number;
}) => TelegramRetryState;
declare const buildRateLimitBarrierAtMs: ({
  result,
  retryState,
  nowMs,
}: {
  result?: TelegramRetryFailure | null;
  retryState?: Partial<TelegramRetryState>;
  nowMs: number;
}) => number;
declare const omitRetryState: (value: unknown) => Record<string, unknown>;
declare const buildErrorState: (
  result: TelegramRetryFailure | null | undefined,
  nowMs: number,
) => TelegramDeliveryErrorState;
export {
  TELEGRAM_SAFE_RETRY_MAX_DELAY_MS,
  TELEGRAM_SAFE_RETRY_WINDOW_MS,
  buildErrorState,
  buildRateLimitBarrierAtMs,
  buildSafeRetryState,
  createTelegramLocalRetryBarrier,
  normalizeAttempts,
  normalizeRetrySequence,
  normalizeTimestamp,
  omitRetryState,
  resolveRetryDeadlineAtMs,
};
