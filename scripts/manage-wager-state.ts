import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWranglerRunner, type SqlRunner } from "./operator/runtime.ts";

type JsonRecord = Record<string, unknown>;

type Arguments = { operation: "status" };

type Counts = {
  rowCount: number;
  wagerCount: number;
  markerCount: number;
};

type Maintenance = {
  profileState: string;
  reservationState: string;
  freezeGeneration: number;
  admissions: number;
  activeGameplayLeases: number;
};

type Activation = {
  activationEpoch: 0 | 1;
  importAttemptId: string | null;
  sourceDigest: string | null;
  importDigest: string | null;
  baselineDigest: string | null;
  verifiedBaselineDigest: string | null;
  sourceWagerCount: number | null;
  sourceMarkerCount: number | null;
  sourceRowCount: number | null;
  importedRowCount: number | null;
  verifiedFreezeGeneration: number | null;
  verifiedAtMs: number | null;
  activatedAtMs: number | null;
  candidateVersionId: string | null;
};

type Dependencies = {
  log(value: JsonRecord): void;
  readMaintenance(): Promise<Maintenance>;
  readActivation(): Promise<Activation>;
  countRows(): Promise<Counts & { nonInitialRevisions: number }>;
};

const GAMEPLAY_DATABASE = "mons-link-profile-games";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseArgs(argv: string[]): Arguments {
  if (argv.length !== 1 || argv[0] !== "--status")
    throw new Error(
      "wager state supports only --status; initial migration commands are retired",
    );
  return { operation: "status" };
}

async function manageWagerState(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  if (args.operation !== "status")
    throw new Error("initial wager migration commands are retired");
  dependencies.log({
    operation: "status",
    maintenance: await dependencies.readMaintenance(),
    activation: await dependencies.readActivation(),
    destination: await dependencies.countRows(),
  });
}

function parseActivation(value: unknown): Activation {
  const row = record(value);
  if (!row || (row.activation_epoch !== 0 && row.activation_epoch !== 1))
    throw new Error(
      "missing or invalid wager state activation control; apply the reviewed schema while frozen first",
    );
  const nullableString = (key: string) => {
    if (row[key] === null) return null;
    if (typeof row[key] !== "string" || !row[key])
      throw new Error("invalid wager activation string");
    return row[key] as string;
  };
  const nullableInteger = (key: string) => {
    if (row[key] === null) return null;
    if (!integer(row[key])) throw new Error("invalid wager activation integer");
    return row[key] as number;
  };
  const result: Activation = {
    activationEpoch: row.activation_epoch,
    importAttemptId: nullableString("import_attempt_id"),
    sourceDigest: nullableString("source_digest"),
    importDigest: nullableString("import_digest"),
    baselineDigest: nullableString("baseline_digest"),
    verifiedBaselineDigest: nullableString("verified_baseline_digest"),
    sourceWagerCount: nullableInteger("source_wager_count"),
    sourceMarkerCount: nullableInteger("source_marker_count"),
    sourceRowCount: nullableInteger("source_row_count"),
    importedRowCount: nullableInteger("imported_row_count"),
    verifiedFreezeGeneration: nullableInteger("verified_freeze_generation"),
    verifiedAtMs: nullableInteger("verified_at_ms"),
    activatedAtMs: nullableInteger("activated_at_ms"),
    candidateVersionId: nullableString("candidate_version_id"),
  };
  for (const value of [
    result.sourceDigest,
    result.importDigest,
    result.baselineDigest,
    result.verifiedBaselineDigest,
  ])
    if (value !== null && !DIGEST_PATTERN.test(value))
      throw new Error("invalid wager activation digest");
  return result;
}

function createSqlDependencies(run: SqlRunner, now = Date.now): Dependencies {
  const readActivation = async () =>
    parseActivation(
      (
        await run("SELECT * FROM wager_state_activation WHERE singleton = 1")
      )[0],
    );
  const readMaintenance = async (): Promise<Maintenance> => {
    const row = (
      await run(
        "SELECT profile.state AS profile_state, reservation.storage_mode AS reservation_state, reservation.freeze_generation, (SELECT COUNT(*) FROM wager_reservation_write_admissions) AS admissions FROM profile_canonical_control AS profile JOIN wager_reservation_runtime_control AS reservation ON reservation.singleton = 1 WHERE profile.singleton = 1",
      )
    )[0];
    const lease = (
      await run(
        `SELECT COUNT(*) AS count FROM game_session_mutation_locks WHERE expires_at_ms > ${now()}`,
        GAMEPLAY_DATABASE,
      )
    )[0];
    if (
      !row ||
      typeof row.profile_state !== "string" ||
      typeof row.reservation_state !== "string" ||
      !integer(row.freeze_generation) ||
      !integer(row.admissions) ||
      !integer(lease?.count)
    )
      throw new Error("invalid maintenance control response");
    return {
      profileState: row.profile_state,
      reservationState: row.reservation_state,
      freezeGeneration: row.freeze_generation,
      admissions: row.admissions,
      activeGameplayLeases: lease.count,
    };
  };
  return {
    log: (value) => console.log(JSON.stringify(value)),
    readActivation,
    readMaintenance,
    async countRows() {
      const row = (
        await run(
          "SELECT COUNT(*) AS row_count, COUNT(wager_json) AS wager_count, COUNT(resolution_marker) AS marker_count, COALESCE(SUM(CASE WHEN revision != 1 THEN 1 ELSE 0 END), 0) AS non_initial_revisions FROM invite_wager_states",
        )
      )[0];
      if (
        !row ||
        !integer(row.row_count) ||
        !integer(row.wager_count) ||
        !integer(row.marker_count) ||
        !integer(row.non_initial_revisions)
      )
        throw new Error("invalid wager destination counts");
      return {
        rowCount: row.row_count,
        wagerCount: row.wager_count,
        markerCount: row.marker_count,
        nonInitialRevisions: row.non_initial_revisions,
      };
    },
  };
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  await manageWagerState(args, createSqlDependencies(createWranglerRunner()));
}

export {
  parseArgs,
  parseActivation,
  createSqlDependencies,
  manageWagerState,
  execute,
  type Arguments,
  type Dependencies,
  type Activation,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  execute().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "wager state operation failed; inspect status",
    );
    process.exitCode = 1;
  });
