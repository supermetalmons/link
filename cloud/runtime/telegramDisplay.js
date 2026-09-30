// Generated from src/telegramDisplay.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUTOMATCH_WAITING_EMOJI_ID = void 0;
exports.getDisplayNameFromAddress = getDisplayNameFromAddress;
exports.getTelegramEmojiTag = getTelegramEmojiTag;
exports.resolveTelegramEmojiId = resolveTelegramEmojiId;
const profiles_1 = require("@mons/shared/profiles");
const telegramEmojiData_js_1 = require("./telegramEmojiData.js");
const AUTOMATCH_WAITING_EMOJI_ID = "5355002036817525409";
exports.AUTOMATCH_WAITING_EMOJI_ID = AUTOMATCH_WAITING_EMOJI_ID;
function resolveTelegramEmojiId(emoji) {
  const parsed = typeof emoji === "string" ? Number(emoji) : emoji;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed <= 0) {
    return "";
  }
  return telegramEmojiData_js_1.customTelegramEmojis[parsed] || "";
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
    baseName = (0, profiles_1.cropAddress)(ethAddress);
  } else if (solAddress && solAddress !== "") {
    baseName = (0, profiles_1.cropAddress)(solAddress);
  }
  const emojiId = includeEmoji ? resolveTelegramEmojiId(emoji) : "";
  const emojiPrefix = emojiId ? `${getTelegramEmojiTag(emojiId)} ` : "";
  return `${emojiPrefix}${baseName}${ratingSuffix}`;
}
