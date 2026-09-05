import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;
type StorageMode = "firebase" | "frozen" | "d1";
type PreviousStorageMode = "firebase" | "d1" | null;
type Control = {
  storageMode: StorageMode;
  previousStorageMode: PreviousStorageMode;
  freezeGeneration: number;
  activatedAtMs: number | null;
  verifiedImportGeneration: number | null;
  importAttemptId: string | null;
  importStartedAtMs: number | null;
  sourceDigest: string | null;
  sourceBalanceCount: number | null;
  sourceOperationCount: number | null;
  sourceFirstExportedAtMs: number | null;
  sourceExportedAtMs: number | null;
  queuesPausedAtMs: number | null;
  bridgeDeployedAtMs: number | null;
  bridgeVersionId: string | null;
  updatedAtMs: number;
};
type Admission = {
  admissionId: string;
  storageMode: "firebase" | "d1";
  freezeGeneration: number;
  kind: string;
  createdAtMs: number;
  expiresAtMs: number;
  uncertain: boolean;
};
type Deployment = { versionId: string; deployedAtMs: number };
type Operation =
  | "status"
  | "freeze"
  | "return-to-firebase"
  | "activate-d1"
  | "resume-d1"
  | { kind: "recover-admission"; admissionId: string }
  | { kind: "recover-import"; importAttemptId: string };
type Dependencies = {
  now(): number;
  log(value: string): void;
  readControl(): Control;
  readCanonicalState(): string;
  readAdmissions(): Admission[];
  activeGameplayLeases(nowMs: number): number;
  readDeployment(): Deployment;
  updateControl(expected: Control, next: Control): void;
  recoverAdmission(admission: Admission, nowMs: number): boolean;
  recoverImport(control: Control, nowMs: number): boolean;
};

const DATABASE = "mons-link-profiles";
const GAMEPLAY_DATABASE = "mons-link-profile-games";
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV_PATH = "cloud/workers/api/release.env";
const SOURCE_QUIET_INTERVAL_MS = 6 * 60 * 1_000;
const QUEUE_DRAIN_INTERVAL_MS = 15 * 60 * 1_000;

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
  if (argv[0] === "--recover-import") {
    if (
      argv.length !== 3 ||
      !validIdentifier(argv[1]) ||
      argv[2] !== "--confirm-import-stopped"
    )
      throw new Error(
        "import recovery requires one attempt ID and --confirm-import-stopped",
      );
    return { kind: "recover-import", importAttemptId: argv[1] };
  }
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
    ![
      "status",
      "freeze",
      "return-to-firebase",
      "activate-d1",
      "resume-d1",
    ].includes(operation)
  ) {
    throw new Error("choose exactly one wager reservation control operation");
  }
  return operation as Operation;
}

function parseControl(value: unknown): Control {
  const row = record(value);
  if (!row) throw new Error("missing wager reservation storage control");
  const storageMode = row.storage_mode;
  const previousStorageMode = row.previous_storage_mode;
  const optionalInteger = (name: string): number | null => {
    const value = row[name];
    if (value === null) return null;
    if (!integer(value)) throw new Error("invalid wager reservation control");
    return value;
  };
  if (
    (storageMode !== "firebase" &&
      storageMode !== "frozen" &&
      storageMode !== "d1") ||
    (previousStorageMode !== null &&
      previousStorageMode !== "firebase" &&
      previousStorageMode !== "d1") ||
    (storageMode === "frozen") !== (previousStorageMode !== null) ||
    !integer(row.freeze_generation) ||
    !integer(row.updated_at_ms) ||
    (row.source_digest !== null &&
      !/^[a-f0-9]{64}$/.test(String(row.source_digest))) ||
    (row.bridge_version_id !== null && !validIdentifier(row.bridge_version_id))
  ) {
    throw new Error("invalid wager reservation control");
  }
  const control: Control = {
    storageMode,
    previousStorageMode,
    freezeGeneration: row.freeze_generation,
    activatedAtMs: optionalInteger("activated_at_ms"),
    verifiedImportGeneration: optionalInteger("verified_import_generation"),
    importAttemptId: row.import_attempt_id as string | null,
    importStartedAtMs: optionalInteger("import_started_at_ms"),
    sourceDigest: row.source_digest as string | null,
    sourceBalanceCount: optionalInteger("source_balance_count"),
    sourceOperationCount: optionalInteger("source_operation_count"),
    sourceFirstExportedAtMs: optionalInteger("source_first_exported_at_ms"),
    sourceExportedAtMs: optionalInteger("source_exported_at_ms"),
    queuesPausedAtMs: optionalInteger("queues_paused_at_ms"),
    bridgeDeployedAtMs: optionalInteger("bridge_deployed_at_ms"),
    bridgeVersionId: row.bridge_version_id as string | null,
    updatedAtMs: row.updated_at_ms,
  };
  if (
    (control.importAttemptId !== null &&
      !validIdentifier(control.importAttemptId)) ||
    (control.importAttemptId === null) !== (control.importStartedAtMs === null)
  )
    throw new Error("invalid wager reservation import claim");
  if (
    control.activatedAtMs !== null &&
    (storageMode === "firebase" || previousStorageMode === "firebase")
  ) {
    throw new Error("invalid activated wager reservation control");
  }
  return control;
}

