import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseApplicationDataControl,
  type ApplicationDataControl,
} from "../../cloud/workers/api/src/applicationDataRecords.ts";
import { DEFAULT_API_CONFIG, resolveD1Coordinates } from "./configuration.ts";
import {
  OperatorMaintenanceFailure,
  runGuardedOperatorMaintenance,
  type MaintenanceBinding,
  type MaintenanceTransport,
} from "./guardedMaintenance.ts";
import {
  createWranglerRunner,
  resolveCloudflareToken,
  type SqlRunner,
} from "./runtime.ts";

type BindingValue = string | number | null;
type Row = Record<string, unknown>;
export type GuardedOperatorSession = {
  transport: MaintenanceTransport;
  dispose(): Promise<void>;
};
type Options = {
  apiToken?: string;
  fetcher?: typeof fetch;
  configPath?: string;
  now?: () => number;
  createOperationId?: () => string;
  openSession?: (
    binding: MaintenanceBinding,
  ) => Promise<GuardedOperatorSession>;
};
type Job = { sql: string; database: string; bindings: BindingValue[] };
type ProcessResult = { status: number | null; stdout: string };
const PROFILE_DATABASE = "mons-link-profiles";
const CENTRAL_DATABASE = "PROFILE_GAMES_DB";
const MAX_BYTES = 4 * 1024 * 1024;
const CONTROL_SQL =
  "SELECT singleton, generation, data_epoch, phase, migration_id FROM application_data_control WHERE singleton = 1";
const TABLES: Record<
  string,
  { binding: string; operation: "UPDATE" | "DELETE" }
> = {
  automatch_runtime_control: { binding: CENTRAL_DATABASE, operation: "UPDATE" },
  automatch_write_admissions: {
    binding: CENTRAL_DATABASE,
    operation: "DELETE",
  },
  invite_source_write_admissions: {
    binding: CENTRAL_DATABASE,
    operation: "DELETE",
  },
  event_runtime_control: { binding: "EVENT_DB", operation: "UPDATE" },
  event_write_admissions: { binding: "EVENT_DB", operation: "DELETE" },
  profile_canonical_control: { binding: "PROFILE_DB", operation: "UPDATE" },
  wager_reservation_runtime_control: {
    binding: "PROFILE_DB",
    operation: "UPDATE",
  },
  wager_reservation_write_admissions: {
    binding: "PROFILE_DB",
    operation: "DELETE",
  },
  event_prize_withdrawal_runtime_control: {
    binding: "EVENT_PRIZE_WITHDRAWALS_DB",
    operation: "UPDATE",
  },
};

export class GuardedOperatorSqlFailure extends Error {
  readonly code: string;
  readonly operationId: string | null;
  readonly stage: "admission" | "mutation" | "completion" | "cleanup" | null;
  readonly queryConfirmed: boolean;
  readonly cleanupUnconfirmed: boolean;

