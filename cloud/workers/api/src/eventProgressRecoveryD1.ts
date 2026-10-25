import {
  retainEventProgressRecord,
  type EventProgressDocument,
  type EventProgressDeadLetter,
} from "../../../runtime/eventProgressRecords.js";
import {
  EventD1Failure,
  type EventD1Connection,
  type EventWriteAdmission,
} from "./eventD1.ts";
import { eventWriteAdmissionGuard } from "./eventD1/guards.ts";
import {
  decodeJson,
  encodeJson,
  exactKey,
  isRecord,
  safeInteger,
  validateEventProgressOutbox,
} from "./eventD1/validation.ts";
import {
  parseEventProgressOutbox,
  type EventProgressPlan,
} from "./eventProgressCodec.ts";

export type EventProgressRecoverySnapshot = {
  outboxId: string;
  record: EventProgressDocument<"pending">;
  recordJson: string;
  nextReconcileAtMs: number;
};

export type EventProgressRecoveryStore = {
  ensureScheduledStart(
    plan: EventProgressPlan,
  ): Promise<EventProgressRecoverySnapshot>;
  listDue(
    nowMs: number,
    limit: number,
  ): Promise<EventProgressRecoverySnapshot[]>;
  read(outboxId: string): Promise<EventProgressRecoverySnapshot | null>;
  checkpoint(
    snapshot: EventProgressRecoverySnapshot,
    nextReconcileAtMs: number,
  ): Promise<boolean>;
  remove(snapshot: EventProgressRecoverySnapshot): Promise<boolean>;
  deadLetter(
    snapshot: EventProgressRecoverySnapshot,
    deadAtMs: number,
  ): Promise<boolean>;
};

type RecoveryRow = {
  outbox_id: string;
  record_json: string;
  next_reconcile_at_ms: number;
};

function snapshot(row: RecoveryRow): EventProgressRecoverySnapshot {
  return {
    outboxId: row.outbox_id,
    record: retainEventProgressRecord("pending", decodeJson(row.record_json)),
    recordJson: row.record_json,
    nextReconcileAtMs: safeInteger(row.next_reconcile_at_ms),
  };
}

