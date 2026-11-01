// Generated from src/shared/profiles.ts. Run npm run generate:runtime.
import {
  PROFILE_FALLBACK_EMOJI_COUNT,
  PROFILE_STICKER_CATALOG,
  getProfileFallbackEmojiId,
  type ProfileAppearance,
  type CardBackgroundId,
  type CardSubtitleId,
  type ProfileCounter,
  type SelectedMons,
  type StickerMap,
} from "./appearance.js";
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
export interface PlayerProfile extends ProfileAppearance {
  id: string;
  nonce?: number;
  rating?: number;
  totalManaPoints?: number;
  win?: boolean;
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
      value: Pick<ProfileAppearance, "emoji" | "aura">;
    }
  | {
      field: "cardBackgroundId";
      value: CardBackgroundId;
    }
  | {
      field: "cardSubtitleId";
      value: CardSubtitleId;
    }
  | {
      field: "profileCounter";
      value: ProfileCounter;
    }
  | {
      field: "profileMons";
      value: SelectedMons | null;
    }
  | {
      field: "cardStickers";
      value: StickerMap;
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
declare const LEADERBOARD_READ_TYPES: readonly LeaderboardReadType[];
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
declare const cropAddress: (address: string) => string;
export {
  LEADERBOARD_READ_TYPES,
  PROFILE_STICKER_CATALOG,
  PROFILE_FALLBACK_EMOJI_COUNT,
  getProfileFallbackEmojiId,
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
