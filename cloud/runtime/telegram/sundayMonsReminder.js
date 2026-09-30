// Generated from src/telegram/sundayMonsReminder.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSundayMonsReminderEvent =
  exports.isSundayMonsReminderLeadMs =
  exports.getSundayMonsReminderLeadMs =
  exports.buildSundayMonsReminder =
  exports.SUNDAY_MONS_REMINDER_LEAD_MS =
    void 0;
const values_js_1 = require("./values.js");
const ids_1 = require("@mons/shared/ids");
const eventParticipants_js_1 = require("./eventParticipants.js");
const telegramDisplay_js_1 = require("../telegramDisplay.js");
const SUNDAY_MONS_REMINDER_LEAD_MS = 14_400_000;
exports.SUNDAY_MONS_REMINDER_LEAD_MS = SUNDAY_MONS_REMINDER_LEAD_MS;
const isSundayMonsReminderLeadMs = (value) =>
  value === 10_800_000 || value === SUNDAY_MONS_REMINDER_LEAD_MS;
exports.isSundayMonsReminderLeadMs = isSundayMonsReminderLeadMs;
const normalizeEventId = (value) => {
  const eventId = (0, ids_1.normalizeRecordKey)(value);
  if (!eventId) return null;
  try {
    encodeURIComponent(eventId);
    return eventId;
  } catch {
    return null;
  }
};
const isSundayMonsReminderEvent = (eventId, eventData) =>
  Boolean(
    normalizeEventId(eventId) &&
    eventData &&
    (0, values_js_1.isRecord)(eventData) &&
    eventData.status === "scheduled" &&
    eventData.isSundayMons === true &&
    typeof eventData.startAtMs === "number" &&
    Number.isSafeInteger(eventData.startAtMs) &&
    eventData.startAtMs > 0,
  );
exports.isSundayMonsReminderEvent = isSundayMonsReminderEvent;
const buildSundayMonsReminder = (input) => {
  if (!(0, values_js_1.isRecord)(input)) {
    throw new TypeError("eventId is required");
  }
  const keys = Object.keys(input);
  if (
    !Object.hasOwn(input, "eventId") ||
    keys.some(
      (key) => key !== "eventId" && key !== "eventData" && key !== "leadMs",
    )
  ) {
    throw new TypeError(
      "only eventId, eventData and leadMs are supported arguments",
    );
  }
  const eventId = normalizeEventId(input.eventId);
  if (!eventId) {
    throw new TypeError("eventId must be a valid event key");
  }
  const leadMs =
    input.leadMs === undefined ? SUNDAY_MONS_REMINDER_LEAD_MS : input.leadMs;
  if (!isSundayMonsReminderLeadMs(leadMs)) {
    throw new TypeError("leadMs must be a supported reminder lead time");
  }
  const eventUrl = `https://mons.link/event/${encodeURIComponent(eventId)}`;
  const participantLine = (0, eventParticipants_js_1.renderParticipantLine)(
    input.eventData,
  );
  return {
    eventId,
    eventUrl,
    text: `sunday mons in ${leadMs / 3_600_000} hours!\n\n${eventUrl} ${(0, telegramDisplay_js_1.getTelegramEmojiTag)(telegramDisplay_js_1.AUTOMATCH_WAITING_EMOJI_ID)}${participantLine ? `\n\n${participantLine}` : ""}`,
    parseMode: "HTML",
  };
};
exports.buildSundayMonsReminder = buildSundayMonsReminder;
const getSundayMonsReminderLeadMs = (eventId, text) => {
  if (!normalizeEventId(eventId) || typeof text !== "string") return null;
  for (const leadMs of [10_800_000, SUNDAY_MONS_REMINDER_LEAD_MS]) {
    const base = buildSundayMonsReminder({ eventId, leadMs }).text;
    if (text === base || text.startsWith(`${base}\n\n`)) return leadMs;
  }
  return null;
};
exports.getSundayMonsReminderLeadMs = getSundayMonsReminderLeadMs;
