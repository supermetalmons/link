import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;
type StorageMode = "frozen" | "d1";
type Control = {
  storageMode: StorageMode;
  freezeGeneration: number;
  updatedAtMs: number;
};
type Admission = {
  admissionId: string;
  freezeGeneration: number;
  kind: string;
  createdAtMs: number;
  expiresAtMs: number;
  uncertain: boolean;
};
type Operation =
  | "status"
  | "freeze"
  | "resume-d1"
  | { kind: "recover-admission"; admissionId: string };
type Dependencies = {
  now(): number;
  log(value: string): void;
  readControl(): Control;
  readCanonicalState(): string;
  readAdmissions(): Admission[];
  activeGameplayLeases(nowMs: number): number;
  updateControl(expected: Control, next: Control): void;
  recoverAdmission(admission: Admission, nowMs: number): boolean;
};

const DATABASE = "mons-link-profiles";
const GAMEPLAY_DATABASE = "mons-link-profile-games";
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV_PATH = "cloud/workers/api/release.env";

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 768 &&
    value.trim() === value &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) || 0;
      return code > 0x1f && code !== 0x7f && !".#$/[]".includes(character);
    })
  );
}

function parseArgs(argv: string[]): Operation {
  if (argv[0] === "--recover-admission") {
    if (
      argv.length !== 4 ||
      !validIdentifier(argv[1]) ||
      argv[2] !== "--confirm-request-finished" ||
      argv[3] !== "--confirm-source-reconciled"
    ) {
      throw new Error(
        "admission recovery requires one ID, --confirm-request-finished and --confirm-source-reconciled",
      );
    }
    return { kind: "recover-admission", admissionId: argv[1] };
  }
  const operation = argv[0]?.replace(/^--/, "");
  if (
    argv.length !== 1 ||
    !["status", "freeze", "resume-d1"].includes(operation)
  ) {
    throw new Error("choose exactly one wager reservation control operation");
  }
  return operation as Operation;
}

function parseControl(value: unknown): Control {
  const row = record(value);
  if (!row) throw new Error("missing wager reservation storage control");
  if (
    (row.storage_mode !== "frozen" && row.storage_mode !== "d1") ||
    !integer(row.freeze_generation) ||
    !integer(row.updated_at_ms)
  )
    throw new Error("invalid wager reservation control");
  return {
    storageMode: row.storage_mode,
    freezeGeneration: row.freeze_generation,
    updatedAtMs: row.updated_at_ms,
  };
}

function parseAdmission(value: unknown): Admission {
  const row = record(value);
  if (
    !row ||
    !validIdentifier(row.admission_id) ||
    !integer(row.freeze_generation) ||
    !integer(row.created_at_ms) ||
    !integer(row.expires_at_ms) ||
    row.expires_at_ms <= row.created_at_ms ||
    typeof row.kind !== "string" ||
    row.kind.length === 0 ||
    (row.uncertain !== 0 && row.uncertain !== 1)
  ) {
    throw new Error("invalid wager reservation admission");
  }
  return {
    admissionId: row.admission_id,
    freezeGeneration: row.freeze_generation,
    kind: row.kind,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    uncertain: row.uncertain === 1,
  };
}

function manageWagerReservations(
  operation: Operation,
  dependencies: Dependencies,
): void {
  const nowMs = dependencies.now();
  if (!integer(nowMs)) throw new Error("invalid management timestamp");
  let control = dependencies.readControl();
  if (operation !== "status") {
    if (dependencies.readCanonicalState() !== "frozen") {
      throw new Error("freeze canonical profile writes first");
    }
    if (typeof operation !== "string") {
      if (control.storageMode !== "frozen")
        throw new Error("freeze wager reservations before recovery");
      const admission = dependencies
        .readAdmissions()
        .find((entry) => entry.admissionId === operation.admissionId);
      if (!admission)
        throw new Error("wager reservation admission was not found");
      if (admission.expiresAtMs > nowMs)
        throw new Error("wager reservation admission has not expired");
      if (!dependencies.recoverAdmission(admission, nowMs))
        throw new Error("wager reservation admission recovery conflicted");
    } else {
      const next: Control = { ...control, updatedAtMs: nowMs };
      if (operation === "freeze") {
        if (control.storageMode !== "frozen") {
          next.storageMode = "frozen";
          next.freezeGeneration += 1;
        }
      } else {
        if (dependencies.readAdmissions().length !== 0)
          throw new Error("wager reservation writers are not drained");
        if (dependencies.activeGameplayLeases(nowMs) !== 0)
          throw new Error("gameplay mutation leases are not drained");
        next.storageMode = "d1";
      }
      if (next.storageMode !== control.storageMode) {
        dependencies.updateControl(control, next);
        control = dependencies.readControl();
        if (
          control.storageMode !== next.storageMode ||
          control.freezeGeneration !== next.freezeGeneration ||
          control.updatedAtMs !== next.updatedAtMs
        )
          throw new Error("wager reservation control update conflicted");
      }
    }
  }
  const admissions = dependencies.readAdmissions();
  dependencies.log(
    JSON.stringify({
      operation: typeof operation === "string" ? operation : operation.kind,
      ...control,
      canonicalState: dependencies.readCanonicalState(),
      activeGameplayLeases: dependencies.activeGameplayLeases(nowMs),
      writeAdmissions: admissions.length,
      uncertainAdmissions: admissions.filter((entry) => entry.uncertain).length,
      expiredAdmissions: admissions.filter(
        (entry) => entry.expiresAtMs <= nowMs,
      ).length,
      admissions,
    }),
  );
}

