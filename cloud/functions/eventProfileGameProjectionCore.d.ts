export type EventProjectionWrite = {
  type: "delete" | "merge";
  profileId: string;
  eventId: string;
  data?: Record<string, unknown>;
};

export type EventProfileGameProjectionRepository = {
  commitProjectionWrites(writes: EventProjectionWrite[]): Promise<void>;
  getEvent(eventId: string): Promise<Record<string, unknown> | null>;
  getMergeTarget(profileId: string): Promise<Record<string, unknown> | null>;
  getProfile(
    profileId: string,
  ): Promise<{ data: Record<string, unknown>; updateTime: string } | null>;
};

export type EventProjectionResult = {
  deleted: number;
  ownerProfileIds: string[];
  written: number;
};

export function createEventProfileGameProjectionCore(dependencies: {
  now?: () => number;
  repository: EventProfileGameProjectionRepository;
  timestampFromMillis(millis: number): unknown;
  wait?(milliseconds: number): Promise<void>;
}): {
  projectEvent(
    eventId: string,
    eventData: Record<string, unknown> | null,
    cleanupOwnerProfileIds?: string[],
  ): Promise<EventProjectionResult>;
  reconcileEventProjection(
    eventId: string,
    cleanupOwnerProfileIds?: string[],
  ): Promise<EventProjectionResult & { status: "missing" | "projected" }>;
  resolveProfilePaths(profileIds: string[]): Promise<Map<string, string[]>>;
};

export function buildEventProjectionOwnerPlan(input: {
  afterOwnerPaths: string[][];
  beforeOwnerPaths?: string[][];
  cleanupOwnerPaths?: string[][];
  rawAfterOwnerProfileIds: string[];
  rawBeforeOwnerProfileIds?: string[];
}): { afterOwnerProfileIds: string[]; allOwnerProfileIds: string[] };

export const EVENT_PROJECTION_RECONCILE_ATTEMPTS: number;
export const PROFILE_PATH_RESOLVE_CONCURRENCY: number;
export const READ_RETRY_ATTEMPTS: number;
export const READ_RETRY_DELAY_MS: number;
