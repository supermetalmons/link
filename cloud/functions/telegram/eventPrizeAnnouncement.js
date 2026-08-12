"use strict";

const { defineSecret } = require("firebase-functions/params");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { getEventPrizeDefinitions } = require("@mons/shared/event-prizes");
const { isMonsLinkAdmin } = require("@mons/shared/events");
const { sendTelegramMediaGroup, telegramBotToken } = require("./client");
const { getProfileByLoginId } = require("../profileSummaryLookup");

const EVENT_URL_ROOT = "https://mons.link/event/";
const TELEGRAM_MEDIA_CAPTION_MAX_LENGTH = 1024;
const telegramCommunityChatId = defineSecret("TELEGRAM_EXTRA_CHAT_ID");

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

const handleAnnounceEventPrizes = async (request, dependencies = {}) => {
  const uid = normalizeString(request?.auth?.uid);
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }

  const readProfile = dependencies.getProfileByLoginId || getProfileByLoginId;
  const profile = await readProfile(uid);
  const username = normalizeString(profile?.username).toLowerCase();
  if (!isMonsLinkAdmin(username)) {
    throw new HttpsError(
      "permission-denied",
      "Only mons.link admins can announce event prizes.",
    );
  }

  let announcement;
  try {
    announcement = buildEventPrizeAnnouncement(request?.data);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new HttpsError("invalid-argument", error.message);
    }
    throw error;
  }

  const hasInjectedChatId = Object.prototype.hasOwnProperty.call(
    dependencies,
    "chatId",
  );
  const chatId = normalizeString(
    hasInjectedChatId ? dependencies.chatId : telegramCommunityChatId.value(),
  );
  if (!chatId) {
    throw new HttpsError(
      "failed-precondition",
      "Telegram community chat is not configured.",
    );
  }

  const send = dependencies.sendTelegramMediaGroup || sendTelegramMediaGroup;
  const logger = dependencies.logger || console;
  const result = await send({
    chatId,
    imageUrls: announcement.imageUrls,
    text: announcement.text,
    silent: false,
  });
  if (!result?.ok) {
    logger.error("Event prize Telegram announcement failed", {
      eventId: announcement.eventId,
      classification: result?.classification || "unknown",
      code: result?.code || "unknown",
      description: result?.description || "",
    });
    if (result?.classification === "uncertain") {
      throw new HttpsError(
        "aborted",
        "Telegram may have accepted this announcement. Check the group before retrying.",
      );
    }
    if (result?.classification === "retryable") {
      throw new HttpsError(
        "unavailable",
        "Telegram is temporarily unavailable. Please try again.",
      );
    }
    throw new HttpsError(
      "failed-precondition",
      "Telegram rejected the announcement.",
    );
  }

  return {
    ok: true,
    eventId: announcement.eventId,
    eventUrl: announcement.eventUrl,
    messageIds: result.messageIds,
  };
};

const announceEventPrizes = onCall(
  {
    secrets: [telegramBotToken, telegramCommunityChatId],
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 1,
    concurrency: 1,
  },
  handleAnnounceEventPrizes,
);

module.exports = {
  EVENT_URL_ROOT,
  TELEGRAM_MEDIA_CAPTION_MAX_LENGTH,
  announceEventPrizes,
  buildEventPrizeAnnouncement,
  handleAnnounceEventPrizes,
  telegramCommunityChatId,
};
