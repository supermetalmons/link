import {
  type EventD1Connection,
  type EventWriteAdmission,
  type EventLeaseGuard,
  EventD1Failure,
  EventD1Conflict,
  EventWritesDisabled,
  type EventMutationState,
  type ProgressOutboxSnapshot,
} from "./types.ts";
import { exactKey, encodeJson } from "./validation.ts";
import { classifyD1Failure } from "../d1Failure.ts";

export function guardStatement(
  db: EventD1Connection,
  failurePredicate: string,
  values: unknown[],
  kind: "conflict" | "invariant" = "conflict",
): D1PreparedStatement {
  // Reinsert the sentinel for identifiable conflicts; a missing sentinel fails CHECK.
  const value =
    kind === "conflict"
      ? "CASE WHEN EXISTS (SELECT 1 FROM event_transaction_guards WHERE singleton = 1) THEN 1 ELSE 0 END"
      : "0";
  return db
    .prepare(
      `INSERT INTO event_transaction_guards (singleton)
       SELECT ${value} WHERE ${failurePredicate}`,
    )
    .bind(...values);
}

export function eventWriteAdmissionGuard(
  db: EventD1Connection,
  admission: EventWriteAdmission,
): D1PreparedStatement {
  return guardStatement(
    db,
    `NOT EXISTS (
       SELECT 1
       FROM event_write_admissions AS admission
       JOIN event_runtime_control AS control ON control.singleton = 1
       WHERE admission.admission_id = ?
         AND admission.freeze_generation = ?
         AND admission.freeze_generation = control.freeze_generation
         AND admission.expires_at_ms > CAST(
           (julianday('now') - 2440587.5) * 86400000 AS INTEGER
         )
         AND control.storage_mode = 'd1'
     )`,
    [admission.admissionId, admission.freezeGeneration],
    "invariant",
  );
}

export function eventLeaseGuard(
  db: EventD1Connection,
  lease: EventLeaseGuard,
): D1PreparedStatement {
  const eventId = exactKey(lease.eventId);
  const lockId = exactKey(lease.lockId);
  const ownerUid = exactKey(lease.ownerUid);
  if (!eventId || !lockId || !ownerUid) {
    throw new EventD1Failure("invalid-event-lease-guard");
  }
  return guardStatement(
    db,
    `NOT EXISTS (
       SELECT 1 FROM event_leases
       WHERE event_id = ? AND lease_id = ? AND owner_uid = ?
         AND expires_at_ms > CAST(
           (julianday('now') - 2440587.5) * 86400000 AS INTEGER
         )
     )`,
    [eventId, lockId, ownerUid],
    "invariant",
  );
}

export async function rethrowEventBatchFailure(
  db: EventD1Connection,
  error: unknown,
  options: { admission: EventWriteAdmission; eventLease?: EventLeaseGuard },
): Promise<never> {
  const failure = classifyD1Failure(error);
  if (failure === "event-conflict") {
    throw new EventD1Conflict("event-d1-conflict", { cause: error });
  }
  if (failure === "guard") {
    let control: {
      storage_mode: string;
      admission_valid: number;
      lease_valid: number;
    } | null;
    try {
      const primary = db.withSession?.("first-primary") || db;
      control = await primary
        .prepare(
          `SELECT control.storage_mode,
             EXISTS (
               SELECT 1 FROM event_write_admissions AS admission
               WHERE admission.admission_id = ?
                 AND admission.freeze_generation = ?
                 AND admission.freeze_generation = control.freeze_generation
                 AND admission.expires_at_ms > CAST(
                   (julianday('now') - 2440587.5) * 86400000 AS INTEGER
                 )
             ) AS admission_valid,
             (? IS NULL OR EXISTS (
               SELECT 1 FROM event_leases
               WHERE event_id = ? AND lease_id = ? AND owner_uid = ?
                 AND expires_at_ms > CAST(
                   (julianday('now') - 2440587.5) * 86400000 AS INTEGER
                 )
             )) AS lease_valid
           FROM event_runtime_control AS control WHERE singleton = 1`,
        )
        .bind(
          options.admission.admissionId,
          options.admission.freezeGeneration,
          options.eventLease?.eventId ?? null,
          options.eventLease?.eventId ?? null,
          options.eventLease?.lockId ?? null,
          options.eventLease?.ownerUid ?? null,
        )
        .first<typeof control>();
    } catch {
      throw new EventD1Failure("event-d1-unavailable", { cause: error });
    }
    if (control?.storage_mode === "frozen") {
      throw new EventWritesDisabled({ cause: error });
    }
    if (control?.storage_mode === "d1") {
      if (control.admission_valid === 0) {
        throw new EventD1Failure("event-write-admission-invalid", {
          cause: error,
        });
      }
      if (control.lease_valid === 0) {
        throw new EventD1Failure("event-lease-lost", { cause: error });
      }
    }
  }
  if (failure !== "unknown") {
    throw new EventD1Failure("event-d1-integrity", { cause: error });
  }
  throw error;
}

