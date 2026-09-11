"use strict";

const { normalizeRecordKey } = require("@mons/shared/ids");
const { renderParticipantLine } = require("./eventParticipants");
const {
  AUTOMATCH_WAITING_EMOJI_ID,
  getTelegramEmojiTag,
} = require("../telegramDisplay");

const SUNDAY_MONS_REMINDER_LEAD_MS = 14_400_000;

const isSundayMonsReminderLeadMs = (value) =>
  value === 10_800_000 || value === SUNDAY_MONS_REMINDER_LEAD_MS;

const normalizeEventId = (value) => {
  const eventId = normalizeRecordKey(value);
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
    typeof eventData === "object" &&
    !Array.isArray(eventData) &&
    eventData.status === "scheduled" &&
    eventData.isSundayMons === true &&
    Number.isSafeInteger(eventData.startAtMs) &&
    eventData.startAtMs > 0,
  );

const buildSundayMonsReminder = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
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
  const participantLine = renderParticipantLine(input.eventData);
  return {
    eventId,
    eventUrl,
    text: `sunday mons in ${leadMs / 3_600_000} hours!\n\n${eventUrl} ${getTelegramEmojiTag(AUTOMATCH_WAITING_EMOJI_ID)}${participantLine ? `\n\n${participantLine}` : ""}`,
    parseMode: "HTML",
  };
};

const getSundayMonsReminderLeadMs = (eventId, text) => {
  if (!normalizeEventId(eventId) || typeof text !== "string") return null;
  for (const leadMs of [10_800_000, SUNDAY_MONS_REMINDER_LEAD_MS]) {
    const base = buildSundayMonsReminder({ eventId, leadMs }).text;
    if (text === base || text.startsWith(`${base}\n\n`)) return leadMs;
  }
  return null;
};

module.exports = {
  SUNDAY_MONS_REMINDER_LEAD_MS,
  buildSundayMonsReminder,
  getSundayMonsReminderLeadMs,
  isSundayMonsReminderLeadMs,
  isSundayMonsReminderEvent,
};
