import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AUTOMATCH_QUEUE_AUDIT_SQL,
  AUTOMATCH_QUEUE_INVALID_COLUMNS,
  AUTOMATCH_QUEUE_SCHEMA_OBJECTS,
} from "../cloud/workers/api/src/automatchQueueSql.ts";
import {
  createWranglerRunner,
  resolveCloudflareToken,
  type SqlRunner,
} from "./operator/runtime.ts";

const DATABASE = "mons-link-profile-games";

type Arguments = { operation: "inspect" };

type Dependencies = {
  run: SqlRunner;
  log(value: Record<string, unknown>): void;
};

export function parseArgs(argv: string[]): Arguments {
  if (argv.length === 1 && argv[0] === "--inspect")
    return { operation: "inspect" };
  throw new Error("use --inspect");
}

export async function manageAutomatchQueue(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  const control = (
    await dependencies.run(
      "SELECT backend, state, epoch, freeze_generation FROM automatch_runtime_control WHERE singleton = 1",
      DATABASE,
    )
  )[0];
  if (
    !control ||
    control.backend !== "d1" ||
    !["active", "frozen"].includes(String(control.state)) ||
    !Number.isSafeInteger(control.epoch) ||
    !Number.isSafeInteger(control.freeze_generation)
  )
    throw new Error("automatch queue control is unavailable");
  const schema = await dependencies.run(
    "SELECT name FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?))",
    DATABASE,
    [JSON.stringify(AUTOMATCH_QUEUE_SCHEMA_OBJECTS)],
  );
  const names = new Set(schema.map((row) => row.name));
  const missing = AUTOMATCH_QUEUE_SCHEMA_OBJECTS.filter(
    (name) => !names.has(name),
  );
  if (missing.length) {
    dependencies.log({
      operation: args.operation,
      mode: "fifo",
      missingSchemaObjects: missing,
    });
    return;
  }
  const audit = (
    await dependencies.run(AUTOMATCH_QUEUE_AUDIT_SQL, DATABASE)
  )[0];
  if (!audit) throw new Error("automatch queue audit is unavailable");
  const valid = AUTOMATCH_QUEUE_INVALID_COLUMNS.every(
    (column) => audit[column] === 0,
  );
  dependencies.log({
    operation: args.operation,
    mode: "fifo",
    state: control.state,
    valid,
    audit,
  });
}

export async function execute(
  argv = process.argv.slice(2),
  createRunner: typeof createWranglerRunner = createWranglerRunner,
): Promise<void> {
  const args = parseArgs(argv);
  await manageAutomatchQueue(args, {
    run: createRunner({ apiToken: resolveCloudflareToken() }),
    log: (value) => console.log(JSON.stringify(value)),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  execute().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "automatch queue operation failed",
    );
    process.exitCode = 1;
  });
