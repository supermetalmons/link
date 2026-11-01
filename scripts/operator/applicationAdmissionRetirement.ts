import { createHash } from "node:crypto";
import { canonicalReceiptJson } from "../../cloud/workers/api/src/canonicalJson.ts";
import type { MaintenanceStatement } from "./guardedMaintenance.ts";
import type {
  RemoteD1Binding,
  RemoteD1Transport,
} from "./remoteMaintenanceBinding.ts";

export const RETIREMENT_BINDINGS = [
  "PROFILE_GAMES_DB",
  "PROFILE_DB",
  "AUTH_STATE_DB",
  "EVENT_DB",
  "EVENT_PRIZE_WITHDRAWALS_DB",
  "TELEGRAM_DB",
] as const;
export type RetirementBinding = (typeof RETIREMENT_BINDINGS)[number];
export const RETIREMENT_MIGRATIONS: Record<RetirementBinding, string> = {
  PROFILE_GAMES_DB: "migrations/0040_application_admission_retirements.sql",
  PROFILE_DB: "profile-migrations/0024_application_admission_retirements.sql",
  AUTH_STATE_DB:
    "auth-state-migrations/0008_application_admission_retirements.sql",
  EVENT_DB: "event-migrations/0013_application_admission_retirements.sql",
  EVENT_PRIZE_WITHDRAWALS_DB:
    "event-prize-withdrawal-migrations/0010_application_admission_retirements.sql",
  TELEGRAM_DB: "telegram-migrations/0008_application_admission_retirements.sql",
};
export const RETIREMENT_TARGETS = [
  ["266a2a12-fc93-4a4e-bdc7-de88b8ad818a", 1793433731458],
  ["3107cbbf-8394-4434-a43e-c90c15cd5adb", 1793429628994],
  ["48a11e93-4502-4011-8248-f66a0e533611", 1793429693025],
  ["b885962f-efd9-4ce9-bedf-d572c6d06644", 1793429688980],
  ["ffeeedbe-6e4f-402b-9d6c-f450ae990b69", 1793429630130],
] as const;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ORIGINAL_FIELDS = [
  "operation_id",
  "generation",
  "data_epoch",
  "kind",
  "started_at_ms",
  "status",
  "failure_code",
  "parent_operation_id",
] as const;
const TOMBSTONE_FIELDS = [
  "operation_id",
  "generation",
  "data_epoch",
  "retirement_id",
  "manifest_digest",
  "original_row_json",
  "original_row_digest",
  "armed_at_ms",
] as const;
export const RETIREMENT_OUTCOME =
  "application-write-authority-retired-outcome-unknown";
