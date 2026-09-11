import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createWranglerRunner,
  digest,
  privateDirectory,
  resolveCloudflareToken,
  writePrivateImmutable,
  type SqlRunner,
} from "./operator/runtime.ts";

const DATABASE = "mons-link-profile-games";
const EVENTS = "mons-link-events";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type JsonRecord = Record<string, unknown>;
export type MatchStateArguments =
  | { operation: "status" }
  | { operation: "inspect-admissions"; directory: string };
type Control = JsonRecord & {
  backend: "rtdb" | "durable";
  state: "active" | "draining" | "frozen";
  epoch: number;
  freeze_generation: number;
  import_id: string | null;
};
export type MatchStateOperatorDependencies = {
  run: SqlRunner;
  now(): number;
  log(value: JsonRecord): void;
};

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("match-state-invalid-record");
  return value as JsonRecord;
}

export function parseMatchStateArgs(argv: string[]): MatchStateArguments {
  if (argv.length === 1 && argv[0] === "--status")
    return { operation: "status" };
  if (
    argv.length === 3 &&
    argv[0] === "--inspect-admissions" &&
    argv[1] === "--directory" &&
    isAbsolute(argv[2])
  )
    return { operation: "inspect-admissions", directory: argv[2] };
  throw new Error(
    "match-state supports only --status or --inspect-admissions --directory <absolute protected output path>; migration commands are retired",
  );
}

async function control(deps: MatchStateOperatorDependencies): Promise<Control> {
  const row = record(
    (
      await deps.run(
        "SELECT * FROM match_state_control WHERE singleton = 1",
        DATABASE,
      )
    )[0],
  ) as Control;
  if (
    !["rtdb", "durable"].includes(row.backend) ||
    !["active", "draining", "frozen"].includes(row.state) ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 1 ||
    !Number.isSafeInteger(row.freeze_generation) ||
    row.freeze_generation < 0
  )
    throw new Error("match-state-control-unavailable");
  return row;
}

async function counts(
  deps: MatchStateOperatorDependencies,
): Promise<JsonRecord> {
  const gameplay = record(
    (
      await deps.run(
        `SELECT
    (SELECT COUNT(*) FROM match_state_write_admissions) AS admissions,
    (SELECT COUNT(*) FROM game_session_transitions WHERE status = 'pending') AS session_intents,
    (SELECT COUNT(*) FROM game_session_transition_resources) AS session_resources,
    (SELECT COUNT(*) FROM invite_source_write_admissions) AS invite_admissions,
    (SELECT COUNT(*) FROM automatch_write_admissions) AS automatch_admissions,
    (SELECT COUNT(*) FROM game_session_mutation_locks WHERE expires_at_ms > ?) AS session_leases,
    (SELECT COUNT(*) FROM match_state_routes) AS routes,
    (SELECT COUNT(*) FROM match_state_import_receipts) AS bundles`,
        DATABASE,
        [deps.now()],
      )
    )[0],
  );
  const event = record(
    (
      await deps.run(
        `SELECT
    (SELECT COUNT(*) FROM event_write_admissions) AS event_admissions,
    (SELECT COUNT(*) FROM event_transition_intents WHERE status = 'pending') AS event_intents,
    (SELECT COUNT(*) FROM event_leases WHERE expires_at_ms > ?) AS event_leases`,
        EVENTS,
        [deps.now()],
      )
    )[0],
  );
  return { ...gameplay, ...event };
}

export async function manageMatchState(
  args: MatchStateArguments,
  deps: MatchStateOperatorDependencies,
): Promise<void> {
  const before = await control(deps);
  if (args.operation === "status") {
    deps.log({
      operation: "status",
      control: before,
      counts: await counts(deps),
      operatorLock:
        (
          await deps.run(
            "SELECT import_id, phase, created_at_ms FROM match_state_operator_lock WHERE singleton = 1",
            DATABASE,
          )
        )[0] ?? null,
    });
    return;
  }
  if (
    before.backend !== "durable" ||
    typeof before.import_id !== "string" ||
    !UUID.test(before.import_id)
  )
    throw new Error("match-state-inspection-requires-durable-import-identity");
  const rows = await deps.run(
    "SELECT * FROM match_state_write_admissions ORDER BY admission_id",
    DATABASE,
  );
  const after = await control(deps);
  if (
    after.backend !== before.backend ||
    after.epoch !== before.epoch ||
    after.import_id !== before.import_id
  )
    throw new Error("match-state-inspection-import-changed");
  const directory = privateDirectory(args.directory);
  writePrivateImmutable(resolve(directory, `admissions-${digest(rows)}.json`), {
    schemaVersion: 1,
    importId: before.import_id,
    admissions: rows,
  });
  deps.log({
    operation: args.operation,
    importId: before.import_id,
    admissions: rows.length,
  });
}

export async function executeMatchState(
  argv = process.argv.slice(2),
): Promise<void> {
  const args = parseMatchStateArgs(argv);
  await manageMatchState(args, {
    run: createWranglerRunner({ apiToken: resolveCloudflareToken() }),
    now: Date.now,
    log: (value) => console.log(JSON.stringify(value)),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  executeMatchState().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "match-state-inspection-failed; retry status",
    );
    process.exitCode = 1;
  });
