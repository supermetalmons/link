import type { EventProgressDocument } from "../../../../runtime/eventProgressRecords.js";
import {
  retainEventProjectionOutbox,
  type EventProjectionOutboxDocument,
  type EventProjectionOutboxKind,
} from "../../../../runtime/eventProjectionOutboxRecords.js";
import {
  EventD1Failure,
  type EventRow,
  type DecodedEventRow,
  type EventTransitionIntent,
} from "./types.ts";
import type {
  EventJsonRecord,
  EventPrizeAssignmentRecord,
} from "../../../../runtime/eventReads.js";
import { isEventPrizeId } from "@mons/shared/event-prizes";
import { STATE_EFFECTS_FIELD } from "../stateCompatibility.ts";

export const EVENT_STATUSES = new Set([
  "scheduled",
  "active",
  "ended",
  "dismissed",
]);

const UTF8_ENCODER = new TextEncoder();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) || 0;
    return code <= 0x1f || code === 0x7f;
  });
}

export function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      !hasControlCharacter(key) && isJsonValue(entry, depth + 1),
  );
}

export function exactKey(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) return "";
  const bytes = UTF8_ENCODER.encode(value).byteLength;
  return bytes > 0 &&
    bytes <= 768 &&
    ![".", "#", "$", "/", "[", "]"].some((character) =>
      value.includes(character),
    ) &&
    !hasControlCharacter(value)
    ? value
    : "";
}

export function safeInteger(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new EventD1Failure("invalid-event-integer");
  }
  return value;
}

function nullableInteger(value: unknown, minimum = 0): number | null {
  return value === null || value === undefined
    ? null
    : safeInteger(value, minimum);
}

export function cloneJson<T>(value: T): T {
  if (!isJsonValue(value)) throw new EventD1Failure("invalid-event-json");
  return structuredClone(value);
}

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!jsonValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]),
    )
  );
}

export function encodeJson(value: unknown): string {
  if (!isJsonValue(value)) throw new EventD1Failure("invalid-event-json");
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new EventD1Failure("invalid-event-json", { cause: error });
  }
}

export function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") throw new EventD1Failure();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isJsonValue(parsed)) throw new EventD1Failure();
    return parsed;
  } catch (error) {
    if (error instanceof EventD1Failure) throw error;
    throw new EventD1Failure("invalid-event-json", { cause: error });
  }
}

export function validateEventAggregate(
  eventId: string,
  value: unknown,
): EventJsonRecord {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId || !isRecord(value) || !isJsonValue(value)) {
    throw new EventD1Failure("invalid-event-record");
  }
  if (
    value.eventId !== normalizedEventId ||
    !EVENT_STATUSES.has(String(value.status)) ||
    !Number.isSafeInteger(value.startAtMs) ||
    Number(value.startAtMs) < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    Number(value.updatedAtMs) < 0 ||
    !isRecord(value.participants) ||
    !isRecord(value.rounds)
  ) {
    throw new EventD1Failure("invalid-event-record");
  }
  if (Object.keys(value.participants).length > 32) {
    throw new EventD1Failure("invalid-event-record");
  }
  for (const [profileId, participant] of Object.entries(value.participants)) {
    if (!exactKey(profileId) || !isRecord(participant)) {
      throw new EventD1Failure("invalid-event-record");
    }
  }
  for (const round of Object.values(value.rounds)) {
    if (!isRecord(round)) throw new EventD1Failure("invalid-event-record");
  }
  return cloneJson(value);
}

export function parseStoredEventPrizeAssignment(
  profileId: string,
  eventId: string,
  value: unknown,
): EventPrizeAssignmentRecord {
  const normalizedProfileId = exactKey(profileId);
  const normalizedEventId = exactKey(eventId);
  const prizeId = isRecord(value) ? exactKey(value.prizeId) : "";
  if (
    !normalizedProfileId ||
    !normalizedEventId ||
    !prizeId ||
    !isRecord(value) ||
    !isJsonValue(value) ||
    value.profileId !== normalizedProfileId ||
    value.eventId !== normalizedEventId ||
    (value.place !== 1 && value.place !== 2 && value.place !== 3) ||
    !Number.isSafeInteger(value.assignedAtMs) ||
    Number(value.assignedAtMs) < 0
  ) {
    throw new EventD1Failure("invalid-event-prize-assignment");
  }
  return cloneJson(value) as EventPrizeAssignmentRecord;
}

export function validateEventPrizeAssignment(
  profileId: string,
  eventId: string,
  value: unknown,
): EventPrizeAssignmentRecord {
  const assignment = parseStoredEventPrizeAssignment(profileId, eventId, value);
  if (!isEventPrizeId(assignment.eventId, assignment.prizeId)) {
    throw new EventD1Failure("invalid-event-prize-assignment");
  }
  return assignment;
}

export function parseStoredPrizeSelection(value: unknown): string {
  const prizeId = exactKey(value);
  if (!prizeId) {
    throw new EventD1Failure("invalid-event-prize-selection");
  }
  return prizeId;
}