type Row = Record<string, unknown>;
export type OriginalAdmission = {
  operation_id: string;
  generation: 3;
  data_epoch: 1;
  kind: "http";
  started_at_ms: number;
  status: "running";
  failure_code: null;
  parent_operation_id: null;
};
export type AdmissionRetirementManifest = {
  schemaVersion: 1;
  kind: "exact-http-admission-retirement";
  retirementId: string;
  accountId: string;
  generation: 3;
  dataEpoch: 1;
  armedAtMs: number;
  targets: OriginalAdmission[];
  databases: Array<{ binding: RetirementBinding; databaseId: string }>;
};
export type RetirementSchemaEntry = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
};
export type RetirementSnapshot = {
  binding: RetirementBinding;
  databaseId: string;
  schema: RetirementSchemaEntry[];
  control: Row;
  tombstones: Row[];
  originalAdmissions: Row[];
  rpcAdmissions: number | null;
  receipts: Row[];
};
export type RetirementDependencies = {
  transport(binding: RetirementBinding): Promise<RemoteD1Transport>;
  expectedSchema(binding: RetirementBinding): RetirementSchemaEntry[];
  now(): number;
  record?(event: Record<string, unknown>): void;
};
function fail(code: string): never {
  throw new Error(`admission-retirement-${code}`);
}
export function retirementJson(value: unknown): string {
  return canonicalReceiptJson(value, () => fail("invalid-json"));
}
export function retirementDigest(value: unknown): string {
  return createHash("sha256").update(retirementJson(value)).digest("hex");
}
function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid-record");
  return value as Row;
}
function exact(value: unknown, fields: readonly string[]): Row {
  const row = record(value);
  if (Object.keys(row).sort().join("\0") !== [...fields].sort().join("\0"))
    fail("unexpected-fields");
  return row;
}
function same(actual: unknown, expected: unknown, code: string): void {
  if (retirementJson(actual) !== retirementJson(expected)) fail(code);
}
export function parseAdmissionRetirementManifest(
  value: unknown,
): AdmissionRetirementManifest {
  const row = exact(value, [
    "schemaVersion",
    "kind",
    "retirementId",
    "accountId",
    "generation",
    "dataEpoch",
    "armedAtMs",
    "targets",
    "databases",
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.kind !== "exact-http-admission-retirement" ||
    row.generation !== 3 ||
    row.dataEpoch !== 1 ||
    row.accountId !== "e25f90fc073ea309b54b8b5144bf28e0" ||
    typeof row.retirementId !== "string" ||
    !UUID.test(row.retirementId) ||
    !Number.isSafeInteger(row.armedAtMs) ||
    Number(row.armedAtMs) <= 1793433731458
  )
    fail("invalid-manifest");
  const targets = RETIREMENT_TARGETS.map(([operation_id, started_at_ms]) => ({
    operation_id,
    generation: 3 as const,
    data_epoch: 1 as const,
    kind: "http" as const,
    started_at_ms,
    status: "running" as const,
    failure_code: null,
    parent_operation_id: null,
  }));
  same(row.targets, targets, "unreviewed-targets");
  if (
    !Array.isArray(row.databases) ||
    row.databases.length !== RETIREMENT_BINDINGS.length
  )
    fail("database-coverage");
  const databases = row.databases.map((entry, index) => {
    const database = exact(entry, ["binding", "databaseId"]);
    if (
      database.binding !== RETIREMENT_BINDINGS[index] ||
      typeof database.databaseId !== "string" ||
      !UUID.test(database.databaseId)
    )
      fail("database-identity");
    return {
      binding: RETIREMENT_BINDINGS[index]!,
      databaseId: database.databaseId,
    };
  });
  if (
    new Set(databases.map((entry) => entry.databaseId)).size !==
    databases.length
  )
    fail("database-alias");
  return {
    schemaVersion: 1,
    kind: "exact-http-admission-retirement",
    retirementId: row.retirementId,
    accountId: row.accountId,
    generation: 3,
    dataEpoch: 1,
    armedAtMs: Number(row.armedAtMs),
    targets,
    databases,
  };
}
export function expectedRetirementRows(
  manifest: AdmissionRetirementManifest,
): Row[] {
  const manifestDigest = retirementDigest(manifest);
  return manifest.targets.map((original) => ({
    operation_id: original.operation_id,
    generation: original.generation,
    data_epoch: original.data_epoch,
    retirement_id: manifest.retirementId,
    manifest_digest: manifestDigest,
    original_row_json: retirementJson(original),
    original_row_digest: retirementDigest(original),
    armed_at_ms: manifest.armedAtMs,
  }));
}
const placeholders = "?, ?, ?, ?, ?";
function targetIds(manifest: AdmissionRetirementManifest): string[] {
  return manifest.targets.map((row) => row.operation_id);
}
function statement(
  sql: string,
  bindings: readonly (string | number | null)[] = [],
): MaintenanceStatement {
  return { sql, bindings };
}
function guard(
  condition: string,
  bindings: readonly (string | number | null)[] = [],
): MaintenanceStatement {
  return statement(
    `INSERT INTO application_admission_retirement_guards (singleton) SELECT 0 WHERE NOT (${condition})`,
    bindings,
  );
}
function controlGuard(): MaintenanceStatement {
  return guard(
    "EXISTS (SELECT 1 FROM application_data_control WHERE singleton = 1 AND generation = 3 AND data_epoch = 1 AND phase = 'active')",
  );
}
function rpcGuard(): MaintenanceStatement {
  return guard(
    "NOT EXISTS (SELECT 1 FROM application_data_admissions WHERE generation = 3 AND data_epoch = 1 AND kind = 'rpc')",
  );
}
function sourceGuards(
  manifest: AdmissionRetirementManifest,
): MaintenanceStatement[] {
  return manifest.targets.map((row) =>
    guard(
      `EXISTS (SELECT 1 FROM application_data_admissions WHERE ${ORIGINAL_FIELDS.map((key) => `${key} IS ?`).join(" AND ")})`,
      ORIGINAL_FIELDS.map((key) => row[key]),
    ),
  );
}
function tombstoneGuards(
  manifest: AdmissionRetirementManifest,
): MaintenanceStatement[] {
  return expectedRetirementRows(manifest).map((row) =>
    guard(
      `EXISTS (SELECT 1 FROM application_admission_retirements WHERE ${TOMBSTONE_FIELDS.map((key) => `${key} IS ?`).join(" AND ")})`,
      TOMBSTONE_FIELDS.map((key) => row[key] as string | number),
    ),
  );
}
export function buildRetirementArmBatch(
  manifest: AdmissionRetirementManifest,
  binding: RetirementBinding,
): MaintenanceStatement[] {
  parseAdmissionRetirementManifest(manifest);
  if (!RETIREMENT_BINDINGS.includes(binding)) fail("binding-outside-scope");
  return [
    controlGuard(),
    ...(binding === "PROFILE_GAMES_DB"
      ? [rpcGuard(), ...sourceGuards(manifest)]
      : []),
    ...expectedRetirementRows(manifest).map((row) =>
      statement(
        `INSERT INTO application_admission_retirements (${TOMBSTONE_FIELDS.join(", ")}) VALUES (${TOMBSTONE_FIELDS.map(() => "?").join(", ")}) ON CONFLICT(operation_id) DO NOTHING`,
        TOMBSTONE_FIELDS.map((key) => row[key] as string | number),
      ),
    ),
    ...tombstoneGuards(manifest),
  ];
}
function normalizedSchema(
  rows: RetirementSchemaEntry[],
): RetirementSchemaEntry[] {
  return rows
    .map((row) => ({
      ...row,
      sql: row.sql.replace(/\s+/g, " ").trim().replace(/;$/, ""),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function inspectRetirementDatabase(
  manifest: AdmissionRetirementManifest,
  binding: RetirementBinding,
  dependencies: RetirementDependencies,
): Promise<RetirementSnapshot> {
  const transport = await dependencies.transport(binding),
    expected = dependencies.expectedSchema(binding);
  if (
    !expected.length ||
    new Set(expected.map((row) => row.name)).size !== expected.length
  )
    fail("invalid-expected-schema");
  const read = (
    sql: string,
    bindings: readonly (string | number | null)[] = [],
  ) => transport.readRows(binding, statement(sql, bindings));
  const schema = await read(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name IN (${expected.map(() => "?").join(", ")}) ORDER BY name`,
    expected.map((row) => row.name),
  );
  same(
    normalizedSchema(schema as RetirementSchemaEntry[]),
    normalizedSchema(expected),
    "schema-mismatch",
  );
  const controls = await read(
    "SELECT singleton, generation, data_epoch, phase, migration_id FROM application_data_control WHERE singleton = 1",
  );
  const control = controls[0];
  if (
    controls.length !== 1 ||
    !control ||
    control.generation !== 3 ||
    control.data_epoch !== 1 ||
    control.phase !== "active"
  )
    fail("control-mismatch");
  const tombstones = await read(
    `SELECT ${TOMBSTONE_FIELDS.join(", ")} FROM application_admission_retirements WHERE retirement_id = ? OR operation_id IN (${placeholders}) ORDER BY operation_id`,
    [manifest.retirementId, ...targetIds(manifest)],
  );
  if (tombstones.length !== 0)
    same(tombstones, expectedRetirementRows(manifest), "tombstone-mismatch");
  const central = binding === "PROFILE_GAMES_DB";
  const originalAdmissions = central
    ? await read(
        `SELECT ${ORIGINAL_FIELDS.join(", ")} FROM application_data_admissions WHERE operation_id IN (${placeholders}) ORDER BY operation_id`,
        targetIds(manifest),
      )
    : [];
  const rpcRows = central
    ? await read(
        "SELECT COUNT(*) AS count FROM application_data_admissions WHERE generation = 3 AND data_epoch = 1 AND kind = 'rpc'",
      )
    : [];
  const rpcAdmissions = central ? Number(rpcRows[0]?.count) : null;
  if (central && (!Number.isSafeInteger(rpcAdmissions) || rpcAdmissions! < 0))
    fail("rpc-read-unconfirmed");
  const receipts = central
    ? await read(
        "SELECT * FROM application_admission_retirement_receipts WHERE retirement_id = ?",
        [manifest.retirementId],
      )
    : [];
  if (receipts.length > 1) fail("duplicate-receipt");
  const database = manifest.databases.find(
    (entry) => entry.binding === binding,
  );
  if (!database) fail("binding-outside-scope");
  return {
    binding,
    databaseId: database.databaseId,
    schema: schema as RetirementSchemaEntry[],
    control,
    tombstones,
    originalAdmissions,
    rpcAdmissions,
    receipts,
  };
}
export async function inspectAdmissionRetirement(
  manifest: AdmissionRetirementManifest,
  dependencies: RetirementDependencies,
): Promise<RetirementSnapshot[]> {
  parseAdmissionRetirementManifest(manifest);
  const snapshots: RetirementSnapshot[] = [];
  for (const binding of RETIREMENT_BINDINGS)
    snapshots.push(
      await inspectRetirementDatabase(manifest, binding, dependencies),
    );
  return snapshots;
}
function replicaProof(snapshots: RetirementSnapshot[]): Row[] {
  return snapshots.map((snapshot) => ({
    binding: snapshot.binding,
    databaseId: snapshot.databaseId,
    schemaDigest: retirementDigest(normalizedSchema(snapshot.schema)),
    tombstoneDigest: retirementDigest(snapshot.tombstones),
  }));
}
function verifyArmed(
  manifest: AdmissionRetirementManifest,
  snapshots: RetirementSnapshot[],
): void {
  same(
    snapshots.map((row) => row.binding),
    RETIREMENT_BINDINGS,
    "snapshot-coverage",
  );
  for (const snapshot of snapshots)
    same(snapshot.tombstones, expectedRetirementRows(manifest), "not-armed");
}
function verifyReceipt(
  manifest: AdmissionRetirementManifest,
  snapshots: RetirementSnapshot[],
): Row | null {
  const central = snapshots[0]!;
  if (!central.receipts.length) return null;
  verifyArmed(manifest, snapshots);
  const receipt = exact(central.receipts[0], [
    "retirement_id",
    "manifest_digest",
    "original_rows_json",
    "replica_proof_json",
    "replica_proof_digest",
    "outcome",
    "accepted_independent_work_preserved",
    "successful_completion_claimed",
    "invocation_termination_claimed",
    "completed_at_ms",
  ]);
  const proof = replicaProof(snapshots);
  same(
    { ...receipt, completed_at_ms: 1 },
    {
      retirement_id: manifest.retirementId,
      manifest_digest: retirementDigest(manifest),
      original_rows_json: retirementJson(manifest.targets),
      replica_proof_json: retirementJson(proof),
      replica_proof_digest: retirementDigest(proof),
      outcome: RETIREMENT_OUTCOME,
      accepted_independent_work_preserved: 1,
      successful_completion_claimed: 0,
      invocation_termination_claimed: 0,
      completed_at_ms: 1,
    },
    "receipt-mismatch",
  );
  if (
    !Number.isSafeInteger(receipt.completed_at_ms) ||
    Number(receipt.completed_at_ms) < manifest.armedAtMs ||
    central.originalAdmissions.length !== 0
  )
    fail("retirement-incomplete");
  return receipt;
}
export function buildRetirementFinalizeBatch(
  manifest: AdmissionRetirementManifest,
  snapshots: RetirementSnapshot[],
  nowMs: number,
): MaintenanceStatement[] {
  parseAdmissionRetirementManifest(manifest);
  verifyArmed(manifest, snapshots);
  if (!Number.isSafeInteger(nowMs) || nowMs < manifest.armedAtMs)
    fail("invalid-finalization-time");
  const proof = replicaProof(snapshots);
  return [
    controlGuard(),
    rpcGuard(),
    ...sourceGuards(manifest),
    ...tombstoneGuards(manifest),
    statement(
      "INSERT INTO application_admission_retirement_receipts (retirement_id, manifest_digest, original_rows_json, replica_proof_json, replica_proof_digest, outcome, accepted_independent_work_preserved, successful_completion_claimed, invocation_termination_claimed, completed_at_ms) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?)",
      [
        manifest.retirementId,
        retirementDigest(manifest),
        retirementJson(manifest.targets),
        retirementJson(proof),
        retirementDigest(proof),
        RETIREMENT_OUTCOME,
        nowMs,
      ],
    ),
    statement(
      `DELETE FROM application_data_admissions WHERE operation_id IN (${placeholders})`,
      targetIds(manifest),
    ),
    guard(
      `NOT EXISTS (SELECT 1 FROM application_data_admissions WHERE operation_id IN (${placeholders}))`,
      targetIds(manifest),
    ),
  ];
}
export type RetirementOperation =
  "inspect" | "arm-central" | "arm-replicas" | "finalize";
export async function executeAdmissionRetirement(
  operation: RetirementOperation,
  value: unknown,
  dependencies: RetirementDependencies,
): Promise<{
  operation: RetirementOperation;
  confirmed: true;
  reconciledAfterUncertainResponse: boolean;
  snapshots: RetirementSnapshot[];
}> {
  const manifest = parseAdmissionRetirementManifest(value);
  let snapshots = await inspectAdmissionRetirement(manifest, dependencies);
  if (operation === "inspect")
    return {
      operation,
      confirmed: true,
      reconciledAfterUncertainResponse: false,
      snapshots,
    };
  if (!["arm-central", "arm-replicas", "finalize"].includes(operation))
    fail("invalid-operation");
  if (verifyReceipt(manifest, snapshots))
    return {
      operation,
      confirmed: true,
      reconciledAfterUncertainResponse: false,
      snapshots,
    };
  same(snapshots[0]!.originalAdmissions, manifest.targets, "source-changed");
  let uncertain = false;
  const execute = async (
    binding: RetirementBinding,
    batch: MaintenanceStatement[],
    confirmed: (readback: RetirementSnapshot[]) => boolean,
  ) => {
    dependencies.record?.({
      kind: "atomic-batch-intent",
      binding,
      statements: batch,
      snapshotDigest: retirementDigest(snapshots),
      automaticRetry: false,
    });
    try {
      const result = await (
        await dependencies.transport(binding)
      ).atomicBatch(binding as RemoteD1Binding, batch);
      if (
        result.length !== batch.length ||
        result.some(
          (entry) =>
            !entry.success || !Number.isSafeInteger(entry.meta.changes),
        )
      )
        uncertain = true;
    } catch {
      uncertain = true;
    }
    snapshots = await inspectAdmissionRetirement(manifest, dependencies);
    dependencies.record?.({
      kind: "atomic-batch-readback",
      binding,
      uncertainResponse: uncertain,
      snapshots,
    });
    if (!confirmed(snapshots)) fail("mutation-unconfirmed-readback-required");
  };
  if (operation === "arm-central") {
    if (!snapshots[0]!.tombstones.length)
      await execute(
        "PROFILE_GAMES_DB",
        buildRetirementArmBatch(manifest, "PROFILE_GAMES_DB"),
        (rows) =>
          rows[0]!.tombstones.length === 5 &&
          rows[0]!.originalAdmissions.length === 5,
      );
  } else {
    same(
      snapshots[0]!.tombstones,
      expectedRetirementRows(manifest),
      "central-not-armed",
    );
    if (operation === "arm-replicas") {
      for (const binding of RETIREMENT_BINDINGS.slice(1)) {
        if (
          !snapshots.find((row) => row.binding === binding)!.tombstones.length
        )
          await execute(
            binding,
            buildRetirementArmBatch(manifest, binding),
            (rows) =>
              rows.find((row) => row.binding === binding)!.tombstones.length ===
              5,
          );
      }
      verifyArmed(manifest, snapshots);
    } else {
      verifyArmed(manifest, snapshots);
      await execute(
        "PROFILE_GAMES_DB",
        buildRetirementFinalizeBatch(manifest, snapshots, dependencies.now()),
        (rows) => verifyReceipt(manifest, rows) !== null,
      );
    }
  }
  return {
    operation,
    confirmed: true,
    reconciledAfterUncertainResponse: uncertain,
    snapshots,
  };
}
