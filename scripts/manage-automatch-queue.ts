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
const VERSION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

type Arguments =
  | { operation: "inspect" }
  | { operation: "activate"; candidateVersionId: string };

type Dependencies = {
  run: SqlRunner;
  log(value: Record<string, unknown>): void;
  now?: () => number;
};

export function parseArgs(argv: string[]): Arguments {
  if (argv.length === 1 && argv[0] === "--inspect")
    return { operation: "inspect" };
  if (
    argv.length === 3 &&
    argv[0] === "--activate" &&
    argv[1] === "--candidate-version-id" &&
    VERSION_PATTERN.test(argv[2])
  )
    return { operation: "activate", candidateVersionId: argv[2] };
  throw new Error(
    "use --inspect or --activate --candidate-version-id <promoted-compatible-version-id>",
  );
}

export async function manageAutomatchQueue(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  const control = (
    await dependencies.run(
      "SELECT backend, state, epoch, freeze_generation, metadata_json FROM automatch_runtime_control WHERE singleton = 1",
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
  let metadata: unknown = null;
  if (control.metadata_json !== null) {
    if (typeof control.metadata_json !== "string")
      throw new Error("automatch queue metadata is unavailable");
    metadata = JSON.parse(control.metadata_json) as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw new Error("automatch queue metadata must be an object");
  }
  const mode =
    metadata &&
    typeof metadata === "object" &&
    "queueSelection" in metadata &&
    metadata.queueSelection === "fifo"
      ? "fifo"
      : "legacy";
  if (missing.length) {
    if (args.operation === "activate")
      throw new Error(
        "automatch queue schema is incomplete; inspect before activation",
      );
    dependencies.log({
      operation: "inspect",
      mode,
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
  if (args.operation === "inspect") {
    dependencies.log({
      operation: "inspect",
      mode,
      state: control.state,
      valid,
      audit,
    });
    return;
  }
  if (!valid || control.state !== "active")
    throw new Error(
      "automatch queue must be active with a valid projection before activation",
    );
  const nowMs = (dependencies.now || Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("invalid automatch queue activation timestamp");
  const activated = await dependencies.run(
    `UPDATE automatch_runtime_control
     SET metadata_json = json_set(COALESCE(metadata_json, '{}'),
       '$.queueSelection', 'fifo', '$.queueSelectionCandidateVersionId', ?,
       '$.queueSelectionActivatedAtMs', ?)
     WHERE singleton = 1 AND backend = 'd1' AND state = 'active'
       AND epoch = ? AND freeze_generation = ?
       AND (metadata_json IS NULL OR json_type(metadata_json) = 'object')
       AND EXISTS (SELECT 1 FROM (${AUTOMATCH_QUEUE_AUDIT_SQL})
         WHERE ${AUTOMATCH_QUEUE_INVALID_COLUMNS.map((column) => `${column} = 0`).join(" AND ")})
     RETURNING json_extract(metadata_json, '$.queueSelection') AS mode`,
    DATABASE,
    [
      args.candidateVersionId,
      nowMs,
      Number(control.epoch),
      Number(control.freeze_generation),
    ],
  );
  if (activated.length !== 1 || activated[0].mode !== "fifo")
    throw new Error(
      "automatch queue activation was not confirmed; inspect current state",
    );
  dependencies.log({
    operation: "activate",
    mode: "fifo",
    candidateVersionId: args.candidateVersionId,
  });
}

export async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  await manageAutomatchQueue(args, {
    run: createWranglerRunner({ apiToken: resolveCloudflareToken() }),
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
