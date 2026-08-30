"use strict";

const { getEventPrizeDefinitions } = require("@mons/shared/event-prizes");

const EVENT_URL_ROOT = "https://mons.link/event/";
const EVENT_PRIZE_ANNOUNCEMENT_PREFIX = "sunday mons treats — ";
const EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE = "HTML";
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

const buildEventPrizeAnnouncement = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("eventId and collectionName are required");
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "collectionName" ||
    keys[1] !== "eventId"
  ) {
    throw new TypeError(
      "eventId and collectionName are the only supported arguments",
    );
  }

  const eventId = normalizeString(input.eventId);
  const collectionName = normalizeString(input.collectionName);
  if (!eventId || !collectionName) {
    throw new TypeError("eventId and collectionName are required");
  }
  if (/[\n\r\v\f\u0085\u2028\u2029]/u.test(collectionName)) {
    throw new TypeError("collectionName must be a single line");
  }

  const prizes = getEventPrizeDefinitions(eventId);
  if (prizes.length < 2 || prizes.length > 10) {
    throw new TypeError("event must have 2 to 10 configured prizes");
  }

  const eventUrl = `${EVENT_URL_ROOT}${eventId}`;
  const plainText = `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}${collectionName}\n\n${eventUrl}`;
  if (plainText.length > TELEGRAM_MEDIA_CAPTION_MAX_LENGTH) {
    throw new TypeError("collectionName is too long");
  }
  const text = `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}<tg-spoiler>${escapeHtml(collectionName)}</tg-spoiler>\n\n${eventUrl}`;

  return {
    collectionName,
    eventId,
    eventUrl,
    imageUrls: prizes.map((prize) => prize.imageUrl),
    parseMode: EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE,
    text,
  };
};

module.exports = {
  EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE,
  EVENT_PRIZE_ANNOUNCEMENT_PREFIX,
  EVENT_URL_ROOT,
  TELEGRAM_MEDIA_CAPTION_MAX_LENGTH,
  buildEventPrizeAnnouncement,
};
