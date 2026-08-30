import type {
  RecomputeInviteProjectionOptions,
  RecomputeInviteProjectionResult,
} from "./profileGamesProjectionCore.js";

export type ProfileLinkProjectionRepository = {
  getMatches(
    loginUid: string,
    query: {
      limitToFirst: number;
      orderBy: "$key";
      startAt?: string;
    },
  ): Promise<Record<string, unknown> | null>;
  inviteExists(inviteId: string): Promise<boolean>;
  readProfileOwnershipSnapshot(query: {
    loginUids: readonly string[];
    profileIds: readonly string[];
  }): Promise<{
    profileIdByLoginUid: ReadonlyMap<string, string | null>;
  }>;
};

export type ProfileLinkProjectionSummary = {
  loginUid: string;
  profileId: string;
  eventProfileId: string;
  matchIdsScanned: number;
  inviteIdsResolved: number;
  processed: number;
  failed: number;
  didTimeout: boolean;
  didHitInviteCap: boolean;
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
export const PROFILE_LINK_CATCHUP_MAX_INVITES_WITH_CLEANUP: number;
export const PROFILE_LINK_CATCHUP_TIMEOUT_MS: number;
