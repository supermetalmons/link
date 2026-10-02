import type { SqlRunner } from "../runtime.ts";

const DATABASE = "mons-link-profile-games";

type JsonRecord = Record<string, unknown>;

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

async function inspectMatchPresentations(
  dependencies: Dependencies,
): Promise<void> {
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
}

export { inspectMatchPresentations, type Dependencies };
