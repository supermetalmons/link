const { MATERIAL_KEYS, isMiningSnapshot } = require("./mining");

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
const LEADERBOARD_READ_TYPES = Object.freeze([
  "rating",
  "mp",
  ...MATERIAL_KEYS,
]);

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
  isMiningSnapshot(value.mining);

const isProfileLookupRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["kind", "id"]) &&
  (value.kind === "login" || value.kind === "profile") &&
  typeof value.id === "string" &&
  value.id.trim() !== "";

const isProfileLookupResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "profile"]) &&
  value.ok === true &&
  (value.profile === null || isPlayerProfile(value.profile));

const isLeaderboardReadType = (value) =>
  typeof value === "string" && LEADERBOARD_READ_TYPES.includes(value);

const isLeaderboardReadRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["type"]) &&
  isLeaderboardReadType(value.type);

const isLeaderboardReadResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "profiles"]) &&
  value.ok === true &&
  Array.isArray(value.profiles) &&
  value.profiles.every(isPlayerProfile);

const getProfileFallbackEmojiId = (profileId) => {
  let hash = 0;
  for (let index = 0; index < profileId.length; index += 1) {
    hash += profileId.charCodeAt(index);
  }
  return `${(hash % PROFILE_FALLBACK_EMOJI_COUNT) + 1}`;
};

const normalizeProfileEmojiId = (value, fallback = 1) => {
  const parsed =
    typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "")
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
};

const cropAddress = (address) =>
  `${address.slice(0, 4)}...${address.slice(-4)}`;

module.exports = {
  LEADERBOARD_READ_TYPES,
  PROFILE_FALLBACK_EMOJI_COUNT,
  getProfileFallbackEmojiId,
  normalizeProfileEmojiId,
  isLeaderboardReadRequest,
  isLeaderboardReadResponse,
  isLeaderboardReadType,
  isPlayerProfile,
  isProfileLookupRequest,
  isProfileLookupResponse,
  cropAddress,
};
