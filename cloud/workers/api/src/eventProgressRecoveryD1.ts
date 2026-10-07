import {
  EventD1Failure,
  type EventD1Connection,
  type EventWriteAdmission,
} from "./eventD1.ts";
import { eventWriteAdmissionGuard } from "./eventD1/guards.ts";
import { decodeJson, exactKey, safeInteger } from "./eventD1/validation.ts";

export type EventProgressRecoverySnapshot = {
  outboxId: string;
  record: unknown;
  recordJson: string;
  nextReconcileAtMs: number;
};

export type EventProgressRecoveryStore = {
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
};

type RecoveryRow = {
  outbox_id: string;
  record_json: string;
  next_reconcile_at_ms: number;
};

function snapshot(row: RecoveryRow): EventProgressRecoverySnapshot {
  return {
    outboxId: row.outbox_id,
    record: decodeJson(row.record_json),
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
  };
}
