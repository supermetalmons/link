import type {
  RecomputeInviteProjectionOptions,
  RecomputeInviteProjectionResult,
} from "./profileGamesProjectionCore.js";

export type ProfileLinkProjectionRepository = {
  deleteProfileGameProjections(
    profileId: string,
    inviteIds: string[],
  ): Promise<number>;
  getCurrentProfileLink(loginUid: string): Promise<unknown>;
  getMatches(loginUid: string): Promise<Record<string, unknown> | null>;
  getMergeTarget(profileId: string): Promise<Record<string, unknown> | null>;
  inviteExists(inviteId: string): Promise<boolean>;
  profileExists(profileId: string): Promise<boolean>;
};

export type ProfileLinkProjectionSummary = {
  loginUid: string;
  profileId: string;
  eventProfileId: string;
  matchIdsScanned: number;
  inviteIdsResolved: number;
  processed: number;
  failed: number;
  staleCleanupDeleted: number;
  didTimeout: boolean;
  didHitInviteCap: boolean;
  didConverge: boolean;
  convergenceAttempts: number;
  elapsedMs: number;
  nextMatchCursor: string | null;
};

export function createProfileLinkProjectionCore(dependencies: {
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  recomputeInviteProjection(
    inviteId: string,
    reason: string,
    options?: RecomputeInviteProjectionOptions,
  ): Promise<RecomputeInviteProjectionResult>;
  repository: ProfileLinkProjectionRepository;
  resolveInviteIdFromMatchId?(
    matchId: string,
    options: { inviteExistenceCache: Map<string, boolean | Promise<boolean>> },
  ): Promise<string | null>;
  wait?(milliseconds: number): Promise<void>;
  withInviteProjectionLock<T>(
    inviteId: string,
    work: () => Promise<T>,
  ): Promise<T>;
}): {
  processProfileLinkCatchup(input: {
    cleanupProfileIds?: string[];
    loginUid: string;
    matchCursor?: string | null;
    profileId: string;
    sourceUpdatedAtMs?: number;
  }): Promise<ProfileLinkProjectionSummary | null>;
};

export const PROFILE_LINK_CATCHUP_CONCURRENCY: number;
export const PROFILE_LINK_CATCHUP_MAX_INVITES: number;
export const PROFILE_LINK_CATCHUP_TIMEOUT_MS: number;
export const PROFILE_LINK_RECONCILE_ATTEMPTS: number;
