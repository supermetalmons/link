import { isSafeRecordKey } from "./recordKeys.ts";
import {
  normalizeEventTransitionReceiptRow,
  parseEventTransitionReceipt,
  serializeEventTransitionReceipt,
  type EventTransitionReceipt,
  type EventTransitionReceiptRow,
} from "./eventTransitionReceipts.ts";

export {
  normalizeEventTransitionReceiptRow,
  parseEventTransitionReceipt,
  serializeEventTransitionReceipt,
  type EventTransitionReceipt,
  type EventTransitionReceiptRow,
} from "./eventTransitionReceipts.ts";

export const EVENT_RECEIPT_ADMISSION_KIND = "event-effects-d1-receipts";

function fail(message = "invalid-event-transition-receipt"): never {
  throw new Error(message);
}

function safeKey(value: string): boolean {
  return value === value.trim() && isSafeRecordKey(value);
}

export async function readEventTransitionReceipt(
  db: D1Database,
  transitionId: string,
): Promise<EventTransitionReceipt | null> {
  if (!safeKey(transitionId)) return fail();
  const row = await db
    .withSession("first-primary")
    .prepare("SELECT * FROM event_transition_receipts WHERE transition_id = ?")
    .bind(transitionId)
    .first<EventTransitionReceiptRow>();
  if (!row) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.receipt_json);
  } catch {
    return fail();
  }
  const normalized = normalizeEventTransitionReceiptRow(
    transitionId,
    value,
    row.recorded_at_ms,
  );
  if (
    Object.keys(normalized).some(
      (key) =>
        normalized[key as keyof EventTransitionReceiptRow] !==
        row[key as keyof EventTransitionReceiptRow],
    )
  ) {
    return fail();
  }
  return parseEventTransitionReceipt(value, transitionId);
}

export function eventReceiptControlGuardStatements(
  db: D1Database,
): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO event_transition_receipt_guards (singleton)
    SELECT 0 WHERE NOT EXISTS (
      SELECT 1 FROM event_transition_receipt_control WHERE singleton = 1 AND state = 'active'
    )`),
  ];
}

export function eventTransitionReceiptGuardStatements(
  db: D1Database,
  expected: EventTransitionReceipt,
): D1PreparedStatement[] {
  const receipt = parseEventTransitionReceipt(expected);
  return [
    ...eventReceiptControlGuardStatements(db),
    db
      .prepare(
        `INSERT INTO event_transition_receipt_guards (singleton)
      SELECT 0 WHERE NOT EXISTS (
        SELECT 1 FROM event_transition_receipts WHERE transition_id = ? AND receipt_json = ?
      )`,
      )
      .bind(receipt.transitionId, serializeEventTransitionReceipt(receipt)),
  ];
}

export async function ensureEventTransitionReceipt(
  db: D1Database,
  expected: EventTransitionReceipt,
  options: {
    recordedAtMs: number;
    guards: () => D1PreparedStatement[];
    signal?: AbortSignal;
  },
): Promise<void> {
  const row = normalizeEventTransitionReceiptRow(
    expected.transitionId,
    expected,
    options.recordedAtMs,
  );
  options.signal?.throwIfAborted();
  let failure: unknown;
  try {
    await db.batch([
      ...eventReceiptControlGuardStatements(db),
      ...options.guards(),
      db
        .prepare(
          `INSERT INTO event_transition_receipts (
        transition_id, schema_version, event_id, expected_revision,
        payload_digest, receipt_json, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (transition_id) DO NOTHING`,
        )
        .bind(
          row.transition_id,
          row.schema_version,
          row.event_id,
          row.expected_revision,
          row.payload_digest,
          row.receipt_json,
          row.recorded_at_ms,
        ),
      ...eventTransitionReceiptGuardStatements(db, expected),
    ]);
  } catch (error) {
    failure = error;
  }
  const stored = await readEventTransitionReceipt(db, row.transition_id);
  if (stored && serializeEventTransitionReceipt(stored) !== row.receipt_json) {
    return fail("event-transition-receipt-conflict");
  }
  if (!stored) {
    throw failure ?? new Error("event-transition-receipt-unconfirmed");
  }
  if (failure) {
    options.signal?.throwIfAborted();
    await db.batch([
      ...eventReceiptControlGuardStatements(db),
      ...options.guards(),
    ]);
  }
}
