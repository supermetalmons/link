import type { AutomatchWriteAdmission } from "./automatchD1.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";

const MAX_AUDIT_BYTES = 1_800_000;
const MAX_AUDIT_ATTEMPTS = 50;
const AUDIT_WRITE_ATTEMPTS = 3;

export type AutomatchAdmissionPhase =
  "prepared" | "dispatching" | "uncertain" | "completed";

export type AutomatchAdmissionTransactionAttempt = {
  attemptId: string;
  current: unknown;
  proposed: unknown;
  atMs: number;
  etag?: string;
};

export type AutomatchAdmissionProof =
  | {
      schemaVersion: 1;
      kind: "patch";
      updates: Record<string, unknown>;
    }
  | {
      schemaVersion: 1;
      kind: "transaction";
      path: string;
      attempts: AutomatchAdmissionTransactionAttempt[];
    };

export type AutomatchAdmissionAuditSnapshot = {
  admission: AutomatchWriteAdmission;
  phase: AutomatchAdmissionPhase;
  proof: AutomatchAdmissionProof | null;
  auditRevision: number;
  updatedAtMs: number;
  completedAtMs: number | null;
};

type AuditRow = {
  phase: AutomatchAdmissionPhase;
  proof_json: string | null;
  audit_revision: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
};

export class AutomatchAdmissionAuditFailure extends Error {
  constructor(code: string, options?: ErrorOptions) {
    super(`automatch-admission-${code}`, options);
  }
}

