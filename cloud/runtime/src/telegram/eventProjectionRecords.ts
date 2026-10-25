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

type SourceRecord = Record<string, unknown>;
const objectProperties = (value: unknown): SourceRecord =>
  value && typeof value === "object" ? (value as SourceRecord) : {};
const record = (value: unknown): SourceRecord | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : null;

export function readEventTelegramProjectionDocument(
  value: unknown,
): EventTelegramProjectionStateDocument {
  return objectProperties(value) as EventTelegramProjectionStateDocument;
}

export function createEventTelegramProjectionDocument(
  value: EventTelegramProjectionStateWrite,
): EventTelegramProjectionStateDocument {
  const retained: unknown = value;
  return retained as EventTelegramProjectionStateDocument;
}

export function retainStartedMatchLines(
  value: unknown,
): RetainedStartedMatchLines {
  return objectProperties(value) as RetainedStartedMatchLines;
}

export function retainEventTelegramEndedResults(
  value: unknown,
): EventTelegramEndedResultsDocument {
  return value as EventTelegramEndedResultsDocument;
}

export function copyStartedMatchLines(
  value: RetainedStartedMatchLines,
  keys: ReadonlySet<string>,
): Record<string, string> {
  const lines: Record<string, string> = {};
  for (const [key, line] of Object.entries(objectProperties(value))) {
    if (keys.has(key) && typeof line === "string" && line !== "") {
      lines[key] = line;
    }
  }
  return lines;
}

export function withEventTelegramProjectionGuard(
  value: EventTelegramProjectionStateDocument,
  guard: EventTelegramProjectionGuard,
): EventTelegramProjectionStateDocument {
  const retained: unknown = {
    ...value,
    eventTelegramProjectionGuard: { ...guard },
  };
  return retained as EventTelegramProjectionStateDocument;
}

export function eventTelegramProjectionGeneration(
  value: EventTelegramProjectionStateDocument | null,
): number {
  const source = record(value);
  const guard = record(source?.eventTelegramProjectionGuard);
  const generation = guard?.generation;
  return typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation >= 0
    ? generation
    : 0;
}

export function eventTelegramProjectionNeedsResults(
  value: EventTelegramProjectionStateDocument | null,
): boolean {
  const source = record(value) || {};
  return (
    source.endedAnnouncementArmed === true &&
    (typeof source.endedText !== "string" || source.endedText === "")
  );
}

export function deferEventTelegramProjectionTexts(
  next: EventTelegramProjectionStateDocument,
  previous: EventTelegramProjectionStateDocument | null,
  fields: ReadonlySet<EventTelegramTextField>,
): EventTelegramProjectionStateDocument {
  const source = record(previous) || {};
  const retained: unknown = {
    ...(record(next) || {}),
    ...Object.fromEntries(
      Array.from(fields, (field) => [
        field,
        typeof source[field] === "string" ? source[field] : "",
      ]),
    ),
    lastProjectedSignature: "",
  };
  return retained as EventTelegramProjectionStateDocument;
}
