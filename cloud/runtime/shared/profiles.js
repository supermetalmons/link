// Generated from src/shared/profiles.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cropAddress =
  exports.isResolveProfileIdResponse =
  exports.isResolveProfileIdRequest =
  exports.isProfileLookupResponse =
  exports.isProfileLookupRequest =
  exports.isProfileCustomizationUpdateResponse =
  exports.isProfileCustomizationUpdateRequest =
  exports.isPlayerProfile =
  exports.isLeaderboardReadType =
  exports.isLeaderboardReadResponse =
  exports.isLeaderboardReadRequest =
  exports.getProfileFallbackEmojiId =
  exports.PROFILE_FALLBACK_EMOJI_COUNT =
  exports.PROFILE_STICKER_CATALOG =
  exports.LEADERBOARD_READ_TYPES =
    void 0;
const appearance_js_1 = require("./appearance.js");
Object.defineProperty(exports, "PROFILE_FALLBACK_EMOJI_COUNT", {
  enumerable: true,
  get: function () {
    return appearance_js_1.PROFILE_FALLBACK_EMOJI_COUNT;
  },
});
Object.defineProperty(exports, "PROFILE_STICKER_CATALOG", {
  enumerable: true,
  get: function () {
    return appearance_js_1.PROFILE_STICKER_CATALOG;
  },
});
Object.defineProperty(exports, "getProfileFallbackEmojiId", {
  enumerable: true,
  get: function () {
    return appearance_js_1.getProfileFallbackEmojiId;
  },
});
const mining_js_1 = require("./mining.js");
const PROFILE_KEYS = Object.freeze([
  "id",
  "nonce",
  "rating",
  "totalManaPoints",
  "win",
  "emoji",
  "aura",
  "cardBackgroundId",
  "cardSubtitleId",
  "profileCounter",
  "profileMons",
  "cardStickers",
  "username",
  "eth",
  "sol",
  "feb2026UniqueOpponentsCount",
  "completedProblemIds",
  "isTutorialCompleted",
  "mining",
]);
const REQUIRED_PROFILE_KEYS = Object.freeze([
  "id",
  "nonce",
  "rating",
  "totalManaPoints",
  "win",
  "emoji",
  "aura",
  "cardBackgroundId",
  "cardSubtitleId",
  "profileCounter",
  "profileMons",
  "cardStickers",
  "username",
  "eth",
  "sol",
  "mining",
]);
const LEADERBOARD_READ_TYPES = Object.freeze([
  "rating",
  "mp",
  ...mining_js_1.MATERIAL_KEYS,
]);
exports.LEADERBOARD_READ_TYPES = LEADERBOARD_READ_TYPES;
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, expectedKeys) => {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
};
const hasOnlyKeys = (value, allowedKeys) =>
  Object.keys(value).every((key) => allowedKeys.includes(key));
const isOptionalFiniteNumber = (value) =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));
const isNullableString = (value) => value === null || typeof value === "string";
const isPlayerProfile = (value) =>
  isRecord(value) &&
  hasOnlyKeys(value, PROFILE_KEYS) &&
  REQUIRED_PROFILE_KEYS.every((key) => Object.hasOwn(value, key)) &&
  typeof value.id === "string" &&
  value.id !== "" &&
  typeof value.nonce === "number" &&
  Number.isFinite(value.nonce) &&
  typeof value.rating === "number" &&
  Number.isFinite(value.rating) &&
  typeof value.totalManaPoints === "number" &&
  Number.isFinite(value.totalManaPoints) &&
  typeof value.win === "boolean" &&
  (0, appearance_js_1.isEmojiId)(value.emoji) &&
  (0, appearance_js_1.isAura)(value.aura) &&
  (0, appearance_js_1.isCardBackgroundId)(value.cardBackgroundId) &&
  (0, appearance_js_1.isCardSubtitleId)(value.cardSubtitleId) &&
  (0, appearance_js_1.isProfileCounter)(value.profileCounter) &&
  (value.profileMons === null ||
    (0, appearance_js_1.isSelectedMons)(value.profileMons)) &&
  (0, appearance_js_1.isStickerMap)(value.cardStickers) &&
  isNullableString(value.username) &&
  isNullableString(value.eth) &&
  isNullableString(value.sol) &&
  isOptionalFiniteNumber(value.feb2026UniqueOpponentsCount) &&
  (value.completedProblemIds === undefined ||
    (Array.isArray(value.completedProblemIds) &&
      value.completedProblemIds.every((item) => typeof item === "string"))) &&
  (value.isTutorialCompleted === undefined ||
    typeof value.isTutorialCompleted === "boolean") &&
  (0, mining_js_1.isMiningSnapshot)(value.mining);
