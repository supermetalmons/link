import {
  type RuntimeControlRow,
  type EventRuntimeControl,
  EventD1Failure,
  type EventD1Connection,
  EventWritesDisabled,
  type EventWriteAdmission,
  type EventLeaseRecord,
  type EventSyncThrottleRecord,
  MAX_EVENT_TRANSACTION_ATTEMPTS,
  EventD1Conflict,
} from "./types.ts";
import { safeInteger, exactKey, isRecord, cloneJson } from "./validation.ts";
import type {
  TransactionDecision,
  TransactionResult,
} from "../../../../runtime/transactions.js";
import {
  eventWriteAdmissionGuard,
  rethrowEventBatchFailure,
} from "./guards.ts";
import { readEventLease, readEventSyncThrottle } from "./reads.ts";
import { readD1FirstRow } from "../d1Reads.ts";

const EVENT_WRITE_ADMISSION_TTL_MS = 5 * 60 * 1_000;

function parseRuntimeControl(
  row: RuntimeControlRow | null,
): EventRuntimeControl {
  if (!row) throw new EventD1Failure("event-runtime-control-unavailable");
  if (row.storage_mode !== "frozen" && row.storage_mode !== "d1") {
    throw new EventD1Failure("invalid-event-runtime-control");
  }
  return {
    freezeGeneration: safeInteger(row.freeze_generation),
    storageMode: row.storage_mode,
    updatedAtMs: safeInteger(row.updated_at_ms),
  };
}

export async function readEventRuntimeControl(
  db: EventD1Connection,
): Promise<EventRuntimeControl> {
  const row = await readD1FirstRow<RuntimeControlRow>(
    db.prepare(
      "SELECT storage_mode, freeze_generation, updated_at_ms FROM event_runtime_control WHERE singleton = 1",
    ),
  );
  return parseRuntimeControl(row);
}

export async function assertEventWritesAllowed(
  db: EventD1Connection,
): Promise<void> {
  if ((await readEventRuntimeControl(db)).storageMode === "frozen") {
    throw new EventWritesDisabled();
  }
}

export async function acquireEventWriteAdmission(
  db: EventD1Connection,
  input: {
    admissionId?: string;
    nowMs?: number;
    ttlMs?: number;
  } = {},
): Promise<EventWriteAdmission> {
  const admissionId = exactKey(
    input.admissionId || `ewa_${crypto.randomUUID()}`,
  );
  const nowMs = safeInteger(input.nowMs ?? Date.now());
  const ttlMs = safeInteger(input.ttlMs ?? EVENT_WRITE_ADMISSION_TTL_MS, 1);
  if (!admissionId || nowMs + ttlMs > Number.MAX_SAFE_INTEGER) {
    throw new EventD1Failure("invalid-event-write-admission");
  }
  const result = await db
    .prepare(
      `INSERT INTO event_write_admissions (
         admission_id, freeze_generation, created_at_ms, expires_at_ms
       )
       SELECT ?, freeze_generation, ?, ?
       FROM event_runtime_control
       WHERE singleton = 1 AND storage_mode = 'd1'
       RETURNING freeze_generation`,
    )
    .bind(admissionId, nowMs, nowMs + ttlMs)
    .all<{ freeze_generation: number }>();
  const freezeGeneration = result.results[0]?.freeze_generation;
  if (freezeGeneration === undefined) throw new EventWritesDisabled();
  return {
    admissionId,
    expiresAtMs: nowMs + ttlMs,
    freezeGeneration: safeInteger(freezeGeneration),
  };
}

export async function releaseEventWriteAdmission(
  db: EventD1Connection,
  admission: Pick<EventWriteAdmission, "admissionId">,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM event_write_admissions WHERE admission_id = ?")
    .bind(exactKey(admission.admissionId))
    .run();
  return result.meta.changes === 1;
}

async function transactEventCoordination<
  T extends EventLeaseRecord | EventSyncThrottleRecord,
