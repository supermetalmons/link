"use strict";

const { getTelegramEmojiTag } = require("../telegramDisplay");
const { customTelegramEmojis } = require("../telegramEmojiData");

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
    eventData.participants &&
    typeof eventData.participants === "object"
      ? eventData.participants
      : {};
  return Object.entries(participants)
    .filter(
      ([profileId, participant]) =>
        typeof profileId === "string" &&
        profileId.trim() !== "" &&
        participant &&
        typeof participant === "object",
    )
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

const resolveParticipantName = (participant, fallbackDisplayName = "") => {
  const username = normalizeString(participant && participant.username);
  if (username) {
    return username;
  }
  const displayName = normalizeString(participant && participant.displayName);
  if (displayName) {
    return displayName;
  }
  return normalizeString(fallbackDisplayName) || "anon";
};

const resolveParticipantToken = (participant, fallbackDisplayName = "") => {
  const emoji = normalizePositiveNumberOrNull(
    participant && participant.emojiId,
  );
  const customEmojiId =
    emoji === null ? "" : normalizeString(customTelegramEmojis[emoji]);
  const emojiTag = customEmojiId ? getTelegramEmojiTag(customEmojiId) : "";
  const name = escapeHtml(
    resolveParticipantName(participant, fallbackDisplayName),
  );
  return emojiTag ? `${emojiTag} ${name}` : name;
};

const renderParticipantLine = (eventData) => {
  const participants = getParticipantRecords(eventData);
  return participants.length >= 2
    ? participants
        .map(({ participant }) => resolveParticipantToken(participant))
        .join(" ")
    : "";
};

module.exports = {
  buildParticipantRenderKey,
  getParticipantRecords,
  renderParticipantLine,
  resolveParticipantToken,
};
