// Generated from src/telegram/eventProjectionRecords.ts. Run npm run generate:runtime.
export type EventTelegramProjectionGuard = {
  eventId: string;
  generation?: number;
  lockId: string;
  lockRoot: "eventTelegramProjectionLocks";
  ownerUid: string;
};
export type RetainedStartedMatchLines = Record<string, string>;
export type EventTelegramEndedResult =
  | {
      status: "unavailable" | "disqualified";
    }
  | {
      status: "scored";
      hostScore: number;
      guestScore: number;
    };
export type EventTelegramEndedResultsDocument = Record<
  string,
  EventTelegramEndedResult
>;
export type EventTelegramProjectionStateDocument = {
  schemaVersion: 3;
  upcomingText: string;
  reminderText: string;
  startedText: string;
  endedText: string;
  endedAnnouncementArmed: boolean;
  startedMatchKeys: string[];
  startedMatchLinesByKey: RetainedStartedMatchLines;
  lastProjectedSignature: string;
  updatedAtMs: number;
  eventTelegramProjectionGuard: Required<EventTelegramProjectionGuard> | null;
};
export type EventTelegramProjectionStateWrite =
  EventTelegramProjectionStateDocument;
export type EventTelegramTextField = "upcomingText" | "reminderText";
export declare function readEventTelegramProjectionDocument(
  value: unknown,
): EventTelegramProjectionStateDocument;
export declare function createEventTelegramProjectionDocument(
  value: EventTelegramProjectionStateWrite,
): EventTelegramProjectionStateDocument;
export declare function createEmptyEventTelegramProjectionDocument(
  updatedAtMs?: number,
): EventTelegramProjectionStateDocument;
export declare function retainEventTelegramEndedResults(
  value: unknown,
): EventTelegramEndedResultsDocument;
export declare function copyStartedMatchLines(
  value: RetainedStartedMatchLines,
  keys: ReadonlySet<string>,
): Record<string, string>;
export declare function withEventTelegramProjectionGuard(
  value: EventTelegramProjectionStateDocument,
  guard: EventTelegramProjectionGuard,
): EventTelegramProjectionStateDocument;
export declare function eventTelegramProjectionGeneration(
  value: EventTelegramProjectionStateDocument | null,
): number;
export declare function eventTelegramProjectionNeedsResults(
  value: EventTelegramProjectionStateDocument | null,
): boolean;
export declare function deferEventTelegramProjectionTexts(
  next: EventTelegramProjectionStateDocument,
  previous: EventTelegramProjectionStateDocument | null,
  fields: ReadonlySet<EventTelegramTextField>,
): EventTelegramProjectionStateDocument;
