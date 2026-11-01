// Generated from src/eventProgressRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readEventProgressPending = readEventProgressPending;
exports.readEventProgressDeadLetter = readEventProgressDeadLetter;
exports.retainEventProgressRecord = retainEventProgressRecord;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  Array.from(value).every(
    (character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  );
const integer = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function readEventProgressPending(value) {
  const keys = [
    "schemaVersion",
    "dataEpoch",
    "eventId",
    "sourceKey",
    "reason",
    "runAtMs",
    "firstQueuedAtMs",
    "lastQueuedAtMs",
  ];
  if (
    !object(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== 2 ||
    value.dataEpoch !== 1 ||
    !text(value.eventId) ||
    /[.#$/[\]\\]/.test(value.eventId) ||
    !text(value.sourceKey) ||
    !text(value.reason) ||
    !(value.runAtMs === null || integer(value.runAtMs)) ||
    !integer(value.firstQueuedAtMs) ||
    !integer(value.lastQueuedAtMs) ||
    value.lastQueuedAtMs < value.firstQueuedAtMs
  )
    return null;
  return value;
}
function readEventProgressDeadLetter(value) {
  const keys = [
    "schemaVersion",
    "dataEpoch",
    "deadAtMs",
    "sourceDigest",
    "originalRecord",
    "reason",
  ];
  if (
    !object(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== 1 ||
    value.dataEpoch !== 1 ||
    !integer(value.deadAtMs) ||
    typeof value.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
    !(
      value.originalRecord === null ||
      readEventProgressPending(value.originalRecord)
    ) ||
    (value.reason !== "invalid-event-progress-outbox" &&
      value.reason !== "canonical-data-cutover")
  )
    return null;
  return value;
}
function retainEventProgressRecord(kind, value) {
  const result =
    kind === "pending"
      ? readEventProgressPending(value)
      : readEventProgressDeadLetter(value);
  if (!result) throw new TypeError("invalid-canonical-event-progress-record");
  return result;
}
