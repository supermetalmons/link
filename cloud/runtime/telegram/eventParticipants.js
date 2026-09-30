// Generated from src/telegram/eventParticipants.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveParticipantToken =
  exports.renderParticipantLine =
  exports.getParticipantRecords =
  exports.buildParticipantRenderKey =
    void 0;
const values_js_1 = require("./values.js");
const telegramDisplay_js_1 = require("../telegramDisplay.js");
const telegramEmojiData_js_1 = require("../telegramEmojiData.js");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const normalizeNumberOrNull = (value) => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.floor(numeric);
};
const normalizePositiveNumberOrNull = (value) => {
  const numeric = normalizeNumberOrNull(value);
  if (numeric === null || numeric <= 0) {
    return null;
  }
  return numeric;
};
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const getParticipantRecords = (eventData) => {
  const participants =
    eventData &&
    (0, values_js_1.readProperty)(eventData, "participants") &&
    typeof (0, values_js_1.readProperty)(eventData, "participants") === "object"
      ? (0, values_js_1.readProperty)(eventData, "participants")
      : {};
  return Object.entries(participants)
    .filter((entry) => {
      const [profileId, participant] = entry;
      return (
        typeof profileId === "string" &&
        profileId.trim() !== "" &&
        !!participant &&
        typeof participant === "object"
      );
    })
    .map(([profileId, participant]) => ({ profileId, participant }))
    .sort((left, right) => {
      const leftJoined = normalizePositiveNumberOrNull(
        left.participant.joinedAtMs,
      );
      const rightJoined = normalizePositiveNumberOrNull(
        right.participant.joinedAtMs,
      );
      const leftJoinedValue = leftJoined === null ? 0 : leftJoined;
      const rightJoinedValue = rightJoined === null ? 0 : rightJoined;
      if (leftJoinedValue !== rightJoinedValue) {
        return leftJoinedValue - rightJoinedValue;
      }
      return left.profileId.localeCompare(right.profileId);
    });
};
exports.getParticipantRecords = getParticipantRecords;
const buildParticipantRenderKey = (eventData) =>
  getParticipantRecords(eventData)
    .map(({ profileId, participant }) => {
      const emojiId = normalizePositiveNumberOrNull(participant.emojiId);
      const joinedAtMs = normalizePositiveNumberOrNull(participant.joinedAtMs);
      const username = normalizeString(participant.username);
      const displayName = normalizeString(participant.displayName);
      return [
        profileId,
        username,
        displayName,
        emojiId === null ? "" : String(emojiId),
        joinedAtMs === null ? "" : String(joinedAtMs),
      ].join("|");
    })
    .join(";");
exports.buildParticipantRenderKey = buildParticipantRenderKey;
const resolveParticipantName = (participant, fallbackDisplayName = "") => {
  const username = normalizeString(
    participant && (0, values_js_1.readProperty)(participant, "username"),
  );
  if (username) {
    return username;
  }
  const displayName = normalizeString(
    participant && (0, values_js_1.readProperty)(participant, "displayName"),
  );
  if (displayName) {
    return displayName;
  }
  return normalizeString(fallbackDisplayName) || "anon";
};
const resolveParticipantToken = (participant, fallbackDisplayName = "") => {
  const emoji = normalizePositiveNumberOrNull(
    participant && (0, values_js_1.readProperty)(participant, "emojiId"),
  );
  const customEmojiId =
    emoji === null
      ? ""
      : normalizeString(telegramEmojiData_js_1.customTelegramEmojis[emoji]);
  const emojiTag = customEmojiId
    ? (0, telegramDisplay_js_1.getTelegramEmojiTag)(customEmojiId)
    : "";
  const name = escapeHtml(
    resolveParticipantName(participant, fallbackDisplayName),
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
