import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isSafeFirebaseKey } from "../cloud/workers/api/src/firebaseKeys.ts";
import {
  d1Rows,
  integer,
  QUEUE_DRAIN_INTERVAL_MS,
  readCanonicalState,
  readDeployment,
  record,
  runTool,
  SOURCE_QUIET_INTERVAL_MS,
  sqlText,
  wranglerArgs,
  type Deployment,
  type JsonRecord,
} from "./manage-wager-reservations.ts";
import {
  digest,
  parseEvidence,
  persistArtifacts as persistProtectedArtifacts,
  readJson,
  type Evidence,
} from "./migrate-wager-reservations.ts";

type Phase = "preview" | "observe" | "final";
type Options = {
  phase: Phase;
  project: string;
  evidenceFile?: string;
  observationFile?: string;
};
type Source = Record<string, Record<string, boolean>>;
type Completion = { inviteId: string; matchId: string };
type Control = {
  activatedAtMs: number | null;
  sourceDigest: string | null;
  sourceCount: number | null;
};
type State = { control: Control | null; completions: Completion[] };
type Observation = {
  schemaVersion: 1;
  project: string;
  exportedAtMs: number;
  sourceDigest: string;
  source: Source;
  evidence: Evidence;
};
type Inspection = {
  canonicalState: string;
  activeRatingLeases: number;
  activeProjectionLeases: number;
  deployment: Deployment;
};
type Dependencies = {
  now(): number;
  log(message: string): void;
  readJson(path: string): unknown;
  readSource(project: string): unknown;
  readState(): State;
  inspect(): Inspection;
  executeSql(sql: string): void;
  persistArtifacts(
    files: Record<string, string>,
    phase: Phase,
    nowMs: number,
  ): string;
};

const PROJECT = "mons-link";
const INSTANCE = "mons-link-default-rtdb";
const DATABASE = "mons-link-profiles";
const SQL_BATCH_BYTES = 80_000;
const DIGEST = /^[a-f0-9]{64}$/;

function parseArgs(argv: string[]): Options {
  const options: Options = { phase: "preview", project: PROJECT };
  let phaseSeen = false;
  const seen = new Set<string>();
  const values = {
    "--project": "project",
    "--evidence-file": "evidenceFile",
    "--observation": "observationFile",
  } as const;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (seen.has(arg)) throw new Error("duplicate migration argument");
    seen.add(arg);
    if (["--preview", "--observe", "--final"].includes(arg)) {
      if (phaseSeen) throw new Error("choose exactly one migration phase");
      phaseSeen = true;
      options.phase = arg.slice(2) as Phase;
      continue;
    }
    if (!Object.hasOwn(values, arg))
      throw new Error("unknown rating completion migration argument");
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error("missing migration argument value");
    options[values[arg as keyof typeof values]] = value;
  }
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(options.project))
    throw new Error("invalid Firebase project");
  if (options.phase !== "preview" && options.project !== PROJECT)
    throw new Error("cutover requires the canonical Firebase project");
  if ((options.phase !== "preview") !== Boolean(options.evidenceFile))
    throw new Error("observe and final require --evidence-file");
  if ((options.phase === "final") !== Boolean(options.observationFile))
    throw new Error("final requires --observation");
  return options;
}

