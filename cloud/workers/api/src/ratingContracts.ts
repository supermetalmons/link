import type { WagerAgreement } from "@mons/shared/wagers";
import type {
  RatingProfile,
  RatingUpdateData,
  RatingLeaseInput,
  RatingProfilePatch,
  RatingCompletionPatch,
} from "./ratingStateContracts.ts";
import type { EventProgressOutboxRecord } from "../../../runtime/events.js";
import type { GameSessionPort } from "./gameSessionContracts.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import type { RecoveryRowObservation } from "./recoveryObservation.ts";
import type { RecoveryScanPage } from "./recoveryScanPage.ts";
import type { ProfileOwnershipReader } from "./profileOwnership.ts";
export type {
  RatingProfile,
  RatingUpdateData,
  RatingLeaseInput,
  RatingProfilePatch,
  RatingCompletionPatch,
} from "./ratingStateContracts.ts";

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

export type RatingLeaseResult = {
  data: RatingUpdateData | null;
  status: "acquired" | "busy" | "done" | "blocked";
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
  readWagerAgreement(
    inviteId: string,
    matchId: string,
  ): Promise<Pick<WagerAgreement, "material" | "count"> | null>;
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