export function createEventProgressRecoveryStore(
  db: EventD1Connection,
  admission: EventWriteAdmission,
): EventProgressRecoveryStore {
  const mutate = async (statement: D1PreparedStatement): Promise<boolean> => {
    const results = await db.batch([
      eventWriteAdmissionGuard(db, admission),
      statement,
    ]);
    const changes = results[1]?.meta.changes;
    if (changes !== 0 && changes !== 1) throw new EventD1Failure();
    return changes === 1;
  };
  return {
    async ensureScheduledStart(plan) {
      const record = validateEventProgressOutbox(plan.outboxId, plan.outbox);
      const parsed = await parseEventProgressOutbox(plan.outboxId, record);
      if (
        !parsed ||
        parsed.params.reason !== "scheduled-start-reconciliation" ||
        parsed.params.runAtMs === null ||
        parsed.params.sourceKey !==
          `start:${parsed.params.eventId}:${parsed.params.runAtMs}` ||
        parsed.workflowId !== plan.workflowId ||
        Object.keys(parsed.params).length !== Object.keys(plan.params).length ||
        Object.entries(parsed.params).some(
          ([key, value]) =>
            plan.params[key as keyof EventProgressPlan["params"]] !== value,
        )
      ) {
        throw new EventD1Failure("invalid-scheduled-start-plan");
      }
      const results = await db.batch<RecoveryRow>([
        eventWriteAdmissionGuard(db, admission),
        db
          .prepare(
            `INSERT INTO event_progress_outboxes (
               outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
               record_json
             ) VALUES (?, ?, 'pending', ?, ?, ?)
             ON CONFLICT (status, outbox_id) DO NOTHING`,
          )
          .bind(
            parsed.outboxId,
            record.eventId,
            record.runAtMs,
            record.lastQueuedAtMs,
            encodeJson(record),
          ),
        db
          .prepare(
            `SELECT outbox_id, record_json, next_reconcile_at_ms
             FROM event_progress_outboxes
             WHERE status = 'pending' AND outbox_id = ?`,
          )
          .bind(parsed.outboxId),
      ]);
      const rows = results[2]?.results;
      if (rows?.length !== 1) throw new EventD1Failure();
      return snapshot(rows[0]);
    },
    async listDue(nowMs, limit) {
      const rows = await db
        .prepare(
          `SELECT outbox_id, record_json, next_reconcile_at_ms
           FROM event_progress_outboxes
           WHERE status = 'pending' AND next_reconcile_at_ms <= ?
           ORDER BY next_reconcile_at_ms, last_queued_at_ms, outbox_id
           LIMIT ?`,
        )
        .bind(safeInteger(nowMs), Math.min(safeInteger(limit, 1), 100))
        .all<RecoveryRow>();
      return rows.results.map(snapshot);
    },
    async read(outboxId) {
      const row = await db
        .prepare(
          `SELECT outbox_id, record_json, next_reconcile_at_ms
           FROM event_progress_outboxes
           WHERE status = 'pending' AND outbox_id = ?`,
        )
        .bind(exactKey(outboxId))
        .first<RecoveryRow>();
      return row ? snapshot(row) : null;
    },
    checkpoint(current, nextReconcileAtMs) {
      const next = safeInteger(nextReconcileAtMs);
      return mutate(
        db
          .prepare(
            `UPDATE event_progress_outboxes
             SET next_reconcile_at_ms = ?
             WHERE status = 'pending' AND outbox_id = ? AND record_json = ?
               AND (next_reconcile_at_ms = ? OR next_reconcile_at_ms > ?)`,
          )
          .bind(
            next,
            exactKey(current.outboxId),
            current.recordJson,
            safeInteger(current.nextReconcileAtMs),
            next,
          ),
      );
    },
    remove(current) {
      return mutate(
        db
          .prepare(
            `DELETE FROM event_progress_outboxes
             WHERE status = 'pending' AND outbox_id = ? AND record_json = ?`,
          )
          .bind(exactKey(current.outboxId), current.recordJson),
      );
    },
    async deadLetter(current, deadAtMs) {
      const outboxId = exactKey(current.outboxId);
      if (!outboxId) throw new EventD1Failure("invalid-event-path");
      const timestamp = safeInteger(deadAtMs);
      const eventId = isRecord(current.record)
        ? exactKey((current.record as { eventId?: unknown }).eventId)
        : "";
      const deadRecord = encodeJson({
        deadAtMs: timestamp,
        originalRecord: current.record === undefined ? null : current.record,
        reason: "invalid-event-progress-outbox",
      } satisfies EventProgressDeadLetter);
      const results = await db.batch([
        eventWriteAdmissionGuard(db, admission),
        db
          .prepare(
            `INSERT INTO event_progress_outboxes (
               outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
               record_json
             )
             SELECT outbox_id, (
               SELECT event_id FROM event_records WHERE event_id = ?
             ), 'dead', NULL, ?, ?
             FROM event_progress_outboxes
             WHERE status = 'pending' AND outbox_id = ? AND record_json = ?
             ON CONFLICT (status, outbox_id) DO UPDATE SET
               event_id = excluded.event_id,
               run_at_ms = NULL,
               last_queued_at_ms = excluded.last_queued_at_ms,
               record_json = excluded.record_json
             RETURNING outbox_id`,
          )
          .bind(
            eventId || null,
            timestamp,
            deadRecord,
            outboxId,
            current.recordJson,
          ),
        db
          .prepare(
            `DELETE FROM event_progress_outboxes
             WHERE status = 'pending' AND outbox_id = ? AND record_json = ?
             RETURNING outbox_id`,
          )
          .bind(outboxId, current.recordJson),
      ]);
      const archived = results[1]?.results.length;
      const removed = results[2]?.results.length;
      if (archived === 0 && removed === 0) return false;
      if (archived === 1 && removed === 1) return true;
      throw new EventD1Failure();
    },
  };
}
