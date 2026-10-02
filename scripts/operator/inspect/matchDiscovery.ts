import type { SqlRunner } from "../runtime.ts";

const DATABASE = "mons-link-profile-games";

type JsonRecord = Record<string, unknown>;

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

async function inspectMatchDiscovery(
  dependencies: Dependencies,
): Promise<void> {
  const control = await readControl(dependencies);
  const counts = await dependencies.run(
    "SELECT provenance, resolution, count(*) AS count FROM login_match_discovery GROUP BY provenance, resolution",
    DATABASE,
  );
  dependencies.log({ operation: "status", control, counts });
}

export { inspectMatchDiscovery, type Dependencies };
