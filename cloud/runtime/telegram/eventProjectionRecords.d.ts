// Generated from src/telegram/eventProjectionRecords.ts. Run npm run generate:runtime.
declare const projectionStateDocument: unique symbol;
declare const startedLinesDocument: unique symbol;
declare const endedResultsDocument: unique symbol;
export type EventTelegramProjectionStateDocument = {
  readonly [projectionStateDocument]: true;
};
export type RetainedStartedMatchLines = {
  readonly [startedLinesDocument]: true;
};
export type EventTelegramEndedResultsDocument = {
  readonly [endedResultsDocument]: true;
};
export type EventTelegramProjectionGuard = {
  eventId: string;
  generation?: number;
  lockId: string;
  lockRoot: string;
  ownerUid: string;
};
export type EventTelegramProjectionStateWrite = {
  schemaVersion: 2;
  upcomingText: string;
  reminderText: string;
  startedText: string;
  endedText: string;
  endedAnnouncementArmed: boolean;
  startedMatchKeys: string[];
  startedMatchLinesByKey: Record<string, string> | RetainedStartedMatchLines;
  lastProjectedSignature: string;
  updatedAtMs: number;
  eventTelegramProjectionGuard?: EventTelegramProjectionGuard;
};
export type EventTelegramTextField = "upcomingText" | "reminderText";
export declare function readEventTelegramProjectionDocument(
  value: unknown,
): EventTelegramProjectionStateDocument;
export declare function createEventTelegramProjectionDocument(
  value: EventTelegramProjectionStateWrite,
): EventTelegramProjectionStateDocument;
export declare function retainStartedMatchLines(
  value: unknown,
): RetainedStartedMatchLines;
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
export {};
