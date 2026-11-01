import { isSafeRecordKey } from "../recordKeys.ts";
import {
  parseRecoveryKey,
  parseRecoveryObservation,
  recoveryKeyHex,
  recoveryKeyMatches,
  recoveryObservationColumns,
  recoveryObservationGuard,
  type RecoveryKeyObservation,
  type RecoveryKeyRow,
  type RecoveryRowObservation,
} from "../recoveryObservation.ts";
import { buildRecoveryQuarantineWrite } from "../recoveryQuarantine.ts";
import { parseCanonicalAuthRecoveryRow } from "./auth.ts";
import { CanonicalProfileCorruption, type RecoveryRow } from "./types.ts";

const JOB_COLUMNS = [
  "profile_id",
  "login_uids_json",
  "source_profile_ids_json",
  "source_phase",
  "prize_cursor",
  "phase_started_at_ms",
  "last_enqueued_at_ms",
  "created_at_ms",
  "updated_at_ms",
  "revision",
] as const;
const JOB_EXPRESSIONS = JOB_COLUMNS.map((column) => `job.${column}`);
const JOB_REVISION_INDEX = 9;

type AuthRecoverySweepRow = RecoveryRow & RecoveryKeyRow;

export type AuthRecoveryQuarantineReason =
  "invalid-record" | "invalid-profile-id";

type AuthRecoveryQuarantineEntry = {
  observation: RecoveryRowObservation;
  reason: AuthRecoveryQuarantineReason;
};

function authRecoveryQuarantineReason(
  row: RecoveryRow,
  profileId: string,
  key: RecoveryKeyObservation,
): AuthRecoveryQuarantineReason | null {
  if (!profileId || !recoveryKeyMatches(key, profileId)) {
    return "invalid-profile-id";
  }
  try {
    parseCanonicalAuthRecoveryRow(row);
    return null;
  } catch (error) {
    if (error instanceof CanonicalProfileCorruption) return "invalid-record";
    throw error;
  }
}

export async function quarantineCanonicalAuthRecoveryJob(
  db: D1Database,
  { observation, reason }: AuthRecoveryQuarantineEntry,
  nowMs: number,
): Promise<{
  profileIdHex: string;
  revisionHex: string;
  reason: AuthRecoveryQuarantineReason;
} | null> {
  const profileIdBytes = observation.keyBytes;
  const guard = recoveryObservationGuard(JOB_EXPRESSIONS, observation);
  const statement = buildRecoveryQuarantineWrite({
    target: "auth",
    select: {
      sql: `SELECT job.profile_id, CAST(job.revision AS TEXT), ?, ?
       FROM profile_auth_recovery_jobs_canonical AS job
       WHERE job.profile_id = CASE WHEN ? = 'blob' THEN ? ELSE CAST(? AS TEXT) END
         AND ${guard.sql}
         AND EXISTS (
           SELECT 1 FROM profile_canonical_control
           WHERE singleton = 1 AND state = 'active'
         )`,
      bindings: [
        reason,
        nowMs,
        observation.keyType,
        profileIdBytes,
        profileIdBytes,
        ...guard.bindings,
      ],
    },
  });
  const result = await db
    .prepare(statement.sql)
    .bind(...statement.bindings)
    .run();
  if (result.meta.changes !== 1) return null;
  return {
    profileIdHex: recoveryKeyHex(observation),
    revisionHex: observation.revisionHex,
    reason,
  };
}

export async function listCanonicalAuthRecoverySweepRows(
  db: D1Database,
  beforeMs: number,
  limit: number,
): Promise<AuthRecoverySweepRow[]> {
  const page = await db
    .prepare(
      `SELECT ${JOB_EXPRESSIONS.join(", ")},
              CAST(job.profile_id AS BLOB) AS recovery_key_bytes,
              typeof(job.profile_id) AS recovery_key_type
       FROM profile_auth_recovery_jobs_canonical AS job
       WHERE job.last_enqueued_at_ms <= ?
         AND NOT EXISTS (
           SELECT 1 FROM profile_auth_recovery_quarantine_canonical AS quarantine
           WHERE quarantine.profile_id = job.profile_id
             AND quarantine.revision_token = CAST(job.revision AS TEXT)
         )
       ORDER BY job.last_enqueued_at_ms, job.profile_id
       LIMIT ?`,
    )
    .bind(beforeMs, limit)
    .all<AuthRecoverySweepRow>();
  return page.results;
}

export function inspectCanonicalAuthRecoverySweepRow(
  row: AuthRecoverySweepRow,
): {
  profileId: string;
  quarantineReason: AuthRecoveryQuarantineReason | null;
  key: RecoveryKeyObservation;
} {
  const key = parseRecoveryKey(row);
  const profileId = safeProfileId(row.profile_id);
  return {
    profileId,
    quarantineReason: authRecoveryQuarantineReason(row, profileId, key),
    key,
  };
}

function safeProfileId(value: unknown): string {
  return typeof value === "string" &&
    value.trim() === value &&
    isSafeRecordKey(value)
    ? value
    : "";
}

export async function readCanonicalAuthRecoveryQuarantineEntry(
  db: D1Database,
  key: RecoveryKeyObservation,
  beforeMs: number,
): Promise<AuthRecoveryQuarantineEntry | null> {
  const fresh = await db
    .withSession("first-primary")
    .prepare(
      `SELECT ${recoveryObservationColumns(JOB_EXPRESSIONS, JOB_REVISION_INDEX)}
       FROM profile_auth_recovery_jobs_canonical AS job
       WHERE job.profile_id = CASE WHEN ? = 'blob' THEN ? ELSE CAST(? AS TEXT) END
         AND job.last_enqueued_at_ms <= ?
         AND NOT EXISTS (
           SELECT 1 FROM profile_auth_recovery_quarantine_canonical AS quarantine
           WHERE quarantine.profile_id = job.profile_id
             AND quarantine.revision_token = CAST(job.revision AS TEXT)
         )`,
    )
    .bind(key.keyType, key.keyBytes, key.keyBytes, beforeMs)
    .first<Record<string, unknown>>();
  if (!fresh) return null;
  const { observation, value } = parseRecoveryObservation(
    fresh,
    JOB_COLUMNS,
    JOB_REVISION_INDEX,
  );
  const row = value as RecoveryRow;
  const profileId = safeProfileId(row.profile_id);
  const reason = authRecoveryQuarantineReason(row, profileId, observation);
  return reason ? { observation, reason } : null;
}
