import type { EventDocument } from "./events/documents.js";
export type EventJsonRecord = Record<string, unknown>;

export type EventPrizeAssignmentRecord = {
  assignedAtMs: number;
  eventId: string;
  place: 1 | 2 | 3;
  prizeId: string;
  profileId: string;
};

export type EventSnapshot = {
  event: EventDocument | null;
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
  ): Promise<EventDocument | null>;
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
  listProfileEventPrizeAssignments(
    profileId: string,
    query?: ProfileEventPrizePageQuery,
    signal?: AbortSignal,
  ): Promise<Record<string, EventPrizeAssignmentRecord>>;
};
