import type { GameplayRepository } from "../gameplayRepository.ts";
import type { GameSessionRecoveryContext } from "../gameSessionContracts.ts";
import type { RatingProfileGameProjectionRepository } from "../ratingContracts.ts";
import type { EventStore } from "../eventStoreContracts.ts";
import type { EventOutboxReads } from "../eventOutboxReadRepository.ts";
import type { EventProjectionRecoveryStore } from "../eventProjectionRecoveryD1.ts";
import type {
  EventProfileGameProjectionRuntime,
  ProfileGameProjectionRuntime,
} from "../profileGameProjectionRepository.ts";
import type { ProfileLinkProjectionSummary } from "../profileLinkProfileGameProjection.ts";
import type { ProfileGameProjectionLockStore } from "../profileGameProjectionLocksD1.ts";
import type { ProfileLinkCatchupStore } from "../profileLinkCatchupD1.ts";

export type ProfileGameProjectionLogger = Pick<Console, "error" | "info">;
export type ProfileLinkProjectionResult = Pick<
  ProfileLinkProjectionSummary,
  "didHitInviteCap" | "nextMatchCursor"
>;
export type ProfileGameProjectionState = Pick<
  GameplayRepository,
  | "readInviteMetadata"
  | "readAutomatchEntry"
  | "readMatchPair"
  | "readMatchRecord"
  | "readAutomatchProfileOutbox"
  | "settleAutomatchHistoricalDescriptor"
  | "claimAutomatchProfileOutbox"
  | "acknowledgeAutomatchProfileOutbox"
  | "finishAutomatchProfileOutbox"
>;

export type EventProfileProjectionState = Pick<
  EventStore,
  | "readEventProfileGameProjectionOutbox"
  | "claimEventProfileGameProjectionOutbox"
  | "acknowledgeEventProfileGameProjectionOutbox"
  | "transactEventLease"
>;

export type ProfileLinkProjectionJobs = Pick<
  ProfileLinkCatchupStore,
  | "read"
  | "scanDue"
  | "scanDuePage"
  | "quarantineInvalidEntry"
  | "claimDispatch"
  | "advance"
  | "settle"
  | "settleMissing"
>;

export type ProfileGameProjectionDependencies = {
  forwardEventTasks?: boolean;
  createLocks?: (env: Env) => ProfileGameProjectionLockStore;
  createProfileLinkJobs?: (env: Env) => ProfileLinkProjectionJobs;
  createEventRuntime?: (env: Env) => EventProfileGameProjectionRuntime;
  createRating?: (env: Env) => RatingProfileGameProjectionRepository;
  createStateRepository?: (
    env: Env,
  ) => ProfileGameProjectionState &
    EventProfileProjectionState &
    Pick<EventOutboxReads, "listDueEventProfileGameProjectionOutboxes">;
  createRequestId?: () => string;
  createRuntime?: (env: Env) => ProfileGameProjectionRuntime;
  logger?: ProfileGameProjectionLogger;
  now?: () => number;
  processProfileLink?: (input: {
    cleanupProfileIds: string[];
    loginUid: string;
    matchCursor: string | null;
    profileId: string;
    sourceUpdatedAtMs: number;
    withInviteProjectionLock<T>(
      inviteId: string,
      work: () => Promise<T>,
    ): Promise<T>;
  }) => Promise<ProfileLinkProjectionResult | null>;
};

export type AutomatchProjectionState = Pick<
  ProfileGameProjectionState,
  | "readMatchPair"
  | "readAutomatchProfileOutbox"
  | "settleAutomatchHistoricalDescriptor"
  | "acknowledgeAutomatchProfileOutbox"
  | "finishAutomatchProfileOutbox"
>;

export type AutomatchRecoveryState = Pick<
  ProfileGameProjectionState,
  "claimAutomatchProfileOutbox"
> &
  GameSessionRecoveryContext;

export type ProfileLinkProcessingJobs = Pick<
  ProfileLinkProjectionJobs,
  "read" | "advance" | "settle" | "settleMissing"
>;

export type ProfileLinkRecoveryJobs = Pick<
  ProfileLinkProjectionJobs,
  "scanDuePage" | "quarantineInvalidEntry" | "claimDispatch"
>;

export type ProfileGameProjectionQueueDependencies = Pick<
  ProfileGameProjectionDependencies,
  | "forwardEventTasks"
  | "createLocks"
  | "createEventRuntime"
  | "createRating"
  | "createRuntime"
  | "logger"
  | "now"
  | "processProfileLink"
> & {
  createEventStateRepository?: (env: Env) => EventProfileProjectionState;
  createProfileLinkJobs?: (env: Env) => ProfileLinkProcessingJobs;
  createStateRepository?: (
    env: Env,
  ) => AutomatchProjectionState &
    EventProfileProjectionState &
    Pick<GameplayRepository, "readAutomatchEntry" | "readInviteMetadata">;
};

type RecoveryDependencies = Pick<
  ProfileGameProjectionDependencies,
  "logger" | "now"
>;

export type RatingRecoveryDependencies = RecoveryDependencies &
  Pick<ProfileGameProjectionDependencies, "createRating">;

export type AutomatchRecoveryDependencies = RecoveryDependencies &
  Pick<ProfileGameProjectionDependencies, "createRequestId"> & {
    createStateRepository?: (env: Env) => AutomatchRecoveryState;
  };

export type EventRecoveryDependencies = RecoveryDependencies &
  Pick<ProfileGameProjectionDependencies, "createRequestId"> & {
    createEventRecovery?: (
      env: Env,
    ) => EventProjectionRecoveryStore<"profile-game">;
  };

export type ProfileLinkRecoveryDependencies = Pick<
  RecoveryDependencies,
  "now" | "logger"
> & {
  createProfileLinkJobs?: (env: Env) => ProfileLinkRecoveryJobs;
};

export type ProfileGameProjectionRecoveryDependencies =
  RatingRecoveryDependencies &
    AutomatchRecoveryDependencies &
    EventRecoveryDependencies &
    ProfileLinkRecoveryDependencies &
    Pick<ProfileGameProjectionDependencies, "createLocks">;

export type ProfileGameProjectionSweepResult = {
  automatch: number;
  event: number;
  profile: number;
  rating: number;
};
