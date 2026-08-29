export type ProjectionDocument = {
  data: Record<string, unknown>;
  updateTime: string;
};

export type ProjectionWrite = {
  type: "create" | "delete" | "merge" | "update";
  profileId: string;
  inviteId: string;
  data?: Record<string, unknown>;
  updateTime?: string;
};

export type ProfileGamesProjectionRepository = {
  commitProjectionWrites(writes: ProjectionWrite[]): Promise<void>;
  findProfileByLogin(
    loginUid: string,
  ): Promise<{ id: string; data: Record<string, unknown> } | null>;
  getMergeTarget(profileId: string): Promise<Record<string, unknown> | null>;
  getProfile(profileId: string): Promise<ProjectionDocument | null>;
  getProjection(
    profileId: string,
    inviteId: string,
  ): Promise<ProjectionDocument | null>;
  getRtdbPath(path: string): Promise<unknown>;
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

export function createProfileGamesProjectionCore(dependencies: {
  logger?: Pick<Console, "error">;
  repository: ProfileGamesProjectionRepository;
  wait?(milliseconds: number): Promise<void>;
}): {
  recomputeInviteProjection(
    inviteId: string,
    reason: string,
    options?: RecomputeInviteProjectionOptions,
  ): Promise<RecomputeInviteProjectionResult>;
};

export function buildResolvedProfile(profilePath: string[]): {
  cleanupProfileIds: string[];
  profileId: string | null;
};

export function buildInviteProjectionOwnerPlan(
  hostProfile: ReturnType<typeof buildResolvedProfile>,
  guestProfile: ReturnType<typeof buildResolvedProfile>,
  cleanupProfileIds?: string[],
): { cleanupProfileIds: string[]; ownerProfileIds: string[] };

export function readExistingProjectionDocuments(input: {
  attempts?: number;
  inviteId: string;
  logger?: Pick<Console, "error">;
  profileIds: string[];
  readDocument(profileId: string): Promise<{ exists: boolean }>;
  reason: string;
  retryDelayMs?: number;
  wait?(milliseconds: number): Promise<void>;
}): Promise<Array<{ profileId: string; snapshot: { exists: boolean } }>>;

export const READ_RETRY_ATTEMPTS: number;
export const READ_RETRY_DELAY_MS: number;
