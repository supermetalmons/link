"use strict";

const TELEGRAM_SAFE_RETRY_WINDOW_MS = 10 * 60 * 1000;
const TELEGRAM_SAFE_RETRY_MAX_DELAY_MS = 60_000;

/** @param {unknown} value @returns {Record<string, unknown>} */
const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};

/** @param {unknown} value @param {string[]} keys */
const omitKeys = (value, keys) => {
  const output = { ...asObject(value) };
  for (const key of keys) {
    delete output[key];
  }
  return output;
};

/** @param {unknown} value */
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

/** @param {number} [initialRetryNotBeforeMs] @returns {import("./deliveryRetryTypes").TelegramLocalRetryBarrier} */
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

/** @param {unknown} value */
const normalizeAttempts = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;

/** @param {unknown} value */
const normalizeTimestamp = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

/** @param {unknown} value */
const normalizeRetrySequence = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;

/** @param {unknown} value */
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

/** @param {{current: unknown, result?: import("./deliveryRetryTypes").TelegramRetryFailure | null, nowMs: number}} input @returns {import("./deliveryRetryTypes").TelegramRetryState} */
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

/** @param {{result?: import("./deliveryRetryTypes").TelegramRetryFailure | null, retryState?: Partial<import("./deliveryRetryTypes").TelegramRetryState>, nowMs: number}} input */
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

/** @param {unknown} value */
const omitRetryState = (value) =>
  omitKeys(value, [
    "retryStartedAtMs",
    "retryDeadlineAtMs",
    "retryAtMs",
    "retrySequence",
  ]);

/** @param {import("./deliveryRetryTypes").TelegramRetryFailure | null | undefined} result @param {number} nowMs */
const buildErrorState = (result, nowMs) => {
  /** @type {import("./deliveryRetryTypes").TelegramDeliveryErrorState} */
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

module.exports = {
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
