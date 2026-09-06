"use strict";

const { normalizeFirebaseKey } = require("@mons/shared/ids");
const { renderParticipantLine } = require("./eventParticipants");
const {
  AUTOMATCH_WAITING_EMOJI_ID,
  getTelegramEmojiTag,
} = require("../telegramDisplay");

const SUNDAY_MONS_REMINDER_LEAD_MS = 10_800_000;

const normalizeEventId = (value) => {
  const eventId = normalizeFirebaseKey(value);
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
    keys.some((key) => key !== "eventId" && key !== "eventData")
  ) {
    throw new TypeError("only eventId and eventData are supported arguments");
  }
  const eventId = normalizeEventId(input.eventId);
  if (!eventId) {
    throw new TypeError("eventId must be a valid event key");
  }
  const eventUrl = `https://mons.link/event/${encodeURIComponent(eventId)}`;
  const participantLine = renderParticipantLine(input.eventData);
  return {
    eventId,
    eventUrl,
    text: `sunday mons in 3 hours!\n\n${eventUrl} ${getTelegramEmojiTag(AUTOMATCH_WAITING_EMOJI_ID)}${participantLine ? `\n\n${participantLine}` : ""}`,
    parseMode: "HTML",
  };
};

module.exports = {
  SUNDAY_MONS_REMINDER_LEAD_MS,
  buildSundayMonsReminder,
  isSundayMonsReminderEvent,
};
