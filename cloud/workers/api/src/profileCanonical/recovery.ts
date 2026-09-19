import { isSafeRecordKey } from "../recordKeys.ts";
import { parseCanonicalAuthRecoveryRow } from "./auth.ts";
import { CanonicalProfileCorruption } from "./types.ts";

const AUTH_RECOVERY_JOB_SNAPSHOT_SQL = `hex(json_array(${[
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
]
  .map(
    (column) =>
      `typeof(job.${column}), CASE WHEN typeof(job.${column}) = 'blob'
       THEN hex(job.${column}) ELSE job.${column} END`,
  )
  .join(", ")}))`;

type AuthRecoverySweepRow = {
  profile_id: unknown;
  sweep_profile_id_bytes: number[];
  sweep_profile_id_type: "text" | "blob";
  sweep_revision_hex: string;
  sweep_snapshot_token: string;
};

export type AuthRecoveryQuarantineReason =
  "invalid-record" | "invalid-profile-id";

function authRecoveryQuarantineReason(
  row: AuthRecoverySweepRow,
  profileId: string,
): AuthRecoveryQuarantineReason | null {
  const encodedId = new TextEncoder().encode(profileId);
  if (
    !profileId ||
    row.sweep_profile_id_type !== "text" ||
    encodedId.length !== row.sweep_profile_id_bytes.length ||
    !encodedId.every(
      (byte, index) => byte === row.sweep_profile_id_bytes[index],
    )
  ) {
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
  row: AuthRecoverySweepRow,
  reason: AuthRecoveryQuarantineReason,
  nowMs: number,
): Promise<{
  profileIdHex: string;
  revisionHex: string;
  reason: AuthRecoveryQuarantineReason;
} | null> {
  const profileIdBytes = Uint8Array.from(row.sweep_profile_id_bytes);
  const result = await db
    .prepare(
      `INSERT INTO profile_auth_recovery_quarantine (
         profile_id, revision_token, reason, quarantined_at_ms
       )
       SELECT job.profile_id, CAST(job.revision AS TEXT), ?, ?
       FROM profile_auth_recovery_jobs AS job
       WHERE job.profile_id = CASE WHEN ? = 'blob' THEN ? ELSE CAST(? AS TEXT) END
         AND ${AUTH_RECOVERY_JOB_SNAPSHOT_SQL} = ?
         AND EXISTS (
           SELECT 1 FROM profile_canonical_control
           WHERE singleton = 1 AND state = 'active'
         )
       ON CONFLICT(profile_id) DO UPDATE SET
         revision_token = excluded.revision_token,
         reason = excluded.reason,
         quarantined_at_ms = excluded.quarantined_at_ms
       WHERE profile_auth_recovery_quarantine.revision_token != excluded.revision_token`,
    )
    .bind(
      reason,
      nowMs,
      row.sweep_profile_id_type,
      profileIdBytes,
      profileIdBytes,
      row.sweep_snapshot_token,
    )
    .run();
  if (result.meta.changes !== 1) return null;
  return {
    profileIdHex: row.sweep_profile_id_bytes
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    revisionHex: row.sweep_revision_hex,
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
      `SELECT job.*, CAST(job.profile_id AS BLOB) AS sweep_profile_id_bytes,
              typeof(job.profile_id) AS sweep_profile_id_type,
              hex(CAST(job.revision AS TEXT)) AS sweep_revision_hex,
              ${AUTH_RECOVERY_JOB_SNAPSHOT_SQL} AS sweep_snapshot_token
       FROM profile_auth_recovery_jobs AS job
       WHERE job.last_enqueued_at_ms <= ?
         AND NOT EXISTS (
           SELECT 1 FROM profile_auth_recovery_quarantine AS quarantine
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
} {
  if (
    !Array.isArray(row.sweep_profile_id_bytes) ||
    (row.sweep_profile_id_type !== "text" &&
      row.sweep_profile_id_type !== "blob") ||
    typeof row.sweep_revision_hex !== "string" ||
    typeof row.sweep_snapshot_token !== "string"
  ) {
    throw new Error("auth-recovery-sweep-row-invalid");
  }
  const profileId =
    typeof row.profile_id === "string" &&
    row.profile_id.trim() === row.profile_id &&
    isSafeRecordKey(row.profile_id)
      ? row.profile_id
      : "";
  return {
    profileId,
    quarantineReason: authRecoveryQuarantineReason(row, profileId),
  };
}
