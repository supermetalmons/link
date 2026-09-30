// Generated from src/profileGamesProjectionCore.ts. Run npm run generate:runtime.
import type { MatchPresentationSnapshot } from "@mons/shared/match-presentation";
export type ProjectionRecord = {
  data: Record<string, unknown>;
  version: number;
};
export type ProjectionWrite = {
  type: "create" | "delete" | "merge" | "update";
  profileId: string;
  inviteId: string;
  data?: Record<string, unknown>;
  expectedVersion?: number;
};
export type ProjectionOwnershipSnapshot = {
  profileDataById: ReadonlyMap<string, Record<string, unknown>>;
  profileIdByLoginUid: ReadonlyMap<string, string | null>;
};
export type ProfileGamesProjectionRepository = {
  commitProjectionWrites(writes: ProjectionWrite[]): Promise<void>;
  getProjections(
    profileIds: readonly string[],
    inviteId: string,
  ): Promise<Map<string, ProjectionRecord>>;
  readAutomatchEntry(inviteId: string): Promise<unknown>;
  readInviteMetadata(inviteId: string): Promise<Record<string, unknown> | null>;
  readMatchPresentation?(
    inviteId: string,
    matchId: string,
  ): Promise<MatchPresentationSnapshot>;
  hasCompletedRatingUpdate(inviteId: string, matchId: string): Promise<boolean>;
  readProfileOwnershipSnapshot(query: {
    loginUids: readonly string[];
    profileIds: readonly string[];
  }): Promise<ProjectionOwnershipSnapshot>;
};
export type RecomputeInviteProjectionOptions = {
  cleanupProfileIds?: string[];
  eventTimestampMs?: number;
  latestMatchIdHint?: string | null;
  listSortAtMs?: number;
  preserveListSortAt?: boolean;
  preserveNewerListSortAt?: boolean;
};
export type RecomputeInviteProjectionResult = {
  blockedReason?: string;
  deletes?: number;
  inviteId: string | null;
  ok: boolean;
  ownerProfileIds?: string[];
  reason: string;
  shouldProject?: boolean;
  skipReason?: string;
  skipped: boolean | number;
  sourceCleanupSafe: boolean;
  writes?: number;
};
type Signature_createProfileGamesProjectionCore = (dependencies: {
  logger?: Pick<Console, "error">;
  repository: ProfileGamesProjectionRepository;
  wait?(milliseconds: number): Promise<void>;
}) => {
  recomputeInviteProjection(
    inviteId: string,
    reason: string,
    options?: RecomputeInviteProjectionOptions,
  ): Promise<RecomputeInviteProjectionResult>;
};
type Signature_buildResolvedProfile = (profilePath: string[]) => {
  cleanupProfileIds: string[];
  profileId: string | null;
};
type Signature_buildInviteProjectionOwnerPlan = (
  hostProfile: ReturnType<typeof buildResolvedProfile>,
  guestProfile: ReturnType<typeof buildResolvedProfile>,
  cleanupProfileIds?: string[],
) => {
  cleanupProfileIds: string[];
  ownerProfileIds: string[];
};
type Signature_readExistingProjectionRecords = (input: {
  attempts?: number;
  inviteId: string;
  logger?: Pick<Console, "error">;
  profileIds: string[];
  readRecords(
    profileIds: readonly string[],
  ): Promise<Map<string, ProjectionRecord>>;
  reason: string;
  retryDelayMs?: number;
  wait?(milliseconds: number): Promise<void>;
}) => Promise<
  Array<{
    profileId: string;
    data: Record<string, unknown>;
    version: number;
  }>
>;
declare const READ_RETRY_ATTEMPTS = 2;
declare const READ_RETRY_DELAY_MS = 25;
declare const readExistingProjectionRecords: Signature_readExistingProjectionRecords;
declare const buildResolvedProfile: Signature_buildResolvedProfile;
declare const buildInviteProjectionOwnerPlan: Signature_buildInviteProjectionOwnerPlan;
declare const createProfileGamesProjectionCore: Signature_createProfileGamesProjectionCore;
export {
  READ_RETRY_ATTEMPTS,
  READ_RETRY_DELAY_MS,
  buildInviteProjectionOwnerPlan,
  buildResolvedProfile,
  createProfileGamesProjectionCore,
  readExistingProjectionRecords,
};
