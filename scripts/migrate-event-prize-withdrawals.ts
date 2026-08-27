import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;
type MigrationPhase = "abort" | "dry-run" | "final" | "freeze" | "rollback";
type WithdrawalSnapshot = Record<string, Record<string, JsonRecord>>;

type MigrationOptions = {
  phase: MigrationPhase;
  project: string;
};

const DATABASE = "mons-link-event-prize-withdrawals";
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV_PATH = "cloud/workers/api/release.env";
const VALID_STATUSES = new Set([
  "blocked",
  "completed",
  "processing",
  "submitted",
]);

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function validKey(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) || 0;
      return !".#$/[]".includes(character) && code > 0x1f && code !== 0x7f;
    })
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonicalize(object[key])]),
  );
}

function snapshotDigest(snapshot: WithdrawalSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

function normalizeSnapshot(value: unknown): WithdrawalSnapshot {
  const source = value === null ? {} : record(value);
  if (!source) throw new Error("invalid event prize withdrawal export");
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([eventId, rawPrizes]) => {
        const prizes = record(rawPrizes);
        if (!validKey(eventId) || !prizes) {
          throw new Error("invalid event prize withdrawal event");
        }
        return [
          eventId,
          Object.fromEntries(
            Object.entries(prizes)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([prizeId, rawWithdrawal]) => {
                const withdrawal = record(rawWithdrawal);
                if (
                  !validKey(prizeId) ||
                  !withdrawal ||
                  withdrawal.eventId !== eventId ||
                  withdrawal.prizeId !== prizeId ||
                  !VALID_STATUSES.has(String(withdrawal.status))
                ) {
                  throw new Error("invalid event prize withdrawal record");
                }
                return [prizeId, withdrawal];
              }),
          ),
        ];
      }),
  );
}

function textHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function sqlText(value: string): string {
  return `CAST(X'${textHex(value)}' AS TEXT)`;
}

function recordTimestamp(value: JsonRecord, fallback: number): number {
  const timestamp = Number(value.updatedAtMs);
  return Number.isSafeInteger(timestamp) && timestamp > 0
    ? timestamp
    : fallback;
}

function buildImportSql(
  snapshot: WithdrawalSnapshot,
  exportedAtMs: number,
): string {
  const statements = ["DELETE FROM event_prize_withdrawals;"];
  for (const [eventId, prizes] of Object.entries(snapshot)) {
    for (const [prizeId, withdrawal] of Object.entries(prizes)) {
      statements.push(
        `INSERT INTO event_prize_withdrawals (event_id, prize_id, record_json, version, updated_at_ms) VALUES (${sqlText(eventId)}, ${sqlText(prizeId)}, ${sqlText(JSON.stringify(withdrawal))}, 1, ${recordTimestamp(withdrawal, exportedAtMs)});`,
      );
    }
  }
  const count = Object.values(snapshot).reduce(
    (total, prizes) => total + Object.keys(prizes).length,
    0,
  );
  statements.push(
    `UPDATE event_prize_withdrawal_runtime_control SET source_digest = ${sqlText(snapshotDigest(snapshot))}, source_record_count = ${count}, source_exported_at_ms = ${exportedAtMs}, updated_at_ms = ${exportedAtMs} WHERE singleton = 1 AND storage_mode = 'frozen';`,
  );
  return `${statements.join("\n")}\n`;
}

