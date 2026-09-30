import { cropAddress } from "@mons/shared/profiles";
import { customTelegramEmojis } from "./telegramEmojiData.js";

const AUTOMATCH_WAITING_EMOJI_ID = "5355002036817525409";

function resolveTelegramEmojiId(emoji: unknown): string {
  const parsed = typeof emoji === "string" ? Number(emoji) : emoji;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed <= 0) {
    return "";
  }
  return customTelegramEmojis[parsed] || "";
}

function getTelegramEmojiTag(emojiId: unknown): string {
  if (!emojiId) {
    return "";
  }
  return `<tg-emoji emoji-id="${emojiId}">&#11088;</tg-emoji>`;
}

function getDisplayNameFromAddress(
  username: unknown,
  ethAddress: unknown,
  solAddress: unknown,
  rating: unknown,
  emoji: unknown,
  includeEmoji = true,
) {
  const ratingNumber = Number(rating);
  const ratingSuffix =
    Number.isFinite(ratingNumber) && ratingNumber !== 0
      ? ` (${ratingNumber})`
      : "";
  let baseName: unknown = "anon";
  if (username && username !== "") {
    baseName = username;
  } else if (ethAddress && ethAddress !== "") {
    baseName = cropAddress(ethAddress as string);
  } else if (solAddress && solAddress !== "") {
    baseName = cropAddress(solAddress as string);
  }
  const emojiId = includeEmoji ? resolveTelegramEmojiId(emoji) : "";
  const emojiPrefix = emojiId ? `${getTelegramEmojiTag(emojiId)} ` : "";
  return `${emojiPrefix}${baseName}${ratingSuffix}`;
}

export {
  AUTOMATCH_WAITING_EMOJI_ID,
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
  resolveTelegramEmojiId,
};
