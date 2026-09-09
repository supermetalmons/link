import { isSafeFirebaseKey } from "./firebaseKeys.ts";

type ReceiptIdentity = {
  transitionId: string;
  eventId: string;
  expectedRevision: number;
  [key: string]: unknown;
};

export type EventTransitionReceipt = ReceiptIdentity &
  (
    | { schemaVersion: 1; payloadDigest?: never }
    | { schemaVersion: 2; payloadDigest: string }
  );

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
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fail();
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return fail();
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function safeKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    isSafeFirebaseKey(value)
  );
}

export function parseEventTransitionReceipt(
  value: unknown,
  expectedKey?: string,
): EventTransitionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const record = value as Record<string, unknown>;
  if (
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
  try {
    return JSON.parse(canonicalJson(value)) as EventTransitionReceipt;
  } catch {
    return fail();
  }
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