function parseArgs(argv: string[]): MigrationOptions {
  let phase: MigrationPhase = "dry-run";
  let project = "mons-link";
  let phaseSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--dry-run" ||
      arg === "--freeze" ||
      arg === "--final" ||
      arg === "--rollback" ||
      arg === "--abort"
    ) {
      if (phaseSet) throw new Error("choose one migration phase");
      phaseSet = true;
      phase = arg.slice(2) as MigrationPhase;
      continue;
    }
    if (arg === "--project") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("missing project");
      project = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { phase, project };
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
  if (result.status !== 0) {
    throw new Error(
      `${executable} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return String(result.stdout);
}

function firebaseGet(project: string): unknown {
  const output = run(resolve("node_modules/.bin/firebase"), [
    "database:get",
    "/eventPrizeWithdrawals",
    "--project",
    project,
  ]);
  return JSON.parse(output) as unknown;
}

function wranglerArgs(args: string[]): string[] {
  return [
    "d1",
    "execute",
    DATABASE,
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

function runD1(command: string): void {
  run(
    resolve("node_modules/.bin/wrangler"),
    wranglerArgs(["--command", command]),
  );
}

function readD1Control(): {
  previousStorageMode: string;
  storageMode: string;
} {
  const rows = d1Rows(
    "SELECT storage_mode, previous_storage_mode FROM event_prize_withdrawal_runtime_control WHERE singleton = 1",
  );
  return {
    storageMode:
      typeof rows[0]?.storage_mode === "string" ? rows[0].storage_mode : "",
    previousStorageMode:
      typeof rows[0]?.previous_storage_mode === "string"
        ? rows[0].previous_storage_mode
        : "",
  };
}

function readD1Mode(): string {
  return readD1Control().storageMode;
}

function isFirebaseOriginFreeze(control: {
  previousStorageMode: string;
  storageMode: string;
}): boolean {
  return (
    control.storageMode === "frozen" &&
    control.previousStorageMode === "firebase"
  );
}

function readD1Snapshot(): WithdrawalSnapshot {
  const snapshot: WithdrawalSnapshot = {};
  for (const row of d1Rows(
    "SELECT event_id, prize_id, record_json FROM event_prize_withdrawals ORDER BY event_id, prize_id",
  )) {
    const eventId = String(row.event_id);
    const prizeId = String(row.prize_id);
    const withdrawal = JSON.parse(String(row.record_json)) as unknown;
    snapshot[eventId] ||= {};
    snapshot[eventId][prizeId] = record(withdrawal) || {};
  }
  return normalizeSnapshot(snapshot);
}

function summarize(snapshot: WithdrawalSnapshot, nowMs = Date.now()) {
  const statuses: Record<string, number> = {};
  let activeLeases = 0;
  let records = 0;
  for (const prizes of Object.values(snapshot)) {
    for (const withdrawal of Object.values(prizes)) {
      records += 1;
      const status = String(withdrawal.status);
      statuses[status] = (statuses[status] || 0) + 1;
      if (
        (status === "processing" || status === "submitted") &&
        Number(withdrawal.leaseExpiresAtMs) > nowMs
      ) {
        activeLeases += 1;
      }
    }
  }
  return { records, statuses, activeLeases, digest: snapshotDigest(snapshot) };
}

function assertFinalSnapshotSafe(summary: ReturnType<typeof summarize>): void {
  if (summary.activeLeases !== 0) {
    throw new Error("final event prize withdrawal export is not quiescent");
  }
}

function freezeStorage(nowMs: number): void {
  const mode = readD1Mode();
  if (mode === "frozen") return;
  if (mode !== "firebase" && mode !== "d1") {
    throw new Error("withdrawal storage mode cannot be frozen");
  }
  runD1(
    `UPDATE event_prize_withdrawal_runtime_control SET previous_storage_mode = storage_mode, storage_mode = 'frozen', updated_at_ms = ${nowMs} WHERE singleton = 1 AND storage_mode IN ('firebase', 'd1')`,
  );
  if (readD1Mode() !== "frozen") {
    throw new Error("failed to freeze event prize withdrawal storage");
  }
}

function execute(argv = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  const exportedAtMs = Date.now();
  if (options.phase === "freeze") {
    freezeStorage(exportedAtMs);
    console.log(
      JSON.stringify({ phase: options.phase, storageMode: "frozen" }),
    );
    return;
  }
  if (options.phase === "abort") {
    const control = readD1Control();
    if (
      control.storageMode !== "frozen" ||
      (control.previousStorageMode !== "firebase" &&
        control.previousStorageMode !== "d1")
    ) {
      throw new Error("abort requires a reversible frozen storage mode");
    }
    runD1(
      `UPDATE event_prize_withdrawal_runtime_control SET storage_mode = previous_storage_mode, previous_storage_mode = NULL, updated_at_ms = ${exportedAtMs} WHERE singleton = 1 AND storage_mode = 'frozen'`,
    );
    if (readD1Mode() !== control.previousStorageMode) {
      throw new Error("event prize withdrawal abort failed");
    }
    console.log(
      JSON.stringify({
        phase: options.phase,
        storageMode: control.previousStorageMode,
      }),
    );
    return;
  }
  const snapshot = normalizeSnapshot(firebaseGet(options.project));
  const summary = summarize(snapshot, exportedAtMs);
  if (options.phase === "rollback") {
    assertFinalSnapshotSafe(summary);
    const control = readD1Control();
    if (
      control.storageMode !== "frozen" ||
      control.previousStorageMode !== "d1"
    ) {
      throw new Error("rollback requires frozen withdrawal storage mode");
    }
    const d1Summary = summarize(readD1Snapshot(), exportedAtMs);
    if (
      d1Summary.digest !== summary.digest ||
      d1Summary.records !== summary.records
    ) {
      throw new Error("rollback withdrawal storage verification mismatch");
    }
    runD1(
      `UPDATE event_prize_withdrawal_runtime_control SET storage_mode = 'firebase', previous_storage_mode = NULL, updated_at_ms = ${exportedAtMs} WHERE singleton = 1 AND storage_mode = 'frozen'`,
    );
    if (readD1Mode() !== "firebase") {
      throw new Error("event prize withdrawal rollback failed");
    }
    console.log(
      JSON.stringify({
        phase: options.phase,
        verified: true,
        storageMode: "firebase",
        records: summary.records,
        digest: summary.digest,
      }),
    );
    return;
  }
  console.log(JSON.stringify({ phase: options.phase, ...summary }));
  if (options.phase === "dry-run") return;
  assertFinalSnapshotSafe(summary);
  const finalControl = readD1Control();
  if (!isFirebaseOriginFreeze(finalControl)) {
    throw new Error("final import requires a Firebase-origin freeze");
  }
  const runDirectory = resolve(
    ".cache",
    "event-prize-withdrawal-migration",
    `${exportedAtMs}-${process.pid}`,
  );
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(runDirectory, "source.json"),
    `${JSON.stringify(snapshot)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(runDirectory, "import.sql"),
    buildImportSql(snapshot, exportedAtMs),
    { mode: 0o600 },
  );
  run(
    resolve("node_modules/.bin/wrangler"),
    wranglerArgs(["--file", resolve(runDirectory, "import.sql"), "--yes"]),
  );
  const importedSummary = summarize(readD1Snapshot(), exportedAtMs);
  if (
    importedSummary.digest !== summary.digest ||
    importedSummary.records !== summary.records
  ) {
    throw new Error("event prize withdrawal D1 verification mismatch");
  }
  runD1(
    `UPDATE event_prize_withdrawal_runtime_control SET storage_mode = 'd1', previous_storage_mode = NULL, cutover_at_ms = ${exportedAtMs}, updated_at_ms = ${exportedAtMs} WHERE singleton = 1 AND storage_mode = 'frozen' AND source_digest = ${sqlText(summary.digest)}`,
  );
  if (readD1Mode() !== "d1") {
    throw new Error("event prize withdrawal D1 cutover failed");
  }
  try {
    rmSync(runDirectory, { recursive: true, force: true });
  } catch {
    console.warn(
      JSON.stringify({
        phase: options.phase,
        artifactCleanupFailed: true,
      }),
    );
  }
  console.log(
    JSON.stringify({
      phase: options.phase,
      verified: true,
      storageMode: "d1",
      records: importedSummary.records,
      digest: importedSummary.digest,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    execute();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "migration failed");
    process.exitCode = 1;
  }
}

export {
  assertFinalSnapshotSafe,
  buildImportSql,
  canonicalize,
  execute,
  isFirebaseOriginFreeze,
  normalizeSnapshot,
  parseArgs,
  snapshotDigest,
  summarize,
};
