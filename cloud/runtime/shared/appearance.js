// Generated from src/shared/appearance.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStickerMap =
  exports.isStickerSlot =
  exports.isSelectedMons =
  exports.isCardSubtitleId =
  exports.isCardBackgroundId =
  exports.isProfileCounter =
  exports.isEmojiAppearance =
  exports.isAura =
  exports.isEmojiId =
  exports.PROFILE_STICKER_CATALOG =
  exports.MON_SELECTION_CATALOG =
  exports.CARD_SUBTITLE_IDS =
  exports.CARD_BACKGROUND_IDS =
  exports.INVENTORY_EMOJI_END =
  exports.INVENTORY_EMOJI_START =
  exports.PROFILE_FALLBACK_EMOJI_COUNT =
    void 0;
exports.isMonSelectionIndex = isMonSelectionIndex;
exports.isStickerName = isStickerName;
exports.withStickerSelection = withStickerSelection;
exports.withMonSelection = withMonSelection;
exports.createDefaultProfileAppearance = createDefaultProfileAppearance;
exports.getProfileFallbackEmojiId = getProfileFallbackEmojiId;
exports.PROFILE_FALLBACK_EMOJI_COUNT = 155;
exports.INVENTORY_EMOJI_START = 1000;
exports.INVENTORY_EMOJI_END = 1466;
exports.CARD_BACKGROUND_IDS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 100,
];
exports.CARD_SUBTITLE_IDS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 27, 28, 29,
];
exports.MON_SELECTION_CATALOG = {
  demon: ["borgalo", "notchur"],
  angel: ["applecreme", "gerp", "goxfold", "mowch", "mummyfly"],
  drainer: [
    "deino",
    "greenseech",
    "omom",
    "supermetaldrop",
    "zwubbi",
    "royal_aguapwoshi",
  ],
  spirit: ["melmut", "omenstatue", "owg"],
  mystic: ["chamgot", "dart", "estalibur"],
};
exports.PROFILE_STICKER_CATALOG = {
  "big-mon-top-right": [
    "applecreme",
    "armored-gummoskullj",
    "crystal-cloud-gabber",
    "crystal-gummy-deino",
    "gate",
    "crystal-owg",
    "estalibur",
    "gerp",
    "gummy-deino",
    "hatchat",
    "king-snowbie",
    "lord-idgecreist",
    "melmut",
    "omen-statue",
    "omom-2",
    "omom-3",
    "omom-4",
    "omom",
    "speklmic",
    "super-mana-piece-3",
    "zemred",
  ],
  "bottom-left": ["heart", "rock"],
  "bottom-right": ["cursor", "star"],
  mana: ["blue-mana", "metal-mana"],
  "middle-left": ["super-mana-piece-2", "super-mana-piece"],
  "middle-right": ["glitter-rock", "metal-mana-pog", "swag-coin"],
  "mini-logo": ["bomb", "mana", "potion", "super-mana"],
  "type-logo": ["angel", "demon", "drainer", "mystic", "spirit"],
};
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isEmojiId = (value) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  ((value >= 0 && value <= exports.PROFILE_FALLBACK_EMOJI_COUNT) ||
    (value >= exports.INVENTORY_EMOJI_START &&
      value <= exports.INVENTORY_EMOJI_END));
exports.isEmojiId = isEmojiId;
const isAura = (value) => value === "none" || value === "rainbow";
exports.isAura = isAura;
const isEmojiAppearance = (value) =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  (0, exports.isEmojiId)(value.emoji) &&
  (0, exports.isAura)(value.aura);
exports.isEmojiAppearance = isEmojiAppearance;
const isProfileCounter = (value) => value === "gp" || value === "mp";
exports.isProfileCounter = isProfileCounter;
const isCardBackgroundId = (value) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  ((value >= 0 && value < 37) || value === 100);
exports.isCardBackgroundId = isCardBackgroundId;
const isCardSubtitleId = (value) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value < 30;
exports.isCardSubtitleId = isCardSubtitleId;
function isMonSelectionIndex(kind, value) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < exports.MON_SELECTION_CATALOG[kind].length
  );
}
const isSelectedMons = (value) =>
  isRecord(value) &&
  Object.keys(value).length === 5 &&
  isMonSelectionIndex("demon", value.demon) &&
  isMonSelectionIndex("angel", value.angel) &&
  isMonSelectionIndex("drainer", value.drainer) &&
  isMonSelectionIndex("spirit", value.spirit) &&
  isMonSelectionIndex("mystic", value.mystic);
exports.isSelectedMons = isSelectedMons;
const isStickerSlot = (value) =>
  typeof value === "string" &&
  Object.hasOwn(exports.PROFILE_STICKER_CATALOG, value);
exports.isStickerSlot = isStickerSlot;
function isStickerName(slot, value) {
  const names = exports.PROFILE_STICKER_CATALOG[slot];
  return typeof value === "string" && names.includes(value);
}
const isStickerMap = (value) =>
  isRecord(value) &&
  Object.entries(value).every(
    ([slot, name]) =>
      (0, exports.isStickerSlot)(slot) && isStickerName(slot, name),
  );
exports.isStickerMap = isStickerMap;
function withStickerSelection(current, slot, name) {
  if (name !== undefined && !isStickerName(slot, name))
    throw new Error("invalid-sticker-selection");
  const next = { ...current };
  if (name === undefined) delete next[slot];
  else next[slot] = name;
  return next;
}
function withMonSelection(current, kind, index) {
  if (!isMonSelectionIndex(kind, index))
    throw new Error("invalid-mon-selection");
  return { ...current, [kind]: index };
}
function createDefaultProfileAppearance(emoji = 1) {
  if (!(0, exports.isEmojiId)(emoji)) throw new Error("invalid-profile-emoji");
  return {
    emoji,
    aura: "none",
    cardBackgroundId: 30,
    cardSubtitleId: 0,
    profileCounter: "gp",
    profileMons: null,
    cardStickers: {},
  };
}
function getProfileFallbackEmojiId(profileId) {
  let hash = 0;
  for (let index = 0; index < profileId.length; index++) {
    hash += profileId.charCodeAt(index);
  }
  return (hash % exports.PROFILE_FALLBACK_EMOJI_COUNT) + 1;
}
