import { readD1FirstRow } from "../d1Reads.ts";
import { timestamp } from "./codec.ts";
import {
  AutomatchD1Failure,
  type AutomatchRuntimeControl,
  type AutomatchWriteAdmission,
  type ControlRow,
  type AdmissionRow,
} from "./types.ts";

function nullableTimestamp(value: number | null): number | null {
  return value === null ? null : timestamp(value);
}

export function prepareAutomatchRuntimeControlRead(
  db: Pick<D1Database, "prepare">,
): D1PreparedStatement {
  return db.prepare(
    `SELECT backend, state, epoch, freeze_generation, staged_at_ms,
      candidate_version_id, imported_at_ms, source_digest, import_digest, activated_at_ms
     FROM automatch_runtime_control WHERE singleton = 1`,
  );
}

export function parseAutomatchRuntimeControlRow(
  value: unknown,
): AutomatchRuntimeControl {
  const row = value as ControlRow | null | undefined;
  if (
    !row ||
    row.backend !== "d1" ||
    (row.state !== "active" && row.state !== "frozen") ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 1 ||
    !Number.isSafeInteger(row.freeze_generation) ||
    row.freeze_generation < 0 ||
    ![row.candidate_version_id].every(
      (value) => value === null || (typeof value === "string" && value !== ""),
    ) ||
    ![row.source_digest, row.import_digest].every(
      (value) =>
        value === null ||
        (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)),
    )
  ) {
    throw new AutomatchD1Failure("automatch-control-unavailable");
  }
  try {
    return {
      backend: row.backend,
      state: row.state,
      epoch: row.epoch,
      freezeGeneration: row.freeze_generation,
      stagedAtMs: nullableTimestamp(row.staged_at_ms),
      candidateVersionId: row.candidate_version_id,
      importedAtMs: nullableTimestamp(row.imported_at_ms),
      sourceDigest: row.source_digest,
      importDigest: row.import_digest,
      activatedAtMs: nullableTimestamp(row.activated_at_ms),
    };
  } catch (error) {
    throw new AutomatchD1Failure("automatch-control-corrupt", { cause: error });
  }
}

export async function readAutomatchRuntimeControl(
  db: D1Database,
): Promise<AutomatchRuntimeControl> {
  const row = await readD1FirstRow<ControlRow>(
    prepareAutomatchRuntimeControlRead(db.withSession("first-primary")),
  );
  return parseAutomatchRuntimeControlRow(row);
}

function admissionFromRow(row: AdmissionRow): AutomatchWriteAdmission {
  return {
    admissionId: row.admission_id,
    backend: row.backend,
    epoch: row.epoch,
    freezeGeneration: row.freeze_generation,
    kind: row.kind,
    createdAtMs: row.created_at_ms,
  };
}

export async function acquireAutomatchWriteAdmission(
  db: D1Database,
  kind: string,
  {
    admissionId = crypto.randomUUID(),
    now = Date.now,
  }: { admissionId?: string; now?: () => number } = {},
): Promise<AutomatchWriteAdmission> {
  if (!kind.trim() || !admissionId.trim()) {
    throw new TypeError("invalid-automatch-admission");
  }
  const row = await db
    .withSession("first-primary")
    .prepare(
      `INSERT INTO automatch_write_admissions
         (admission_id, epoch, freeze_generation, backend, kind, created_at_ms, phase)
       SELECT ?, epoch, freeze_generation, backend, ?, ?, 'prepared'
       FROM automatch_runtime_control WHERE singleton = 1 AND state = 'active' AND backend = 'd1'
       RETURNING *`,
    )
    .bind(admissionId, kind, timestamp(now()))
    .first<AdmissionRow>();
  if (!row) {
    if ((await readAutomatchRuntimeControl(db)).backend !== "d1") {
      throw new AutomatchD1Failure("automatch-backend-retired");
    }
    throw new AutomatchD1Failure("automatch-writes-frozen");
  }
  return admissionFromRow(row);
}

export function automatchAdmissionGuardStatements(
  db: D1Database,
  admission: AutomatchWriteAdmission,
  { allowFrozen = false }: { allowFrozen?: boolean } = {},
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO automatch_write_guards (singleton)
         SELECT 0 WHERE NOT EXISTS (
           SELECT 1 FROM automatch_runtime_control AS control
           JOIN automatch_write_admissions AS admission
             ON admission.epoch = control.epoch AND admission.backend = control.backend
           WHERE control.singleton = 1 ${allowFrozen ? "" : "AND control.state = 'active' AND control.freeze_generation = admission.freeze_generation"}
             AND admission.admission_id = ? AND admission.epoch = ?
             AND admission.backend = ? AND admission.freeze_generation = ?
             AND admission.kind = ? AND admission.created_at_ms = ?
         )`,
      )
      .bind(
        admission.admissionId,
        admission.epoch,
        admission.backend,
        admission.freezeGeneration,
        admission.kind,
        admission.createdAtMs,
      ),
  ];
}

export async function assertAutomatchWriteAdmission(
  db: D1Database,
  admission: AutomatchWriteAdmission,
  options?: { allowFrozen?: boolean },
): Promise<void> {
  await db.batch(automatchAdmissionGuardStatements(db, admission, options));
}

export async function releaseAutomatchWriteAdmission(
  db: D1Database,
  admission: AutomatchWriteAdmission,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db
        .prepare(
          `DELETE FROM automatch_write_admissions WHERE admission_id = ?
         AND epoch = ? AND backend = ? AND freeze_generation = ?
         AND kind = ? AND created_at_ms = ?`,
        )
        .bind(
          admission.admissionId,
          admission.epoch,
          admission.backend,
          admission.freezeGeneration,
          admission.kind,
          admission.createdAtMs,
        )
        .run();
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}
