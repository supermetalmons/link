export type EventJsonRecord = Record<string, unknown>;

export type EventStatus = "scheduled" | "active" | "ended" | "dismissed";

export type EventPrizeAssignmentRecord = {
  assignedAtMs: number;
  eventId: string;
  place: 1 | 2 | 3;
  prizeId: string;
  profileId: string;
} & EventJsonRecord;

export type EventSnapshot = {
  event: EventJsonRecord | null;
  eventId: string;
  prizeSelections: Record<string, string>;
  revision: number;
};

export type ProfileEventPrizeSnapshot = {
  prizes: Record<string, EventPrizeAssignmentRecord>;
  profileId: string;
  revision: number;
};

export type ProfileEventPrizePageQuery = {
  startAt?: string;
  limit?: number;
};

export type EventReads = {
  readEvent(
    eventId: string,
    signal?: AbortSignal,
  ): Promise<EventJsonRecord | null>;
  readEventPrizeSelections(
    eventId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, string>>;
  readProfileEventPrizeAssignment(
    profileId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<EventPrizeAssignmentRecord | null>;
  readEventSnapshot(
    eventId: string,
    signal?: AbortSignal,
  ): Promise<EventSnapshot>;
  readProfileEventPrizes(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<ProfileEventPrizeSnapshot>;
  listEventsByStatus(
    status: EventStatus,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, EventJsonRecord>>;
  listProfileEventPrizeAssignments(
    profileId: string,
    query?: ProfileEventPrizePageQuery,
    signal?: AbortSignal,
  ): Promise<Record<string, EventPrizeAssignmentRecord>>;
};