function fail(code: string): never {
  throw new AutomatchAdmissionAuditFailure(code);
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid-audit-time");
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePath(path: string): void {
  if (
    typeof path !== "string" ||
    path.split("/").some((part) => !isSafeFirebaseKey(part))
  ) {
    fail("invalid-audit-path");
  }
}

function encode(value: unknown): string {
  const seen = new Set<object>();
  const visit = (child: unknown, depth: number): void => {
    if (depth > 64) fail("invalid-audit-json");
    if (
      child === null ||
      typeof child === "string" ||
      typeof child === "boolean" ||
      (typeof child === "number" && Number.isFinite(child))
    )
      return;
    if (!child || typeof child !== "object" || seen.has(child))
      fail("invalid-audit-json");
    const prototype = Object.getPrototypeOf(child);
    if (
      !Array.isArray(child) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      fail("invalid-audit-json");
    }
    seen.add(child);
    for (const nested of Object.values(child)) visit(nested, depth + 1);
    seen.delete(child);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > MAX_AUDIT_BYTES)
    fail("audit-proof-too-large");
  return json;
}

function validateProof(value: unknown): AutomatchAdmissionProof {
  if (!record(value) || value.schemaVersion !== 1) fail("invalid-audit-proof");
  if (value.kind === "patch") {
    if (!record(value.updates) || !Object.keys(value.updates).length)
      fail("invalid-audit-proof");
    Object.keys(value.updates).forEach(validatePath);
    return { schemaVersion: 1, kind: "patch", updates: value.updates };
  }
  if (
    value.kind !== "transaction" ||
    typeof value.path !== "string" ||
    !Array.isArray(value.attempts)
  ) {
    fail("invalid-audit-proof");
  }
  validatePath(value.path);
  if (value.attempts.length > MAX_AUDIT_ATTEMPTS)
    fail("too-many-audit-attempts");
  const attempts = value.attempts.map(
    (attempt): AutomatchAdmissionTransactionAttempt => {
      if (
        !record(attempt) ||
        typeof attempt.attemptId !== "string" ||
        !isSafeFirebaseKey(attempt.attemptId) ||
        !Object.hasOwn(attempt, "current") ||
        !Object.hasOwn(attempt, "proposed") ||
        typeof attempt.atMs !== "number" ||
        !(attempt.etag === undefined || typeof attempt.etag === "string")
      )
        fail("invalid-audit-attempt");
      return {
        attemptId: attempt.attemptId,
        current: attempt.current,
        proposed: attempt.proposed,
        atMs: validTimestamp(attempt.atMs),
        ...(attempt.etag === undefined ? {} : { etag: attempt.etag }),
      };
    },
  );
  if (
    new Set(attempts.map(({ attemptId }) => attemptId)).size !== attempts.length
  )
    fail("duplicate-audit-attempt");
  return { schemaVersion: 1, kind: "transaction", path: value.path, attempts };
}

const ADMISSION_WHERE =
  "admission_id = ? AND epoch = ? AND backend = ? AND freeze_generation = ? AND kind = ? AND created_at_ms = ?";

function admissionValues(
  admission: AutomatchWriteAdmission,
): Array<string | number> {
  return [
    admission.admissionId,
    admission.epoch,
    admission.backend,
    admission.freezeGeneration,
    admission.kind,
    admission.createdAtMs,
  ];
}

export async function readAutomatchAdmissionAudit(
  db: D1Database,
  admission: AutomatchWriteAdmission,
): Promise<AutomatchAdmissionAuditSnapshot | null> {
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT phase, proof_json, audit_revision, updated_at_ms, completed_at_ms
     FROM automatch_write_admissions WHERE ${ADMISSION_WHERE}`,
    )
    .bind(...admissionValues(admission))
    .first<AuditRow>();
  if (!row) return null;
  if (
    !["prepared", "dispatching", "uncertain", "completed"].includes(
      row.phase,
    ) ||
    !Number.isSafeInteger(row.audit_revision) ||
    row.audit_revision < 0 ||
    (row.phase === "completed" && row.completed_at_ms === null)
  )
    fail("invalid-audit-row");
  return {
    admission,
    phase: row.phase,
    proof:
      row.proof_json === null
        ? null
        : validateProof(JSON.parse(row.proof_json)),
    auditRevision: row.audit_revision,
    updatedAtMs: validTimestamp(row.updated_at_ms),
    completedAtMs:
      row.completed_at_ms === null ? null : validTimestamp(row.completed_at_ms),
  };
}

export function createAutomatchAdmissionAudit(
  db: D1Database,
  admission: AutomatchWriteAdmission,
  { now = Date.now }: { now?: () => number } = {},
) {
  const read = () => readAutomatchAdmissionAudit(db, admission);

  async function update(
    build: (current: AutomatchAdmissionAuditSnapshot) => {
      phase: AutomatchAdmissionPhase;
      proof: AutomatchAdmissionProof | null;
      completedAtMs: number | null;
    } | null,
  ): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < AUDIT_WRITE_ATTEMPTS; attempt++) {
      try {
        const current = await read();
        if (!current) fail("audit-missing");
        const next = build(current);
        if (!next) return;
        if (!Number.isSafeInteger(current.auditRevision + 1))
          fail("audit-revision-exhausted");
        const result = await db
          .prepare(
            `UPDATE automatch_write_admissions
           SET phase = ?, proof_json = ?, completed_at_ms = ?,
             audit_revision = audit_revision + 1, updated_at_ms = MAX(updated_at_ms, ?)
           WHERE ${ADMISSION_WHERE} AND audit_revision = ? AND phase = ?`,
          )
          .bind(
            next.phase,
            next.proof === null ? null : encode(next.proof),
            next.completedAtMs,
            validTimestamp(now()),
            ...admissionValues(admission),
            current.auditRevision,
            current.phase,
          )
          .run();
        if (result.meta.changes === 1) return;
        if (result.meta.changes !== 0) fail("invalid-audit-write-count");
      } catch (error) {
        failure = error;
        if (error instanceof AutomatchAdmissionAuditFailure) throw error;
      }
    }
    throw new AutomatchAdmissionAuditFailure("audit-write-unavailable", {
      cause: failure,
    });
  }

  async function prepare(proof: AutomatchAdmissionProof): Promise<void> {
    const json = encode(proof);
    const captured = validateProof(JSON.parse(json));
    await update((current) => {
      if (current.phase !== "prepared") fail("audit-already-dispatched");
      if (current.proof !== null) {
        if (encode(current.proof) !== json) fail("audit-proof-conflict");
        return null;
      }
      return { phase: "prepared", proof: captured, completedAtMs: null };
    });
  }

  async function preparePatch(updates: Record<string, unknown>): Promise<void> {
    await prepare({ schemaVersion: 1, kind: "patch", updates });
  }

  async function prepareTransaction(path: string): Promise<void> {
    validatePath(path);
    await prepare({
      schemaVersion: 1,
      kind: "transaction",
      path,
      attempts: [],
    });
  }

  async function markDispatching(): Promise<void> {
    await update((current) => {
      if (!current.proof) fail("audit-proof-required");
      if (current.phase === "dispatching") return null;
      if (current.phase !== "prepared") fail("audit-already-dispatched");
      return {
        phase: "dispatching",
        proof: current.proof,
        completedAtMs: null,
      };
    });
  }

  async function recordTransactionAttempt(input: {
    current: unknown;
    proposed: unknown;
    etag?: string;
  }): Promise<void> {
    const captured: AutomatchAdmissionTransactionAttempt = JSON.parse(
      encode({
        attemptId: crypto.randomUUID(),
        current: input.current,
        proposed: input.proposed,
        atMs: validTimestamp(now()),
        ...(input.etag === undefined ? {} : { etag: input.etag }),
      }),
    );
    await update((current) => {
      if (current.proof?.kind !== "transaction")
        fail("transaction-audit-required");
      if (current.phase !== "prepared" && current.phase !== "dispatching")
        fail("audit-already-finished");
      if (
        current.proof.attempts.some(
          ({ attemptId }) => attemptId === captured.attemptId,
        )
      )
        return null;
      if (current.proof.attempts.length >= MAX_AUDIT_ATTEMPTS)
        fail("too-many-audit-attempts");
      return {
        phase: "dispatching",
        proof: {
          ...current.proof,
          attempts: [...current.proof.attempts, captured],
        },
        completedAtMs: null,
      };
    });
  }

  async function markCompleted(): Promise<void> {
    const completedAtMs = validTimestamp(now());
    await update((current) => {
      if (!current.proof) fail("audit-proof-required");
      return current.phase === "completed"
        ? null
        : {
            phase: "completed",
            proof: current.proof,
            completedAtMs,
          };
    });
  }

  async function markUncertain(): Promise<void> {
    await update((current) =>
      current.phase !== "dispatching"
        ? null
        : {
            phase: "uncertain",
            proof: current.proof,
            completedAtMs: null,
          },
    );
  }

  async function releaseIfSafe(): Promise<boolean> {
    let failure: unknown;
    for (let attempt = 0; attempt < AUDIT_WRITE_ATTEMPTS; attempt++) {
      try {
        const current = await read();
        if (!current) return true;
        if (current.phase !== "prepared" && current.phase !== "completed")
          return false;
        const result = await db
          .prepare(
            `DELETE FROM automatch_write_admissions
           WHERE ${ADMISSION_WHERE} AND audit_revision = ? AND phase = ?`,
          )
          .bind(
            ...admissionValues(admission),
            current.auditRevision,
            current.phase,
          )
          .run();
        if (result.meta.changes === 1) return true;
        if (result.meta.changes !== 0) fail("invalid-audit-release-count");
      } catch (error) {
        failure = error;
        if (error instanceof AutomatchAdmissionAuditFailure) throw error;
      }
    }
    throw new AutomatchAdmissionAuditFailure("audit-release-unavailable", {
      cause: failure,
    });
  }

  return {
    preparePatch,
    prepareTransaction,
    recordTransactionAttempt,
    markDispatching,
    markCompleted,
    markUncertain,
    releaseIfSafe,
    read,
  };
}

export type AutomatchAdmissionAudit = ReturnType<
  typeof createAutomatchAdmissionAudit
>;
