import { EVENT_PRIZE_CONFIGS } from "@mons/shared/event-prizes";
import {
  EventD1Failure,
  type EventD1Connection,
  type EventWriteAdmission,
} from "./eventD1.ts";
import { eventWriteAdmissionGuard } from "./eventD1/guards.ts";
import {
  EVENT_ANNOUNCEMENT_KINDS,
  EVENT_ANNOUNCEMENT_SPECS,
  eventAnnouncementRunAtMs,
  type EventAnnouncementKind,
} from "./eventAnnouncementKinds.ts";
import { isSafeRecordKey } from "./recordKeys.ts";

export const SCHEDULED_EVENT_RECOVERY_PAGE_SIZE = 100;
export const SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT = 800;
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
  listUrgent(
    throughMs: number,
    nowMs?: number,
  ): Promise<ScheduledEventRecoveryCandidate[]>;
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
  announcement_covered?: number;
};

const CANDIDATE_COLUMNS = `event_id, start_at_ms, status,
  json_extract(record_json, '$.eventId') AS record_event_id,
  json_extract(record_json, '$.startAtMs') AS record_start_at_ms,
  json_extract(record_json, '$.status') AS record_status,
  json_type(record_json, '$.isSundayMons') = 'true' AS is_sunday_mons`;
const CANDIDATE_ORDERING = `typeof(start_at_ms) IN ('integer', 'real')`;
const PRIZE_EVENT_IDS = Object.keys(EVENT_PRIZE_CONFIGS);

