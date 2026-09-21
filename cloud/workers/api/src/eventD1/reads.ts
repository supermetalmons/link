import {
  type EventD1Connection,
  type DecodedEventRow,
  EventD1Failure,
  type EventRow,
  type ConditionalSnapshot,
  type StoredEventSnapshot,
  type AssignmentRow,
  type ProfilePrizeAssignmentSnapshot,
  type EventLeaseRecord,
  type EventSyncThrottleRecord,
  type EventOutboxRecord,
  type ProgressOutboxSnapshot,
  type TelegramProjectionState,
} from "./types.ts";
import {
  exactKey,
  decodeEventRow,
  parseStoredPrizeSelection,
  safeInteger,
  EVENT_STATUSES,
  parseStoredEventPrizeAssignment,
  decodeJson,
  isRecord,
} from "./validation.ts";
import type {
  EventJsonRecord,
  EventSnapshot,
  ProfileEventPrizeSnapshot,
  EventPrizeAssignmentRecord,
  ProfileEventPrizePageQuery,
} from "../../../../runtime/eventReads.js";

export async function readEventRecord(
  db: EventD1Connection,
  eventId: string,
): Promise<DecodedEventRow | null> {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId) throw new EventD1Failure("invalid-event-id");
  const row = await db
    .prepare(
      `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
              pending_transition_id, record_json
       FROM event_records WHERE event_id = ?`,
    )
    .bind(normalizedEventId)
    .first<EventRow>();
  return row ? decodeEventRow(row) : null;
}

export async function readSelections(
  db: EventD1Connection,
  eventId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .prepare(
      `SELECT profile_id, prize_id FROM event_prize_selections
       WHERE event_id = ? ORDER BY profile_id`,
    )
    .bind(eventId)
    .all<{ prize_id: string; profile_id: string }>();
  return selectionsFromRows(eventId, rows.results);
}

export async function readEvent(
  db: EventD1Connection,
  eventId: string,
): Promise<EventJsonRecord | null> {
  return (await readEventRecord(db, eventId))?.event ?? null;
}

export async function readEventPrizeSelections(
  db: EventD1Connection,
  eventId: string,
): Promise<Record<string, string>> {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId) throw new EventD1Failure("invalid-event-id");
  return readSelections(db, normalizedEventId);
}

function selectionsFromRows(
  eventId: string,
  rows: Array<{ prize_id: string; profile_id: string }>,
): Record<string, string> {
  const selections: Record<string, string> = {};
  for (const row of rows) {
    const profileId = exactKey(row.profile_id);
    if (!profileId) throw new EventD1Failure();
    selections[profileId] = parseStoredPrizeSelection(row.prize_id);
  }
  return selections;
}

export async function readEventSnapshot(
  db: EventD1Connection,
  eventId: string,
): Promise<EventSnapshot> {
  const result = await readEventSnapshotIfChanged(db, eventId);
  if (result.notModified) throw new EventD1Failure();
  return result.snapshot;
}

export async function readEventSnapshotIfChanged(
  db: EventD1Connection,
  eventId: string,
  knownRevision: number | null = null,
): Promise<ConditionalSnapshot<EventSnapshot>> {
  const result = await readStoredEventSnapshotIfChanged(
    db,
    eventId,
    knownRevision,
  );
  if (result.notModified) return result;
  const {
    event,
    eventId: storedEventId,
    prizeSelections,
    revision,
  } = result.snapshot;
  return {
    notModified: false,
    snapshot: { event, eventId: storedEventId, prizeSelections, revision },
  };
}

export async function readStoredEventSnapshotIfChanged(
  db: EventD1Connection,
  eventId: string,
  knownRevision: number | null = null,
): Promise<ConditionalSnapshot<StoredEventSnapshot>> {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId) throw new EventD1Failure("invalid-event-id");
  if (knownRevision !== null) safeInteger(knownRevision);
  const results = await db.batch([
    db
      .prepare(
        `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
                pending_transition_id,
                CASE WHEN revision = ? THEN NULL ELSE record_json END AS record_json
         FROM event_records WHERE event_id = ?`,
      )
      .bind(knownRevision, normalizedEventId),
    db
      .prepare(
        `SELECT profile_id, prize_id FROM event_prize_selections
         WHERE event_id = CASE WHEN EXISTS (
           SELECT 1 FROM event_records WHERE event_id = ? AND revision = ?
         ) THEN NULL ELSE ? END ORDER BY profile_id`,
      )
      .bind(normalizedEventId, knownRevision, normalizedEventId),
  ]);
  const row = results[0].results[0] as EventRow | undefined;
  if (!row) {
    if (knownRevision === 0) return { notModified: true, revision: 0 };
    return {
      notModified: false,
      snapshot: {
        event: null,
        eventId: normalizedEventId,
        pendingTransitionId: null,
        prizeSelections: {},
        revision: 0,
      },
    };
  }
  if (knownRevision !== null && row.revision === knownRevision) {
    if (
      exactKey(row.event_id) !== normalizedEventId ||
      !EVENT_STATUSES.has(row.status)
    ) {
      throw new EventD1Failure("event-row-mismatch");
    }
    safeInteger(row.start_at_ms);
    safeInteger(row.updated_at_ms);
    return { notModified: true, revision: safeInteger(row.revision, 1) };
  }
  const state = decodeEventRow(row);
  return {
    notModified: false,
    snapshot: {
      event: state.event,
      eventId: normalizedEventId,
      pendingTransitionId: state.pendingTransitionId,
      prizeSelections: selectionsFromRows(
        normalizedEventId,
        results[1].results as Array<{ prize_id: string; profile_id: string }>,
      ),
      revision: state.revision,
    },
  };
}

