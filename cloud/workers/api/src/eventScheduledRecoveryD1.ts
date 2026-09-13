import {
  EventD1Failure,
  type EventD1Connection,
  type EventWriteAdmission,
} from "./eventD1.ts";
import { isSafeRecordKey } from "./recordKeys.ts";

export const SCHEDULED_EVENT_RECOVERY_PAGE_SIZE = 100;
export const SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT = 1_000;
export const SCHEDULED_EVENT_RECOVERY_MARGIN_MS = 10 * 60 * 1_000;

export type ScheduledEventRecoveryCursor = {
  startAtMs: number;
  eventId: string;
};

export type ScheduledEventRecoveryCandidate = {
  cursor: ScheduledEventRecoveryCursor;
  event: {
    eventId: string;
    status: "scheduled";
    startAtMs: number;
    isSundayMons: boolean;
  } | null;
};

export type EventScheduledRecoveryStore = {
  readCursor(): Promise<{
    cursor: ScheduledEventRecoveryCursor | null;
    revision: number;
  }>;
  listUrgent(throughMs: number): Promise<ScheduledEventRecoveryCandidate[]>;
  listPage(
    after: ScheduledEventRecoveryCursor | null,
  ): Promise<ScheduledEventRecoveryCandidate[]>;
  checkpoint(
    expectedRevision: number,
    next: ScheduledEventRecoveryCursor | null,
    nowMs: number,
  ): Promise<boolean>;
};

type CandidateRow = {
  event_id: string;
  start_at_ms: number;
  status: string;
  record_event_id: unknown;
  record_start_at_ms: unknown;
  record_status: unknown;
  is_sunday_mons: number;
};

const CANDIDATE_COLUMNS = `event_id, start_at_ms, status,
  json_extract(record_json, '$.eventId') AS record_event_id,
  json_extract(record_json, '$.startAtMs') AS record_start_at_ms,
  json_extract(record_json, '$.status') AS record_status,
  json_type(record_json, '$.isSundayMons') = 'true' AS is_sunday_mons`;
const CANDIDATE_ORDERING = `typeof(start_at_ms) IN ('integer', 'real')`;

function cursorFromRow(row: {
  start_at_ms: number;
  event_id: string;
}): ScheduledEventRecoveryCursor {
  if (
    typeof row.start_at_ms !== "number" ||
    !Number.isFinite(row.start_at_ms) ||
    row.start_at_ms < 0 ||
    typeof row.event_id !== "string" ||
    row.event_id.length === 0
  ) {
    throw new EventD1Failure("invalid-scheduled-event-recovery-cursor");
  }
  return { startAtMs: row.start_at_ms, eventId: row.event_id };
}

function candidateFromRow(row: CandidateRow): ScheduledEventRecoveryCandidate {
  const cursor = cursorFromRow(row);
  const valid =
    isSafeRecordKey(row.event_id) &&
    Number.isSafeInteger(row.start_at_ms) &&
    row.status === "scheduled" &&
    row.record_event_id === row.event_id &&
    row.record_start_at_ms === row.start_at_ms &&
    row.record_status === row.status;
  return {
    cursor,
    event: valid
      ? {
          ...cursor,
          status: "scheduled",
          isSundayMons: row.is_sunday_mons === 1,
        }
      : null,
  };
}

export function createEventScheduledRecoveryStore(
  db: EventD1Connection,
  admission: EventWriteAdmission,
): EventScheduledRecoveryStore {
  return {
    async readCursor() {
      const row = await db
        .prepare(
          `SELECT start_at_ms, event_id, revision
           FROM event_scheduled_recovery_cursor WHERE singleton = 1`,
        )
        .first<{
          start_at_ms: number | null;
          event_id: string | null;
          revision: number;
        }>();
      if (
        !row ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        (row.start_at_ms === null) !== (row.event_id === null)
      ) {
        throw new EventD1Failure("invalid-scheduled-event-recovery-cursor");
      }
      return {
        revision: row.revision,
        cursor:
          row.start_at_ms === null || row.event_id === null
            ? null
            : cursorFromRow({
                start_at_ms: row.start_at_ms,
                event_id: row.event_id,
              }),
      };
    },
    async listUrgent(throughMs) {
      const rows = await db
        .prepare(
          `SELECT ${CANDIDATE_COLUMNS} FROM event_records
           WHERE status = 'scheduled' AND ${CANDIDATE_ORDERING}
             AND start_at_ms >= 0 AND start_at_ms <= ?
           ORDER BY start_at_ms, event_id LIMIT ?`,
        )
        .bind(
          Math.min(throughMs, Number.MAX_SAFE_INTEGER),
          SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT,
        )
        .all<CandidateRow>();
      return rows.results.map(candidateFromRow);
    },
    async listPage(after) {
      const rows = await db
        .prepare(
          `SELECT ${CANDIDATE_COLUMNS} FROM event_records
           WHERE status = 'scheduled' AND ${CANDIDATE_ORDERING}
             AND start_at_ms <= 9007199254740991${after ? " AND (start_at_ms, event_id) > (?, ?)" : " AND start_at_ms >= 0"}
           ORDER BY start_at_ms, event_id LIMIT ?`,
        )
        .bind(
          ...(after ? [after.startAtMs, after.eventId] : []),
          SCHEDULED_EVENT_RECOVERY_PAGE_SIZE + 1,
        )
        .all<CandidateRow>();
      return rows.results.map(candidateFromRow);
    },
    async checkpoint(expectedRevision, next, nowMs) {
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO event_transaction_guards (singleton)
             SELECT 0 WHERE NOT EXISTS (
               SELECT 1 FROM event_write_admissions AS admission
               JOIN event_runtime_control AS control ON control.singleton = 1
               WHERE admission.admission_id = ?
                 AND admission.freeze_generation = ?
                 AND admission.freeze_generation = control.freeze_generation
                 AND admission.expires_at_ms > CAST(
                   (julianday('now') - 2440587.5) * 86400000 AS INTEGER
                 )
                 AND control.storage_mode = 'd1'
             )`,
          )
          .bind(admission.admissionId, admission.freezeGeneration),
        db
          .prepare(
            `UPDATE event_scheduled_recovery_cursor
             SET start_at_ms = ?, event_id = ?, revision = revision + 1,
                 updated_at_ms = ?
             WHERE singleton = 1 AND revision = ?`,
          )
          .bind(
            next?.startAtMs ?? null,
            next?.eventId ?? null,
            nowMs,
            expectedRevision,
          ),
      ]);
      return results[1].meta.changes === 1;
    },
  };
}
