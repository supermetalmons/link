import { isSafeRecordKey } from "./shared/ids.js";

export type EventProjectionOutboxKind = "profile-game" | "telegram";
export type EventProfileGameProjectionRequest = {
  schemaVersion: 1;
  status: "pending";
  requestId: string;
  lastQueuedAtMs: number;
  cleanupOwnerProfileIds?: Record<string, true>;
  reason?: string;
};
export type EventTelegramProjectionRequest = {
  schemaVersion: 1;
  status: "pending";
  requestId: string;
  firstQueuedAtMs: number;
  updatedAtMs: number;
};
type EventProjectionRequestMap = {
  "profile-game": EventProfileGameProjectionRequest;
  telegram: EventTelegramProjectionRequest;
};
export type EventProjectionDeadLetter<Kind extends EventProjectionOutboxKind> =
  {
    schemaVersion: 2;
    status: "dead";
    requestId: string;
    reason: "invalid-record";
    deadAtMs: number;
    sourceDigest: string;
    originalRecord: EventProjectionRequestMap[Kind] | null;
  };
export type EventProjectionOutboxDocument<
  Kind extends EventProjectionOutboxKind,
> = EventProjectionRequestMap[Kind] | EventProjectionDeadLetter<Kind>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
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
export function isEventProjectionPending<
  Kind extends EventProjectionOutboxKind,
>(kind: Kind, value: unknown): value is EventProjectionRequestMap[Kind] {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.status !== "pending" ||
    !key(value.requestId)
  )
    return false;
  if (kind === "profile-game")
    return (
      exact(
        value,
        ["schemaVersion", "status", "requestId", "lastQueuedAtMs"],
        ["cleanupOwnerProfileIds", "reason"],
      ) &&
      integer(value.lastQueuedAtMs) &&
      (!Object.hasOwn(value, "reason") || typeof value.reason === "string") &&
      (!Object.hasOwn(value, "cleanupOwnerProfileIds") ||
        (record(value.cleanupOwnerProfileIds) &&
          Object.entries(value.cleanupOwnerProfileIds).every(
            ([profileId, included]) => key(profileId) && included === true,
          )))
    );
  return (
    exact(value, [
      "schemaVersion",
      "status",
      "requestId",
      "firstQueuedAtMs",
      "updatedAtMs",
    ]) &&
    integer(value.firstQueuedAtMs) &&
    integer(value.updatedAtMs) &&
    value.updatedAtMs >= value.firstQueuedAtMs
  );
}
export function isEventProjectionOutbox<Kind extends EventProjectionOutboxKind>(
  kind: Kind,
  value: unknown,
): value is EventProjectionOutboxDocument<Kind> {
  if (isEventProjectionPending(kind, value)) return true;
  return (
    record(value) &&
    exact(value, [
      "schemaVersion",
      "status",
      "requestId",
      "reason",
      "deadAtMs",
      "sourceDigest",
      "originalRecord",
    ]) &&
    value.schemaVersion === 2 &&
    value.status === "dead" &&
    key(value.requestId) &&
    value.reason === "invalid-record" &&
    integer(value.deadAtMs) &&
    typeof value.sourceDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.sourceDigest) &&
    (value.originalRecord === null ||
      (isEventProjectionPending(kind, value.originalRecord) &&
        value.originalRecord.requestId === value.requestId))
  );
}
export function retainEventProjectionOutbox<
  Kind extends EventProjectionOutboxKind,
>(kind: Kind, value: unknown): EventProjectionOutboxDocument<Kind> {
  if (!isEventProjectionOutbox(kind, value))
    throw new TypeError("invalid-event-projection-outbox");
  return structuredClone(value);
}
export function createEventProfileGameProjectionRequest(
  value: EventProfileGameProjectionRequest,
): EventProfileGameProjectionRequest {
  if (!isEventProjectionPending("profile-game", value))
    throw new TypeError("invalid-event-projection-outbox");
  return structuredClone(value);
}
export function createEventTelegramProjectionRequest(
  value: EventTelegramProjectionRequest,
): EventTelegramProjectionRequest {
  if (!isEventProjectionPending("telegram", value))
    throw new TypeError("invalid-event-projection-outbox");
  return structuredClone(value);
}
