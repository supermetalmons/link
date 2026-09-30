// Generated from src/telegram/eventPrizeAnnouncement.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEventPrizeAnnouncementEvent =
  exports.buildEventPrizeAnnouncement =
  exports.TELEGRAM_MEDIA_CAPTION_MAX_LENGTH =
  exports.EVENT_URL_ROOT =
  exports.EVENT_PRIZE_ANNOUNCEMENT_PREFIX =
  exports.EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE =
  exports.EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS =
  exports.EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS =
    void 0;
const values_js_1 = require("./values.js");
const event_prizes_1 = require("@mons/shared/event-prizes");
const ids_1 = require("@mons/shared/ids");
const telegramDisplay_js_1 = require("../telegramDisplay.js");
const sundayMonsReminder_js_1 = require("./sundayMonsReminder.js");
const getEventPrizeConfig = event_prizes_1.getEventPrizeConfig;
const EVENT_URL_ROOT = "https://mons.link/event/";
exports.EVENT_URL_ROOT = EVENT_URL_ROOT;
const EVENT_PRIZE_ANNOUNCEMENT_PREFIX = "sunday mons treats — ";
exports.EVENT_PRIZE_ANNOUNCEMENT_PREFIX = EVENT_PRIZE_ANNOUNCEMENT_PREFIX;
const EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE = "HTML";
exports.EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE =
  EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE;
const EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS = 3_600_000;
exports.EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS = EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS;
const EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS = 60_000;
exports.EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS = EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS;
const TELEGRAM_MEDIA_CAPTION_MAX_LENGTH = 1024;
exports.TELEGRAM_MEDIA_CAPTION_MAX_LENGTH = TELEGRAM_MEDIA_CAPTION_MAX_LENGTH;
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
    (0, sundayMonsReminder_js_1.isSundayMonsReminderEvent)(
      eventId,
      eventData,
    ) && isValidPrizeConfig(getEventPrizeConfig(eventId)),
  );
exports.isEventPrizeAnnouncementEvent = isEventPrizeAnnouncementEvent;
const buildEventPrizeAnnouncement = (input) => {
  if (!(0, values_js_1.isRecord)(input)) {
    throw new TypeError("eventId is required");
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "eventId") {
    throw new TypeError("eventId is the only supported argument");
  }
  const eventId = (0, ids_1.normalizeRecordKey)(input.eventId);
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
  const text = `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}<tg-spoiler>${escapeHtml(collectionName)}</tg-spoiler>\n\nstarting in 1 hour\n\n${eventUrl} ${(0, telegramDisplay_js_1.getTelegramEmojiTag)(telegramDisplay_js_1.AUTOMATCH_WAITING_EMOJI_ID)}`;
  return {
    collectionName,
    eventId,
    eventUrl,
    imageUrls: config.prizes.map((prize) => prize.imageUrl),
    parseMode: EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE,
    text,
  };
};
exports.buildEventPrizeAnnouncement = buildEventPrizeAnnouncement;
