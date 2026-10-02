import type { MiningMaterialName, MiningSnapshot } from "./mining.js";
import { MATERIAL_KEYS, isMiningSnapshot } from "./mining.js";

export type ProfileLookupKind = "login" | "profile";

export type ProfileLookupRequest = {
  kind: ProfileLookupKind;
  id: string;
};

export type ResolveProfileIdRequest = { profileId: string };

export type ResolveProfileIdResponse = { ok: true; profileId: string | null };

export type LeaderboardReadType = "rating" | "mp" | MiningMaterialName;

export interface PlayerProfile {
  id: string;
  nonce?: number;
  rating?: number;
  totalManaPoints?: number;
  win?: boolean;
  emoji: number | string;
  aura?: string;
  cardBackgroundId?: number;
  cardSubtitleId?: number;
  profileCounter?: string;
  profileMons?: string;
  cardStickers?: string;
  username: string | null;
  eth: string | null;
  sol: string | null;
  feb2026UniqueOpponentsCount?: number;
  completedProblemIds?: string[];
  isTutorialCompleted?: boolean;
  mining?: MiningSnapshot;
}

export interface CompletePlayerProfile extends PlayerProfile {
  nonce: number;
  rating: number;
  totalManaPoints: number;
  win: boolean;
  mining: MiningSnapshot;
}

export interface ProfileLookupResponse {
  ok: true;
  profile: CompletePlayerProfile | null;
}

export interface LeaderboardReadRequest {
  type: LeaderboardReadType;
}

export interface LeaderboardReadResponse {
  ok: true;
  profiles: CompletePlayerProfile[];
}

export type ProfileCustomizationField =
  | "emojiAndAura"
  | "cardBackgroundId"
  | "cardSubtitleId"
  | "profileCounter"
  | "profileMons"
  | "cardStickers"
  | "completedProblems"
  | "tutorialCompleted";

export type ProfileCustomizationUpdateRequest =
  | {
      field: "emojiAndAura";
      value: { emoji: number; aura: "" | "rainbow" };
    }
  | {
      field: "cardBackgroundId" | "cardSubtitleId";
      value: number;
    }
  | { field: "profileCounter"; value: "gp" | "mp" }
  | { field: "profileMons" | "cardStickers"; value: string }
  | { field: "completedProblems"; value: string[] }
  | { field: "tutorialCompleted"; value: boolean };

export type ProfileCustomizationUpdateResponse = { ok: true };

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
const LEADERBOARD_READ_TYPES: readonly LeaderboardReadType[] = Object.freeze([
  "rating",
  "mp",
  ...MATERIAL_KEYS,
]);
const PROFILE_STICKER_CATALOG: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
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
    "type-logo": Object.freeze([
      "angel",
      "demon",
      "drainer",
      "mystic",
      "spirit",
    ]),
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: object,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
};

const hasOnlyKeys = (value: object, allowedKeys: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowedKeys.includes(key));

const isOptionalFiniteNumber = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const isOptionalNullableString = (
  value: unknown,
): value is string | null | undefined =>
  value === undefined || value === null || typeof value === "string";

const isPlayerProfile = (value: unknown): value is CompletePlayerProfile =>
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

const isProfileLookupRequest = (
  value: unknown,
): value is ProfileLookupRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["kind", "id"]) &&
  (value.kind === "login" || value.kind === "profile") &&
  typeof value.id === "string" &&
  value.id.trim() !== "";

const isProfileLookupResponse = (
  value: unknown,
): value is ProfileLookupResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "profile"]) &&
  value.ok === true &&
  (value.profile === null || isPlayerProfile(value.profile));

const isResolveProfileIdRequest = (
  value: unknown,
): value is ResolveProfileIdRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["profileId"]) &&
  typeof value.profileId === "string" &&
  value.profileId.trim() !== "";

const isResolveProfileIdResponse = (
  value: unknown,
): value is ResolveProfileIdResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "profileId"]) &&
  value.ok === true &&
  (value.profileId === null ||
    (typeof value.profileId === "string" && value.profileId.trim() !== ""));

const isLeaderboardReadType = (value: unknown): value is LeaderboardReadType =>
  typeof value === "string" &&
  (LEADERBOARD_READ_TYPES as readonly unknown[]).includes(value);

const isLeaderboardReadRequest = (
  value: unknown,
): value is LeaderboardReadRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["type"]) &&
  isLeaderboardReadType(value.type);

const isLeaderboardReadResponse = (
  value: unknown,
): value is LeaderboardReadResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "profiles"]) &&
  value.ok === true &&
  Array.isArray(value.profiles) &&
  value.profiles.every(isPlayerProfile);

const isProfileCustomizationUpdateRequest = (
  value: unknown,
): value is ProfileCustomizationUpdateRequest => {
  if (!isRecord(value) || !hasExactKeys(value, ["field", "value"])) {
    return false;
  }
  switch (value.field) {
    case "emojiAndAura":
      return (
        isRecord(value.value) &&
        hasExactKeys(value.value, ["emoji", "aura"]) &&
        Number.isSafeInteger(value.value.emoji) &&
        (((value.value.emoji as number) >= 0 &&
          (value.value.emoji as number) <= 155 &&
          value.value.aura === "") ||
          ((value.value.emoji as number) >= 1000 &&
            (value.value.emoji as number) <= 1466 &&
            (value.value.aura === "" || value.value.aura === "rainbow")))
      );
    case "cardBackgroundId":
      return (
        Number.isSafeInteger(value.value) &&
        (((value.value as number) >= 0 && (value.value as number) < 37) ||
          value.value === 100)
      );
    case "cardSubtitleId":
      return (
        Number.isSafeInteger(value.value) &&
        (value.value as number) >= 0 &&
        (value.value as number) < 30
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

const isProfileCustomizationUpdateResponse = (
  value: unknown,
): value is ProfileCustomizationUpdateResponse =>
  isRecord(value) && hasExactKeys(value, ["ok"]) && value.ok === true;

const getProfileFallbackEmojiId = (profileId: string): string => {
  let hash = 0;
  for (let index = 0; index < profileId.length; index += 1) {
    hash += profileId.charCodeAt(index);
  }
  return `${(hash % PROFILE_FALLBACK_EMOJI_COUNT) + 1}`;
};

const normalizeProfileEmojiId = (
  value: unknown,
  fallback: number = 1,
): number => {
  const parsed =
    typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "")
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
};

const cropAddress = (address: string): string =>
  `${address.slice(0, 4)}...${address.slice(-4)}`;

export {
  LEADERBOARD_READ_TYPES,
  PROFILE_STICKER_CATALOG,
  PROFILE_FALLBACK_EMOJI_COUNT,
  getProfileFallbackEmojiId,
  normalizeProfileEmojiId,
  isLeaderboardReadRequest,
  isLeaderboardReadResponse,
  isLeaderboardReadType,
  isPlayerProfile,
  isProfileCustomizationUpdateRequest,
  isProfileCustomizationUpdateResponse,
  isProfileLookupRequest,
  isProfileLookupResponse,
  isResolveProfileIdRequest,
  isResolveProfileIdResponse,
  cropAddress,
};
