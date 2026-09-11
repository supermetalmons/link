const { cropAddress } = require("@mons/shared/profiles");
const { customTelegramEmojis } = require("./telegramEmojiData");

const AUTOMATCH_WAITING_EMOJI_ID = "5355002036817525409";

function resolveTelegramEmojiId(emoji) {
  const parsed = typeof emoji === "string" ? Number(emoji) : emoji;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return "";
  }
  return customTelegramEmojis[parsed] || "";
}

function getTelegramEmojiTag(emojiId) {
  if (!emojiId) {
    return "";
  }
  return `<tg-emoji emoji-id="${emojiId}">&#11088;</tg-emoji>`;
}

function getDisplayNameFromAddress(
  username,
  ethAddress,
  solAddress,
  rating,
  emoji,
  includeEmoji = true,
) {
  const ratingNumber = Number(rating);
  const ratingSuffix =
    Number.isFinite(ratingNumber) && ratingNumber !== 0
      ? ` (${ratingNumber})`
      : "";
  let baseName = "anon";
  if (username && username !== "") {
    baseName = username;
  } else if (ethAddress && ethAddress !== "") {
    baseName = cropAddress(ethAddress);
  } else if (solAddress && solAddress !== "") {
    baseName = cropAddress(solAddress);
  }
  const emojiId = includeEmoji ? resolveTelegramEmojiId(emoji) : "";
  const emojiPrefix = emojiId ? `${getTelegramEmojiTag(emojiId)} ` : "";
  return `${emojiPrefix}${baseName}${ratingSuffix}`;
}

module.exports = {
  AUTOMATCH_WAITING_EMOJI_ID,
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
  resolveTelegramEmojiId,
};