>(
  db: EventD1Connection,
  kind: "lease" | "throttle",
  eventId: string,
  updater: (current: T | null) => TransactionDecision<T>,
  options: { admission: EventWriteAdmission },
): Promise<TransactionResult<T>> {
  const runMutation = async (
    statement: D1PreparedStatement,
  ): Promise<D1Result> => {
    try {
      const results = await db.batch([
        eventWriteAdmissionGuard(db, options.admission),
        statement,
      ]);
      return results[1];
    } catch (error) {
      return rethrowEventBatchFailure(db, error, options);
    }
  };
  eventId = exactKey(eventId);
  if (!eventId) throw new EventD1Failure("invalid-event-path");
  for (
    let attempt = 0;
    attempt < MAX_EVENT_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    const current = (await (kind === "lease"
      ? readEventLease(db, eventId)
      : readEventSyncThrottle(db, eventId))) as T | null;
    const decision = updater(current);
    if ("commit" in decision) {
      return {
        committed: false,
        decision: decision.decision,
        value: current,
      };
    }
    if (kind === "lease") {
      const currentRecord: Record<string, unknown> | null = isRecord(current)
        ? current
        : null;
      if (decision.value === null) {
        if (!currentRecord) {
          return { committed: true, decision: decision.decision, value: null };
        }
        const result = await runMutation(
          db
            .prepare(
              `DELETE FROM event_leases
             WHERE event_id = ? AND lease_id = ? AND owner_uid = ?
               AND expires_at_ms = ?`,
            )
            .bind(
              eventId,
              currentRecord.lockId,
              currentRecord.ownerUid,
              currentRecord.expiresAtMs,
            ),
        );
        if (result.meta.changes === 1) {
          return { committed: true, decision: decision.decision, value: null };
        }
        continue;
      }
      const next: Record<string, unknown> | null = isRecord(decision.value)
        ? decision.value
        : null;
      const lockId = next ? exactKey(next.lockId) : "";
      const ownerUid = next ? exactKey(next.ownerUid) : "";
      if (!next || !lockId || !ownerUid) {
        throw new EventD1Failure("invalid-event-lease");
      }
      const acquiredAtMs = safeInteger(next.acquiredAtMs);
      const refreshedAtMs = safeInteger(next.refreshedAtMs);
      const expiresAtMs = safeInteger(next.expiresAtMs, refreshedAtMs + 1);
      const statement = currentRecord
        ? db
            .prepare(
              `UPDATE event_leases SET
                 lease_id = ?, owner_uid = ?, acquired_at_ms = ?,
                 refreshed_at_ms = ?, expires_at_ms = ?
               WHERE event_id = ? AND lease_id = ? AND owner_uid = ?
                 AND expires_at_ms = ?`,
            )
            .bind(
              lockId,
              ownerUid,
              acquiredAtMs,
              refreshedAtMs,
              expiresAtMs,
              eventId,
              currentRecord.lockId,
              currentRecord.ownerUid,
              currentRecord.expiresAtMs,
            )
        : db
            .prepare(
              `INSERT INTO event_leases (
                 event_id, lease_id, owner_uid, acquired_at_ms,
                 refreshed_at_ms, expires_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (event_id) DO NOTHING`,
            )
            .bind(
              eventId,
              lockId,
              ownerUid,
              acquiredAtMs,
              refreshedAtMs,
              expiresAtMs,
            );
      const result = await runMutation(statement);
      if (result.meta.changes === 1) {
        return {
          committed: true,
          decision: decision.decision,
          value: cloneJson(next) as T,
        };
      }
      continue;
    }
    const currentRecord: Record<string, unknown> | null = isRecord(current)
      ? current
      : null;
    if (decision.value === null) {
      const result = currentRecord
        ? await runMutation(
            db
              .prepare(
                `DELETE FROM event_sync_throttles
               WHERE event_id = ? AND token = ? AND started_at_ms = ?`,
              )
              .bind(eventId, currentRecord.token, currentRecord.startedAtMs),
          )
        : null;
      if (!result || result.meta.changes === 1) {
        return { committed: true, decision: decision.decision, value: null };
      }
      continue;
    }
    const next: Record<string, unknown> | null = isRecord(decision.value)
      ? decision.value
      : null;
    const ownerUid = next ? exactKey(next.ownerUid) : "";
    const token = next ? exactKey(next.token) : "";
    if (!next || !ownerUid || !token) {
      throw new EventD1Failure("invalid-event-sync-throttle");
    }
    const startedAtMs = safeInteger(next.startedAtMs);
    const statement = currentRecord
      ? db
          .prepare(
            `UPDATE event_sync_throttles
             SET owner_uid = ?, token = ?, started_at_ms = ?
             WHERE event_id = ? AND token = ? AND started_at_ms = ?`,
          )
          .bind(
            ownerUid,
            token,
            startedAtMs,
            eventId,
            currentRecord.token,
            currentRecord.startedAtMs,
          )
      : db
          .prepare(
            `INSERT INTO event_sync_throttles (
               event_id, owner_uid, token, started_at_ms
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (event_id) DO NOTHING`,
          )
          .bind(eventId, ownerUid, token, startedAtMs);
    const result = await runMutation(statement);
    if (result.meta.changes === 1) {
      return {
        committed: true,
        decision: decision.decision,
        value: cloneJson(next) as T,
      };
    }
  }
  throw new EventD1Conflict();
}

export function transactEventLease(
  db: EventD1Connection,
  key: string,
  updater: (
    current: EventLeaseRecord | null,
  ) => TransactionDecision<EventLeaseRecord>,
  options: { admission: EventWriteAdmission },
) {
  return transactEventCoordination(db, "lease", key, updater, options);
}

export function transactEventSyncThrottle(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: EventSyncThrottleRecord | null,
  ) => TransactionDecision<EventSyncThrottleRecord>,
  options: { admission: EventWriteAdmission },
) {
  return transactEventCoordination(db, "throttle", eventId, updater, options);
}