export function eventRevisionGuard(
  db: EventD1Connection,
  eventId: string,
  expectedRevision: number,
): D1PreparedStatement {
  return expectedRevision === 0
    ? guardStatement(
        db,
        "EXISTS (SELECT 1 FROM event_records WHERE event_id = ?)",
        [eventId],
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM event_records WHERE event_id = ? AND revision = ?
         )`,
        [eventId, expectedRevision],
      );
}

export function eventMutationGuard(
  db: EventD1Connection,
  eventId: string,
  state: EventMutationState,
): D1PreparedStatement {
  if (state.revision === 0) return eventRevisionGuard(db, eventId, 0);
  return guardStatement(
    db,
    `NOT EXISTS (
       SELECT 1 FROM event_records
       WHERE event_id = ? AND revision = ? AND pending_transition_id IS ?
     )`,
    [eventId, state.revision, state.pendingTransitionId],
  );
}

export function profileRevisionGuard(
  db: EventD1Connection,
  profileId: string,
  expectedRevision: number,
): D1PreparedStatement {
  return expectedRevision === 0
    ? guardStatement(
        db,
        `EXISTS (
           SELECT 1 FROM profile_event_prize_revisions WHERE profile_id = ?
         )`,
        [profileId],
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM profile_event_prize_revisions
           WHERE profile_id = ? AND revision = ?
         )`,
        [profileId, expectedRevision],
      );
}

export function recordJsonGuard(
  db: EventD1Connection,
  table:
    | "event_progress_outboxes"
    | "event_profile_game_projection_outboxes"
    | "event_telegram_projection_outboxes",
  recordId: string,
  expected: unknown,
  status?: "dead" | "pending",
): D1PreparedStatement {
  const keyColumn =
    table === "event_progress_outboxes" ? "outbox_id" : "event_id";
  const statusPredicate = status ? " AND status = ?" : "";
  const keyValues = status ? [recordId, status] : [recordId];
  return expected === null
    ? guardStatement(
        db,
        `EXISTS (
           SELECT 1 FROM ${table}
           WHERE ${keyColumn} = ?${statusPredicate}
         )`,
        keyValues,
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM ${table}
           WHERE ${keyColumn} = ?${statusPredicate} AND record_json = ?
         )`,
        [...keyValues, encodeJson(expected)],
      );
}

export function progressOutboxSnapshotGuard(
  db: EventD1Connection,
  snapshot: ProgressOutboxSnapshot,
): D1PreparedStatement {
  return guardStatement(
    db,
    snapshot.recordJson === null
      ? `EXISTS (
           SELECT 1 FROM event_progress_outboxes
           WHERE outbox_id = ? AND status = 'pending'
         )`
      : `NOT EXISTS (
           SELECT 1 FROM event_progress_outboxes
           WHERE outbox_id = ? AND status = 'pending' AND record_json = ?
         )`,
    snapshot.recordJson === null
      ? [snapshot.outboxId]
      : [snapshot.outboxId, snapshot.recordJson],
  );
}

export function telegramStateRevisionGuard(
  db: EventD1Connection,
  eventId: string,
  expectedRevision: number,
): D1PreparedStatement {
  return expectedRevision === 0
    ? guardStatement(
        db,
        "EXISTS (SELECT 1 FROM event_telegram_projection_state WHERE event_id = ?)",
        [eventId],
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM event_telegram_projection_state
           WHERE event_id = ? AND revision = ?
         )`,
        [eventId, expectedRevision],
      );
}
