import { isSafeRecordKey } from "../shared/ids.js";

export type EventTelegramProjectionGuard = {
  eventId: string;
  generation?: number;
  lockId: string;
  lockRoot: "eventTelegramProjectionLocks";
  ownerUid: string;
};
export type RetainedStartedMatchLines = Record<string, string>;
export type EventTelegramEndedResult =
  | { status: "unavailable" | "disqualified" }
  | { status: "scored"; hostScore: number; guestScore: number };
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

function invalid(): never {
  throw new TypeError("invalid-event-telegram-projection-state");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
function key(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    isSafeRecordKey(value)
  );
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isEventTelegramProjectionGuard(
  value: unknown,
): value is Required<EventTelegramProjectionGuard> {
  return (
    record(value) &&
    exact(value, ["eventId", "generation", "lockId", "lockRoot", "ownerUid"]) &&
    key(value.eventId) &&
    integer(value.generation) &&
    key(value.lockId) &&
    value.lockRoot === "eventTelegramProjectionLocks" &&
    key(value.ownerUid)
  );
}
function isStartedMatchLines(
  value: unknown,
): value is RetainedStartedMatchLines {
  return (
    record(value) &&
    Object.entries(value).every(
      ([name, line]) => key(name) && typeof line === "string" && line !== "",
    )
  );
}
function isEventTelegramEndedResults(
  value: unknown,
): value is EventTelegramEndedResultsDocument {
  return (
    record(value) &&
    Object.entries(value).every(
      ([name, entry]) =>
        key(name) &&
        record(entry) &&
        (entry.status === "scored"
          ? exact(entry, ["status", "hostScore", "guestScore"]) &&
            integer(entry.hostScore) &&
            integer(entry.guestScore)
          : exact(entry, ["status"]) &&
            (entry.status === "unavailable" ||
              entry.status === "disqualified")),
    )
  );
}
function isEventTelegramProjectionDocument(
  value: unknown,
): value is EventTelegramProjectionStateDocument {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "upcomingText",
      "reminderText",
      "startedText",
      "endedText",
      "endedAnnouncementArmed",
      "startedMatchKeys",
      "startedMatchLinesByKey",
      "lastProjectedSignature",
      "updatedAtMs",
      "eventTelegramProjectionGuard",
    ]) ||
    value.schemaVersion !== 3 ||
    ![
      value.upcomingText,
      value.reminderText,
      value.startedText,
      value.endedText,
    ].every((text) => typeof text === "string") ||
    typeof value.endedAnnouncementArmed !== "boolean" ||
    !Array.isArray(value.startedMatchKeys) ||
    !value.startedMatchKeys.every(key) ||
    new Set(value.startedMatchKeys).size !== value.startedMatchKeys.length ||
    !isStartedMatchLines(value.startedMatchLinesByKey) ||
    typeof value.lastProjectedSignature !== "string" ||
    !(
      value.lastProjectedSignature === "" ||
      /^[a-f0-9]{64}$/.test(value.lastProjectedSignature)
    ) ||
    !integer(value.updatedAtMs) ||
    !(
      value.eventTelegramProjectionGuard === null ||
      isEventTelegramProjectionGuard(value.eventTelegramProjectionGuard)
    )
  )
    return false;
  const keys = new Set(value.startedMatchKeys);
  return Object.keys(value.startedMatchLinesByKey).every((name) =>
    keys.has(name),
  );
}

export function readEventTelegramProjectionDocument(
  value: unknown,
): EventTelegramProjectionStateDocument {
  if (!isEventTelegramProjectionDocument(value)) invalid();
  return structuredClone(value);
}
export function createEventTelegramProjectionDocument(
  value: EventTelegramProjectionStateWrite,
): EventTelegramProjectionStateDocument {
  return readEventTelegramProjectionDocument(value);
}
export function createEmptyEventTelegramProjectionDocument(
  updatedAtMs = 0,
): EventTelegramProjectionStateDocument {
  return createEventTelegramProjectionDocument({
    schemaVersion: 3,
    upcomingText: "",
    reminderText: "",
    startedText: "",
    endedText: "",
    endedAnnouncementArmed: false,
    startedMatchKeys: [],
    startedMatchLinesByKey: {},
    lastProjectedSignature: "",
    updatedAtMs,
    eventTelegramProjectionGuard: null,
  });
}

export function retainEventTelegramEndedResults(
  value: unknown,
): EventTelegramEndedResultsDocument {
  if (!isEventTelegramEndedResults(value)) invalid();
  return structuredClone(value);
}
export function copyStartedMatchLines(
  value: RetainedStartedMatchLines,
  keys: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => keys.has(name)),
  );
}
export function withEventTelegramProjectionGuard(
  value: EventTelegramProjectionStateDocument,
  guard: EventTelegramProjectionGuard,
): EventTelegramProjectionStateDocument {
  return createEventTelegramProjectionDocument({
    ...value,
    eventTelegramProjectionGuard: {
      ...guard,
      generation: guard.generation ?? 0,
    },
  });
}
export function eventTelegramProjectionGeneration(
  value: EventTelegramProjectionStateDocument | null,
): number {
  return value?.eventTelegramProjectionGuard?.generation ?? 0;
}
export function eventTelegramProjectionNeedsResults(
  value: EventTelegramProjectionStateDocument | null,
): boolean {
  return (
    value !== null && value.endedAnnouncementArmed && value.endedText === ""
  );
}
export function deferEventTelegramProjectionTexts(
  next: EventTelegramProjectionStateDocument,
  previous: EventTelegramProjectionStateDocument | null,
  fields: ReadonlySet<EventTelegramTextField>,
): EventTelegramProjectionStateDocument {
  const result = { ...next, lastProjectedSignature: "" };
  for (const field of fields) result[field] = previous?.[field] ?? "";
  return createEventTelegramProjectionDocument(result);
}
