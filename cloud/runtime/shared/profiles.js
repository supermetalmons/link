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
  exports.normalizeProfileEmojiId =
  exports.getProfileFallbackEmojiId =
  exports.PROFILE_FALLBACK_EMOJI_COUNT =
  exports.PROFILE_STICKER_CATALOG =
  exports.LEADERBOARD_READ_TYPES =
    void 0;
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
  "username",
  "eth",
  "sol",
  "mining",
]);
const PROFILE_FALLBACK_EMOJI_COUNT = 155;
exports.PROFILE_FALLBACK_EMOJI_COUNT = PROFILE_FALLBACK_EMOJI_COUNT;
const LEADERBOARD_READ_TYPES = Object.freeze([
  "rating",
  "mp",
  ...mining_js_1.MATERIAL_KEYS,
]);
exports.LEADERBOARD_READ_TYPES = LEADERBOARD_READ_TYPES;
const PROFILE_STICKER_CATALOG = Object.freeze({
  "big-mon-top-right": Object.freeze([
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
  ]),
  "bottom-left": Object.freeze(["heart", "rock"]),
  "bottom-right": Object.freeze(["cursor", "star"]),
  mana: Object.freeze(["blue-mana", "metal-mana"]),
  "middle-left": Object.freeze(["super-mana-piece-2", "super-mana-piece"]),
  "middle-right": Object.freeze([
    "glitter-rock",
    "metal-mana-pog",
    "swag-coin",
  ]),
  "mini-logo": Object.freeze(["bomb", "mana", "potion", "super-mana"]),
  "type-logo": Object.freeze(["angel", "demon", "drainer", "mystic", "spirit"]),
});
exports.PROFILE_STICKER_CATALOG = PROFILE_STICKER_CATALOG;
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
const isOptionalString = (value) =>
  value === undefined || typeof value === "string";
const isOptionalNullableString = (value) =>
  value === undefined || value === null || typeof value === "string";
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
  ((typeof value.emoji === "number" && Number.isFinite(value.emoji)) ||
    (typeof value.emoji === "string" && value.emoji !== "")) &&
  isOptionalString(value.aura) &&
  isOptionalFiniteNumber(value.cardBackgroundId) &&
  isOptionalFiniteNumber(value.cardSubtitleId) &&
  isOptionalString(value.profileCounter) &&
  isOptionalString(value.profileMons) &&
  isOptionalString(value.cardStickers) &&
  isOptionalNullableString(value.username) &&
  isOptionalNullableString(value.eth) &&
  isOptionalNullableString(value.sol) &&
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
        isRecord(value.value) &&
        hasExactKeys(value.value, ["emoji", "aura"]) &&
        Number.isSafeInteger(value.value.emoji) &&
        ((value.value.emoji >= 0 &&
          value.value.emoji <= 155 &&
          value.value.aura === "") ||
          (value.value.emoji >= 1000 &&
            value.value.emoji <= 1466 &&
            (value.value.aura === "" || value.value.aura === "rainbow")))
      );
    case "cardBackgroundId":
      return (
        Number.isSafeInteger(value.value) &&
        ((value.value >= 0 && value.value < 37) || value.value === 100)
      );
    case "cardSubtitleId":
      return (
        Number.isSafeInteger(value.value) &&
        value.value >= 0 &&
        value.value < 30
      );
    case "profileCounter":
      return value.value === "gp" || value.value === "mp";
    case "profileMons":
      return (
        value.value === "" ||
        (typeof value.value === "string" &&
          /^(?:0|1),(?:0|1|2|3|4),(?:0|1|2|3|4|5),(?:0|1|2),(?:0|1|2)$/.test(
            value.value,
          ))
      );
    case "cardStickers": {
      if (value.value === "") {
        return true;
      }
      if (typeof value.value !== "string") {
        return false;
      }
      let stickers;
      try {
        stickers = JSON.parse(value.value);
      } catch {
        return false;
      }
      return (
        isRecord(stickers) &&
        Object.keys(stickers).length <=
          Object.keys(PROFILE_STICKER_CATALOG).length &&
        Object.entries(stickers).every(
          ([field, name]) =>
            Object.hasOwn(PROFILE_STICKER_CATALOG, field) &&
            typeof name === "string" &&
            PROFILE_STICKER_CATALOG[field].includes(name),
        )
      );
    }
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
const getProfileFallbackEmojiId = (profileId) => {
  let hash = 0;
  for (let index = 0; index < profileId.length; index += 1) {
    hash += profileId.charCodeAt(index);
  }
  return `${(hash % PROFILE_FALLBACK_EMOJI_COUNT) + 1}`;
};
exports.getProfileFallbackEmojiId = getProfileFallbackEmojiId;
const normalizeProfileEmojiId = (value, fallback = 1) => {
  const parsed =
    typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "")
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
};
exports.normalizeProfileEmojiId = normalizeProfileEmojiId;
const cropAddress = (address) =>
  `${address.slice(0, 4)}...${address.slice(-4)}`;
exports.cropAddress = cropAddress;
