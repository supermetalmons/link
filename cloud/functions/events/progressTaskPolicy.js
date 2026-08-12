"use strict";

const crypto = require("node:crypto");
const {
  isTaskAlreadyExistsError,
  normalizeTaskQueueErrorCode: normalizeErrorCode,
} = require("../taskQueueErrors");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const buildEventProgressTaskId = (eventId, sourceKey) => {
  const normalizedEventId = normalizeString(eventId);
  const normalizedSourceKey = normalizeString(sourceKey);
  const digest = crypto
    .createHash("sha1")
    .update(`${normalizedEventId}:${normalizedSourceKey}`)
    .digest("hex")
    .slice(0, 24);
  return `evp_${normalizedEventId}_${digest}`;
};

const buildEventProgressFallbackSignalId = (eventId) => {
  const normalizedEventId = normalizeString(eventId);
  const digest = crypto
    .createHash("sha1")
    .update(`fallback:${normalizedEventId}`)
    .digest("hex")
    .slice(0, 24);
  return `sig_${digest}`;
};

const stripFunctionsErrorCodePrefix = (code) =>
  code.startsWith("functions/") ? code.slice("functions/".length) : code;

const isTransientEnqueueError = (error) => {
  const normalizedCode = stripFunctionsErrorCodePrefix(
    normalizeErrorCode(error),
  );
  if (
    normalizedCode === "unavailable" ||
    normalizedCode === "deadline-exceeded" ||
    normalizedCode === "deadline_exceeded" ||
    normalizedCode === "resource-exhausted" ||
    normalizedCode === "resource_exhausted" ||
    normalizedCode === "internal" ||
    normalizedCode === "internal-error" ||
    normalizedCode === "aborted" ||
    normalizedCode === "unknown" ||
    normalizedCode === "unknown-error" ||
    normalizedCode === "14" ||
    normalizedCode === "13" ||
    normalizedCode === "10" ||
    normalizedCode === "8" ||
    normalizedCode === "4"
  ) {
    return true;
  }
  const message =
    typeof error?.message === "string" ? error.message.toLowerCase() : "";
  return (
    message.includes("deadline exceeded") ||
    message.includes("temporarily unavailable") ||
    message.includes("connection reset") ||
    message.includes("econnreset")
  );
};

module.exports = {
  buildEventProgressFallbackSignalId,
  buildEventProgressTaskId,
  isTaskAlreadyExistsError,
  isTransientEnqueueError,
  normalizeErrorCode,
  normalizeString,
};