export async function listEventAggregates(
  db: EventD1Connection,
  input: {
    limit?: number;
    status?: "scheduled" | "active" | "ended" | "dismissed";
  } = {},
): Promise<Record<string, EventJsonRecord>> {
  const limit = Math.min(safeInteger(input.limit ?? 1_000, 1), 1_000);
  const rows = input.status
    ? await db
        .prepare(
          `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
                  pending_transition_id, record_json
           FROM event_records WHERE status = ?
           ORDER BY start_at_ms, event_id LIMIT ?`,
        )
        .bind(input.status, limit)
        .all<EventRow>()
    : await db
        .prepare(
          `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
                  pending_transition_id, record_json
           FROM event_records ORDER BY updated_at_ms, event_id LIMIT ?`,
        )
        .bind(limit)
        .all<EventRow>();
  return Object.fromEntries(
    rows.results.map((row) => [row.event_id, decodeEventRow(row).event]),
  );
}

export async function readProfileEventPrizes(
  db: EventD1Connection,
  profileId: string,
): Promise<ProfileEventPrizeSnapshot> {
  const result = await readProfileEventPrizesIfChanged(db, profileId);
  if (result.notModified) throw new EventD1Failure();
  return result.snapshot;
}

export async function readProfileEventPrizesIfChanged(
  db: EventD1Connection,
  profileId: string,
  knownRevision: number | null = null,
): Promise<ConditionalSnapshot<ProfileEventPrizeSnapshot>> {
  const normalizedProfileId = exactKey(profileId);
  if (!normalizedProfileId) throw new EventD1Failure("invalid-profile-id");
  if (knownRevision !== null) safeInteger(knownRevision);
  const results = await db.batch([
    db
      .prepare(
        `SELECT profile_id, event_id, assignment_json
         FROM profile_event_prizes
         WHERE profile_id = CASE WHEN EXISTS (
           SELECT 1 FROM profile_event_prize_revisions
           WHERE profile_id = ? AND revision = ?
         ) THEN NULL ELSE ? END ORDER BY event_id`,
      )
      .bind(normalizedProfileId, knownRevision, normalizedProfileId),
    db
      .prepare(
        `SELECT revision FROM profile_event_prize_revisions
         WHERE profile_id = ?`,
      )
      .bind(normalizedProfileId),
  ]);
  const revisionRow = results[1].results[0] as { revision: number } | undefined;
  const revision = revisionRow ? safeInteger(revisionRow.revision, 1) : 0;
  if (revisionRow && knownRevision === revision) {
    return { notModified: true, revision };
  }
  const prizes: Record<string, EventPrizeAssignmentRecord> = {};
  for (const row of results[0].results as AssignmentRow[]) {
    prizes[row.event_id] = parseStoredEventPrizeAssignment(
      normalizedProfileId,
      row.event_id,
      decodeJson(row.assignment_json),
    );
  }
  if (knownRevision === revision) return { notModified: true, revision };
  return {
    notModified: false,
    snapshot: { prizes, profileId: normalizedProfileId, revision },
  };
}

export async function readProfileEventPrizeAssignment(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
): Promise<EventPrizeAssignmentRecord | null> {
  const normalizedProfileId = exactKey(profileId);
  if (!normalizedProfileId) throw new EventD1Failure("invalid-profile-id");
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId) throw new EventD1Failure("invalid-event-id");
  const row = await db
    .prepare(
      `SELECT assignment_json FROM profile_event_prizes
       WHERE profile_id = ? AND event_id = ?`,
    )
    .bind(normalizedProfileId, normalizedEventId)
    .first<{ assignment_json: string }>();
  return row
    ? parseStoredEventPrizeAssignment(
        normalizedProfileId,
        normalizedEventId,
        decodeJson(row.assignment_json),
      )
    : null;
}

