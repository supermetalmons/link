import { getTelegramEmojiTag } from "../telegramDisplay.js";
import { customTelegramEmojis } from "../telegramEmojiData.js";
import {
  readEventDocument,
  type EventParticipantDocument,
} from "../events/documents.js";

const normalizeString = (value: string | null | undefined): string =>
  value?.trim() ?? "";
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const getParticipantRecords = (eventData: unknown) => {
  if (eventData === null || eventData === undefined) return [];
  const event = readEventDocument(eventData);
  if (!event) throw new TypeError("invalid-event-telegram-event");
  return Object.entries(event.participants)
    .map(([profileId, participant]) => ({ profileId, participant }))
    .sort(
      (left, right) =>
        left.participant.joinedAtMs - right.participant.joinedAtMs ||
        left.profileId.localeCompare(right.profileId),
    );
};

const buildParticipantRenderKey = (eventData: unknown) =>
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

const resolveParticipantToken = (
  participant: EventParticipantDocument | null | undefined,
  fallbackDisplayName: string | null = "",
) => {
  const emoji = participant?.emojiId ?? 0;
  const customEmojiId =
    emoji > 0 ? normalizeString(customTelegramEmojis[emoji]) : "";
  const emojiTag = customEmojiId ? getTelegramEmojiTag(customEmojiId) : "";
  const name = escapeHtml(
    normalizeString(participant?.username) ||
      normalizeString(participant?.displayName) ||
      normalizeString(fallbackDisplayName) ||
      "anon",
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
