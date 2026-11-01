import type { HistoricalMatchPair } from "@mons/shared/game-sessions";
import type { ProfileOwnershipProfile } from "./profileOwnership.ts";
import type { CanonicalProjectionState } from "./profileCanonical/types.ts";

export type RatingProfile = ProfileOwnershipProfile & {
  nonce: number;
  totalManaPoints: number;
};

export type RatingUpdateData = {
  completedAtMs: number | null;
  eventId: string | null;
  eventOwned: boolean;
  eventProgressReason: string | null;
  eventProgressState: CanonicalProjectionState | null;
  eventProgressUpdatedAtMs: number | null;
  eventProgressVersion: number | null;
  historicalMatchArchiveVersion: 1 | null;
  inviteId: string;
  historicalMatchPair: HistoricalMatchPair | null;
  isEventMatch: boolean;
  leaseExpiresAtMs: number;
  matchId: string;
  opponentId: string;
  opponentManaPoints: number | null;
  opponentProfileId: string | null;
  ownerToken: string;
  playerId: string;
  playerManaPoints: number | null;
  playerProfileId: string | null;
  profileGameProjectionReason: string | null;
  profileGameProjectionState: CanonicalProjectionState | null;
  profileGameProjectionUpdatedAtMs: number | null;
  profileGameProjectionVersion: number | null;
  shouldUpdateFebruaryChallenge: boolean;
  startedAtMs: number;
  status: "processing" | "done" | "blocked";
  telegramDeliveryVersion: 2 | null;
  telegramProjectionReason: string | null;
  telegramProjectionState: CanonicalProjectionState | null;
  telegramProjectionUpdatedAtMs: number | null;
  telegramProjectionVersion: number | null;
  updateRatingMessage: string | null;
};

export type RatingLeaseInput = {
  inviteId: string;
  matchId: string;
  opponentId: string;
  ownerToken: string;
  ownerUid: string;
  playerId: string;
  leaseMs: number;
};

export type RatingProfilePatch = {
  rating?: number;
  nonce?: number;
  win?: boolean;
  totalManaPoints?: number;
};

export type RatingCompletionPatch = {
  status: "done";
  completedAtMs: number;
  updatedAtMs: number;
  leaseExpiresAtMs: number;
  inviteId?: string;
  matchId?: string;
  playerId?: string;
  opponentId?: string;
  playerProfileId?: string;
  opponentProfileId?: string;
  historicalMatchArchiveVersion?: 1;
  historicalMatchPair?: HistoricalMatchPair;
  result?: "gg" | "win";
  canUpdateRatings?: boolean;
  didApplyRatingDelta?: boolean;
  winnerDisplayName?: string;
  loserDisplayName?: string;
  winnerNewRating?: number | null;
  loserNewRating?: number | null;
  playerManaPoints?: number;
  opponentManaPoints?: number;
  shouldUpdateFebruaryChallenge?: boolean;
  updateRatingMessage?: string;
  telegramDeliveryVersion?: 2 | null;
  isEventMatch?: boolean;
  eventOwned?: boolean;
  eventId?: string | null;
  profileGameProjectionVersion?: 1;
  profileGameProjectionState?: "pending";
  profileGameProjectionUpdatedAtMs?: number;
  profileGameProjectionReason?: string | null;
  telegramProjectionVersion?: 1;
  telegramProjectionState?: "pending";
  telegramProjectionUpdatedAtMs?: number;
  telegramProjectionReason?: string | null;
  eventProgressVersion?: 1;
  eventProgressState?: "pending";
  eventProgressUpdatedAtMs?: number;
  eventProgressReason?: string | null;
};
