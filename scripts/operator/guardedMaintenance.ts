import { randomUUID } from "node:crypto";
import { parseApplicationDataControl } from "../../cloud/workers/api/src/applicationDataRecords.ts";

type Binding =
  "PROFILE_GAMES_DB" | "PROFILE_DB" | "EVENT_DB" | "EVENT_PRIZE_WITHDRAWALS_DB";
export type MaintenanceBinding = Binding;
type Value = string | number | null;
type Row = Record<string, unknown>;

export type MaintenanceStatement = {
  sql: string;
  bindings: readonly Value[];
};

export type MaintenanceResult = {
  success: boolean;
  results: Row[];
  meta: { changes: number };
};

export type MaintenanceTransport = {
  readControl(): Promise<unknown[]>;
  atomicBatch(
    binding: Binding,
    statements: readonly MaintenanceStatement[],
  ): Promise<MaintenanceResult[]>;
};

const BINDINGS: readonly Binding[] = [
  "PROFILE_GAMES_DB",
  "PROFILE_DB",
  "EVENT_DB",
  "EVENT_PRIZE_WITHDRAWALS_DB",
];

function requireConfirmed(results: MaintenanceResult[], count: number): void {
  if (
    results.length !== count ||
    results.some(
      (result) =>
        result.success !== true ||
        !Array.isArray(result.results) ||
        !Number.isSafeInteger(result.meta.changes) ||
        result.meta.changes < 0,
    )
  )
    throw new Error("operator-maintenance-result-unconfirmed");
}

function requireOne(results: MaintenanceResult[]): void {
  requireConfirmed(results, 1);
  if (results[0]!.meta.changes !== 1)
    throw new Error("operator-maintenance-admission-unconfirmed");
}

function validateStatements(
  binding: Binding,
  statements: readonly MaintenanceStatement[],
): void {
  if (
    !BINDINGS.includes(binding) ||
    statements.length === 0 ||
    statements.length > 16
  )
    throw new Error("invalid-operator-maintenance-batch");
  for (const statement of statements) {
    if (
      !statement.sql.trim() ||
      Buffer.byteLength(statement.sql) > 90 * 1024 ||
      statement.bindings.length > 100 ||
      statement.bindings.some(
        (value) =>
          value !== null &&
          typeof value !== "string" &&
          !(typeof value === "number" && Number.isSafeInteger(value)),
      )
    )
      throw new Error("invalid-operator-maintenance-statement");
  }
}

export class OperatorMaintenanceFailure extends Error {
  readonly operationId: string;
  readonly stage: "admission" | "mutation" | "completion";
  readonly admissionBlocked: boolean;

  constructor(
    operationId: string,
    stage: OperatorMaintenanceFailure["stage"],
    admissionBlocked: boolean,
  ) {
    super("operator-maintenance-unconfirmed");
    this.name = "OperatorMaintenanceFailure";
    this.operationId = operationId;
    this.stage = stage;
    this.admissionBlocked = admissionBlocked;
  }
}

export async function runGuardedOperatorMaintenance(input: {
  transport: MaintenanceTransport;
  binding: Binding;
  generation: number;
  dataEpoch: 1;
  statements: readonly MaintenanceStatement[];
  now?: () => number;
  createOperationId?: () => string;
}): Promise<MaintenanceResult[]> {
  validateStatements(input.binding, input.statements);
  const nowMs = (input.now ?? Date.now)();
  if (
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    input.dataEpoch !== 1 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  )
    throw new Error("invalid-operator-maintenance-generation");
  const rows = await input.transport.readControl();
  if (rows.length !== 1)
    throw new Error("operator-maintenance-control-unavailable");
  const control = parseApplicationDataControl(rows[0]);
  if (
    control.phase !== "active" ||
    control.generation !== input.generation ||
    control.dataEpoch !== input.dataEpoch
  )
    throw new Error("operator-maintenance-control-mismatch");
  const operationId = (input.createOperationId ?? randomUUID)();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      operationId,
    )
  )
    throw new Error("invalid-operator-maintenance-operation-id");
  const identity = [operationId, input.generation, input.dataEpoch] as const;
  let stage: OperatorMaintenanceFailure["stage"] = "admission";
  let admitted = false;
  try {
    requireOne(
      await input.transport.atomicBatch("PROFILE_GAMES_DB", [
        {
          sql: "INSERT INTO application_data_admissions (operation_id, generation, data_epoch, kind, started_at_ms, status, failure_code, parent_operation_id) VALUES (?, ?, ?, 'rpc', ?, 'running', NULL, NULL)",
          bindings: [...identity, nowMs],
        },
      ]),
    );
    admitted = true;
    stage = "mutation";
    const results = await input.transport.atomicBatch(input.binding, [
      {
        sql: "SELECT CASE WHEN EXISTS (SELECT 1 FROM application_data_control WHERE singleton = 1 AND generation = ? AND data_epoch = ? AND phase = 'active') THEN 1 ELSE json('operator-control-changed') END AS verified",
        bindings: [input.generation, input.dataEpoch],
      },
      {
        sql: "INSERT INTO application_write_context (singleton, generation, data_epoch, operation_id, migration_id) VALUES (1, ?, ?, ?, ?)",
        bindings: [input.generation, input.dataEpoch, operationId, null],
      },
      ...input.statements,
      {
        sql: "DELETE FROM application_write_context WHERE singleton = 1 AND operation_id = ?",
        bindings: [operationId],
      },
    ]);
    requireConfirmed(results, input.statements.length + 3);
    if (results[1]!.meta.changes !== 1 || results.at(-1)!.meta.changes !== 1)
      throw new Error("operator-maintenance-context-unconfirmed");
    stage = "completion";
    requireOne(
      await input.transport.atomicBatch("PROFILE_GAMES_DB", [
        {
          sql: "DELETE FROM application_data_admissions WHERE operation_id = ? AND generation = ? AND data_epoch = ? AND kind = 'rpc' AND started_at_ms = ? AND status = 'running' AND failure_code IS NULL AND parent_operation_id IS NULL",
          bindings: [...identity, nowMs],
        },
      ]),
    );
    return results.slice(2, -1);
  } catch {
    let admissionBlocked = false;
    if (admitted) {
      try {
        requireOne(
          await input.transport.atomicBatch("PROFILE_GAMES_DB", [
            {
              sql: "UPDATE application_data_admissions SET status = 'blocked', failure_code = 'operator-maintenance-unconfirmed' WHERE operation_id = ? AND generation = ? AND data_epoch = ? AND kind = 'rpc' AND started_at_ms = ? AND status = 'running' AND failure_code IS NULL AND parent_operation_id IS NULL",
              bindings: [...identity, nowMs],
            },
          ]),
        );
        admissionBlocked = true;
      } catch {
        admissionBlocked = false;
      }
    }
    throw new OperatorMaintenanceFailure(operationId, stage, admissionBlocked);
  }
}
