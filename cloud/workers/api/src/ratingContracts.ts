import type { HistoricalMatchPair } from "@mons/shared/game-sessions";
import type { EventProgressOutboxRecord } from "../../../runtime/events.js";
import type { GameSessionPort } from "./gameSessionContracts.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import type {
  ProfileOwnershipProfile,
  ProfileOwnershipReader,
} from "./profileOwnership.ts";

export type RatingProfile = ProfileOwnershipProfile & {
  nonce: number;
  totalManaPoints: number;
};

export type RatingUpdateData = {
  completedAtMs?: number;
  eventId?: string;
  eventOwned?: boolean;
  eventProgressReason?: string;
  eventProgressState?: string;
  eventProgressUpdatedAtMs?: number;
  eventProgressVersion?: number;
  historicalMatchArchiveVersion?: number;
  inviteId: string;
  historicalMatchPair?: HistoricalMatchPair;
  isEventMatch?: boolean;
  leaseExpiresAtMs: number;
  matchId: string;
  opponentId: string;
  opponentManaPoints?: number;
  opponentProfileId: string;
  ownerToken: string;
  playerId: string;
  playerManaPoints?: number;
  playerProfileId: string;
  profileGameProjectionReason?: string;
  profileGameProjectionState?: string;
  profileGameProjectionUpdatedAtMs?: number;
  profileGameProjectionVersion?: number;
  shouldUpdateFebruaryChallenge: boolean;
  startedAtMs: number;
  status: string;
  telegramDeliveryVersion?: number | null;
  telegramProjectionReason?: string;
  telegramProjectionState?: string;
  telegramProjectionUpdatedAtMs?: number;
  telegramProjectionVersion?: number;
  updateRatingMessage?: string;
};

export type PendingRatingTelegramProjection = {
  operationId: string;
  updateTime: string;
};

export type PendingRatingProfileGameProjection = {
  inviteId: string;
  matchId: string;
  operationId: string;
  updateTime: string;
  version: number;
};

export type PendingRatingEventProgress = {
  eventId: string;
  inviteId: string;
  matchId: string;
  operationId: string;
  updateTime: string;
  version: number;
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

export type RatingLeaseResult = {
  data: RatingUpdateData | null;
  status: "acquired" | "busy" | "done";
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
  historicalMatchArchiveVersion?: number;
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
  telegramDeliveryVersion?: number | null;
  isEventMatch?: boolean;
  eventOwned?: boolean;
  eventId?: string | null;
  profileGameProjectionVersion?: number;
  profileGameProjectionState?: "pending";
  profileGameProjectionUpdatedAtMs?: number;
  profileGameProjectionReason?: string | null;
  telegramProjectionVersion?: number;
  telegramProjectionState?: "pending";
  telegramProjectionUpdatedAtMs?: number;
  telegramProjectionReason?: string | null;
  eventProgressVersion?: number;
  eventProgressState?: "pending";
  eventProgressUpdatedAtMs?: number;
  eventProgressReason?: string | null;
};

export type RatingCommitPlan = {
  opponentUpdate: RatingProfilePatch | null;
  playerUpdate: RatingProfilePatch | null;
  repairData: RatingRepairData;
  ratingUpdate: RatingCompletionPatch;
};

export type RatingRepairData = Pick<
  RatingUpdateData,
  "opponentProfileId" | "playerProfileId" | "shouldUpdateFebruaryChallenge"
>;

export type RatingFinalizeInput = {
  inviteId: string;
  matchId: string;
  opponentId: string;
  operationId: string;
  ownerToken: string;
  playerId: string;
};

export type RatingFinalizeResult =
  | { data: RatingUpdateData; status: "replayed" }
  | { data: RatingRepairData; status: "committed" }
  | { status: "lost" };

export type RatingGameplayReader = Pick<GameSessionPort, "readInviteMetadata"> &
  Pick<MatchStatePort, "readMatchRecord" | "readMatchPair"> &
  ProfileOwnershipReader;

export type RatingRepository = RatingGameplayReader & {
  putEventProgressOutbox(
    outboxId: string,
    record: EventProgressOutboxRecord,
  ): Promise<void>;
  applyFebruaryChallengeReplay: (
    playerProfileId: string,
    opponentProfileId: string,
  ) => Promise<void>;
  finalizeRatingUpdate: (
    input: RatingFinalizeInput,
    buildPlan: (
      player: RatingProfile | null,
      opponent: RatingProfile | null,
    ) => RatingCommitPlan,
  ) => Promise<RatingFinalizeResult>;
  readRatingUpdate: (operationId: string) => Promise<RatingUpdateData | null>;
  hasCompletedRatingUpdate: (
    inviteId: string,
    matchId: string,
  ) => Promise<boolean>;
  tryAcquireRatingLease: (
    input: RatingLeaseInput,
  ) => Promise<RatingLeaseResult>;
};

export type RatingEventProgressRepository = RatingRepository & {
  claimRatingEventProgress: (
    operationId: string,
    updateTime: string,
    claimedAtMs: number,
  ) => Promise<boolean>;
  listDueRatingEventProgress: (
    updatedBeforeMs: number,
    limit: number,
  ) => Promise<PendingRatingEventProgress[]>;
  markRatingEventProgress: (
    operationId: string,
    state: "dead" | "done",
    updatedAtMs: number,
    reason?: string,
  ) => Promise<void>;
};

export type RatingProjectionRepository = RatingRepository & {
  claimRatingTelegramProjection: (
    operationId: string,
    updateTime: string,
    claimedAtMs: number,
  ) => Promise<boolean>;
  listDueRatingTelegramProjections: (
    updatedBeforeMs: number,
    limit: number,
  ) => Promise<PendingRatingTelegramProjection[]>;
  markRatingTelegramProjection: (
    operationId: string,
    state: "dead" | "done",
    updatedAtMs: number,
    reason?: string,
  ) => Promise<void>;
};

export type RatingProfileGameProjectionRepository = RatingRepository & {
  claimRatingProfileGameProjection: (
    operationId: string,
    updateTime: string,
    claimedAtMs: number,
  ) => Promise<boolean>;
  listDueRatingProfileGameProjections: (
    updatedBeforeMs: number,
    limit: number,
  ) => Promise<PendingRatingProfileGameProjection[]>;
  markRatingProfileGameProjection: (
    operationId: string,
    state: "dead" | "done",
    updatedAtMs: number,
    reason?: string,
  ) => Promise<void>;
};
