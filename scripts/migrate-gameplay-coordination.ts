import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;

type MigrationOptions = {
  project: string;
};

type LegacyLease = {
  expiresAtMs: number;
  lockId: string;
  operationId: string;
  ownerId: string;
};

type D1Lease = LegacyLease;

type TimerMarker = {
  matchId: string;
  playerId: string;
  timer: string;
  turnNumber: number;
};

type D1TimerMarker = TimerMarker & {
  opponentId: string | null;
  updatedAtMs: number;
};

type LegacySnapshot = {
  leases: LegacyLease[];
  timerMarkers: TimerMarker[];
};

type D1Snapshot = {
  hasOpponentIdColumn: boolean;
  leases: D1Lease[];
  timerMarkers: D1TimerMarker[];
};

type MigrationDependencies = {
  log(message: string): void;
  now(): number;
  persistArtifacts(input: {
    exportedAtMs: number;
    files: Readonly<Record<string, string>>;
  }): void;
  readActiveD1Leases(): number;
  readD1Snapshot(): D1Snapshot;
  readLegacySnapshot(project: string): LegacySnapshot;
};

const PROFILE_GAMES_DATABASE = "mons-link-profile-games";
const CANONICAL_FIREBASE_PROJECT = "mons-link";
const CANONICAL_FIREBASE_INSTANCE = "mons-link-default-rtdb";
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV_PATH = "cloud/workers/api/release.env";
const FIREBASE_SOURCE_OVERRIDE_KEYS = new Set([
  "FIREBASE_CONFIG",
  "FIREBASE_DATABASE_EMULATOR_HOST",
  "FIREBASE_REALTIME_URL",
]);

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function objectRoot(value: unknown, message: string): JsonRecord {
  if (value === null) return {};
  const root = record(value);
  if (!root) throw new Error(message);
  return root;
}

