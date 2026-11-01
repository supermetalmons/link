export type EventProgressPendingRecord = {
  schemaVersion: 2;
  dataEpoch: 1;
  eventId: string;
  sourceKey: string;
  reason: string;
  runAtMs: number | null;
  firstQueuedAtMs: number;
  lastQueuedAtMs: number;
};
export type EventProgressWorkflowParams = {
  schemaVersion: 2;
  dataEpoch: 1;
  eventId: string;
  outboxId: string;
  reason: string;
  runAtMs: number | null;
  sourceKey: string;
};
export type RetainedEventProgressParams = EventProgressWorkflowParams;
export type EventProgressDeadLetter = {
  schemaVersion: 1;
  dataEpoch: 1;
  deadAtMs: number;
  sourceDigest: string;
  originalRecord: EventProgressPendingRecord | null;
  reason: "invalid-event-progress-outbox" | "canonical-data-cutover";
};
export type EventProgressRecordKind = "pending" | "dead";
export type EventProgressDocument<Kind extends EventProgressRecordKind> =
  Kind extends "pending" ? EventProgressPendingRecord : EventProgressDeadLetter;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  Array.from(value).every(
    (character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  );
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function readEventProgressPending(
  value: unknown,
): EventProgressPendingRecord | null {
  const keys = [
    "schemaVersion",
    "dataEpoch",
    "eventId",
    "sourceKey",
    "reason",
    "runAtMs",
    "firstQueuedAtMs",
    "lastQueuedAtMs",
  ];
  if (
    !object(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== 2 ||
    value.dataEpoch !== 1 ||
    !text(value.eventId) ||
    /[.#$/[\]\\]/.test(value.eventId) ||
    !text(value.sourceKey) ||
    !text(value.reason) ||
    !(value.runAtMs === null || integer(value.runAtMs)) ||
    !integer(value.firstQueuedAtMs) ||
    !integer(value.lastQueuedAtMs) ||
    value.lastQueuedAtMs < value.firstQueuedAtMs
  )
    return null;
  return value as EventProgressPendingRecord;
}
export function readEventProgressDeadLetter(
  value: unknown,
): EventProgressDeadLetter | null {
  const keys = [
    "schemaVersion",
    "dataEpoch",
    "deadAtMs",
    "sourceDigest",
    "originalRecord",
    "reason",
  ];
  if (
    !object(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== 1 ||
    value.dataEpoch !== 1 ||
    !integer(value.deadAtMs) ||
    typeof value.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
    !(
      value.originalRecord === null ||
      readEventProgressPending(value.originalRecord)
    ) ||
    (value.reason !== "invalid-event-progress-outbox" &&
      value.reason !== "canonical-data-cutover")
  )
    return null;
  return value as EventProgressDeadLetter;
}
export function retainEventProgressRecord<Kind extends EventProgressRecordKind>(
  kind: Kind,
  value: unknown,
): EventProgressDocument<Kind> {
  const result =
    kind === "pending"
      ? readEventProgressPending(value)
      : readEventProgressDeadLetter(value);
  if (!result) throw new TypeError("invalid-canonical-event-progress-record");
  return result as EventProgressDocument<Kind>;
}
