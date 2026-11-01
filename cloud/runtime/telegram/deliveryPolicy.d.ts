// Generated from src/telegram/deliveryPolicy.ts. Run npm run generate:runtime.
import type {
  TelegramDeliveryErrorState,
  TelegramLocalRetryBarrier,
  TelegramRetryFailure,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
declare const createTelegramLocalRetryBarrier: (
  initialRetryNotBeforeMs?: number,
) => TelegramLocalRetryBarrier;
declare const normalizeAttempts: (value: unknown) => number;
declare const normalizeTimestamp: (value: unknown) => number;
declare const normalizeRetrySequence: (value: unknown) => number;
declare const resolveRetryDeadlineAtMs: (
  state: Partial<TelegramRetryState> & {
    apiGateStartedAtMs?: number;
  },
) => number;
declare const buildSafeRetryState: ({
  current,
  result,
  nowMs,
}: {
  current: Partial<TelegramRetryState> & {
    apiGateStartedAtMs?: number;
  };
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
declare const omitRetryState: <T extends object>(
  value: T,
) => Omit<T, keyof TelegramRetryState>;
declare const buildErrorState: (
  result: TelegramRetryFailure | null | undefined,
  nowMs: number,
) => TelegramDeliveryErrorState;
export {
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