exports.isPlayerProfile = isPlayerProfile;
const isProfileLookupRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["kind", "id"]) &&
  (value.kind === "login" || value.kind === "profile") &&
  typeof value.id === "string" &&
  value.id.trim() !== "";
exports.isProfileLookupRequest = isProfileLookupRequest;
const isProfileLookupResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "profile"]) &&
  value.ok === true &&
  (value.profile === null || isPlayerProfile(value.profile));
exports.isProfileLookupResponse = isProfileLookupResponse;
const isResolveProfileIdRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["profileId"]) &&
  typeof value.profileId === "string" &&
  value.profileId.trim() !== "";
exports.isResolveProfileIdRequest = isResolveProfileIdRequest;
const isResolveProfileIdResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "profileId"]) &&
  value.ok === true &&
  (value.profileId === null ||
    (typeof value.profileId === "string" && value.profileId.trim() !== ""));
exports.isResolveProfileIdResponse = isResolveProfileIdResponse;
const isLeaderboardReadType = (value) =>
  typeof value === "string" && LEADERBOARD_READ_TYPES.includes(value);
exports.isLeaderboardReadType = isLeaderboardReadType;
const isLeaderboardReadRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["type"]) &&
  isLeaderboardReadType(value.type);
exports.isLeaderboardReadRequest = isLeaderboardReadRequest;
const isLeaderboardReadResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "profiles"]) &&
  value.ok === true &&
  Array.isArray(value.profiles) &&
  value.profiles.every(isPlayerProfile);
exports.isLeaderboardReadResponse = isLeaderboardReadResponse;
const isProfileCustomizationUpdateRequest = (value) => {
  if (!isRecord(value) || !hasExactKeys(value, ["field", "value"])) {
    return false;
  }
  switch (value.field) {
    case "emojiAndAura":
      return (
        (0, appearance_js_1.isEmojiAppearance)(value.value) &&
        (value.value.aura === "none" ||
          value.value.emoji >= appearance_js_1.INVENTORY_EMOJI_START)
      );
    case "cardBackgroundId":
      return (0, appearance_js_1.isCardBackgroundId)(value.value);
    case "cardSubtitleId":
      return (0, appearance_js_1.isCardSubtitleId)(value.value);
    case "profileCounter":
      return (0, appearance_js_1.isProfileCounter)(value.value);
    case "profileMons":
      return (
        value.value === null || (0, appearance_js_1.isSelectedMons)(value.value)
      );
    case "cardStickers":
      return (0, appearance_js_1.isStickerMap)(value.value);
    case "completedProblems":
      return (
        Array.isArray(value.value) &&
        value.value.length <= 256 &&
        value.value.every(
          (item) => typeof item === "string" && item.length <= 128,
        )
      );
    case "tutorialCompleted":
      return typeof value.value === "boolean";
    default:
      return false;
  }
};
exports.isProfileCustomizationUpdateRequest =
  isProfileCustomizationUpdateRequest;
const isProfileCustomizationUpdateResponse = (value) =>
  isRecord(value) && hasExactKeys(value, ["ok"]) && value.ok === true;
exports.isProfileCustomizationUpdateResponse =
  isProfileCustomizationUpdateResponse;
const cropAddress = (address) =>
  `${address.slice(0, 4)}...${address.slice(-4)}`;
exports.cropAddress = cropAddress;