function runTool(
  executable: string,
  args: string[],
  maxBuffer = 16 * 1024 * 1024,
): string {
  const result = spawnSync(executable, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer,
    shell: false,
  });
  if (result.status !== 0)
    throw new Error("wager reservation subprocess failed");
  return String(result.stdout);
}

function wranglerArgs(args: string[]): string[] {
  return [...args, "--config", CONFIG_PATH, "--env-file", RELEASE_ENV_PATH];
}

function d1Rows(command: string, database = DATABASE): JsonRecord[] {
  const value: unknown = JSON.parse(
    runTool(
      resolve("node_modules/.bin/wrangler"),
      wranglerArgs([
        "d1",
        "execute",
        database,
        "--remote",
        "--command",
        command,
        "--json",
      ]),
    ),
  );
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("invalid D1 response");
  return value.flatMap((entry) => {
    const result = record(entry);
    if (!result || result.success === false || !Array.isArray(result.results))
      throw new Error("invalid D1 response");
    return result.results.map((row: unknown) => {
      const parsed = record(row);
      if (!parsed) throw new Error("invalid D1 row");
      return parsed;
    });
  });
}

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function readRemoteControl(): Control {
  return parseControl(
    d1Rows(
      "SELECT * FROM wager_reservation_runtime_control WHERE singleton = 1",
    )[0],
  );
}

function readCanonicalState(): string {
  const state = d1Rows(
    "SELECT state FROM profile_canonical_control WHERE singleton = 1",
  )[0]?.state;
  if (state !== "active" && state !== "frozen")
    throw new Error("invalid canonical profile control");
  return state;
}

function readRemoteAdmissions(): Admission[] {
  const rows = d1Rows(
    "SELECT * FROM wager_reservation_write_admissions ORDER BY admission_id LIMIT 10001",
  );
  if (rows.length > 10000)
    throw new Error("too many wager reservation admissions to inspect safely");
  return rows.map(parseAdmission);
}

function activeGameplayLeases(nowMs: number): number {
  if (!integer(nowMs)) throw new Error("invalid lease inspection timestamp");
  const count = d1Rows(
    `SELECT COUNT(*) AS count FROM game_session_mutation_locks WHERE expires_at_ms > ${nowMs}`,
    GAMEPLAY_DATABASE,
  )[0]?.count;
  if (!integer(count)) throw new Error("invalid gameplay lease count");
  return count;
}

function updateRemoteControl(expected: Control, next: Control): void {
  const rows = d1Rows(
    `UPDATE wager_reservation_runtime_control SET storage_mode = '${next.storageMode}', freeze_generation = ${next.freezeGeneration}, updated_at_ms = ${next.updatedAtMs} WHERE singleton = 1 AND storage_mode = '${expected.storageMode}' AND freeze_generation = ${expected.freezeGeneration} AND updated_at_ms = ${expected.updatedAtMs} AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen') RETURNING singleton`,
  );
  if (rows.length !== 1)
    throw new Error("wager reservation control update conflicted");
}

function recoverRemoteAdmission(admission: Admission, nowMs: number): boolean {
  const rows = d1Rows(
    `DELETE FROM wager_reservation_write_admissions WHERE admission_id = ${sqlText(admission.admissionId)} AND freeze_generation = ${admission.freezeGeneration} AND created_at_ms = ${admission.createdAtMs} AND expires_at_ms = ${admission.expiresAtMs} AND uncertain = ${Number(admission.uncertain)} AND expires_at_ms <= ${nowMs} AND EXISTS (SELECT 1 FROM wager_reservation_runtime_control WHERE singleton = 1 AND storage_mode = 'frozen') AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen') RETURNING admission_id`,
  );
  return rows.length === 1;
}

function execute(argv = process.argv.slice(2)): void {
  manageWagerReservations(parseArgs(argv), {
    now: Date.now,
    log: console.log,
    readControl: readRemoteControl,
    readCanonicalState,
    readAdmissions: readRemoteAdmissions,
    activeGameplayLeases,
    updateControl: updateRemoteControl,
    recoverAdmission: recoverRemoteAdmission,
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
      error instanceof Error
        ? error.message
        : "wager reservation management failed",
    );
    process.exitCode = 1;
  }
}

export {
  execute,
  manageWagerReservations,
  parseAdmission,
  parseArgs,
  parseControl,
  type Admission,
  type Control,
  type Dependencies,
  type Operation,
};
