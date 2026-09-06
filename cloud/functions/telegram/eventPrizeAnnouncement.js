"use strict";

const { getEventPrizeConfig } = require("@mons/shared/event-prizes");
const { normalizeFirebaseKey } = require("@mons/shared/ids");
const {
  AUTOMATCH_WAITING_EMOJI_ID,
  getTelegramEmojiTag,
} = require("../telegramDisplay");
const { isSundayMonsReminderEvent } = require("./sundayMonsReminder");

const EVENT_URL_ROOT = "https://mons.link/event/";
const EVENT_PRIZE_ANNOUNCEMENT_PREFIX = "sunday mons treats — ";
const EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE = "HTML";
const EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS = 3_600_000;
const EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS = 60_000;
const TELEGRAM_MEDIA_CAPTION_MAX_LENGTH = 1024;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const isValidPrizeConfig = (config) =>
  Boolean(
    config &&
    normalizeString(config.collectionName) &&
    !/[\n\r\v\f\u0085\u2028\u2029]/u.test(config.collectionName) &&
    Array.isArray(config.prizes) &&
    config.prizes.length >= 2 &&
    config.prizes.length <= 10,
  );

const isEventPrizeAnnouncementEvent = (eventId, eventData) =>
  Boolean(
    isSundayMonsReminderEvent(eventId, eventData) &&
    isValidPrizeConfig(getEventPrizeConfig(eventId)),
  );

const buildEventPrizeAnnouncement = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("eventId is required");
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "eventId") {
    throw new TypeError("eventId is the only supported argument");
  }

  const eventId = normalizeFirebaseKey(input.eventId);
  if (!eventId) {
    throw new TypeError("eventId must be a valid event key");
  }

  const config = getEventPrizeConfig(eventId);
  if (!isValidPrizeConfig(config)) {
    throw new TypeError(
      "event must have a collection name and 2 to 10 configured prizes",
    );
  }

  const collectionName = normalizeString(config.collectionName).toLowerCase();
  const eventUrl = `${EVENT_URL_ROOT}${eventId}`;
  const plainText = `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}${collectionName}\n\nstarting in 1 hour\n\n${eventUrl} ⭐`;
  if (plainText.length > TELEGRAM_MEDIA_CAPTION_MAX_LENGTH) {
    throw new TypeError("event prize announcement caption is too long");
  }
  const text = `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}<tg-spoiler>${escapeHtml(collectionName)}</tg-spoiler>\n\nstarting in 1 hour\n\n${eventUrl} ${getTelegramEmojiTag(AUTOMATCH_WAITING_EMOJI_ID)}`;

  return {
    collectionName,
    eventId,
    eventUrl,
    imageUrls: config.prizes.map((prize) => prize.imageUrl),
    parseMode: EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE,
    text,
  };
};

module.exports = {
  EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS,
  EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS,
  EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE,
  EVENT_PRIZE_ANNOUNCEMENT_PREFIX,
  EVENT_URL_ROOT,
  TELEGRAM_MEDIA_CAPTION_MAX_LENGTH,
  buildEventPrizeAnnouncement,
  isEventPrizeAnnouncementEvent,
};