function validKey(value: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return (
    bytes > 0 &&
    bytes <= 768 &&
    value.trim() === value &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) || 0;
      return code > 0x1f && code !== 0x7f && !".#$[]/".includes(character);
    })
  );
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function safeNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parseLegacyTimer(value: unknown): {
  targetTimestamp: number;
  turnNumber: number;
} | null {
  if (typeof value !== "string" || !/^\d+;\d+$/.test(value)) return null;
  const [turnNumber, targetTimestamp] = value.split(";").map(Number);
  return Number.isSafeInteger(turnNumber) &&
    turnNumber >= 0 &&
    Number.isSafeInteger(targetTimestamp) &&
    targetTimestamp > 0
    ? { turnNumber, targetTimestamp }
    : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareLeases(left: LegacyLease, right: LegacyLease): number {
  return compareText(left.lockId, right.lockId);
}

function compareMarkers(left: TimerMarker, right: TimerMarker): number {
  return (
    compareText(left.playerId, right.playerId) ||
    compareText(left.matchId, right.matchId)
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .sort(compareText)
      .map((key) => [key, canonicalize(object[key])]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function normalizeLease(input: {
  expiresAtMs: unknown;
  lockId: unknown;
  operationId: unknown;
  ownerId: unknown;
}): LegacyLease {
  if (
    typeof input.lockId !== "string" ||
    !validKey(input.lockId) ||
    typeof input.ownerId !== "string" ||
    input.ownerId.length === 0 ||
    typeof input.operationId !== "string" ||
    input.operationId.length === 0 ||
    !safeTimestamp(input.expiresAtMs)
  ) {
    throw new Error("invalid gameplay mutation lock record");
  }
  return {
    lockId: input.lockId,
    ownerId: input.ownerId,
    operationId: input.operationId,
    expiresAtMs: input.expiresAtMs,
  };
}

function normalizeLegacySnapshot(input: {
  locks: unknown;
  timerStarts: unknown;
}): LegacySnapshot {
  const leases = Object.entries(
    objectRoot(input.locks, "invalid gameplay mutation lock export"),
  ).map(([lockId, raw]) => {
    const lease = record(raw);
    if (
      !lease ||
      !hasExactKeys(lease, ["ownerId", "operationId", "expiresAtMs"])
    ) {
      throw new Error("invalid gameplay mutation lock record");
    }
    return normalizeLease({
      lockId,
      ownerId: lease.ownerId,
      operationId: lease.operationId,
      expiresAtMs: lease.expiresAtMs,
    });
  });
  leases.sort(compareLeases);

  const timerMarkers: TimerMarker[] = [];
  for (const [playerId, rawMatches] of Object.entries(
    objectRoot(input.timerStarts, "invalid match timer start export"),
  )) {
    if (!validKey(playerId)) {
      throw new Error("invalid match timer start record");
    }
    for (const [matchId, rawMarker] of Object.entries(
      objectRoot(rawMatches, "invalid match timer start player record"),
    )) {
      const marker = record(rawMarker);
      const parsed = parseLegacyTimer(marker?.timer);
      if (
        !validKey(matchId) ||
        !marker ||
        !hasExactKeys(marker, ["timer", "turnNumber"]) ||
        !parsed ||
        !safeNonnegativeInteger(marker.turnNumber) ||
        parsed.turnNumber !== marker.turnNumber
      ) {
        throw new Error("invalid match timer start record");
      }
      timerMarkers.push({
        playerId,
        matchId,
        timer: String(marker.timer),
        turnNumber: Number(marker.turnNumber),
      });
    }
  }
  timerMarkers.sort(compareMarkers);
  return { leases, timerMarkers };
}

function normalizeD1Leases(rows: readonly JsonRecord[]): D1Lease[] {
  const seen = new Set<string>();
  const leases = rows.map((row) => {
    const lease = normalizeLease({
      lockId: row.lock_id,
      ownerId: row.owner_id,
      operationId: row.operation_id,
      expiresAtMs: row.expires_at_ms,
    });
    if (seen.has(lease.lockId)) {
      throw new Error("duplicate D1 gameplay mutation lock record");
    }
    seen.add(lease.lockId);
    return lease;
  });
  return leases.sort(compareLeases);
}

function normalizeD1TimerMarkers(rows: readonly JsonRecord[]): D1TimerMarker[] {
  const seen = new Set<string>();
  const markers = rows.map((row) => {
    const playerId = row.player_id;
    const matchId = row.match_id;
    const timer = row.timer;
    const turnNumber = row.turn_number;
    const updatedAtMs = row.updated_at_ms;
    const opponentId = row.opponent_id;
    const parsed = parseLegacyTimer(timer);
    if (
      typeof playerId !== "string" ||
      !validKey(playerId) ||
      typeof matchId !== "string" ||
      !validKey(matchId) ||
      typeof timer !== "string" ||
      !parsed ||
      !safeNonnegativeInteger(turnNumber) ||
      parsed.turnNumber !== turnNumber ||
      !safeNonnegativeInteger(updatedAtMs) ||
      !(
        opponentId === null ||
        (typeof opponentId === "string" && validKey(opponentId))
      )
    ) {
      throw new Error("invalid D1 match timer start record");
    }
    const key = `${playerId}\u0000${matchId}`;
    if (seen.has(key)) {
      throw new Error("duplicate D1 match timer start record");
    }
    seen.add(key);
    return {
      playerId,
      matchId,
      timer,
      turnNumber: Number(turnNumber),
      updatedAtMs: Number(updatedAtMs),
      opponentId,
    };
  });
  return markers.sort(compareMarkers);
}

function logicalD1Markers(markers: readonly D1TimerMarker[]): TimerMarker[] {
  return markers.map(({ matchId, playerId, timer, turnNumber }) => ({
    matchId,
    playerId,
    timer,
    turnNumber,
  }));
}

function summarizeLegacySnapshot(snapshot: LegacySnapshot, nowMs: number) {
  return {
    locks: snapshot.leases.length,
    activeLocks: snapshot.leases.filter((lease) => lease.expiresAtMs > nowMs)
      .length,
    timerMarkers: snapshot.timerMarkers.length,
    timerDigest: digest(snapshot.timerMarkers),
    snapshotDigest: digest(snapshot),
  };
}

function summarizeD1Snapshot(snapshot: D1Snapshot, activeLocks: number) {
  if (!Number.isSafeInteger(activeLocks) || activeLocks < 0) {
    throw new Error("invalid active D1 gameplay lease count");
  }
  return {
    locks: snapshot.leases.length,
    activeLocks,
    timerMarkers: snapshot.timerMarkers.length,
    timerDigest: digest(logicalD1Markers(snapshot.timerMarkers)),
    timerSnapshotDigest: digest(snapshot.timerMarkers),
  };
}

function parseArgs(argv: string[]): MigrationOptions {
  let project = CANONICAL_FIREBASE_PROJECT;
  let previewSeen = false;
  let projectSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--preview") {
      if (previewSeen) throw new Error("duplicate --preview");
      previewSeen = true;
      continue;
    }
    if (arg === "--project") {
      if (projectSeen) throw new Error("duplicate --project");
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("missing project");
      project = value;
      projectSeen = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { project };
}

function assertPreviewSource(
  options: MigrationOptions,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (options.project !== CANONICAL_FIREBASE_PROJECT) return;
  if (
    Object.keys(environment).some(
      (key) =>
        FIREBASE_SOURCE_OVERRIDE_KEYS.has(key) ||
        /^FIREBASE_(?:DATABASE|REALTIME|RTDB)_/.test(key),
    )
  ) {
    throw new Error(
      "canonical gameplay coordination preview rejects Firebase source overrides",
    );
  }
}

function migrateGameplayCoordination(
  options: MigrationOptions,
  dependencies: MigrationDependencies,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  assertPreviewSource(options, environment);
  const exportedAtMs = dependencies.now();
  if (!safeTimestamp(exportedAtMs)) {
    throw new Error("invalid gameplay coordination export timestamp");
  }

  const legacy = dependencies.readLegacySnapshot(options.project);
  const d1 = dependencies.readD1Snapshot();
  const legacySummary = summarizeLegacySnapshot(legacy, exportedAtMs);
  const d1Summary = summarizeD1Snapshot(d1, dependencies.readActiveD1Leases());
  dependencies.persistArtifacts({
    exportedAtMs,
    files: {
      "metadata.json": `${JSON.stringify({
        phase: "preview",
        legacy: legacySummary,
        d1: {
          ...d1Summary,
          hasOpponentIdColumn: d1.hasOpponentIdColumn,
        },
      })}\n`,
      "rtdb-source.json": `${JSON.stringify(legacy)}\n`,
      "d1-source.json": `${JSON.stringify(d1)}\n`,
    },
  });
  dependencies.log(
    JSON.stringify({
      legacy: legacySummary,
      d1: d1Summary,
    }),
  );
}

function run(
  executable: string,
  args: string[],
  { maxBuffer = 64 * 1024 * 1024 }: { maxBuffer?: number } = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer,
    shell: false,
  });
  if (result.status !== 0) throw new Error("preview subprocess failed");
  return String(result.stdout);
}

function firebaseDatabaseGetArgs(project: string, path: string): string[] {
  const args = ["database:get", path, "--project", project];
  if (project === CANONICAL_FIREBASE_PROJECT) {
    args.push("--instance", CANONICAL_FIREBASE_INSTANCE);
  }
  return args;
}

function firebaseGet(project: string, path: string): unknown {
  return JSON.parse(
    run(
      resolve("node_modules/.bin/firebase"),
      firebaseDatabaseGetArgs(project, path),
    ),
  ) as unknown;
}

function readRemoteLegacySnapshot(project: string): LegacySnapshot {
  return normalizeLegacySnapshot({
    locks: firebaseGet(project, "/gameplayMutationLocks"),
    timerStarts: firebaseGet(project, "/matchTimerStarts"),
  });
}

function wranglerArgs(args: string[]): string[] {
  return [
    "d1",
    "execute",
    PROFILE_GAMES_DATABASE,
    "--remote",
    "--config",
    CONFIG_PATH,
    "--env-file",
    RELEASE_ENV_PATH,
    ...args,
  ];
}

function d1Rows(command: string): JsonRecord[] {
  const output = run(resolve("node_modules/.bin/wrangler"), [
    ...wranglerArgs(["--command", command]),
    "--json",
  ]);
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error("invalid D1 JSON response");
  const entry = parsed.find(
    (value) => record(value) && Array.isArray(record(value)?.results),
  ) as JsonRecord | undefined;
  return entry && Array.isArray(entry.results)
    ? entry.results.filter((value): value is JsonRecord =>
        Boolean(record(value)),
      )
    : [];
}

function readRemoteActiveD1Leases(): number {
  const row = d1Rows(
    "SELECT COUNT(*) AS active_leases FROM game_session_mutation_locks WHERE expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)",
  )[0];
  const count = Number(row?.active_leases);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid active D1 gameplay lease count");
  }
  return count;
}

function readRemoteD1Snapshot(): D1Snapshot {
  const hasOpponentIdColumn =
    Number(
      d1Rows(
        "SELECT COUNT(*) AS column_count FROM pragma_table_info('match_timer_starts') WHERE name = 'opponent_id'",
      )[0]?.column_count,
    ) === 1;
  return {
    hasOpponentIdColumn,
    leases: normalizeD1Leases(
      d1Rows(
        "SELECT lock_id, owner_id, operation_id, expires_at_ms FROM game_session_mutation_locks ORDER BY lock_id",
      ),
    ),
    timerMarkers: normalizeD1TimerMarkers(
      d1Rows(
        `SELECT player_id, match_id, timer, turn_number, updated_at_ms, ${hasOpponentIdColumn ? "opponent_id" : "NULL AS opponent_id"} FROM match_timer_starts ORDER BY player_id, match_id`,
      ),
    ),
  };
}

function persistMigrationArtifacts(
  input: Parameters<MigrationDependencies["persistArtifacts"]>[0],
  rootDirectory = resolve(".cache", "gameplay-coordination-migration"),
): void {
  mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  chmodSync(rootDirectory, 0o700);
  const runDirectory = mkdtempSync(
    resolve(rootDirectory, `${input.exportedAtMs}-${process.pid}-preview-`),
  );
  chmodSync(runDirectory, 0o700);
  for (const [name, contents] of Object.entries(input.files)) {
    if (!/^[a-z0-9.-]+$/.test(name)) {
      throw new Error("invalid migration artifact name");
    }
    writeFileSync(resolve(runDirectory, name), contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
}

function createDefaultDependencies(): MigrationDependencies {
  return {
    log: console.log,
    now: Date.now,
    persistArtifacts: persistMigrationArtifacts,
    readActiveD1Leases: readRemoteActiveD1Leases,
    readD1Snapshot: readRemoteD1Snapshot,
    readLegacySnapshot: readRemoteLegacySnapshot,
  };
}

function execute(argv = process.argv.slice(2)): void {
  migrateGameplayCoordination(parseArgs(argv), createDefaultDependencies());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    execute();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "preview failed");
    process.exitCode = 1;
  }
}

export {
  assertPreviewSource,
  canonicalize,
  digest,
  execute,
  firebaseDatabaseGetArgs,
  migrateGameplayCoordination,
  normalizeD1Leases,
  normalizeD1TimerMarkers,
  normalizeLegacySnapshot,
  parseArgs,
  persistMigrationArtifacts,
  summarizeD1Snapshot,
  summarizeLegacySnapshot,
  type D1Snapshot,
  type D1TimerMarker,
  type LegacySnapshot,
  type MigrationDependencies,
  type MigrationOptions,
  type TimerMarker,
};
