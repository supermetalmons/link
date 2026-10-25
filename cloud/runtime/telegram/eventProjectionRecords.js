// Generated from src/telegram/eventProjectionRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readEventTelegramProjectionDocument =
  readEventTelegramProjectionDocument;
exports.createEventTelegramProjectionDocument =
  createEventTelegramProjectionDocument;
exports.retainStartedMatchLines = retainStartedMatchLines;
exports.retainEventTelegramEndedResults = retainEventTelegramEndedResults;
exports.copyStartedMatchLines = copyStartedMatchLines;
exports.withEventTelegramProjectionGuard = withEventTelegramProjectionGuard;
exports.eventTelegramProjectionGeneration = eventTelegramProjectionGeneration;
exports.eventTelegramProjectionNeedsResults =
  eventTelegramProjectionNeedsResults;
exports.deferEventTelegramProjectionTexts = deferEventTelegramProjectionTexts;
const objectProperties = (value) =>
  value && typeof value === "object" ? value : {};
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;
function readEventTelegramProjectionDocument(value) {
  return objectProperties(value);
}
function createEventTelegramProjectionDocument(value) {
  const retained = value;
  return retained;
}
function retainStartedMatchLines(value) {
  return objectProperties(value);
}
function retainEventTelegramEndedResults(value) {
  return value;
}
function copyStartedMatchLines(value, keys) {
  const lines = {};
  for (const [key, line] of Object.entries(objectProperties(value))) {
    if (keys.has(key) && typeof line === "string" && line !== "") {
      lines[key] = line;
    }
  }
  return lines;
}
function withEventTelegramProjectionGuard(value, guard) {
  const retained = {
    ...value,
    eventTelegramProjectionGuard: { ...guard },
  };
  return retained;
}
function eventTelegramProjectionGeneration(value) {
  const source = record(value);
  const guard = record(source?.eventTelegramProjectionGuard);
  const generation = guard?.generation;
  return typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation >= 0
    ? generation
    : 0;
}
function eventTelegramProjectionNeedsResults(value) {
  const source = record(value) || {};
  return (
    source.endedAnnouncementArmed === true &&
    (typeof source.endedText !== "string" || source.endedText === "")
  );
}
function deferEventTelegramProjectionTexts(next, previous, fields) {
  const source = record(previous) || {};
  const retained = {
    ...(record(next) || {}),
    ...Object.fromEntries(
      Array.from(fields, (field) => [
        field,
        typeof source[field] === "string" ? source[field] : "",
      ]),
    ),
    lastProjectedSignature: "",
  };
  return retained;
}
