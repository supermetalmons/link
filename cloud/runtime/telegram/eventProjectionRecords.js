// Generated from src/telegram/eventProjectionRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readEventTelegramProjectionDocument =
  readEventTelegramProjectionDocument;
exports.createEventTelegramProjectionDocument =
  createEventTelegramProjectionDocument;
exports.createEmptyEventTelegramProjectionDocument =
  createEmptyEventTelegramProjectionDocument;
exports.retainEventTelegramEndedResults = retainEventTelegramEndedResults;
exports.copyStartedMatchLines = copyStartedMatchLines;
exports.withEventTelegramProjectionGuard = withEventTelegramProjectionGuard;
exports.eventTelegramProjectionGeneration = eventTelegramProjectionGeneration;
exports.eventTelegramProjectionNeedsResults =
  eventTelegramProjectionNeedsResults;
exports.deferEventTelegramProjectionTexts = deferEventTelegramProjectionTexts;
const ids_js_1 = require("../shared/ids.js");
function invalid() {
  throw new TypeError("invalid-event-telegram-projection-state");
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, fields) {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
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
function isEventTelegramProjectionGuard(value) {
  return (
    record(value) &&
    exact(value, ["eventId", "generation", "lockId", "lockRoot", "ownerUid"]) &&
    key(value.eventId) &&
    integer(value.generation) &&
    key(value.lockId) &&
    value.lockRoot === "eventTelegramProjectionLocks" &&
    key(value.ownerUid)
  );
}
function isStartedMatchLines(value) {
  return (
    record(value) &&
    Object.entries(value).every(
      ([name, line]) => key(name) && typeof line === "string" && line !== "",
    )
  );
}
function isEventTelegramEndedResults(value) {
  return (
    record(value) &&
    Object.entries(value).every(
      ([name, entry]) =>
        key(name) &&
        record(entry) &&
        (entry.status === "scored"
          ? exact(entry, ["status", "hostScore", "guestScore"]) &&
            integer(entry.hostScore) &&
            integer(entry.guestScore)
          : exact(entry, ["status"]) &&
            (entry.status === "unavailable" ||
              entry.status === "disqualified")),
    )
  );
}
function isEventTelegramProjectionDocument(value) {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "upcomingText",
      "reminderText",
      "startedText",
      "endedText",
      "endedAnnouncementArmed",
      "startedMatchKeys",
      "startedMatchLinesByKey",
      "lastProjectedSignature",
      "updatedAtMs",
      "eventTelegramProjectionGuard",
    ]) ||
    value.schemaVersion !== 3 ||
    ![
      value.upcomingText,
      value.reminderText,
      value.startedText,
      value.endedText,
    ].every((text) => typeof text === "string") ||
    typeof value.endedAnnouncementArmed !== "boolean" ||
    !Array.isArray(value.startedMatchKeys) ||
    !value.startedMatchKeys.every(key) ||
    new Set(value.startedMatchKeys).size !== value.startedMatchKeys.length ||
    !isStartedMatchLines(value.startedMatchLinesByKey) ||
    typeof value.lastProjectedSignature !== "string" ||
    !(
      value.lastProjectedSignature === "" ||
      /^[a-f0-9]{64}$/.test(value.lastProjectedSignature)
    ) ||
    !integer(value.updatedAtMs) ||
    !(
      value.eventTelegramProjectionGuard === null ||
      isEventTelegramProjectionGuard(value.eventTelegramProjectionGuard)
    )
  )
    return false;
  const keys = new Set(value.startedMatchKeys);
  return Object.keys(value.startedMatchLinesByKey).every((name) =>
    keys.has(name),
  );
}
function readEventTelegramProjectionDocument(value) {
  if (!isEventTelegramProjectionDocument(value)) invalid();
  return structuredClone(value);
}
function createEventTelegramProjectionDocument(value) {
  return readEventTelegramProjectionDocument(value);
}
function createEmptyEventTelegramProjectionDocument(updatedAtMs = 0) {
  return createEventTelegramProjectionDocument({
    schemaVersion: 3,
    upcomingText: "",
    reminderText: "",
    startedText: "",
    endedText: "",
    endedAnnouncementArmed: false,
    startedMatchKeys: [],
    startedMatchLinesByKey: {},
    lastProjectedSignature: "",
    updatedAtMs,
    eventTelegramProjectionGuard: null,
  });
}
function retainEventTelegramEndedResults(value) {
  if (!isEventTelegramEndedResults(value)) invalid();
  return structuredClone(value);
}
function copyStartedMatchLines(value, keys) {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => keys.has(name)),
  );
}
function withEventTelegramProjectionGuard(value, guard) {
  return createEventTelegramProjectionDocument({
    ...value,
    eventTelegramProjectionGuard: {
      ...guard,
      generation: guard.generation ?? 0,
    },
  });
}
function eventTelegramProjectionGeneration(value) {
  return value?.eventTelegramProjectionGuard?.generation ?? 0;
}
function eventTelegramProjectionNeedsResults(value) {
  return (
    value !== null && value.endedAnnouncementArmed && value.endedText === ""
  );
}
function deferEventTelegramProjectionTexts(next, previous, fields) {
  const result = { ...next, lastProjectedSignature: "" };
  for (const field of fields) result[field] = previous?.[field] ?? "";
  return createEventTelegramProjectionDocument(result);
}
