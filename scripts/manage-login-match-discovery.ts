import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWranglerRunner, type SqlRunner } from "./operator/runtime.ts";

const DATABASE = "mons-link-profile-games";

type JsonRecord = Record<string, unknown>;

type Arguments = { operation: "status" };

type Control = {
  discovery_backend: "rtdb" | "d1";
  capture_enforced: 0 | 1;
  capture_version_id: string | null;
  capture_started_at_ms: number | null;
  import_id: string | null;
  source_digest: string | null;
  imported_at_ms: number | null;
  verified_at_ms: number | null;
  verification_digest: string | null;
};

type Dependencies = { run: SqlRunner; log(value: JsonRecord): void };

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid discovery record");
  return value as JsonRecord;
}

function parseArgs(argv: string[]): Arguments {
  if (argv.length !== 1 || argv[0] !== "--status")
    throw new Error(
      "login-match-discovery supports only --status; initial migration commands are retired",
    );
  return { operation: "status" };
}

async function readControl(dependencies: Dependencies): Promise<Control> {
  const rows = await dependencies.run(
    "SELECT * FROM login_match_discovery_control WHERE singleton = 1",
    DATABASE,
  );
  const row = record(rows[0]);
  if (
    !["rtdb", "d1"].includes(String(row.discovery_backend)) ||
    ![0, 1].includes(Number(row.capture_enforced))
  )
    throw new Error("discovery control schema is unavailable");
  return row as Control;
}

async function manageLoginMatchDiscovery(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  if (args.operation === "status") {
    const control = await readControl(dependencies);
    const counts = await dependencies.run(
      "SELECT provenance, resolution, count(*) AS count FROM login_match_discovery GROUP BY provenance, resolution",
      DATABASE,
    );
    dependencies.log({ operation: "status", control, counts });
    return;
  }
  throw new Error("initial migration commands are retired");
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  await manageLoginMatchDiscovery(args, {
    run: createWranglerRunner(),
    log: (value) => console.log(JSON.stringify(value)),
  });
}

export {
  parseArgs,
  manageLoginMatchDiscovery,
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
        : "login-match-discovery operation failed; inspect status",
    );
    process.exitCode = 1;
  });