  constructor(
    code: string,
    operationId: string | null = null,
    details: {
      stage?: GuardedOperatorSqlFailure["stage"];
      queryConfirmed?: boolean;
      cleanupUnconfirmed?: boolean;
    } = {},
  ) {
    super(
      details.queryConfirmed
        ? `${code}; SQL completed; inspect operation ${operationId} without repeating the SQL`
        : operationId
          ? `${code}; operation ${operationId} requires inspection`
          : code,
    );
    this.name = "GuardedOperatorSqlFailure";
    this.code = code;
    this.operationId = operationId;
    this.stage = details.stage ?? null;
    this.queryConfirmed = details.queryConfirmed ?? false;
    this.cleanupUnconfirmed = details.cleanupUnconfirmed ?? false;
  }
}
function fail(code: string): never {
  throw new GuardedOperatorSqlFailure(code);
}
function record(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("invalid-operator-query-response");
  return Object.fromEntries(Object.entries(value));
}
function singleStatement(sql: string): string {
  if (Buffer.byteLength(sql) > 90 * 1024) fail("operator-query-too-large");
  let normalized = "",
    terminated = false;
  for (let offset = 0; offset < sql.length;) {
    if (/\s/.test(sql[offset]!)) {
      normalized += " ";
      offset++;
      continue;
    }
    if (sql.startsWith("--", offset)) {
      const end = sql.indexOf("\n", offset + 2);
      offset = end < 0 ? sql.length : end + 1;
      normalized += " ";
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      const end = sql.indexOf("*/", offset + 2);
      if (end < 0) fail("invalid-operator-sql");
      offset = end + 2;
      normalized += " ";
      continue;
    }
    if (terminated) fail("operator-sql-multiple-statements-forbidden");
    const character = sql[offset]!;
    if (character === ";") {
      terminated = true;
      offset++;
      continue;
    }
    if (["'", '"', "`", "["].includes(character)) {
      const endQuote = character === "[" ? "]" : character;
      normalized += " quoted ";
      offset++;
      let closed = false;
      while (offset < sql.length) {
        if (sql[offset++] !== endQuote) continue;
        if (endQuote !== "]" && sql[offset] === endQuote) {
          offset++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) fail("invalid-operator-sql");
      continue;
    }
    normalized += character;
    offset++;
  }
  return normalized.trim();
}
function validateBindings(
  bindings: readonly unknown[],
): asserts bindings is readonly BindingValue[] {
  if (
    bindings.length > 100 ||
    bindings.some(
      (value) =>
        value !== null &&
        typeof value !== "string" &&
        (typeof value !== "number" || !Number.isFinite(value)),
    )
  )
    fail("invalid-operator-query-bindings");
}
function hasOuterWhere(sql: string): boolean {
  let depth = 0;
  for (const [token] of sql.matchAll(/[()]|[a-z_][a-z0-9_]*/gi)) {
    if (token === "(") depth++;
    else if (token === ")") {
      if (--depth < 0) return false;
    } else if (depth === 0 && token.toUpperCase() === "WHERE") return true;
  }
  return false;
}
function parseControl(rows: Row[]): ApplicationDataControl {
  if (rows.length !== 1) fail("operator-application-control-unavailable");
  const control = parseApplicationDataControl(rows[0]);
  if (control.phase !== "active" || control.dataEpoch !== 1)
    fail("operator-application-control-unavailable");
  return control;
}
export function createGuardedOperatorRunner({
  apiToken,
  fetcher = fetch,
  configPath = DEFAULT_API_CONFIG,
  now = Date.now,
  createOperationId = randomUUID,
  openSession,
}: Options = {}): SqlRunner {
  let token: string | undefined = apiToken;
  const credentials = () => (token ??= resolveCloudflareToken());
  const read: SqlRunner = (sql, database, bindings) =>
    createWranglerRunner({ apiToken: credentials(), fetcher, configPath })(
      sql,
      database,
      bindings,
    );
  return async (sql, database = PROFILE_DATABASE, bindings = []) => {
    validateBindings(bindings);
    const normalized = singleStatement(sql);
    if (/^(?:SELECT|EXPLAIN\s+(?:QUERY\s+PLAN\s+)?SELECT)\b/i.test(normalized))
      return read(sql, database, bindings);
    const match =
      /^(UPDATE)\s+([a-z_][a-z0-9_]*)\b|^(DELETE)\s+FROM\s+([a-z_][a-z0-9_]*)\b/i.exec(
        normalized,
      );
    const operation = match?.[1] ?? match?.[3],
      table = match?.[2] ?? match?.[4];
    const allowed = table ? TABLES[table.toLowerCase()] : undefined;
    const coordinates = resolveD1Coordinates(database, configPath);
    if (
      !allowed ||
      operation?.toUpperCase() !== allowed.operation ||
      coordinates.binding !== allowed.binding ||
      !hasOuterWhere(normalized)
    )
      fail("operator-write-target-forbidden");
    const binding = coordinates.binding as MaintenanceBinding;
    const session = openSession
      ? await openSession(binding)
      : await (
          await import("./remoteMaintenanceBinding.ts")
        ).openRemoteMaintenanceTransport(binding, {
          configPath,
          apiToken: credentials(),
        });
    let failed = false,
      failure: unknown,
      queryConfirmed = false,
      operationId: string | null = null,
      rows: Row[] | undefined;
    try {
      const control = parseControl(
        (await session.transport.readControl()).map(record),
      );
      if (binding !== CENTRAL_DATABASE) {
        const result = await session.transport.atomicBatch(binding, [
          { sql: CONTROL_SQL, bindings: [] },
        ]);
        if (result.length !== 1 || result[0]?.success !== true)
          fail("operator-application-control-unavailable");
        const local = parseControl(result[0].results);
        if (
          local.generation !== control.generation ||
          local.dataEpoch !== control.dataEpoch
        )
          fail("operator-application-generation-mismatch");
      }
      const result = await runGuardedOperatorMaintenance({
        transport: session.transport,
        binding,
        generation: control.generation,
        dataEpoch: 1,
        statements: [{ sql, bindings }],
        now,
        createOperationId: () => {
          operationId = createOperationId();
          return operationId;
        },
      });
      queryConfirmed = true;
      rows = result[0]!.results;
    } catch (error) {
      failed = true;
      failure =
        error instanceof OperatorMaintenanceFailure
          ? new GuardedOperatorSqlFailure(
              error.stage === "admission"
                ? "operator-admission-unconfirmed"
                : error.stage === "completion"
                  ? "operator-write-confirmed-admission-unconfirmed"
                  : "operator-write-unconfirmed",
              error.operationId,
              {
                stage: error.stage,
                queryConfirmed: error.stage === "completion",
              },
            )
          : error;
    }
    try {
      await session.dispose();
    } catch {
      if (failed) {
        if (failure instanceof GuardedOperatorSqlFailure)
          failure = new GuardedOperatorSqlFailure(
            failure.code,
            failure.operationId,
            {
              stage: failure.stage,
              queryConfirmed: failure.queryConfirmed,
              cleanupUnconfirmed: true,
            },
          );
      } else {
        failed = true;
        failure = new GuardedOperatorSqlFailure(
          queryConfirmed
            ? "operator-write-confirmed-cleanup-unconfirmed"
            : "operator-cleanup-unconfirmed",
          operationId,
          { stage: "cleanup", queryConfirmed, cleanupUnconfirmed: true },
        );
      }
    }
    if (failed) throw failure;
    return rows!;
  };
}

function parseJob(value: unknown): Job {
  const row = record(value);
  if (
    Object.keys(row).length !== 3 ||
    typeof row.sql !== "string" ||
    typeof row.database !== "string" ||
    !Array.isArray(row.bindings)
  )
    fail("invalid-operator-rpc");
  validateBindings(row.bindings);
  singleStatement(row.sql);
  return { sql: row.sql, database: row.database, bindings: [...row.bindings] };
}

export function runGuardedOperatorSqlSync(
  sql: string,
  database: string,
  bindings: BindingValue[] = [],
  invoke?: (input: string) => ProcessResult,
): Row[] {
  const input = JSON.stringify(parseJob({ sql, database, bindings }));
  if (Buffer.byteLength(input) > MAX_BYTES) fail("operator-rpc-too-large");
  const execute =
    invoke ??
    ((input: string): ProcessResult => {
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          fileURLToPath(import.meta.url),
          "--json-rpc",
        ],
        {
          input,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          shell: false,
          cwd: resolve(import.meta.dirname, "../.."),
        },
      );
      return { status: result.status, stdout: result.stdout ?? "" };
    });
  const output = execute(input);
  let response: Row;
  try {
    response = record(JSON.parse(output.stdout));
  } catch {
    return fail("operator-rpc-unconfirmed");
  }
  if (
    output.status !== 0 ||
    response.ok !== true ||
    !Array.isArray(response.rows)
  ) {
    const operationId =
      typeof response.operationId === "string" &&
      /^[a-f0-9-]{36}$/.test(response.operationId)
        ? response.operationId
        : null;
    const queryConfirmed =
      response.queryConfirmed === true &&
      [
        "operator-write-confirmed-admission-unconfirmed",
        "operator-write-confirmed-cleanup-unconfirmed",
      ].includes(String(response.code));
    const stage = ["admission", "mutation", "completion", "cleanup"].includes(
      String(response.stage),
    )
      ? (response.stage as GuardedOperatorSqlFailure["stage"])
      : null;
    throw new GuardedOperatorSqlFailure(
      queryConfirmed ? String(response.code) : "operator-rpc-unconfirmed",
      operationId,
      {
        stage,
        queryConfirmed,
        cleanupUnconfirmed: response.cleanupUnconfirmed === true,
      },
    );
  }
  return response.rows.map(record);
}

async function rpc(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "--json-rpc")
    fail("invalid-operator-rpc-mode");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BYTES) fail("operator-rpc-too-large");
    chunks.push(bytes);
  }
  const job = parseJob(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const rows = await createGuardedOperatorRunner()(
    job.sql,
    job.database,
    job.bindings,
  );
  process.stdout.write(JSON.stringify({ ok: true, rows }) + "\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await rpc().catch((error: unknown) => {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        code:
          error instanceof GuardedOperatorSqlFailure
            ? error.code
            : "operator-rpc-unconfirmed",
        operationId:
          error instanceof GuardedOperatorSqlFailure ? error.operationId : null,
        stage: error instanceof GuardedOperatorSqlFailure ? error.stage : null,
        queryConfirmed:
          error instanceof GuardedOperatorSqlFailure && error.queryConfirmed,
        cleanupUnconfirmed:
          error instanceof GuardedOperatorSqlFailure &&
          error.cleanupUnconfirmed,
      }) + "\n",
    );
    process.exitCode = 1;
  });
