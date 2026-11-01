// Generated from src/telegram/eventParticipants.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveParticipantToken =
  exports.renderParticipantLine =
  exports.getParticipantRecords =
  exports.buildParticipantRenderKey =
    void 0;
const telegramDisplay_js_1 = require("../telegramDisplay.js");
const telegramEmojiData_js_1 = require("../telegramEmojiData.js");
const documents_js_1 = require("../events/documents.js");
const normalizeString = (value) => value?.trim() ?? "";
const escapeHtml = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const getParticipantRecords = (eventData) => {
  if (eventData === null || eventData === undefined) return [];
  const event = (0, documents_js_1.readEventDocument)(eventData);
  if (!event) throw new TypeError("invalid-event-telegram-event");
  return Object.entries(event.participants)
    .map(([profileId, participant]) => ({ profileId, participant }))
    .sort(
      (left, right) =>
        left.participant.joinedAtMs - right.participant.joinedAtMs ||
        left.profileId.localeCompare(right.profileId),
    );
};
exports.getParticipantRecords = getParticipantRecords;
const buildParticipantRenderKey = (eventData) =>
  getParticipantRecords(eventData)
    .map(({ profileId, participant }) =>
      [
        profileId,
        normalizeString(participant.username),
        normalizeString(participant.displayName),
        participant.emojiId > 0 ? String(participant.emojiId) : "",
        participant.joinedAtMs > 0 ? String(participant.joinedAtMs) : "",
      ].join("|"),
    )
    .join(";");
exports.buildParticipantRenderKey = buildParticipantRenderKey;
const resolveParticipantToken = (participant, fallbackDisplayName = "") => {
  const emoji = participant?.emojiId ?? 0;
  const customEmojiId =
    emoji > 0
      ? normalizeString(telegramEmojiData_js_1.customTelegramEmojis[emoji])
      : "";
  const emojiTag = customEmojiId
    ? (0, telegramDisplay_js_1.getTelegramEmojiTag)(customEmojiId)
    : "";
  const name = escapeHtml(
    normalizeString(participant?.username) ||
      normalizeString(participant?.displayName) ||
      normalizeString(fallbackDisplayName) ||
      "anon",
  );
  return emojiTag ? `${emojiTag} ${name}` : name;
};
exports.resolveParticipantToken = resolveParticipantToken;
const renderParticipantLine = (eventData) => {
  const participants = getParticipantRecords(eventData);
  return participants.length >= 2
    ? participants
        .map(({ participant }) => resolveParticipantToken(participant))
        .join(" ")
    : "";
};
exports.renderParticipantLine = renderParticipantLine;
