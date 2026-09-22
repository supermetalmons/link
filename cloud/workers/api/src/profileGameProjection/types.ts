import type { GameplayRepository } from "../gameplayRepository.ts";
import type { RatingProfileGameProjectionRepository } from "../ratingContracts.ts";
import type { EventStore } from "../eventStoreContracts.ts";
import type { EventOutboxReads } from "../eventOutboxReadRepository.ts";
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
  | "transactAutomatchProfileOutbox"
  | "listDueAutomatchProfileOutboxes"
  | "listMalformedAutomatchProfileOutboxes"
>;

export type EventProfileProjectionState = Pick<
  EventStore,
  | "readEventProfileGameProjectionOutbox"
  | "transactEventProfileGameProjectionOutbox"
  | "transactEventLease"
>;

export type ProfileLinkProjectionJobs = Pick<
  ProfileLinkCatchupStore,
  "read" | "listDue" | "claimDispatch" | "advance" | "settle" | "settleMissing"
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
  | "transactAutomatchProfileOutbox"
>;

export type AutomatchRecoveryState = Pick<
  ProfileGameProjectionState,
  | "transactAutomatchProfileOutbox"
  | "listDueAutomatchProfileOutboxes"
  | "listMalformedAutomatchProfileOutboxes"
>;

export type EventProjectionRecoveryState = Pick<
  EventProfileProjectionState,
  "transactEventProfileGameProjectionOutbox"
> &
  Pick<EventOutboxReads, "listDueEventProfileGameProjectionOutboxes">;

export type ProfileLinkProcessingJobs = Pick<
  ProfileLinkProjectionJobs,
  "read" | "advance" | "settle" | "settleMissing"
>;

export type ProfileLinkRecoveryJobs = Pick<
  ProfileLinkProjectionJobs,
  "listDue" | "claimDispatch"
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
    createStateRepository?: (env: Env) => EventProjectionRecoveryState;
  };

export type ProfileLinkRecoveryDependencies = Pick<
  RecoveryDependencies,
  "now"
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
