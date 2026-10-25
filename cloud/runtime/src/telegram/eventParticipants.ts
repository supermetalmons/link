import { readProperty } from "./values.js";
import { getTelegramEmojiTag } from "../telegramDisplay.js";
import { customTelegramEmojis } from "../telegramEmojiData.js";
import {
  readEventParticipantDocument,
  type EventParticipantDocument,
} from "../events/documents.js";

type ParticipantFields = {
  joinedAtMs?: unknown;
  emojiId?: unknown;
  username?: unknown;
  displayName?: unknown;
};
const participantFields = (
  value: EventParticipantDocument,
): ParticipantFields => {
  const retained: unknown = value;
  return retained as ParticipantFields;
};

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizeNumberOrNull = (value: unknown) => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.floor(numeric);
};

const normalizePositiveNumberOrNull = (value: unknown) => {
  const numeric = normalizeNumberOrNull(value);
  if (numeric === null || numeric <= 0) {
    return null;
  }
  return numeric;
};

const escapeHtml = (value: unknown) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const getParticipantRecords = (eventData: unknown) => {
  const participants =
    eventData &&
    readProperty(eventData, "participants") &&
    typeof readProperty(eventData, "participants") === "object"
      ? readProperty(eventData, "participants")
      : {};
  return Object.entries(participants as Record<string, unknown>)
    .filter((entry): entry is [string, Record<string, unknown>] => {
      const [profileId, participant] = entry;
      return (
        typeof profileId === "string" &&
        profileId.trim() !== "" &&
        !!participant &&
        typeof participant === "object"
      );
    })
    .map(([profileId, participant]) => ({
      profileId,
      participant: readEventParticipantDocument(participant)!,
    }))
    .sort((left, right) => {
      const leftJoined = normalizePositiveNumberOrNull(
        participantFields(left.participant).joinedAtMs,
      );
      const rightJoined = normalizePositiveNumberOrNull(
        participantFields(right.participant).joinedAtMs,
      );
      const leftJoinedValue = leftJoined === null ? 0 : leftJoined;
      const rightJoinedValue = rightJoined === null ? 0 : rightJoined;
      if (leftJoinedValue !== rightJoinedValue) {
        return leftJoinedValue - rightJoinedValue;
      }
      return left.profileId.localeCompare(right.profileId);
    });
};

const buildParticipantRenderKey = (eventData: unknown) =>
  getParticipantRecords(eventData)
    .map(({ profileId, participant }) => {
      const emojiId = normalizePositiveNumberOrNull(
        participantFields(participant).emojiId,
      );
      const joinedAtMs = normalizePositiveNumberOrNull(
        participantFields(participant).joinedAtMs,
      );
      const username = normalizeString(participantFields(participant).username);
      const displayName = normalizeString(
        participantFields(participant).displayName,
      );
      return [
        profileId,
        username,
        displayName,
        emojiId === null ? "" : String(emojiId),
        joinedAtMs === null ? "" : String(joinedAtMs),
      ].join("|");
    })
    .join(";");

const resolveParticipantName = (
  participant: unknown,
  fallbackDisplayName: unknown = "",
) => {
  const username = normalizeString(
    participant && readProperty(participant, "username"),
  );
  if (username) {
    return username;
  }
  const displayName = normalizeString(
    participant && readProperty(participant, "displayName"),
  );
  if (displayName) {
    return displayName;
  }
  return normalizeString(fallbackDisplayName) || "anon";
};

const resolveParticipantToken = (
  participant: unknown,
  fallbackDisplayName: unknown = "",
) => {
  const emoji = normalizePositiveNumberOrNull(
    participant && readProperty(participant, "emojiId"),
  );
  const customEmojiId =
    emoji === null ? "" : normalizeString(customTelegramEmojis[emoji]);
  const emojiTag = customEmojiId ? getTelegramEmojiTag(customEmojiId) : "";
  const name = escapeHtml(
    resolveParticipantName(participant, fallbackDisplayName),
  );
  return emojiTag ? `${emojiTag} ${name}` : name;
};

const renderParticipantLine = (eventData: unknown) => {
  const participants = getParticipantRecords(eventData);
  return participants.length >= 2
    ? participants
        .map(({ participant }) => resolveParticipantToken(participant))
        .join(" ")
    : "";
};

export {
  buildParticipantRenderKey,
  getParticipantRecords,
  renderParticipantLine,
  resolveParticipantToken,
};
