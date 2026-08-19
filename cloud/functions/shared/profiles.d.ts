import type { MiningMaterialName, MiningSnapshot } from "./mining";

export type ProfileLookupKind = "login" | "profile";

export type ProfileLookupRequest = {
  kind: ProfileLookupKind;
  id: string;
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

export const LEADERBOARD_READ_TYPES: readonly LeaderboardReadType[];
export const PROFILE_FALLBACK_EMOJI_COUNT: 155;

export function cropAddress(address: string): string;
export function getProfileFallbackEmojiId(profileId: string): string;
export function normalizeProfileEmojiId(
  value: unknown,
  fallback?: number,
): number;
export function isPlayerProfile(value: unknown): value is CompletePlayerProfile;
export function isProfileLookupRequest(
  value: unknown,
): value is ProfileLookupRequest;
export function isProfileLookupResponse(
  value: unknown,
): value is ProfileLookupResponse;
export function isLeaderboardReadType(
  value: unknown,
): value is LeaderboardReadType;
export function isLeaderboardReadRequest(
  value: unknown,
): value is LeaderboardReadRequest;
export function isLeaderboardReadResponse(
  value: unknown,
): value is LeaderboardReadResponse;
