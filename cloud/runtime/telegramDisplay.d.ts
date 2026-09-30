// Generated from src/telegramDisplay.ts. Run npm run generate:runtime.
declare const AUTOMATCH_WAITING_EMOJI_ID = "5355002036817525409";
declare function resolveTelegramEmojiId(emoji: unknown): string;
declare function getTelegramEmojiTag(emojiId: unknown): string;
declare function getDisplayNameFromAddress(
  username: unknown,
  ethAddress: unknown,
  solAddress: unknown,
  rating: unknown,
  emoji: unknown,
  includeEmoji?: boolean,
): string;
export {
  AUTOMATCH_WAITING_EMOJI_ID,
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
  resolveTelegramEmojiId,
};
