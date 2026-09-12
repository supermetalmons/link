import { AuthApiFailure } from "./authErrors.ts";
import {
  d1MigrationDigest,
  type D1MigrationBinding,
} from "./d1MigrationControl.ts";
import { CANONICAL_PROFILE_TOPOLOGY_AUDIT_SQL } from "./profileTopologySql.ts";

export const D1_MIGRATION_FENCE_PREFIX = "d1_migration_fence_";
const GUARD_PREFIX = "d1_migration_guard_";
const APPLICATION_SCHEMA = `substr(name, 1, 7) != 'sqlite_'
  AND substr(name, 1, 4) != '_cf_'`;
const ORIGINAL_SCHEMA = `${APPLICATION_SCHEMA}
  AND substr(name, 1, ${D1_MIGRATION_FENCE_PREFIX.length}) != '${D1_MIGRATION_FENCE_PREFIX}'`;

export type D1MigrationSchemaEntry = {
  type: string;
  name: string;
  tableName: string;
  sql: string;
};

type Control = { table: string; columns: string[]; frozen?: string };
type Blocker = { name: string; sql: string };
type DatabasePolicy = { controls: Control[]; blockers: Blocker[] };

const tableBlocker = (table: string): Blocker => ({
  name: table,
  sql: `SELECT COUNT(*) FROM ${table}`,
});

const liveLeaseBlocker = (table: string): Blocker => ({
  name: table,
  sql: `SELECT COUNT(*) FROM ${table} WHERE expires_at_ms > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`,
});

const POLICIES: Record<D1MigrationBinding, DatabasePolicy> = {
  PROFILE_GAMES_DB: {
    controls: [
      {
        table: "automatch_runtime_control",
        columns: ["backend", "state", "epoch", "freeze_generation"],
        frozen: "backend = 'd1' AND state = 'frozen'",
      },
      {
        table: "match_state_control",
        columns: ["backend", "state", "epoch", "freeze_generation"],
        frozen: "backend = 'durable' AND epoch > 0",
      },
      {
        table: "invite_source_control",
        columns: ["backend", "state", "epoch", "freeze_generation"],
        frozen: "backend = 'd1' AND epoch > 0",
      },
    ],
    blockers: [
      ...[
        "match_state_write_admissions",
        "invite_source_write_admissions",
        "automatch_write_admissions",
      ].map(tableBlocker),
      ...["game_session_mutation_locks", "profile_game_projection_locks"].map(
        liveLeaseBlocker,
      ),
    ],
  },
  AUTH_STATE_DB: { controls: [], blockers: [] },
  TELEGRAM_DB: {
    controls: [
      {
        table: "telegram_runtime_control",
        columns: ["storage_mode"],
        frozen: "storage_mode = 'frozen'",
      },
    ],
    blockers: [
      {
        name: "telegram_processing_deliveries",
        sql: `SELECT COUNT(*) FROM telegram_messages
          WHERE json_extract(record_json, '$.delivery.status') = 'processing'
            OR (json_type(record_json, '$.delivery.sendInFlight') = 'object'
              AND json_extract(record_json, '$.delivery.status') IS NOT 'uncertain')
            OR json_extract(record_json, '$.delivery.pendingDelete.status') = 'processing'
            OR COALESCE(json_extract(record_json, '$.delivery.leaseOwner'), '') != ''
            OR COALESCE(json_extract(record_json, '$.delivery.pendingDelete.leaseOwner'), '') != ''
            OR COALESCE(json_extract(record_json, '$.delivery.retryProofLeaseOwner'), '') != ''`,
      },
      {
        name: "telegram_api_gate",
        sql: `SELECT COUNT(*) FROM telegram_delivery_control
          WHERE COALESCE(json_extract(record_json, '$.apiGate.owner'), '') != ''`,
      },
      {
        name: "telegram_sending_announcements",
        sql: "SELECT COUNT(*) FROM telegram_event_prize_announcements WHERE status = 'sending'",
      },
    ],
  },
  EVENT_PRIZE_WITHDRAWALS_DB: {
    controls: [
      {
        table: "event_prize_withdrawal_runtime_control",
        columns: ["storage_mode", "previous_storage_mode"],
        frozen: "storage_mode = 'frozen' AND previous_storage_mode = 'd1'",
      },
    ],
    blockers: [
      {
        name: "unfinished_withdrawal_submissions",
        sql: `SELECT COUNT(*) FROM event_prize_withdrawals
          WHERE json_extract(record_json, '$.status') IN ('processing', 'submitted')`,
      },
    ],
  },
  PROFILE_DB: {
    controls: [
      {
        table: "profile_canonical_control",
        columns: ["state"],
        frozen: "state = 'frozen'",
      },
      {
        table: "wager_reservation_runtime_control",
        columns: ["storage_mode", "freeze_generation"],
        frozen: "storage_mode = 'frozen'",
      },
    ],
    blockers: [tableBlocker("wager_reservation_write_admissions")],
  },
  EVENT_DB: {
    controls: [
      {
        table: "event_runtime_control",
        columns: ["storage_mode", "freeze_generation"],
        frozen: "storage_mode = 'frozen'",
      },
    ],
    blockers: [
      tableBlocker("event_write_admissions"),
      liveLeaseBlocker("event_leases"),
    ],
  },
};

