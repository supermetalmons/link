// Generated from src/eventProjectionOutboxRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEventProjectionPending = isEventProjectionPending;
exports.isEventProjectionOutbox = isEventProjectionOutbox;
exports.retainEventProjectionOutbox = retainEventProjectionOutbox;
exports.createEventProfileGameProjectionRequest =
  createEventProfileGameProjectionRequest;
exports.createEventTelegramProjectionRequest =
  createEventTelegramProjectionRequest;
const ids_js_1 = require("./shared/ids.js");
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, required, optional = []) {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}
function key(value) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    (0, ids_js_1.isSafeRecordKey)(value)
  );
}
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isEventProjectionPending(kind, value) {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.status !== "pending" ||
    !key(value.requestId)
  )
    return false;
  if (kind === "profile-game")
    return (
      exact(
        value,
        ["schemaVersion", "status", "requestId", "lastQueuedAtMs"],
        ["cleanupOwnerProfileIds", "reason"],
      ) &&
      integer(value.lastQueuedAtMs) &&
      (!Object.hasOwn(value, "reason") || typeof value.reason === "string") &&
      (!Object.hasOwn(value, "cleanupOwnerProfileIds") ||
        (record(value.cleanupOwnerProfileIds) &&
          Object.entries(value.cleanupOwnerProfileIds).every(
            ([profileId, included]) => key(profileId) && included === true,
          )))
    );
  return (
    exact(value, [
      "schemaVersion",
      "status",
      "requestId",
      "firstQueuedAtMs",
      "updatedAtMs",
    ]) &&
    integer(value.firstQueuedAtMs) &&
    integer(value.updatedAtMs) &&
    value.updatedAtMs >= value.firstQueuedAtMs
  );
}
function isEventProjectionOutbox(kind, value) {
  if (isEventProjectionPending(kind, value)) return true;
  return (
    record(value) &&
    exact(value, [
      "schemaVersion",
      "status",
      "requestId",
      "reason",
      "deadAtMs",
      "sourceDigest",
      "originalRecord",
    ]) &&
    value.schemaVersion === 2 &&
    value.status === "dead" &&
    key(value.requestId) &&
    value.reason === "invalid-record" &&
    integer(value.deadAtMs) &&
    typeof value.sourceDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.sourceDigest) &&
    (value.originalRecord === null ||
      (isEventProjectionPending(kind, value.originalRecord) &&
        value.originalRecord.requestId === value.requestId))
  );
}
function retainEventProjectionOutbox(kind, value) {
  if (!isEventProjectionOutbox(kind, value))
    throw new TypeError("invalid-event-projection-outbox");
  return structuredClone(value);
}
function createEventProfileGameProjectionRequest(value) {
  if (!isEventProjectionPending("profile-game", value))
    throw new TypeError("invalid-event-projection-outbox");
  return structuredClone(value);
}
function createEventTelegramProjectionRequest(value) {
  if (!isEventProjectionPending("telegram", value))
    throw new TypeError("invalid-event-projection-outbox");
  return structuredClone(value);
}
