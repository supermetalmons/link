// Generated from src/shared/profiles.ts. Run npm run generate:runtime.
import type { MiningMaterialName, MiningSnapshot } from "./mining.js";
export type ProfileLookupKind = "login" | "profile";
export type ProfileLookupRequest = {
  kind: ProfileLookupKind;
  id: string;
};
export type ResolveProfileIdRequest = {
  profileId: string;
};
export type ResolveProfileIdResponse = {
  ok: true;
  profileId: string | null;
};
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
      value: {
        emoji: number;
        aura: "" | "rainbow";
      };
    }
  | {
      field: "cardBackgroundId" | "cardSubtitleId";
      value: number;
    }
  | {
      field: "profileCounter";
      value: "gp" | "mp";
    }
  | {
      field: "profileMons" | "cardStickers";
      value: string;
    }
  | {
      field: "completedProblems";
      value: string[];
    }
  | {
      field: "tutorialCompleted";
      value: boolean;
    };
export type ProfileCustomizationUpdateResponse = {
  ok: true;
};
declare const PROFILE_FALLBACK_EMOJI_COUNT = 155;
declare const LEADERBOARD_READ_TYPES: readonly LeaderboardReadType[];
declare const PROFILE_CUSTOMIZATION_FIELDS: readonly ProfileCustomizationField[];
declare const PROFILE_STICKER_CATALOG: Readonly<
  Record<string, readonly string[]>
>;
declare const isPlayerProfile: (
  value: unknown,
) => value is CompletePlayerProfile;
declare const isProfileLookupRequest: (
  value: unknown,
) => value is ProfileLookupRequest;
declare const isProfileLookupResponse: (
  value: unknown,
) => value is ProfileLookupResponse;
declare const isResolveProfileIdRequest: (
  value: unknown,
) => value is ResolveProfileIdRequest;
declare const isResolveProfileIdResponse: (
  value: unknown,
) => value is ResolveProfileIdResponse;
declare const isLeaderboardReadType: (
  value: unknown,
) => value is LeaderboardReadType;
declare const isLeaderboardReadRequest: (
  value: unknown,
) => value is LeaderboardReadRequest;
declare const isLeaderboardReadResponse: (
  value: unknown,
) => value is LeaderboardReadResponse;
declare const isProfileCustomizationUpdateRequest: (
  value: unknown,
) => value is ProfileCustomizationUpdateRequest;
declare const isProfileCustomizationUpdateResponse: (
  value: unknown,
) => value is ProfileCustomizationUpdateResponse;
declare const getProfileFallbackEmojiId: (profileId: string) => string;
declare const normalizeProfileEmojiId: (
  value: unknown,
  fallback?: number,
) => number;
declare const cropAddress: (address: string) => string;
export {
  LEADERBOARD_READ_TYPES,
  PROFILE_CUSTOMIZATION_FIELDS,
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