export async function listProfileEventPrizeAssignments(
  db: EventD1Connection,
  profileId: string,
  query: ProfileEventPrizePageQuery = {},
): Promise<Record<string, EventPrizeAssignmentRecord>> {
  const normalizedProfileId = exactKey(profileId);
  if (!normalizedProfileId) throw new EventD1Failure("invalid-profile-id");
  const startAt = typeof query.startAt === "string" ? query.startAt : "";
  const limit = safeInteger(query.limit || 100, 1);
  const ascii = /^[\x20-\x7e]*$/;
  let rows = ascii.test(startAt)
    ? (
        await db
          .prepare(
            `SELECT profile_id, event_id, assignment_json
             FROM profile_event_prizes
             WHERE profile_id = ? AND event_id >= ?
             ORDER BY event_id LIMIT ?`,
          )
          .bind(normalizedProfileId, startAt, limit)
          .all<AssignmentRow>()
      ).results
    : null;
  // Existing recovery cursors use JavaScript's UTF-16 ordering.
  if (rows === null || rows.some((row) => !ascii.test(row.event_id))) {
    const stored = await db
      .prepare(
        `SELECT profile_id, event_id, assignment_json
         FROM profile_event_prizes WHERE profile_id = ?`,
      )
      .bind(normalizedProfileId)
      .all<AssignmentRow>();
    rows = stored.results
      .filter((row) => row.event_id >= startAt)
      .sort((left, right) =>
        left.event_id < right.event_id
          ? -1
          : left.event_id > right.event_id
            ? 1
            : 0,
      )
      .slice(0, limit);
  }
  return Object.fromEntries(
    rows.map((row) => [
      row.event_id,
      parseStoredEventPrizeAssignment(
        normalizedProfileId,
        row.event_id,
        decodeJson(row.assignment_json),
      ),
    ]),
  );
}

export async function readProfilePrizeAssignmentSnapshot(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
): Promise<ProfilePrizeAssignmentSnapshot> {
  const normalizedProfileId = exactKey(profileId);
  if (!normalizedProfileId) throw new EventD1Failure("invalid-profile-id");
  const row = await db
    .prepare(
      `SELECT
         (SELECT assignment_json FROM profile_event_prizes
          WHERE profile_id = ? AND event_id = ?) AS assignment_json,
         (SELECT revision FROM profile_event_prize_revisions
          WHERE profile_id = ?) AS revision`,
    )
    .bind(normalizedProfileId, eventId, normalizedProfileId)
    .first<{ assignment_json: string | null; revision: number | null }>();
  if (!row) throw new EventD1Failure();
  return {
    assignment:
      row.assignment_json === null
        ? null
        : parseStoredEventPrizeAssignment(
            normalizedProfileId,
            eventId,
            decodeJson(row.assignment_json),
          ),
    eventId,
    profileId: normalizedProfileId,
    revision: row.revision === null ? 0 : safeInteger(row.revision, 1),
  };
}

export async function readEventLease(
  db: EventD1Connection,
  eventId: string,
): Promise<EventLeaseRecord | null> {
  const row = await db
    .prepare(
      `SELECT lease_id, owner_uid, acquired_at_ms, refreshed_at_ms,
                expires_at_ms FROM event_leases WHERE event_id = ?`,
    )
    .bind(eventId)
    .first<{
      acquired_at_ms: number;
      expires_at_ms: number;
      lease_id: string;
      owner_uid: string;
      refreshed_at_ms: number;
    }>();
  return row
    ? {
        lockId: row.lease_id,
        ownerUid: row.owner_uid,
        acquiredAtMs: row.acquired_at_ms,
        refreshedAtMs: row.refreshed_at_ms,
        expiresAtMs: row.expires_at_ms,
      }
    : null;
}

export async function readEventSyncThrottle(
  db: EventD1Connection,
  eventId: string,
): Promise<EventSyncThrottleRecord | null> {
  const row = await db
    .prepare(
      `SELECT owner_uid, token, started_at_ms
         FROM event_sync_throttles WHERE event_id = ?`,
    )
    .bind(eventId)
    .first<{ owner_uid: string; started_at_ms: number; token: string }>();
  return row
    ? {
        ownerUid: row.owner_uid,
        token: row.token,
        startedAtMs: row.started_at_ms,
      }
    : null;
}

export async function readEventProgressDeadOutbox(
  db: EventD1Connection,
  outboxId: string,
): Promise<EventOutboxRecord | null> {
  const row = await db
    .prepare(
      "SELECT record_json FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'dead'",
    )
    .bind(outboxId)
    .first<{ record_json: string }>();
  return row ? (decodeJson(row.record_json) as EventOutboxRecord) : null;
}