export function validatePrizeSelection(
  eventId: string,
  value: unknown,
): string {
  const prizeId = parseStoredPrizeSelection(value);
  if (!isEventPrizeId(eventId, prizeId)) {
    throw new EventD1Failure("invalid-event-prize-selection");
  }
  return prizeId;
}

export function decodeEventRow(row: EventRow): DecodedEventRow {
  const event = validateEventAggregate(
    row.event_id,
    decodeJson(row.record_json),
  );
  if (
    event.status !== row.status ||
    event.startAtMs !== row.start_at_ms ||
    event.updatedAtMs !== row.updated_at_ms
  ) {
    throw new EventD1Failure("event-row-mismatch");
  }
  return {
    event,
    pendingTransitionId: row.pending_transition_id,
    revision: safeInteger(row.revision, 1),
  };
}

export function validateTransitionIntent(
  input: unknown,
): EventTransitionIntent {
  const value = input as Record<string, unknown>;
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !exactKey(value.transitionId) ||
    !exactKey(value.eventId) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 1 ||
    !isRecord(value[STATE_EFFECTS_FIELD]) ||
    !isRecord(value.canonicalUpdates) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    (value.createdAtMs as number) < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    (value.updatedAtMs as number) < (value.createdAtMs as number) ||
    !isJsonValue(value)
  ) {
    throw new EventD1Failure("invalid-event-transition");
  }
  if (
    value.schemaVersion === 2 &&
    (!Number.isSafeInteger(value.sourceEpoch) ||
      (value.sourceEpoch as number) < 1 ||
      typeof value.payloadDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.payloadDigest) ||
      !Array.isArray(value.inviteMutations) ||
      value.inviteMutations.length > 32 ||
      value.inviteMutations.some(
        (mutation) =>
          !isRecord(mutation) ||
          !isRecord(mutation.current) ||
          !exactKey(mutation.current.inviteId) ||
          !Number.isSafeInteger(mutation.current.revision) ||
          (mutation.current.revision as number) < 0 ||
          (mutation.current.value === null
            ? mutation.current.revision !== 0
            : !isRecord(mutation.current.value) ||
              (mutation.current.revision as number) < 1) ||
          !isRecord(mutation.value),
      ) ||
      new Set(value.inviteMutations.map(({ current }) => current.inviteId))
        .size !== value.inviteMutations.length)
  ) {
    throw new EventD1Failure("invalid-event-transition");
  }
  const retained: unknown = cloneJson(value);
  return retained as EventTransitionIntent;
}

export function validateEventProgressOutbox(
  outboxId: string,
  value: unknown,
): EventProgressDocument<"pending"> & {
  reason?: unknown;
  firstQueuedAtMs?: unknown;
  eventId: string;
  lastQueuedAtMs: number;
  runAtMs: number | null;
} {
  if (!exactKey(outboxId) || !isRecord(value) || !isJsonValue(value)) {
    throw new EventD1Failure("invalid-event-progress-outbox");
  }
  const eventId = exactKey(value.eventId);
  const runAtMs = nullableInteger(value.runAtMs);
  const lastQueuedAtMs = safeInteger(value.lastQueuedAtMs);
  if (!eventId || value.schemaVersion !== 1) {
    throw new EventD1Failure("invalid-event-progress-outbox");
  }
  const retained: unknown = {
    ...cloneJson(value),
    eventId,
    runAtMs,
    lastQueuedAtMs,
  };
  return retained as EventProgressDocument<"pending"> & {
    reason?: unknown;
    firstQueuedAtMs?: unknown;
    eventId: string;
    runAtMs: number | null;
    lastQueuedAtMs: number;
  };
}

export function validateProjectionOutbox<
  Kind extends EventProjectionOutboxKind,
>(
  kind: Kind,
  eventId: string,
  value: unknown,
): {
  raw: EventProjectionOutboxDocument<Kind>;
  status: "dead" | "pending";
  firstQueuedAtMs?: number;
  lastQueuedAtMs?: number;
  requestId: string;
  updatedAtMs?: number;
} {
  if (!exactKey(eventId) || !isRecord(value) || !isJsonValue(value)) {
    throw new EventD1Failure("invalid-event-projection-outbox");
  }
  const raw = retainEventProjectionOutbox(kind, cloneJson(value));
  if (kind === "telegram" && value.status === "dead") {
    const deadAtMs = safeInteger(value.deadAtMs);
    return {
      raw,
      status: "dead",
      requestId: exactKey(value.requestId) || eventId,
      firstQueuedAtMs: deadAtMs,
      updatedAtMs: deadAtMs,
    };
  }
  const requestId = exactKey(value.requestId);
  if (!requestId || value.schemaVersion !== 1 || value.status !== "pending") {
    throw new EventD1Failure("invalid-event-projection-outbox");
  }
  if (kind === "profile-game") {
    return {
      raw,
      status: "pending",
      requestId,
      lastQueuedAtMs: safeInteger(value.lastQueuedAtMs),
    };
  }
  const updatedAtMs = safeInteger(value.updatedAtMs);
  return {
    raw,
    status: "pending",
    requestId,
    firstQueuedAtMs: safeInteger(value.firstQueuedAtMs ?? updatedAtMs),
    updatedAtMs,
  };
}
