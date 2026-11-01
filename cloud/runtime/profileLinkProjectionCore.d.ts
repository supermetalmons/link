// Generated from src/profileLinkProjectionCore.ts. Run npm run generate:runtime.
import type {
  RecomputeInviteProjectionOptions,
  RecomputeInviteProjectionResult,
} from "./profileGamesProjectionCore.js";
export type ProfileLinkProjectionRepository = {
  listMatchesPage(
    loginUid: string,
    afterMatchId: string,
    limit: number,
  ): Promise<{
    entries: Array<{
      matchId: string;
      inviteId: string | null;
      resolution: "resolved" | "missing" | "ambiguous";
    }>;
    hasMore: boolean;
  }>;
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
type Signature_createProfileLinkProjectionCore = (dependencies: {
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  recomputeInviteProjection(
    inviteId: string,
    reason: string,
    options?: RecomputeInviteProjectionOptions,
  ): Promise<RecomputeInviteProjectionResult>;
  repository: ProfileLinkProjectionRepository;
  withInviteProjectionLock<T>(
    inviteId: string,
    work: () => Promise<T>,
  ): Promise<T>;
}) => {
  processProfileLinkCatchup(input: {
    cleanupProfileIds?: string[];
    loginUid: string;
    matchCursor?: string | null;
    profileId: string;
    sourceUpdatedAtMs?: number;
  }): Promise<ProfileLinkProjectionSummary | null>;
};
declare const processWithConcurrency: <T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<unknown>,
  shouldContinue?: () => boolean,
) => Promise<void>;
declare const createProfileLinkProjectionCore: Signature_createProfileLinkProjectionCore;
export { createProfileLinkProjectionCore, processWithConcurrency };
