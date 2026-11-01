import {
  readEventProgressPending,
  type EventProgressDocument,
} from "../../../../runtime/eventProgressRecords.js";
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
import {
  isEventPrizeId,
  isEventPrizeAssignmentWireRecord,
} from "@mons/shared/event-prizes";
import { isEventRecord } from "@mons/shared/events";
import { parseEventTransitionIntent } from "../eventTransitionCodec.ts";

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

function isJsonValue(value: unknown, depth = 0): boolean {
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
  if (
    !exactKey(eventId) ||
    !isEventRecord(value) ||
    value.eventId !== eventId
  ) {
    throw new EventD1Failure("invalid-event-record");
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
  if (
    !normalizedProfileId ||
    !normalizedEventId ||
    !isEventPrizeAssignmentWireRecord(value) ||
    value.profileId !== normalizedProfileId ||
    value.eventId !== normalizedEventId
  ) {
    throw new EventD1Failure("invalid-event-prize-assignment");
  }
  return cloneJson(value);
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
    event.updatedAtMs !== row.updated_at_ms ||
    (row.pending_transition_id !== null && !exactKey(row.pending_transition_id))
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
  try {
    return parseEventTransitionIntent(input);
  } catch (cause) {
    throw new EventD1Failure("invalid-event-transition", { cause });
  }
}

export function validateEventProgressOutbox(
  outboxId: string,
  value: unknown,
): EventProgressDocument<"pending"> {
  const record = readEventProgressPending(value);
  if (!exactKey(outboxId) || !record)
    throw new EventD1Failure("invalid-event-progress-outbox");
  return record;
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
  exactKey(eventId);
  let raw: EventProjectionOutboxDocument<Kind>;
  try {
    raw = retainEventProjectionOutbox(kind, value);
  } catch (cause) {
    throw new EventD1Failure("invalid-event-projection-outbox", { cause });
  }
  if (raw.status === "dead")
    return {
      raw,
      status: "dead",
      requestId: raw.requestId,
      ...(kind === "profile-game"
        ? { lastQueuedAtMs: raw.deadAtMs }
        : { firstQueuedAtMs: raw.deadAtMs, updatedAtMs: raw.deadAtMs }),
    };
  if (kind === "profile-game") {
    if (!("lastQueuedAtMs" in raw))
      throw new EventD1Failure("invalid-event-projection-outbox");
    return {
      raw,
      status: "pending",
      requestId: raw.requestId,
      lastQueuedAtMs: raw.lastQueuedAtMs,
    };
  }
  if (!("firstQueuedAtMs" in raw))
    throw new EventD1Failure("invalid-event-projection-outbox");
  return {
    raw,
    status: "pending",
    requestId: raw.requestId,
    firstQueuedAtMs: raw.firstQueuedAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}
