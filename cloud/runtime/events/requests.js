// Generated from src/events/requests.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventRequestId = eventRequestId;
exports.eventRequestMatchKey = eventRequestMatchKey;
exports.eventRequestPostponeMinutes = eventRequestPostponeMinutes;
exports.eventRequestStartsInMinutes = eventRequestStartsInMinutes;
exports.eventCreateOptions = eventCreateOptions;
const events_js_1 = require("../shared/events.js");
function fields(value) {
  return value && typeof value === "object" ? value : {};
}
const trimmed = (value) => (typeof value === "string" ? value.trim() : "");
function integer(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : 0;
}
function eventRequestId(value) {
  return trimmed(fields(value).eventId);
}
function eventRequestMatchKey(value) {
  return trimmed(fields(value).matchKey);
}
function eventRequestPostponeMinutes(value) {
  return integer(fields(value).postponeByMinutes);
}
function eventRequestStartsInMinutes(value) {
  return integer(fields(value).startsInMinutes);
}
function eventCreateOptions(value) {
  const data = fields(value);
  return {
    validSundayMons:
      !Object.hasOwn(data, "isSundayMons") ||
      typeof data.isSundayMons === "boolean",
    isSundayMons: data.isSundayMons === true,
    telegramAnnouncements: (0, events_js_1.resolveEventTelegramAnnouncements)(
      data,
    ),
  };
}
