export type EventProjectionWrite = {
  type: "delete" | "merge";
  profileId: string;
  eventId: string;
  data?: Record<string, unknown>;
};

export type EventProjectionOwnershipSnapshot = Readonly<{
  canonicalProfileIdByProfileId: ReadonlyMap<string, string | null>;
  loginOwnerByUid: ReadonlyMap<
    string,
    Readonly<{ profileId: string; revision: number }> | null
  >;
}>;

export type EventProfileGameProjectionRepository = {
  commitProjectionWrites(writes: EventProjectionWrite[]): Promise<void>;
  getEvent(eventId: string): Promise<Record<string, unknown> | null>;
  readProfileOwnershipSnapshot(query: {
    loginUids: string[];
    profileIds: string[];
  }): Promise<EventProjectionOwnershipSnapshot>;
};

export type EventProjectionResult = {
  deleted: number;
  ownerProfileIds: string[];
  written: number;
};

export function createEventProfileGameProjectionCore(dependencies: {
  now?: () => number;
  repository: EventProfileGameProjectionRepository;
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
};

export const READ_RETRY_ATTEMPTS: number;
export const READ_RETRY_DELAY_MS: number;
