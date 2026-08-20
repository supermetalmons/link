"use strict";

const { getEventPrizeDefinitions } = require("@mons/shared/event-prizes");

const EVENT_URL_ROOT = "https://mons.link/event/";
const TELEGRAM_MEDIA_CAPTION_MAX_LENGTH = 1024;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const buildEventPrizeAnnouncement = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("eventId and announcement are required");
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "announcement" ||
    keys[1] !== "eventId"
  ) {
    throw new TypeError(
      "eventId and announcement are the only supported arguments",
    );
  }

  const eventId = normalizeString(input.eventId);
  const announcement = input.announcement;
  if (!eventId || typeof announcement !== "string" || !announcement.trim()) {
    throw new TypeError("eventId and announcement are required");
  }
  if (/[\n\r\v\f\u0085\u2028\u2029]/u.test(announcement)) {
    throw new TypeError("announcement must be a single line");
  }

  const prizes = getEventPrizeDefinitions(eventId);
  if (prizes.length < 2 || prizes.length > 10) {
    throw new TypeError("event must have 2 to 10 configured prizes");
  }

  const eventUrl = `${EVENT_URL_ROOT}${eventId}`;
  const text = `${announcement}\n\n${eventUrl}`;
  if (text.length > TELEGRAM_MEDIA_CAPTION_MAX_LENGTH) {
    throw new TypeError("announcement is too long");
  }

  return {
    eventId,
    eventUrl,
    imageUrls: prizes.map((prize) => prize.imageUrl),
    text,
  };
};

module.exports = {
  EVENT_URL_ROOT,
  TELEGRAM_MEDIA_CAPTION_MAX_LENGTH,
  buildEventPrizeAnnouncement,
};
