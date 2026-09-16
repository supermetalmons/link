import {
  AutomatchD1Failure,
  parseAutomatchRuntimeControlRow,
  prepareAutomatchRuntimeControlRead,
  type AutomatchWriteAdmission,
} from "./automatchD1.ts";
import {
  InviteSourceFailure,
  parseInviteSourceControlRow,
  prepareInviteSourceControlRead,
  type InviteSourceAdmission,
} from "./inviteSourceD1.ts";
import { assertAutomatchBackend } from "./automatchReadD1.ts";

export type AutomatchAdmissions = {
  automatch: AutomatchWriteAdmission;
  invite: InviteSourceAdmission;
};

type AdmissionRow = {
  admission_id: string;
  backend: "d1";
  epoch: number;
  freeze_generation: number;
  kind: string;
  created_at_ms: number;
};

function decodeAdmission(
  value: unknown,
  admissionId: string,
  kind: string,
  createdAtMs: number,
): InviteSourceAdmission | null {
  if (!value) return null;
  const row = value as AdmissionRow;
  if (
    row.admission_id !== admissionId ||
    row.backend !== "d1" ||
    row.kind !== kind ||
    row.created_at_ms !== createdAtMs ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 1 ||
    !Number.isSafeInteger(row.freeze_generation) ||
    row.freeze_generation < 0
  )
    throw new Error("automatch-admission-corrupt");
  return {
    admissionId,
    backend: row.backend,
    epoch: row.epoch,
    freezeGeneration: row.freeze_generation,
    kind,
    createdAtMs,
  };
}

export async function acquireAutomatchAdmissions(
  db: D1Database,
  kind: string,
  now: () => number,
): Promise<AutomatchAdmissions> {
  const admissionId = crypto.randomUUID();
  const createdAtMs = now();
  if (!kind.trim() || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0)
    throw new TypeError("invalid-automatch-admission");
  const session = db.withSession("first-primary");
  const insert = (table: string, control: string, automatch: boolean) =>
    session
      .prepare(
        `INSERT INTO ${table}
      (admission_id, backend, epoch, freeze_generation, kind, created_at_ms${automatch ? ", phase" : ""})
      SELECT ?, backend, epoch, freeze_generation, ?, ?${automatch ? ", 'prepared'" : ""}
      FROM ${control} WHERE singleton = 1 AND backend = 'd1' AND state = 'active'
      ON CONFLICT(admission_id) DO NOTHING`,
      )
      .bind(admissionId, kind, createdAtMs);
  const read = (table: string) =>
    session
      .prepare(
        `SELECT admission_id, backend, epoch, freeze_generation, kind, created_at_ms
      FROM ${table} WHERE admission_id = ?`,
      )
      .bind(admissionId);
  const guard = (table: string, control: string) =>
    session
      .prepare(
        `INSERT INTO automatch_write_guards (singleton)
      SELECT 0 WHERE NOT EXISTS (
        SELECT 1 FROM ${table} a JOIN ${control} c
          ON a.backend = c.backend AND a.epoch = c.epoch AND a.freeze_generation = c.freeze_generation
        WHERE c.singleton = 1 AND c.backend = 'd1' AND c.state = 'active'
          AND typeof(c.epoch) = 'integer' AND c.epoch BETWEEN 1 AND 9007199254740991
          AND typeof(c.freeze_generation) = 'integer' AND c.freeze_generation BETWEEN 0 AND 9007199254740991
          AND a.admission_id = ? AND a.kind = ? AND a.created_at_ms = ?
      )`,
      )
      .bind(admissionId, kind, createdAtMs);
  const reads = [
    prepareAutomatchRuntimeControlRead(session),
    prepareInviteSourceControlRead(session),
    read("automatch_write_admissions"),
    read("invite_source_write_admissions"),
  ];
  const validateControls = async (
    pair: AutomatchAdmissions,
    modeRow: unknown,
    inviteRow: unknown,
  ): Promise<AutomatchAdmissions> => {
    try {
      assertAutomatchBackend(parseAutomatchRuntimeControlRow(modeRow));
      if (parseInviteSourceControlRow(inviteRow).backend !== "d1")
        throw new InviteSourceFailure("invite-source-backend-retired");
      return pair;
    } catch (error) {
      await releaseAutomatchAdmissions(db, pair);
      throw error;
    }
  };
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let acquiredRows: D1Result[] | undefined;
    try {
      acquiredRows = await session.batch([
        insert("automatch_write_admissions", "automatch_runtime_control", true),
        insert(
          "invite_source_write_admissions",
          "invite_source_control",
          false,
        ),
        guard("automatch_write_admissions", "automatch_runtime_control"),
        guard("invite_source_write_admissions", "invite_source_control"),
        ...reads,
      ]);
    } catch (error) {
      failure = error;
    }
    if (acquiredRows) {
      const automatch = decodeAdmission(
        acquiredRows[6].results[0],
        admissionId,
        kind,
        createdAtMs,
      );
      const invite = decodeAdmission(
        acquiredRows[7].results[0],
        admissionId,
        kind,
        createdAtMs,
      );
      if (!automatch || !invite)
        throw new Error("automatch-admission-unconfirmed");
      return validateControls(
        { automatch, invite },
        acquiredRows[4].results[0],
        acquiredRows[5].results[0],
      );
    }
    let rows: D1Result[];
    try {
      rows = await db.withSession("first-primary").batch(reads);
    } catch (error) {
      failure = error;
      continue;
    }
    const automatch = decodeAdmission(
      rows[2].results[0],
      admissionId,
      kind,
      createdAtMs,
    );
    const invite = decodeAdmission(
      rows[3].results[0],
      admissionId,
      kind,
      createdAtMs,
    );
    if (automatch && invite)
      return validateControls(
        { automatch, invite },
        rows[0].results[0],
        rows[1].results[0],
      );
    if (automatch || invite) throw new Error("automatch-admission-partial");
    const mode = parseAutomatchRuntimeControlRow(rows[0].results[0]);
    const control = parseInviteSourceControlRow(rows[1].results[0]);
    assertAutomatchBackend(mode);
    if (mode.state !== "active")
      throw new AutomatchD1Failure("automatch-writes-frozen");
    if (control.backend !== "d1")
      throw new InviteSourceFailure("invite-source-backend-retired");
    if (control.state !== "active")
      throw new InviteSourceFailure("invite-source-writes-frozen");
  }
  throw new Error("automatch-admission-unconfirmed", { cause: failure });
}

export async function releaseAutomatchAdmissions(
  db: D1Database,
  pair: AutomatchAdmissions,
): Promise<void> {
  const statement = (table: string, admission: InviteSourceAdmission) =>
    db
      .prepare(
        `DELETE FROM ${table} WHERE admission_id = ? AND backend = ? AND epoch = ?
      AND freeze_generation = ? AND kind = ? AND created_at_ms = ?`,
      )
      .bind(
        admission.admissionId,
        admission.backend,
        admission.epoch,
        admission.freezeGeneration,
        admission.kind,
        admission.createdAtMs,
      );
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.batch([
        statement("invite_source_write_admissions", pair.invite),
        statement("automatch_write_admissions", pair.automatch),
      ]);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}
