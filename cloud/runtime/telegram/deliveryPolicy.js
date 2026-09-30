// Generated from src/telegram/deliveryPolicy.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRetryDeadlineAtMs =
  exports.omitRetryState =
  exports.normalizeTimestamp =
  exports.normalizeRetrySequence =
  exports.normalizeAttempts =
  exports.createTelegramLocalRetryBarrier =
  exports.buildSafeRetryState =
  exports.buildRateLimitBarrierAtMs =
  exports.buildErrorState =
  exports.TELEGRAM_SAFE_RETRY_WINDOW_MS =
  exports.TELEGRAM_SAFE_RETRY_MAX_DELAY_MS =
    void 0;
const TELEGRAM_SAFE_RETRY_WINDOW_MS = 10 * 60 * 1000;
exports.TELEGRAM_SAFE_RETRY_WINDOW_MS = TELEGRAM_SAFE_RETRY_WINDOW_MS;
const TELEGRAM_SAFE_RETRY_MAX_DELAY_MS = 60_000;
exports.TELEGRAM_SAFE_RETRY_MAX_DELAY_MS = TELEGRAM_SAFE_RETRY_MAX_DELAY_MS;
const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const omitKeys = (value, keys) => {
  const output = { ...asObject(value) };
  for (const key of keys) {
    delete output[key];
  }
  return output;
};
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const createTelegramLocalRetryBarrier = (initialRetryNotBeforeMs = 0) => {
  let retryNotBeforeMs =
    Number.isFinite(initialRetryNotBeforeMs) && initialRetryNotBeforeMs > 0
      ? Math.floor(initialRetryNotBeforeMs)
      : 0;
  return {
    getRetryNotBeforeMs() {
      return retryNotBeforeMs;
    },
    extendRetryNotBeforeMs(candidateMs) {
      const normalizedCandidate = Number(candidateMs);
      if (!Number.isFinite(normalizedCandidate) || normalizedCandidate <= 0) {
        throw new TypeError("local retryNotBeforeMs must be a positive number");
      }
      retryNotBeforeMs = Math.max(
        retryNotBeforeMs,
        Math.floor(normalizedCandidate),
      );
      return retryNotBeforeMs;
    },
  };
};
exports.createTelegramLocalRetryBarrier = createTelegramLocalRetryBarrier;
const normalizeAttempts = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
exports.normalizeAttempts = normalizeAttempts;
const normalizeTimestamp = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};
exports.normalizeTimestamp = normalizeTimestamp;
const normalizeRetrySequence = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
exports.normalizeRetrySequence = normalizeRetrySequence;
const resolveRetryDeadlineAtMs = (value) => {
  const state = asObject(value);
  const retryDeadlineAtMs = normalizeTimestamp(state.retryDeadlineAtMs);
  if (retryDeadlineAtMs) {
    return retryDeadlineAtMs;
  }
  const apiGateStartedAtMs = normalizeTimestamp(state.apiGateStartedAtMs);
  return apiGateStartedAtMs
    ? apiGateStartedAtMs + TELEGRAM_SAFE_RETRY_WINDOW_MS
    : 0;
};
exports.resolveRetryDeadlineAtMs = resolveRetryDeadlineAtMs;
const buildSafeRetryState = ({ current, result, nowMs }) => {
  const value = asObject(current);
  const retryStartedAtMs =
    normalizeTimestamp(value.retryStartedAtMs) ||
    normalizeTimestamp(value.apiGateStartedAtMs) ||
    nowMs;
  const retryDeadlineAtMs =
    resolveRetryDeadlineAtMs(value) ||
    retryStartedAtMs + TELEGRAM_SAFE_RETRY_WINDOW_MS;
  const retrySequence = normalizeRetrySequence(value.retrySequence) + 1;
  const exponentialDelayMs = Math.min(
    2 ** Math.min(retrySequence - 1, 30) * 1000,
    TELEGRAM_SAFE_RETRY_MAX_DELAY_MS,
  );
  const retryAfterSeconds = Number(result?.retryAfterSeconds);
  const retryAfterMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.ceil(retryAfterSeconds * 1000)
      : 0;
  return {
    retryStartedAtMs,
    retryDeadlineAtMs,
    retryAtMs: Math.min(
      nowMs + Math.max(exponentialDelayMs, retryAfterMs),
      retryDeadlineAtMs,
    ),
    retrySequence,
  };
};
exports.buildSafeRetryState = buildSafeRetryState;
const buildRateLimitBarrierAtMs = ({ result, retryState, nowMs }) => {
  const retryAfterSeconds = Number(result?.retryAfterSeconds);
  const retryAfterMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.ceil(retryAfterSeconds * 1000)
      : 0;
  return Math.max(
    normalizeTimestamp(retryState?.retryAtMs),
    nowMs + retryAfterMs,
  );
};
exports.buildRateLimitBarrierAtMs = buildRateLimitBarrierAtMs;
const omitRetryState = (value) =>
  omitKeys(value, [
    "retryStartedAtMs",
    "retryDeadlineAtMs",
    "retryAtMs",
    "retrySequence",
  ]);
exports.omitRetryState = omitRetryState;
const buildErrorState = (result, nowMs) => {
  const error = {
    code: normalizeString(result?.code) || "telegram-error",
    atMs: nowMs,
  };
  const description = normalizeString(result?.description);
  if (description) {
    error.description = description.slice(0, 500);
  }
  if (
    typeof result?.httpStatus === "number" &&
    Number.isInteger(result.httpStatus)
  ) {
    error.httpStatus = result.httpStatus;
  }
  return error;
};
exports.buildErrorState = buildErrorState;