function announcementCoverage(kind: EventAnnouncementKind): string {
  const { leadMs, reason } = EVENT_ANNOUNCEMENT_SPECS[kind];
  const supportedLeads = kind === "reminder" ? [leadMs, 10_800_000] : [leadMs];
  // A positive checkpoint follows dispatch validation; payload changes reset it.
  return `EXISTS (
    SELECT 1 FROM event_progress_outboxes_canonical AS outbox
    INDEXED BY idx_event_progress_outboxes_canonical_event
    WHERE outbox.event_id = event_records_canonical.event_id
      AND outbox.status = 'pending'
      AND outbox.next_reconcile_at_ms > 0
      AND event_records_canonical.start_at_ms - outbox.run_at_ms IN (${supportedLeads.join(", ")})
      AND json_extract(outbox.record_json, '$.eventId') = event_records_canonical.event_id
      AND json_type(outbox.record_json, '$.schemaVersion') = 'integer'
      AND json_extract(outbox.record_json, '$.schemaVersion') = 2
      AND json_extract(outbox.record_json, '$.dataEpoch') = 1
      AND json_extract(outbox.record_json, '$.reason') = '${reason}'
      AND json_extract(outbox.record_json, '$.runAtMs') = outbox.run_at_ms
      AND json_extract(outbox.record_json, '$.sourceKey') =
        '${kind}:' || event_records_canonical.event_id || ':' || event_records_canonical.start_at_ms
  )`;
}

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
    async listUrgent(throughMs, nowMs = Date.now()) {
      const cutoff = Math.min(throughMs, Number.MAX_SAFE_INTEGER);
      const missingAnnouncements = new Set<string>();
      const queries = [
        db
          .prepare(
            `SELECT ${CANDIDATE_COLUMNS} FROM event_records_canonical
           WHERE status = 'scheduled' AND ${CANDIDATE_ORDERING}
             AND start_at_ms >= 0 AND start_at_ms <= ?
           ORDER BY start_at_ms, event_id LIMIT ?`,
          )
          .bind(cutoff, SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT)
          .all<CandidateRow>()
          .then(({ results }) => results),
      ];
      for (const kind of EVENT_ANNOUNCEMENT_KINDS) {
        const from = Math.max(0, nowMs + EVENT_ANNOUNCEMENT_SPECS[kind].leadMs);
        const through = Math.min(
          cutoff,
          from + SCHEDULED_EVENT_RECOVERY_MARGIN_MS,
        );
        if (from > through) continue;
        if (kind === "prizes") {
          if (PRIZE_EVENT_IDS.length === 0) continue;
          queries.push(
            db
              .prepare(
                `SELECT ${CANDIDATE_COLUMNS},
                   ${announcementCoverage(kind)} AS announcement_covered
                 FROM event_records_canonical
                 WHERE event_id IN (SELECT value FROM json_each(?))`,
              )
              .bind(JSON.stringify(PRIZE_EVENT_IDS))
              .all<CandidateRow>()
              .then(({ results }) => {
                const rows = results.filter(
                  (row) =>
                    row.status === "scheduled" &&
                    row.is_sunday_mons === 1 &&
                    typeof row.start_at_ms === "number" &&
                    row.start_at_ms >= from &&
                    row.start_at_ms <= through,
                );
                for (const row of rows) {
                  if (row.announcement_covered !== 1)
                    missingAnnouncements.add(row.event_id);
                }
                return rows;
              }),
          );
        } else {
          queries.push(
            db
              .prepare(
                `SELECT ${CANDIDATE_COLUMNS} FROM event_records_canonical
                 INDEXED BY idx_event_records_canonical_scheduled_sunday_start
                 WHERE status = 'scheduled' AND ${CANDIDATE_ORDERING}
                   AND json_type(record_json, '$.isSundayMons') = 'true'
                   AND start_at_ms >= ? AND start_at_ms <= ?
                   AND NOT ${announcementCoverage(kind)}
                 ORDER BY start_at_ms, event_id LIMIT ?`,
              )
              .bind(from, through, SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT)
              .all<CandidateRow>()
              .then(({ results }) => {
                for (const row of results)
                  missingAnnouncements.add(row.event_id);
                return results;
              }),
          );
          queries.push(
            db
              .prepare(
                `SELECT ${CANDIDATE_COLUMNS} FROM event_records_canonical
                 INDEXED BY idx_event_records_canonical_scheduled_sunday_start
                 WHERE status = 'scheduled' AND ${CANDIDATE_ORDERING}
                   AND json_type(record_json, '$.isSundayMons') = 'true'
                   AND start_at_ms >= ? AND start_at_ms <= ?
                 ORDER BY start_at_ms, event_id LIMIT ?`,
              )
              .bind(from, through, SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT)
              .all<CandidateRow>()
              .then(({ results }) => results),
          );
        }
      }
      const results = await Promise.all(queries);
      const candidates = new Map(
        results.flatMap((rows) =>
          rows.map((row) => [row.event_id, candidateFromRow(row)] as const),
        ),
      );
      return [...candidates.values()]
        .map((candidate) => {
          const announcementAtMs = Math.min(
            ...EVENT_ANNOUNCEMENT_KINDS.map(
              (kind) =>
                eventAnnouncementRunAtMs(
                  candidate.cursor.eventId,
                  candidate.event,
                  nowMs,
                  kind,
                ) ?? Infinity,
            ),
          );
          const urgentAnnouncement =
            announcementAtMs <= nowMs + SCHEDULED_EVENT_RECOVERY_MARGIN_MS;
          return {
            candidate,
            priority: urgentAnnouncement
              ? missingAnnouncements.has(candidate.cursor.eventId)
                ? 0
                : 1
              : 2,
            deadline: urgentAnnouncement
              ? announcementAtMs
              : candidate.cursor.startAtMs,
          };
        })
        .sort(
          (left, right) =>
            left.priority - right.priority ||
            left.deadline - right.deadline ||
            left.candidate.cursor.startAtMs -
              right.candidate.cursor.startAtMs ||
            (left.candidate.cursor.eventId < right.candidate.cursor.eventId
              ? -1
              : left.candidate.cursor.eventId > right.candidate.cursor.eventId
                ? 1
                : 0),
        )
        .slice(0, SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT)
        .map(({ candidate }) => candidate);
    },
    async listPage(after) {
      const rows = await db
        .prepare(
          `SELECT ${CANDIDATE_COLUMNS} FROM event_records_canonical
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
        eventWriteAdmissionGuard(db, admission),
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
      return results[1]!.meta.changes === 1;
    },
  };
}