export async function readEventProgressOutbox(
  db: EventD1Connection,
  outboxId: string,
): Promise<EventOutboxRecord | null> {
  const snapshot = await readEventProgressOutboxSnapshot(db, outboxId);
  return snapshot.recordJson === null
    ? null
    : (decodeJson(snapshot.recordJson) as EventOutboxRecord);
}

export async function readEventProgressOutboxSnapshot(
  db: EventD1Connection,
  outboxId: string,
): Promise<ProgressOutboxSnapshot> {
  const normalizedOutboxId = exactKey(outboxId);
  const row = await db
    .prepare(
      `SELECT record_json FROM event_progress_outboxes
       WHERE outbox_id = ? AND status = 'pending'`,
    )
    .bind(normalizedOutboxId)
    .first<{ record_json: string }>();
  return {
    outboxId: normalizedOutboxId,
    recordJson: row ? row.record_json : null,
  };
}

export async function listDueEventProgressOutboxes(
  db: EventD1Connection,
  beforeMs: number,
  limit = 100,
): Promise<Array<{ outboxId: string; record: EventOutboxRecord }>> {
  const rows = await db
    .prepare(
      `SELECT outbox_id, record_json FROM event_progress_outboxes
       WHERE status = 'pending' AND last_queued_at_ms <= ?
       ORDER BY last_queued_at_ms, outbox_id LIMIT ?`,
    )
    .bind(safeInteger(beforeMs), Math.min(safeInteger(limit, 1), 100))
    .all<{ outbox_id: string; record_json: string }>();
  return rows.results.map((row) => ({
    outboxId: row.outbox_id,
    record: decodeJson(row.record_json) as EventOutboxRecord,
  }));
}

export async function readEventProfileGameProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
): Promise<EventOutboxRecord | null> {
  return readProjectionOutbox(
    db,
    "event_profile_game_projection_outboxes",
    eventId,
  );
}

export async function readEventTelegramProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
): Promise<EventOutboxRecord | null> {
  return readProjectionOutbox(
    db,
    "event_telegram_projection_outboxes",
    eventId,
  );
}

async function readProjectionOutbox(
  db: EventD1Connection,
  table:
    | "event_profile_game_projection_outboxes"
    | "event_telegram_projection_outboxes",
  eventId: string,
): Promise<EventOutboxRecord | null> {
  const row = await db
    .prepare(
      `SELECT record_json FROM ${table}
       WHERE event_id = ? AND status = 'pending'`,
    )
    .bind(exactKey(eventId))
    .first<{ record_json: string }>();
  return row ? (decodeJson(row.record_json) as EventOutboxRecord) : null;
}

export async function listDueEventProfileGameProjectionOutboxes(
  db: EventD1Connection,
  beforeMs: number,
  limit = 100,
): Promise<Array<{ eventId: string; record: EventOutboxRecord }>> {
  return listProjectionOutboxes(
    db,
    "event_profile_game_projection_outboxes",
    "last_queued_at_ms",
    beforeMs,
    limit,
  );
}

export async function listDueEventTelegramProjectionOutboxes(
  db: EventD1Connection,
  beforeMs: number,
  limit = 100,
): Promise<Array<{ eventId: string; record: EventOutboxRecord }>> {
  return listProjectionOutboxes(
    db,
    "event_telegram_projection_outboxes",
    "updated_at_ms",
    beforeMs,
    limit,
  );
}

async function listProjectionOutboxes(
  db: EventD1Connection,
  table:
    | "event_profile_game_projection_outboxes"
    | "event_telegram_projection_outboxes",
  timestampColumn: "last_queued_at_ms" | "updated_at_ms",
  beforeMs: number,
  limit: number,
): Promise<Array<{ eventId: string; record: EventOutboxRecord }>> {
  const rows = await db
    .prepare(
      `SELECT event_id, record_json FROM ${table}
       WHERE status = 'pending' AND ${timestampColumn} <= ?
       ORDER BY ${timestampColumn}, event_id LIMIT ?`,
    )
    .bind(safeInteger(beforeMs), Math.min(safeInteger(limit, 1), 100))
    .all<{ event_id: string; record_json: string }>();
  return rows.results.map((row) => ({
    eventId: row.event_id,
    record: decodeJson(row.record_json) as EventOutboxRecord,
  }));
}

export async function readEventTelegramProjectionState(
  db: EventD1Connection,
  eventId: string,
): Promise<TelegramProjectionState | null> {
  const row = await db
    .prepare(
      `SELECT generation, revision, state_json
       FROM event_telegram_projection_state WHERE event_id = ?`,
    )
    .bind(exactKey(eventId))
    .first<{ generation: number; revision: number; state_json: string }>();
  if (!row) return null;
  const state = decodeJson(row.state_json);
  if (!isRecord(state)) throw new EventD1Failure();
  return {
    generation: safeInteger(row.generation),
    revision: safeInteger(row.revision, 1),
    state,
  };
}