function identifier(value: string): string {
  if (!value || value.includes("\0"))
    throw new Error("d1-migration-invalid-schema");
  return `"${value.replaceAll('"', '""')}"`;
}

function failure(message: string): never {
  throw new AuthApiFailure(409, "failed-precondition", message);
}

function blockers(binding: D1MigrationBinding): Blocker[] {
  const policy = POLICIES[binding];
  return [
    ...policy.controls
      .filter((control) => control.frozen)
      .map((control) => ({
        name: `${control.table}_not_ready`,
        sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM ${control.table}
        WHERE singleton = 1 AND ${control.frozen}) THEN 0 ELSE 1 END`,
      })),
    ...policy.blockers,
  ];
}

function blockerQuery(binding: D1MigrationBinding): string {
  const checks = blockers(binding);
  return checks.length
    ? `SELECT ${checks.map((check) => `(${check.sql}) AS ${identifier(check.name)}`).join(", ")}`
    : "SELECT 0 AS maintenance_gate";
}

async function readSchema(db: D1Database): Promise<D1MigrationSchemaEntry[]> {
  const result = await db
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
      WHERE ${APPLICATION_SCHEMA} AND sql IS NOT NULL ORDER BY type, name`,
    )
    .all<D1MigrationSchemaEntry>();
  if (!result.success || !result.results.length)
    throw new Error("d1-migration-schema-unavailable");
  for (const row of result.results) {
    if (
      !["table", "view", "index", "trigger"].includes(row.type) ||
      typeof row.name !== "string" ||
      typeof row.tableName !== "string" ||
      typeof row.sql !== "string" ||
      row.name.startsWith(GUARD_PREFIX)
    )
      throw new Error("d1-migration-invalid-schema");
  }
  const tableTypes = await db
    .prepare("PRAGMA table_list")
    .all<{ name: string; type: string }>();
  if (!tableTypes.success) throw new Error("d1-migration-schema-unavailable");
  if (
    tableTypes.results.some(
      (table) =>
        !table.name.startsWith("sqlite_") &&
        !table.name.startsWith("_cf_") &&
        (table.type === "virtual" || table.type === "shadow"),
    )
  )
    throw new Error("d1-migration-unsupported-virtual-table");
  return result.results;
}

async function expectedFences(runId: string, tables: string[]) {
  const run = (await d1MigrationDigest(runId)).slice(0, 16);
  return (
    await Promise.all(
      tables.map(async (table) => {
        const target = (await d1MigrationDigest(table)).slice(0, 24);
        return ["INSERT", "UPDATE", "DELETE"].map((operation) => {
          const name = `${D1_MIGRATION_FENCE_PREFIX}${run}_${target}_${operation.toLowerCase()}`;
          return {
            type: "trigger",
            name,
            tableName: table,
            sql: `CREATE TRIGGER ${identifier(name)} BEFORE ${operation} ON ${identifier(table)} BEGIN SELECT RAISE(ABORT, 'd1-migration-source-frozen'); END`,
          } satisfies D1MigrationSchemaEntry;
        });
      }),
    )
  ).flat();
}

function equalSchema(
  a: D1MigrationSchemaEntry,
  b: D1MigrationSchemaEntry,
): boolean {
  return (
    a.type === b.type &&
    a.name === b.name &&
    a.tableName === b.tableName &&
    a.sql === b.sql
  );
}

export async function readD1MigrationStatus(
  db: D1Database,
  binding: D1MigrationBinding,
  runId: string,
) {
  const liveSchema = await readSchema(db);
  const schema = liveSchema.filter(
    (entry) => !entry.name.startsWith(D1_MIGRATION_FENCE_PREFIX),
  );
  const tables = schema
    .filter((entry) => entry.type === "table")
    .map((entry) => entry.name)
    .sort();
  if (!tables.includes("d1_migrations"))
    throw new Error("d1-migration-history-unavailable");
  const expected = await expectedFences(runId, tables);
  const installed = liveSchema.filter((entry) =>
    entry.name.startsWith(D1_MIGRATION_FENCE_PREFIX),
  );
  if (
    installed.some(
      (entry) => !expected.some((candidate) => equalSchema(entry, candidate)),
    )
  )
    failure("d1-migration-fence-conflict");
  const controls = await Promise.all(
    POLICIES[binding].controls.map(async (control) => {
      const result = await db
        .prepare(
          `SELECT ${control.columns.join(", ")} FROM ${control.table} WHERE singleton = 1`,
        )
        .all<Record<string, unknown>>();
      if (!result.success || result.results.length !== 1)
        throw new Error("d1-migration-control-unavailable");
      return { table: control.table, ...result.results[0] };
    }),
  );
  const result = await db
    .prepare(blockerQuery(binding))
    .first<Record<string, number>>();
  if (
    !result ||
    Object.values(result).some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    )
  )
    throw new Error("d1-migration-drain-unavailable");
  const pending = Object.entries(result).map(([name, count]) => ({
    name,
    count,
  }));
  return {
    binding,
    schemaDigest: await d1MigrationDigest(schema),
    schema,
    tables,
    controls,
    blockers: pending,
    drained: pending.every((row) => row.count === 0),
    fence: {
      expectedTriggers: expected.length,
      installedTriggers: installed.length,
      complete: installed.length === expected.length,
      triggerNames: expected.map((entry) => entry.name),
    },
  };
}

export async function fenceD1MigrationSource(
  db: D1Database,
  binding: D1MigrationBinding,
  runId: string,
  schemaDigest: string,
) {
  const before = await readD1MigrationStatus(db, binding, runId);
  if (before.schemaDigest !== schemaDigest)
    failure("d1-migration-schema-conflict");
  if (!before.drained) failure("d1-migration-writers-not-drained");
  if (before.fence.complete) return before;
  if (before.fence.installedTriggers) failure("d1-migration-partial-fence");
  const guardName = `${GUARD_PREFIX}${(await d1MigrationDigest(runId)).slice(0, 16)}`;
  const guard = identifier(guardName);
  const expected = await expectedFences(runId, before.tables);
  const schemaGuard = `NOT EXISTS (
      SELECT 1 FROM json_each(?) AS wanted
      LEFT JOIN sqlite_master AS actual
        ON actual.type = json_extract(wanted.value, '$.type')
        AND actual.name = json_extract(wanted.value, '$.name')
      WHERE actual.tbl_name IS NOT json_extract(wanted.value, '$.tableName')
        OR actual.sql IS NOT json_extract(wanted.value, '$.sql')
    ) AND (SELECT COUNT(*) FROM sqlite_master WHERE ${ORIGINAL_SCHEMA} AND sql IS NOT NULL AND name != ?) = ?`;
  const drainGuard =
    blockers(binding)
      .map((check) => `(${check.sql}) = 0`)
      .join(" AND ") || "1";
  await db.batch([
    db.prepare(
      `CREATE TABLE ${guard} (clear INTEGER NOT NULL CHECK (clear = 1))`,
    ),
    db
      .prepare(
        `INSERT INTO ${guard} (clear) SELECT CASE WHEN ${schemaGuard}
      AND ${drainGuard}
      THEN 1 ELSE 0 END`,
      )
      .bind(JSON.stringify(before.schema), guardName, before.schema.length),
    ...expected.map((entry) => db.prepare(entry.sql)),
    db.prepare(`DROP TABLE ${guard}`),
  ]);
  const after = await readD1MigrationStatus(db, binding, runId);
  if (
    after.schemaDigest !== schemaDigest ||
    !after.fence.complete ||
    !after.drained
  )
    throw new Error("d1-migration-fence-unconfirmed");
  return after;
}

export async function verifyD1MigrationDatabase(
  db: D1Database,
  binding: D1MigrationBinding,
  bookmark?: string,
) {
  if (
    bookmark !== undefined &&
    (bookmark.length === 0 || bookmark.length > 4096)
  )
    throw new Error("d1-migration-invalid-bookmark");
  const [integrity, foreignKeys] = await Promise.all([
    db.prepare("PRAGMA quick_check").all<{ quick_check: string }>(),
    db.prepare("PRAGMA foreign_key_check").all<Record<string, unknown>>(),
  ]);
  if (!integrity.success || !foreignKeys.success)
    throw new Error("d1-migration-verification-unavailable");
  const topologySql =
    binding === "PROFILE_DB"
      ? CANONICAL_PROFILE_TOPOLOGY_AUDIT_SQL
      : binding === "PROFILE_GAMES_DB"
        ? `SELECT
        (SELECT COUNT(*) FROM match_state_routes AS route
          WHERE route.epoch != (SELECT epoch FROM match_state_control WHERE singleton = 1)) AS route_epoch_mismatches,
        (SELECT COUNT(*) FROM match_state_routes AS route
          LEFT JOIN match_state_legacy_records AS record ON record.actor_uid = route.actor_uid AND record.match_id = route.match_id
          WHERE route.kind = 'legacy' AND record.actor_uid IS NULL) AS legacy_routes_without_records`
        : null;
  const topology = topologySql
    ? await db.prepare(topologySql).first<Record<string, number>>()
    : {};
  if (
    !topology ||
    Object.values(topology).some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    )
  )
    throw new Error("d1-migration-topology-unavailable");
  let sessionResult: {
    bookmark: string | null;
    bookmarkAccepted: boolean;
    migrationCount: number | null;
    bookmarkError?: string;
  };
  try {
    const session = db.withSession(bookmark ?? "first-primary");
    const migrationCount = await session
      .prepare("SELECT COUNT(*) AS count FROM d1_migrations")
      .first<number>("count");
    if (
      migrationCount === null ||
      !Number.isSafeInteger(migrationCount) ||
      migrationCount < 0
    )
      throw new Error("d1-migration-session-read-unavailable");
    sessionResult = {
      bookmark: session.getBookmark(),
      bookmarkAccepted: true,
      migrationCount,
    };
  } catch (error) {
    if (bookmark === undefined) throw error;
    sessionResult = {
      bookmark: null,
      bookmarkAccepted: false,
      migrationCount: null,
      bookmarkError:
        error instanceof Error
          ? error.message.replaceAll(bookmark, "[bookmark]").slice(0, 512)
          : "native-session-read-failed",
    };
  }
  return {
    binding,
    ...sessionResult,
    integrityCheckKind: "quick_check" as const,
    integrityCheck: integrity.results.map((row) => row.quick_check),
    foreignKeyViolations: foreignKeys.results.length,
    topology,
    valid:
      sessionResult.bookmarkAccepted &&
      integrity.results.length === 1 &&
      integrity.results[0].quick_check === "ok" &&
      foreignKeys.results.length === 0 &&
      Object.values(topology).every((count) => count === 0),
  };
}
