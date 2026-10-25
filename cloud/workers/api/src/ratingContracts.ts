import type { HistoricalMatchPair } from "@mons/shared/game-sessions";
import type { EventProgressOutboxRecord } from "../../../runtime/events.js";
import type { GameSessionPort } from "./gameSessionContracts.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import type { RecoveryRowObservation } from "./recoveryObservation.ts";
import type { RecoveryScanPage } from "./recoveryScanPage.ts";
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
  revision: number;
};

export type PendingRatingProfileGameProjection = {
  inviteId: string;
  matchId: string;
  operationId: string;
  revision: number;
  version: number;
};

export type PendingRatingEventProgress = {
  eventId: string;
  inviteId: string;
  matchId: string;
  operationId: string;
  revision: number;
  version: number;
};

export type RatingRecoveryProjectionKind =
  "event-progress" | "profile-game" | "telegram";

export type RatingRecoveryQuarantineReason =
  "invalid-operation-id" | "invalid-record";

export type InvalidRatingRecoveryEntry = {
  kind: "invalid";
  projectionKind: RatingRecoveryProjectionKind;
  observation: RecoveryRowObservation;
  reason: RatingRecoveryQuarantineReason;
};

export type RatingRecoveryScanEntry<T> =
  | { kind: "candidate"; value: T }
  | InvalidRatingRecoveryEntry
  | { kind: "failure"; error: unknown };

export type RatingRecoveryQuarantineResult = {
  operationIdHex: string;
  revisionHex: string;
  reason: RatingRecoveryQuarantineReason;
  projectionKind: RatingRecoveryProjectionKind;
};

type RatingRecoveryRepository = {
  quarantineRatingRecoveryEntry: (
    entry: InvalidRatingRecoveryEntry,
    nowMs: number,
  ) => Promise<RatingRecoveryQuarantineResult | null>;
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

export type RatingEventProgressRepository = RatingRepository &
  RatingRecoveryRepository & {
    claimRatingEventProgress: (
      operationId: string,
      expectedRevision: number,
      claimedAtMs: number,
    ) => Promise<boolean>;
    scanDueRatingEventProgress: (
      updatedBeforeMs: number,
      limit: number,
    ) => Promise<RatingRecoveryScanEntry<PendingRatingEventProgress>[]>;
    markRatingEventProgress: (
      operationId: string,
      state: "dead" | "done",
      updatedAtMs: number,
      reason?: string,
    ) => Promise<void>;
  };

export type RatingProjectionRepository = RatingRepository &
  RatingRecoveryRepository & {
    readRatingUpdates: (
      operationIds: readonly string[],
    ) => Promise<Array<RatingUpdateData | null>>;
    claimRatingTelegramProjection: (
      operationId: string,
      expectedRevision: number,
      claimedAtMs: number,
    ) => Promise<boolean>;
    scanDueRatingTelegramProjections: (
      updatedBeforeMs: number,
      limit: number,
    ) => Promise<RatingRecoveryScanEntry<PendingRatingTelegramProjection>[]>;
    scanDueRatingTelegramProjectionsPage: (
      updatedBeforeMs: number,
      limit: number,
      excludedIdentities?: readonly string[],
    ) => Promise<
      RecoveryScanPage<
        RatingRecoveryScanEntry<PendingRatingTelegramProjection>[]
      >
    >;
    markRatingTelegramProjection: (
      operationId: string,
      state: "dead" | "done",
      updatedAtMs: number,
      reason?: string,
    ) => Promise<void>;
  };

export type RatingProfileGameProjectionRepository = RatingRepository &
  RatingRecoveryRepository & {
    claimRatingProfileGameProjection: (
      operationId: string,
      expectedRevision: number,
      claimedAtMs: number,
    ) => Promise<boolean>;
    scanDueRatingProfileGameProjections: (
      updatedBeforeMs: number,
      limit: number,
    ) => Promise<RatingRecoveryScanEntry<PendingRatingProfileGameProjection>[]>;
    scanDueRatingProfileGameProjectionsPage: (
      updatedBeforeMs: number,
      limit: number,
      excludedIdentities?: readonly string[],
    ) => Promise<
      RecoveryScanPage<
        RatingRecoveryScanEntry<PendingRatingProfileGameProjection>[]
      >
    >;
    markRatingProfileGameProjection: (
      operationId: string,
      state: "dead" | "done",
      updatedAtMs: number,
      reason?: string,
    ) => Promise<void>;
  };
