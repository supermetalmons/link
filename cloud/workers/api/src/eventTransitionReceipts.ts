import { isSafeRecordKey } from "./recordKeys.ts";
import { canonicalReceiptJson } from "./canonicalJson.ts";

type ReceiptIdentity = {
  transitionId: string;
  eventId: string;
  expectedRevision: number;
};

export type EventTransitionReceipt = ReceiptIdentity &
  (
    | { schemaVersion: 1; payloadDigest?: never }
    | { schemaVersion: 2; payloadDigest: string }
  );

export type RetainedEventTransitionReceipt = EventTransitionReceipt;

export type EventTransitionReceiptRow = {
  transition_id: string;
  schema_version: 1 | 2;
  event_id: string;
  expected_revision: number;
  payload_digest: string | null;
  receipt_json: string;
  recorded_at_ms: number;
};

function fail(message = "invalid-event-transition-receipt"): never {
  throw new Error(message);
}

function canonicalJson(value: unknown): string {
  return canonicalReceiptJson(value, fail);
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function safeKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    isSafeRecordKey(value)
  );
}

export function parseEventTransitionReceipt(
  value: unknown,
  expectedKey?: string,
): RetainedEventTransitionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const record = value as Record<string, unknown>;
  const allowed =
    record.schemaVersion === 1
      ? ["schemaVersion", "transitionId", "eventId", "expectedRevision"]
      : [
          "schemaVersion",
          "transitionId",
          "eventId",
          "expectedRevision",
          "payloadDigest",
        ];
  if (
    Object.keys(record).length !== allowed.length ||
    allowed.some((field) => !Object.hasOwn(record, field)) ||
    (record.schemaVersion !== 1 && record.schemaVersion !== 2) ||
    !safeKey(record.transitionId) ||
    !safeKey(record.eventId) ||
    !safeInteger(record.expectedRevision, 1) ||
    (expectedKey !== undefined && record.transitionId !== expectedKey) ||
    (record.schemaVersion === 1 && Object.hasOwn(record, "payloadDigest")) ||
    (record.schemaVersion === 2 &&
      (typeof record.payloadDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.payloadDigest)))
  )
    return fail();
  const identity = {
    transitionId: record.transitionId,
    eventId: record.eventId,
    expectedRevision: record.expectedRevision,
  };
  if (record.schemaVersion === 1) return { schemaVersion: 1, ...identity };
  if (typeof record.payloadDigest !== "string") return fail();
  return { schemaVersion: 2, ...identity, payloadDigest: record.payloadDigest };
}

export function serializeEventTransitionReceipt(value: unknown): string {
  return canonicalJson(parseEventTransitionReceipt(value));
}

export function normalizeEventTransitionReceiptRow(
  transitionId: string,
  value: unknown,
  recordedAtMs: number,
): EventTransitionReceiptRow {
  if (!safeInteger(recordedAtMs)) return fail();
  const receipt = parseEventTransitionReceipt(value, transitionId);
  return {
    transition_id: receipt.transitionId,
    schema_version: receipt.schemaVersion,
    event_id: receipt.eventId,
    expected_revision: receipt.expectedRevision,
    payload_digest: receipt.schemaVersion === 2 ? receipt.payloadDigest : null,
    receipt_json: canonicalJson(receipt),
    recorded_at_ms: recordedAtMs,
  };
}