function assertSource(options: Options, environment: NodeJS.ProcessEnv): void {
  if (options.project !== PROJECT) return;
  if (
    Object.keys(environment).some(
      (key) =>
        key === "FIREBASE_CONFIG" ||
        key === "FIREBASE_REALTIME_URL" ||
        /^FIREBASE_(?:DATABASE|REALTIME|RTDB)_/.test(key),
    )
  )
    throw new Error(
      "canonical rating completion migration rejects Firebase source overrides",
    );
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function compareCompletions(left: Completion, right: Completion): number {
  return (
    compareText(left.inviteId, right.inviteId) ||
    compareText(left.matchId, right.matchId)
  );
}

function normalizeSource(value: unknown): Source {
  const root = value === null ? {} : record(value);
  if (!root) throw new Error("invalid rating completion source root");
  const source: Source = Object.create(null) as Source;
  for (const inviteId of Object.keys(root).sort(compareText)) {
    const rawMarkers = root[inviteId];
    const markers = Array.isArray(rawMarkers)
      ? Object.fromEntries(
          Object.entries(rawMarkers).filter(
            ([, completed]) => completed !== null,
          ),
        )
      : rawMarkers === null
        ? {}
        : record(rawMarkers);
    if (!isSafeFirebaseKey(inviteId) || !markers)
      throw new Error("invalid rating completion invite record");
    const normalized: Record<string, boolean> = Object.create(null) as Record<
      string,
      boolean
    >;
    for (const matchId of Object.keys(markers).sort(compareText)) {
      const completed = markers[matchId];
      if (!isSafeFirebaseKey(matchId) || typeof completed !== "boolean")
        throw new Error("invalid rating completion marker");
      normalized[matchId] = completed;
    }
    if (Object.keys(normalized).length) source[inviteId] = normalized;
  }
  return source;
}

function sourceCompletions(source: Source): Completion[] {
  return Object.entries(source)
    .flatMap(([inviteId, matches]) =>
      Object.entries(matches)
        .filter(([, completed]) => completed)
        .map(([matchId]) => ({ inviteId, matchId })),
    )
    .sort(compareCompletions);
}

function normalizeCompletions(value: unknown): Completion[] {
  if (!Array.isArray(value))
    throw new Error("invalid D1 rating completion rows");
  const rows = value.map((item) => {
    const row = record(item);
    if (
      !row ||
      typeof row.inviteId !== "string" ||
      !isSafeFirebaseKey(row.inviteId) ||
      typeof row.matchId !== "string" ||
      !isSafeFirebaseKey(row.matchId)
    )
      throw new Error("invalid D1 rating completion row");
    return { inviteId: row.inviteId, matchId: row.matchId };
  });
  rows.sort(compareCompletions);
  if (
    rows.some(
      (row, index) =>
        index > 0 && compareCompletions(rows[index - 1], row) === 0,
    )
  )
    throw new Error("duplicate D1 rating completion row");
  return rows;
}

function parseControl(row: JsonRecord | undefined): Control {
  if (
    !row ||
    (row.activated_at_ms !== null && !integer(row.activated_at_ms)) ||
    (row.source_digest !== null &&
      (typeof row.source_digest !== "string" ||
        !DIGEST.test(row.source_digest))) ||
    (row.source_count !== null && !integer(row.source_count)) ||
    (row.source_digest === null) !== (row.source_count === null) ||
    (row.activated_at_ms !== null && row.source_digest === null)
  )
    throw new Error("invalid rating completion control");
  return {
    activatedAtMs: row.activated_at_ms as number | null,
    sourceDigest: row.source_digest as string | null,
    sourceCount: row.source_count as number | null,
  };
}

function parseObservation(value: unknown, evidence: Evidence): Observation {
  const item = record(value);
  if (
    !item ||
    item.schemaVersion !== 1 ||
    item.project !== PROJECT ||
    !integer(item.exportedAtMs) ||
    typeof item.sourceDigest !== "string" ||
    !DIGEST.test(item.sourceDigest)
  )
    throw new Error("invalid rating completion observation");
  const source = normalizeSource(item.source);
  const storedEvidence = parseEvidence(item.evidence, item.exportedAtMs);
  if (
    digest(source) !== item.sourceDigest ||
    digest(storedEvidence) !== digest(evidence)
  )
    throw new Error("rating completion observation evidence mismatch");
  return {
    schemaVersion: 1,
    project: PROJECT,
    exportedAtMs: item.exportedAtMs,
    sourceDigest: item.sourceDigest,
    source,
    evidence: storedEvidence,
  };
}

function assertFrozen(
  inspection: Inspection,
  evidence: Evidence,
  nowMs: number,
): void {
  if (inspection.canonicalState !== "frozen")
    throw new Error(
      "rating completion import requires frozen canonical writes",
    );
  if (
    inspection.activeProjectionLeases !== 0 ||
    inspection.activeRatingLeases !== 0
  )
    throw new Error("rating and projection leases must be drained");
  if (
    inspection.deployment.versionId !== evidence.bridgeVersionId ||
    inspection.deployment.deployedAtMs !== evidence.bridgeDeployedAtMs
  )
    throw new Error("deployed source Worker does not match cutover evidence");
  if (
    nowMs - Math.max(...Object.values(evidence.queuesPausedAtMs)) <
    QUEUE_DRAIN_INTERVAL_MS
  )
    throw new Error(
      "all four queues must be paused for at least fifteen minutes",
    );
}

function importGuard(sourceDigest: string, sourceCount: number): string {
  return `EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen') AND EXISTS (SELECT 1 FROM rating_completion_control WHERE singleton = 1 AND activated_at_ms IS NULL AND source_digest = ${sqlText(sourceDigest)} AND source_count = ${sourceCount})`;
}

function buildClaimSql(sourceDigest: string, sourceCount: number): string {
  if (!DIGEST.test(sourceDigest) || !integer(sourceCount))
    throw new Error("invalid rating completion import claim");
  return `UPDATE rating_completion_control SET source_digest = ${sqlText(sourceDigest)}, source_count = ${sourceCount} WHERE singleton = 1 AND activated_at_ms IS NULL AND (source_digest IS NULL OR (source_digest = ${sqlText(sourceDigest)} AND source_count = ${sourceCount})) AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen');`;
}

function buildImportBatches(
  completions: Completion[],
  sourceDigest: string,
  importedAtMs: number,
): string[] {
  const rows = normalizeCompletions(completions);
  if (!DIGEST.test(sourceDigest) || !integer(importedAtMs))
    throw new Error("invalid rating completion import plan");
  const guard = importGuard(sourceDigest, rows.length);
  const batches: string[] = [];
  let batch = "";
  for (const row of rows) {
    const statement = `INSERT OR IGNORE INTO legacy_rating_completions (invite_id, match_id, imported_at_ms) SELECT ${sqlText(row.inviteId)}, ${sqlText(row.matchId)}, ${importedAtMs} WHERE ${guard};\n`;
    if (Buffer.byteLength(batch + statement) > SQL_BATCH_BYTES && batch) {
      batches.push(batch);
      batch = "";
    }
    batch += statement;
  }
  if (batch) batches.push(batch);
  return batches;
}

function buildActivationSql(
  sourceDigest: string,
  sourceCount: number,
  activatedAtMs: number,
): string {
  if (
    !DIGEST.test(sourceDigest) ||
    !integer(sourceCount) ||
    !integer(activatedAtMs)
  )
    throw new Error("invalid rating completion activation");
  return `UPDATE rating_completion_control SET activated_at_ms = ${activatedAtMs} WHERE singleton = 1 AND ${importGuard(sourceDigest, sourceCount)} AND (SELECT COUNT(*) FROM legacy_rating_completions) = ${sourceCount};`;
}

function assertClaim(
  state: State,
  sourceDigest: string,
  sourceCount: number,
): void {
  if (
    !state.control ||
    state.control.activatedAtMs !== null ||
    state.control.sourceDigest !== sourceDigest ||
    state.control.sourceCount !== sourceCount
  )
    throw new Error(
      "rating completion import claim unavailable or source changed",
    );
}

function assertSubset(rows: Completion[], expected: Completion[]): void {
  const keys = new Set(expected.map((row) => JSON.stringify(row)));
  if (rows.some((row) => !keys.has(JSON.stringify(row))))
    throw new Error("D1 completion evidence contains rows outside the source");
}

function migrateRatingCompletions(
  options: Options,
  dependencies: Dependencies,
): void {
  const startedAtMs = dependencies.now();
  const evidence = options.evidenceFile
    ? parseEvidence(dependencies.readJson(options.evidenceFile), startedAtMs)
    : null;
  if (evidence) assertFrozen(dependencies.inspect(), evidence, startedAtMs);
  const prior = options.observationFile
    ? parseObservation(
        dependencies.readJson(options.observationFile),
        evidence!,
      )
    : null;
  if (prior && startedAtMs - prior.exportedAtMs < SOURCE_QUIET_INTERVAL_MS)
    throw new Error("source observations must be at least six minutes apart");

  const source = normalizeSource(dependencies.readSource(options.project));
  const exportedAtMs = dependencies.now();
  const sourceDigest = digest(source);
  const completions = sourceCompletions(source);
  const state = dependencies.readState();
  state.completions = normalizeCompletions(state.completions);
  const files: Record<string, string> = {
    "source.json": `${JSON.stringify(source)}\n`,
    "d1-before.json": `${JSON.stringify(state)}\n`,
    "completions.json": `${JSON.stringify(completions)}\n`,
  };
  if (evidence) {
    assertFrozen(dependencies.inspect(), evidence, exportedAtMs);
    if (!state.control)
      throw new Error(
        "apply rating completion migration 0013 before observing",
      );
    if (state.control.activatedAtMs !== null)
      throw new Error("rating completion storage is already activated");
    files["observation.json"] = `${JSON.stringify({
      schemaVersion: 1,
      project: options.project,
      exportedAtMs,
      sourceDigest,
      source,
      evidence,
    } satisfies Observation)}\n`;
  }
  const batches = buildImportBatches(completions, sourceDigest, exportedAtMs);
  files["import.sql"] = [
    buildClaimSql(sourceDigest, completions.length),
    ...batches,
  ].join("\n");
  const directory = dependencies.persistArtifacts(
    files,
    options.phase,
    exportedAtMs,
  );
  if (options.phase !== "final") {
    const existing = new Set(
      state.completions.map((row) => JSON.stringify(row)),
    );
    dependencies.log(
      JSON.stringify({
        phase: options.phase,
        sourceCount: completions.length,
        sourceDigest,
        importedCount: state.completions.length,
        missingCount: completions.filter(
          (row) => !existing.has(JSON.stringify(row)),
        ).length,
        activated:
          state.control?.activatedAtMs !== null && state.control !== null,
        artifacts: directory,
      }),
    );
    return;
  }
  if (!prior || sourceDigest !== prior.sourceDigest)
    throw new Error("rating completion source changed between observations");
  assertSubset(state.completions, completions);
  dependencies.executeSql(buildClaimSql(sourceDigest, completions.length));
  assertClaim(dependencies.readState(), sourceDigest, completions.length);
  for (const batch of batches) {
    assertFrozen(dependencies.inspect(), evidence!, dependencies.now());
    dependencies.executeSql(batch);
  }
  const imported = dependencies.readState();
  assertClaim(imported, sourceDigest, completions.length);
  if (
    digest(normalizeCompletions(imported.completions)) !== digest(completions)
  )
    throw new Error("rating completion import did not match the exact source");
  const after = normalizeSource(dependencies.readSource(options.project));
  if (digest(after) !== sourceDigest)
    throw new Error("rating completion source changed during import");
  assertFrozen(dependencies.inspect(), evidence!, dependencies.now());
  const activatedAtMs = dependencies.now();
  dependencies.executeSql(
    buildActivationSql(sourceDigest, completions.length, activatedAtMs),
  );
  const activated = dependencies.readState();
  if (
    activated.control?.activatedAtMs !== activatedAtMs ||
    activated.control.sourceDigest !== sourceDigest ||
    activated.control.sourceCount !== completions.length ||
    digest(normalizeCompletions(activated.completions)) !== digest(completions)
  )
    throw new Error("rating completion activation could not be verified");
  const verification = dependencies.persistArtifacts(
    {
      "activation.json": `${JSON.stringify({
        ...activated.control,
        completionDigest: digest(completions),
        sourceVersion: evidence!.bridgeVersionId,
        observation: prior,
        finalExportedAtMs: exportedAtMs,
      })}\n`,
    },
    "final",
    activatedAtMs,
  );
  dependencies.log(
    JSON.stringify({
      phase: "final",
      activated: true,
      sourceCount: completions.length,
      sourceDigest,
      artifacts: directory,
      verification,
    }),
  );
}

function firebaseDatabaseGetArgs(
  project: string,
  path: string,
  shallow = false,
): string[] {
  return [
    "database:get",
    path,
    "--project",
    project,
    ...(project === PROJECT ? ["--instance", INSTANCE] : []),
    ...(shallow ? ["--shallow"] : []),
  ];
}

function readSource(
  project: string,
  get: (path: string, shallow?: boolean) => unknown = (path, shallow) =>
    JSON.parse(
      runTool(
        resolve("node_modules/.bin/firebase"),
        firebaseDatabaseGetArgs(project, path, shallow),
        64 * 1024 * 1024,
      ),
    ),
): Source {
  const value = get("/invites", true);
  const inventory = value === null ? {} : record(value);
  if (!inventory) throw new Error("invalid shallow invite inventory");
  const source: JsonRecord = Object.create(null) as JsonRecord;
  for (const inviteId of Object.keys(inventory).sort(compareText)) {
    if (!isSafeFirebaseKey(inviteId) || inventory[inviteId] !== true)
      throw new Error("invalid shallow invite inventory entry");
    source[inviteId] = get(
      `/invites/${encodeURIComponent(inviteId)}/matchesRatingUpdates`,
    );
  }
  return normalizeSource(source);
}

function readRemoteState(
  readRows: (sql: string) => JsonRecord[] = d1Rows,
): State {
  const schema = readRows(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('legacy_rating_completions', 'rating_completion_control')",
  );
  if (schema.length === 0) return { control: null, completions: [] };
  if (schema.length !== 2)
    throw new Error("incomplete rating completion schema");
  const control = parseControl(
    readRows("SELECT * FROM rating_completion_control WHERE singleton = 1")[0],
  );
  const completions: Completion[] = [];
  let cursor: Completion | null = null;
  for (;;) {
    const rows = readRows(
      `SELECT invite_id AS inviteId, match_id AS matchId FROM legacy_rating_completions ${cursor === null ? "" : `WHERE (invite_id, match_id) > (${sqlText(cursor.inviteId)}, ${sqlText(cursor.matchId)})`} ORDER BY invite_id, match_id LIMIT 500`,
    );
    if (!rows.length) break;
    const page = normalizeCompletions(rows);
    const nextCursor = page[page.length - 1];
    if (cursor && compareCompletions(nextCursor, cursor) <= 0)
      throw new Error("invalid rating completion pagination");
    completions.push(...page);
    cursor = nextCursor;
  }
  return { control, completions: normalizeCompletions(completions) };
}

function persistArtifacts(
  files: Record<string, string>,
  phase: Phase,
  nowMs: number,
  root = resolve(".cache/rating-completion-migration"),
): string {
  return persistProtectedArtifacts(files, phase, nowMs, root);
}

function executeSql(sql: string): void {
  const directory = persistArtifacts(
    { "statement.sql": sql },
    "final",
    Date.now(),
    resolve(tmpdir(), "mons-rating-completion-sql"),
  );
  try {
    runTool(
      resolve("node_modules/.bin/wrangler"),
      wranglerArgs([
        "d1",
        "execute",
        DATABASE,
        "--remote",
        "--file",
        resolve(directory, "statement.sql"),
        "--yes",
      ]),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function execute(argv = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  assertSource(options, process.env);
  migrateRatingCompletions(options, {
    now: Date.now,
    log: console.log,
    readJson,
    readSource,
    readState: readRemoteState,
    inspect: () => {
      const activeRatingLeases = d1Rows(
        "SELECT COUNT(*) AS count FROM rating_updates WHERE status = 'processing' AND lease_expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)",
      )[0]?.count;
      const activeProjectionLeases = d1Rows(
        "SELECT COUNT(*) AS count FROM profile_game_projection_locks WHERE expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)",
        "mons-link-profile-games",
      )[0]?.count;
      if (!integer(activeRatingLeases) || !integer(activeProjectionLeases))
        throw new Error("invalid rating or projection lease count");
      return {
        canonicalState: readCanonicalState(),
        activeRatingLeases,
        activeProjectionLeases,
        deployment: readDeployment(),
      };
    },
    executeSql,
    persistArtifacts,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    execute();
  } catch (error) {
    console.error(
      error instanceof SyntaxError
        ? "invalid JSON in migration source or protected artifact"
        : error instanceof Error
          ? error.message
          : "rating completion migration failed",
    );
    process.exitCode = 1;
  }
}

export {
  assertSource,
  buildActivationSql,
  buildClaimSql,
  buildImportBatches,
  execute,
  firebaseDatabaseGetArgs,
  migrateRatingCompletions,
  normalizeCompletions,
  normalizeSource,
  parseArgs,
  parseControl,
  parseObservation,
  persistArtifacts,
  readRemoteState,
  readSource,
  sourceCompletions,
  SQL_BATCH_BYTES,
  type Completion,
  type Control,
  type Dependencies,
  type Inspection,
  type Observation,
  type Options,
  type Source,
  type State,
};
