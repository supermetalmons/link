import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWranglerRunner, type SqlRunner } from "./operator/runtime.ts";

const DATABASE = "mons-link-profile-games";

type JsonRecord = Record<string, unknown>;

type Arguments = { operation: "status" };

type Control = {
  phase: "legacy" | "capture" | "durable";
  candidate_version_id: string | null;
  migration_id: string | null;
  capture_started_at_ms: number | null;
  source_digest: string | null;
  source_count: number | null;
  verification_digest: string | null;
  verified_at_ms: number | null;
  activated_at_ms: number | null;
};

type Dependencies = { run: SqlRunner; log(value: JsonRecord): void };

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid appearance control record");
  return value as JsonRecord;
}

function parseArgs(argv: string[]): Arguments {
  if (argv.length !== 1 || argv[0] !== "--status")
    throw new Error(
      "match-presentations supports only --status; initial migration commands are retired",
    );
  return { operation: "status" };
}

async function readControl(dependencies: Dependencies): Promise<Control> {
  const rows = await dependencies.run(
    "SELECT * FROM match_presentation_control WHERE singleton = 1",
    DATABASE,
  );
  const control = record(rows[0]) as Control;
  if (!["legacy", "capture", "durable"].includes(control.phase))
    throw new Error("appearance control is unavailable");
  return control;
}

async function manageMatchPresentations(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  if (args.operation === "status") {
    const control = await readControl(dependencies);
    const counts = await dependencies.run(
      "SELECT provenance, count(*) AS count FROM match_presentation_registrations GROUP BY provenance",
      DATABASE,
    );
    const exceptionTable = await dependencies.run(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'match_presentation_source_exceptions'",
      DATABASE,
    );
    const sourceExceptions = exceptionTable.length
      ? await dependencies.run(
          "SELECT disposition, COUNT(*) AS count FROM match_presentation_source_exceptions GROUP BY disposition",
          DATABASE,
        )
      : [];
    dependencies.log({
      operation: "status",
      control,
      counts,
      sourceExceptions,
    });
    return;
  }
  throw new Error("initial migration commands are retired");
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  await manageMatchPresentations(args, {
    run: createWranglerRunner(),
    log: (value) => console.log(JSON.stringify(value)),
  });
}

export {
  parseArgs,
  manageMatchPresentations,
  execute,
  type Arguments,
  type Dependencies,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  execute().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "match-presentations operation failed; inspect status",
    );
    process.exitCode = 1;
  });