function parseAdmission(value: unknown): Admission {
  const row = record(value);
  if (
    !row ||
    !validIdentifier(row.admission_id) ||
    (row.storage_mode !== "firebase" && row.storage_mode !== "d1") ||
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
    storageMode: row.storage_mode,
    freezeGeneration: row.freeze_generation,
    kind: row.kind,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    uncertain: row.uncertain === 1,
  };
}

function hasVerifiedImport(control: Control, nowMs: number): boolean {
  return (
    control.storageMode === "frozen" &&
    control.previousStorageMode === "firebase" &&
    control.activatedAtMs === null &&
    control.importAttemptId === null &&
    control.freezeGeneration > 0 &&
    control.verifiedImportGeneration === control.freezeGeneration &&
    /^[a-f0-9]{64}$/.test(control.sourceDigest || "") &&
    integer(control.sourceBalanceCount) &&
    integer(control.sourceOperationCount) &&
    integer(control.sourceFirstExportedAtMs) &&
    integer(control.sourceExportedAtMs) &&
    integer(control.queuesPausedAtMs) &&
    integer(control.bridgeDeployedAtMs) &&
    validIdentifier(control.bridgeVersionId) &&
    control.sourceExportedAtMs <= nowMs &&
    control.sourceExportedAtMs - control.sourceFirstExportedAtMs >=
      SOURCE_QUIET_INTERVAL_MS &&
    control.sourceExportedAtMs - control.queuesPausedAtMs >=
      QUEUE_DRAIN_INTERVAL_MS &&
    control.bridgeDeployedAtMs <= control.sourceFirstExportedAtMs
  );
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
      if (operation.kind === "recover-import") {
        if (control.importAttemptId !== operation.importAttemptId)
          throw new Error("wager reservation import attempt was not found");
        if (
          dependencies.readAdmissions().length !== 0 ||
          dependencies.activeGameplayLeases(nowMs) !== 0
        )
          throw new Error(
            "reservation writers are not drained for import recovery",
          );
        if (!dependencies.recoverImport(control, nowMs))
          throw new Error("wager reservation import recovery conflicted");
        control = dependencies.readControl();
      } else {
        const admission = dependencies
          .readAdmissions()
          .find((entry) => entry.admissionId === operation.admissionId);
        if (!admission)
          throw new Error("wager reservation admission was not found");
        if (admission.expiresAtMs > nowMs)
          throw new Error("wager reservation admission has not expired");
        if (!dependencies.recoverAdmission(admission, nowMs))
          throw new Error("wager reservation admission recovery conflicted");
      }
    } else {
      const next: Control = { ...control, updatedAtMs: nowMs };
      if (operation === "freeze") {
        if (control.storageMode !== "frozen") {
          next.previousStorageMode = control.storageMode;
          next.storageMode = "frozen";
          next.freezeGeneration += 1;
          next.verifiedImportGeneration = null;
        }
      } else {
        if (control.importAttemptId !== null)
          throw new Error("wager reservation import is still active");
        if (dependencies.readAdmissions().length !== 0)
          throw new Error("wager reservation writers are not drained");
        if (dependencies.activeGameplayLeases(nowMs) !== 0)
          throw new Error("gameplay mutation leases are not drained");
        if (operation === "return-to-firebase") {
          if (
            control.activatedAtMs !== null ||
            (control.storageMode !== "firebase" &&
              control.previousStorageMode !== "firebase")
          )
            throw new Error(
              "activated wager reservations cannot return to Firebase",
            );
          next.storageMode = "firebase";
          next.previousStorageMode = null;
          next.verifiedImportGeneration = null;
        } else if (operation === "activate-d1") {
          if (control.storageMode !== "d1") {
            if (!hasVerifiedImport(control, nowMs))
              throw new Error("wager reservation import is not verified");
            const deployment = dependencies.readDeployment();
            if (
              deployment.versionId !== control.bridgeVersionId ||
              deployment.deployedAtMs !== control.bridgeDeployedAtMs
            )
              throw new Error("verified bridge deployment changed");
            next.storageMode = "d1";
            next.previousStorageMode = null;
            next.activatedAtMs = nowMs;
          }
        } else if (operation === "resume-d1") {
          if (
            control.activatedAtMs === null ||
            (control.storageMode !== "d1" &&
              control.previousStorageMode !== "d1")
          )
            throw new Error("wager reservation D1 storage is not activated");
          next.storageMode = "d1";
          next.previousStorageMode = null;
        }
      }
      if (
        next.storageMode !== control.storageMode ||
        next.previousStorageMode !== control.previousStorageMode ||
        next.activatedAtMs !== control.activatedAtMs
      ) {
        dependencies.updateControl(control, next);
        control = dependencies.readControl();
        if (
          control.storageMode !== next.storageMode ||
          control.previousStorageMode !== next.previousStorageMode ||
          control.freezeGeneration !== next.freezeGeneration ||
          control.activatedAtMs !== next.activatedAtMs
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

function parseDeployment(value: unknown): Deployment {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("missing bridge deployment");
  const deployments = value
    .map((entry) => {
      const deployment = record(entry);
      const deployedAtMs = Date.parse(String(deployment?.created_on));
      if (
        !deployment ||
        !integer(deployedAtMs) ||
        !Array.isArray(deployment.versions)
      )
        throw new Error("invalid bridge deployment");
      return { deployment, deployedAtMs };
    })
    .sort((left, right) => right.deployedAtMs - left.deployedAtMs);
  const latest = deployments[0];
  const versions = latest.deployment.versions as unknown[];
  const version = record(versions[0]);
  if (
    versions.length !== 1 ||
    !version ||
    version.percentage !== 100 ||
    !validIdentifier(version.version_id)
  )
    throw new Error("bridge must serve 100 percent of Worker traffic");
  return { versionId: version.version_id, deployedAtMs: latest.deployedAtMs };
}

function readDeployment(): Deployment {
  return parseDeployment(
    JSON.parse(
      runTool(
        resolve("node_modules/.bin/wrangler"),
        wranglerArgs(["deployments", "list", "--json"]),
      ),
    ),
  );
}

function updateRemoteControl(expected: Control, next: Control): void {
  const rows = d1Rows(
    `UPDATE wager_reservation_runtime_control SET storage_mode = '${next.storageMode}', previous_storage_mode = ${next.previousStorageMode === null ? "NULL" : `'${next.previousStorageMode}'`}, freeze_generation = ${next.freezeGeneration}, activated_at_ms = ${next.activatedAtMs ?? "NULL"}, verified_import_generation = ${next.verifiedImportGeneration ?? "NULL"}, updated_at_ms = ${next.updatedAtMs} WHERE singleton = 1 AND storage_mode = '${expected.storageMode}' AND previous_storage_mode IS ${expected.previousStorageMode === null ? "NULL" : `'${expected.previousStorageMode}'`} AND freeze_generation = ${expected.freezeGeneration} AND updated_at_ms = ${expected.updatedAtMs} AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen') RETURNING singleton`,
  );
  if (rows.length !== 1)
    throw new Error("wager reservation control update conflicted");
}

function recoverRemoteAdmission(admission: Admission, nowMs: number): boolean {
  const rows = d1Rows(
    `DELETE FROM wager_reservation_write_admissions WHERE admission_id = ${sqlText(admission.admissionId)} AND storage_mode = '${admission.storageMode}' AND freeze_generation = ${admission.freezeGeneration} AND created_at_ms = ${admission.createdAtMs} AND expires_at_ms = ${admission.expiresAtMs} AND uncertain = ${Number(admission.uncertain)} AND expires_at_ms <= ${nowMs} AND EXISTS (SELECT 1 FROM wager_reservation_runtime_control WHERE singleton = 1 AND storage_mode = 'frozen') AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen') RETURNING admission_id`,
  );
  return rows.length === 1;
}

function recoverRemoteImport(control: Control, nowMs: number): boolean {
  if (!control.importAttemptId) return false;
  return (
    d1Rows(
      `UPDATE wager_reservation_runtime_control SET import_attempt_id = NULL, import_started_at_ms = NULL, verified_import_generation = NULL, source_digest = NULL, updated_at_ms = ${nowMs} WHERE singleton = 1 AND storage_mode = 'frozen' AND previous_storage_mode = 'firebase' AND activated_at_ms IS NULL AND freeze_generation = ${control.freezeGeneration} AND import_attempt_id = ${sqlText(control.importAttemptId)} AND NOT EXISTS (SELECT 1 FROM wager_reservation_write_admissions) AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen') RETURNING singleton`,
    ).length === 1
  );
}

function execute(argv = process.argv.slice(2)): void {
  manageWagerReservations(parseArgs(argv), {
    now: Date.now,
    log: console.log,
    readControl: readRemoteControl,
    readCanonicalState,
    readAdmissions: readRemoteAdmissions,
    activeGameplayLeases,
    readDeployment,
    updateControl: updateRemoteControl,
    recoverAdmission: recoverRemoteAdmission,
    recoverImport: recoverRemoteImport,
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
  activeGameplayLeases,
  d1Rows,
  execute,
  hasVerifiedImport,
  integer,
  manageWagerReservations,
  parseAdmission,
  parseArgs,
  parseControl,
  parseDeployment,
  QUEUE_DRAIN_INTERVAL_MS,
  readCanonicalState,
  readDeployment,
  readRemoteAdmissions,
  readRemoteControl,
  record,
  runTool,
  SOURCE_QUIET_INTERVAL_MS,
  sqlText,
  validIdentifier,
  wranglerArgs,
  type Admission,
  type Control,
  type Dependencies,
  type Deployment,
  type JsonRecord,
  type Operation,
};
