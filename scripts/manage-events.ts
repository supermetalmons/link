import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;
type StorageMode = "firebase" | "frozen" | "d1";
type PreviousStorageMode = "firebase" | "d1" | null;
type StorageManagementOperation =
  "status" | "freeze" | "return-to-firebase" | "activate-d1" | "resume-d1";
type RecoverStaleAdmissionOperation = {
  admissionId: string;
  kind: "recover-stale-admission";
};
type ManagementOperation =
  StorageManagementOperation | RecoverStaleAdmissionOperation;

type EventWriteAdmissionStatus = {
  admissionId: string;
  admittedStorageMode: "firebase" | "d1";
  createdAtMs: number;
  expired: boolean;
  expiresAtMs: number;
};

type PendingEventTransitionStatus = {
  applicationLeaseExpiresAtMs: number | null;
  attempts: number;
  createdAtMs: number;
  eventId: string;
  expectedRevision: number;
  lastError: string | null;
  transitionId: string;
  updatedAtMs: number;
};

type EventControl = {
  cutoverAtMs: number | null;
  freezeGeneration: number;
  previousStorageMode: PreviousStorageMode;
  sourceAssignedPrizeCount: number | null;
  sourceDigest: string | null;
  sourceEventCount: number | null;
  sourceExportedAtMs: number | null;
  sourceSelectionCount: number | null;
  storageMode: StorageMode;
  verifiedImportGeneration: number | null;
};

type ManagementDependencies = {
  writeAdmissions(): number;
  activeLeases(nowMs: number): number;
  listPendingTransitions(): PendingEventTransitionStatus[];
  listWriteAdmissions(nowMs: number): EventWriteAdmissionStatus[];
  log(message: string): void;
  now(): number;
  readControl(): EventControl;
  recoverStaleAdmission(
    admission: EventWriteAdmissionStatus,
    nowMs: number,
  ): boolean;
  updateControl(input: {
    cutoverAtMs: number | null | undefined;
    expected: EventControl;
    nextPreviousStorageMode: PreviousStorageMode;
    nextStorageMode: StorageMode;
    updatedAtMs: number;
  }): void;
};

const DATABASE = "mons-link-events";
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV_PATH = "cloud/workers/api/release.env";

function validAdmissionId(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const bytes = new TextEncoder().encode(value).byteLength;
  return (
    bytes > 0 &&
    bytes <= 768 &&
    ![".", "#", "$", "/", "[", "]"].some((character) =>
      value.includes(character),
    ) &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) || 0;
      return code > 0x1f && code !== 0x7f;
    })
  );
}

function parseArgs(argv: string[]): ManagementOperation {
  if (argv[0] === "--recover-stale-admission") {
    if (argv.length !== 2 || !validAdmissionId(argv[1])) {
      throw new TypeError(
        "--recover-stale-admission requires one valid admission ID",
      );
    }
    return { kind: "recover-stale-admission", admissionId: argv[1] };
  }
  if (argv.length !== 1) {
    throw new TypeError("choose exactly one event storage control operation");
  }
  const operation = argv[0]?.replace(/^--/, "") as StorageManagementOperation;
  if (
    operation !== "status" &&
    operation !== "freeze" &&
    operation !== "return-to-firebase" &&
    operation !== "activate-d1" &&
    operation !== "resume-d1"
  ) {
    throw new TypeError("choose exactly one event storage control operation");
  }
  return operation;
}

function sameMode(
  control: EventControl,
  storageMode: StorageMode,
  previousStorageMode: PreviousStorageMode,
): boolean {
  return (
    control.storageMode === storageMode &&
    control.previousStorageMode === previousStorageMode
  );
}

function hasVerifiedImport(control: EventControl): boolean {
  return (
    control.storageMode === "frozen" &&
    control.previousStorageMode === "firebase" &&
    control.freezeGeneration > 0 &&
    control.verifiedImportGeneration === control.freezeGeneration &&
    /^[0-9a-f]{64}$/.test(control.sourceDigest || "") &&
    typeof control.sourceExportedAtMs === "number" &&
    Number.isSafeInteger(control.sourceExportedAtMs) &&
    control.sourceExportedAtMs > 0
  );
}

function targetFor(
  operation: Exclude<StorageManagementOperation, "status">,
  control: EventControl,
): {
  cutoverAtMs: number | null | undefined;
  previousStorageMode: PreviousStorageMode;
  storageMode: StorageMode;
} {
  if (operation === "freeze") {
    if (sameMode(control, "firebase", null)) {
      return {
        storageMode: "frozen",
        previousStorageMode: "firebase",
        cutoverAtMs: undefined,
      };
    }
    if (sameMode(control, "d1", null)) {
      return {
        storageMode: "frozen",
        previousStorageMode: "d1",
        cutoverAtMs: undefined,
      };
    }
    if (control.storageMode === "frozen") {
      return {
        storageMode: "frozen",
        previousStorageMode: control.previousStorageMode,
        cutoverAtMs: undefined,
      };
    }
  }
  if (operation === "return-to-firebase") {
    if (
      sameMode(control, "firebase", null) ||
      sameMode(control, "frozen", "firebase")
    ) {
      return {
        storageMode: "firebase",
        previousStorageMode: null,
        cutoverAtMs: null,
      };
    }
  }
  if (operation === "activate-d1") {
    if (
      sameMode(control, "d1", null) ||
      sameMode(control, "frozen", "firebase")
    ) {
      return {
        storageMode: "d1",
        previousStorageMode: null,
        cutoverAtMs: control.cutoverAtMs,
      };
    }
  }
  if (operation === "resume-d1") {
    if (sameMode(control, "d1", null) || sameMode(control, "frozen", "d1")) {
      return {
        storageMode: "d1",
        previousStorageMode: null,
        cutoverAtMs: undefined,
      };
    }
  }
  throw new Error("event storage control transition rejected");
}

function manageEvents(
  operation: ManagementOperation,
  dependencies: ManagementDependencies,
): void {
  let control = dependencies.readControl();
  const nowMs = dependencies.now();
  let recoveredAdmissionId: string | undefined;
  if (typeof operation !== "string") {
    const admission = dependencies
      .listWriteAdmissions(nowMs)
      .find((candidate) => candidate.admissionId === operation.admissionId);
    if (!admission) {
      throw new Error("event write admission was not found");
    }
    if (!admission.expired) {
      throw new Error("event write admission has not expired");
    }
    if (!dependencies.recoverStaleAdmission(admission, nowMs)) {
      throw new Error("event write admission recovery conflicted");
    }
    recoveredAdmissionId = admission.admissionId;
  } else if (operation !== "status") {
    const target = targetFor(operation, control);
    if (
      operation === "freeze" &&
      control.storageMode !== "frozen" &&
      dependencies.writeAdmissions() !== 0
    ) {
      throw new Error("event storage freeze has write admissions");
    }
    if (operation === "activate-d1" && !sameMode(control, "d1", null)) {
      if (!hasVerifiedImport(control)) {
        throw new Error("event D1 activation verification failed");
      }
      if (dependencies.writeAdmissions() !== 0) {
        throw new Error("event D1 activation has write admissions");
      }
      if (dependencies.activeLeases(nowMs) !== 0) {
        throw new Error("event D1 activation has active leases");
      }
      if (control.cutoverAtMs === null) target.cutoverAtMs = nowMs;
    }
    if (
      !sameMode(control, target.storageMode, target.previousStorageMode) ||
      (target.cutoverAtMs !== undefined &&
        target.cutoverAtMs !== control.cutoverAtMs)
    ) {
      dependencies.updateControl({
        expected: control,
        nextStorageMode: target.storageMode,
        nextPreviousStorageMode: target.previousStorageMode,
        cutoverAtMs: target.cutoverAtMs,
        updatedAtMs: nowMs,
      });
      control = dependencies.readControl();
      if (
        !sameMode(control, target.storageMode, target.previousStorageMode) ||
        (target.cutoverAtMs !== undefined &&
          target.cutoverAtMs !== control.cutoverAtMs)
      ) {
        throw new Error("event storage control transition failed");
      }
    }
  }
  dependencies.log(
    JSON.stringify({
      operation: typeof operation === "string" ? operation : operation.kind,
      ...(recoveredAdmissionId ? { recoveredAdmissionId } : {}),
      storageMode: control.storageMode,
      previousStorageMode: control.previousStorageMode,
      freezeGeneration: control.freezeGeneration,
      sourceDigest: control.sourceDigest,
      sourceEventCount: control.sourceEventCount,
      sourceSelectionCount: control.sourceSelectionCount,
      sourceAssignedPrizeCount: control.sourceAssignedPrizeCount,
      sourceExportedAtMs: control.sourceExportedAtMs,
      verifiedImportGeneration: control.verifiedImportGeneration,
      cutoverAtMs: control.cutoverAtMs,
      writeAdmissions: dependencies.writeAdmissions(),
      writeAdmissionRows: dependencies.listWriteAdmissions(nowMs),
      pendingTransitions: dependencies.listPendingTransitions(),
      d1ActiveLeases: dependencies.activeLeases(nowMs),
    }),
  );
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function runWrangler(command: string): JsonRecord[] {
  const result = spawnSync(
    resolve("node_modules/.bin/wrangler"),
    [
      "d1",
      "execute",
      DATABASE,
      "--remote",
      "--config",
      CONFIG_PATH,
      "--env-file",
      RELEASE_ENV_PATH,
      "--command",
      command,
      "--json",
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    },
  );
  if (result.status !== 0) throw new Error("wrangler command failed");
  const parsed = JSON.parse(String(result.stdout)) as unknown;
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

function optionalCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid event control count");
  }
  return count;
}

function optionalTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error("invalid event control timestamp");
  }
  return timestamp;
}

function readRemoteControl(): EventControl {
  const row = runWrangler(
    "SELECT storage_mode, previous_storage_mode, freeze_generation, verified_import_generation, source_digest, source_event_count, source_selection_count, source_assignment_count, source_exported_at_ms, cutover_at_ms FROM event_runtime_control WHERE singleton = 1",
  )[0];
  const storageMode = row?.storage_mode;
  const previous = row?.previous_storage_mode;
  const sourceDigest = row?.source_digest;
  if (
    (storageMode !== "firebase" &&
      storageMode !== "frozen" &&
      storageMode !== "d1") ||
    (previous !== null &&
      previous !== undefined &&
      previous !== "firebase" &&
      previous !== "d1") ||
    (sourceDigest !== null &&
      sourceDigest !== undefined &&
      (typeof sourceDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(sourceDigest)))
  ) {
    throw new Error("invalid event storage control");
  }
  return {
    storageMode,
    previousStorageMode: previous === undefined ? null : previous,
    freezeGeneration: optionalCount(row.freeze_generation) || 0,
    sourceDigest:
      sourceDigest === undefined || sourceDigest === null ? null : sourceDigest,
    sourceEventCount: optionalCount(row.source_event_count),
    sourceSelectionCount: optionalCount(row.source_selection_count),
    sourceAssignedPrizeCount: optionalCount(row.source_assignment_count),
    sourceExportedAtMs: optionalTimestamp(row.source_exported_at_ms),
    verifiedImportGeneration: optionalCount(row.verified_import_generation),
    cutoverAtMs: optionalTimestamp(row.cutover_at_ms),
  };
}

function sqlValue(value: string | null): string {
  return value === null ? "NULL" : `'${value}'`;
}

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function updateRemoteControl({
  cutoverAtMs,
  expected,
  nextPreviousStorageMode,
  nextStorageMode,
  updatedAtMs,
}: Parameters<ManagementDependencies["updateControl"]>[0]): void {
  const cutover =
    cutoverAtMs === undefined
      ? "cutover_at_ms"
      : cutoverAtMs === null
        ? "NULL"
        : String(cutoverAtMs);
  runWrangler(
    `UPDATE event_runtime_control SET storage_mode = '${nextStorageMode}', previous_storage_mode = ${sqlValue(nextPreviousStorageMode)}, cutover_at_ms = ${cutover}, freeze_generation = CASE WHEN storage_mode != 'frozen' AND '${nextStorageMode}' = 'frozen' THEN freeze_generation + 1 ELSE freeze_generation END, verified_import_generation = CASE WHEN storage_mode != 'frozen' AND '${nextStorageMode}' = 'frozen' THEN NULL WHEN storage_mode = 'frozen' AND previous_storage_mode = 'firebase' AND '${nextStorageMode}' = 'firebase' THEN NULL ELSE verified_import_generation END, updated_at_ms = ${updatedAtMs} WHERE singleton = 1 AND storage_mode = '${expected.storageMode}' AND previous_storage_mode IS ${sqlValue(expected.previousStorageMode)} AND freeze_generation = ${expected.freezeGeneration}`,
  );
}

function readWriteAdmissions(): number {
  const count = Number(
    runWrangler(
      "SELECT COUNT(*) AS write_admissions FROM event_write_admissions",
    )[0]?.write_admissions,
  );
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid event write admission count");
  }
  return count;
}

function readWriteAdmissionRows(_nowMs: number): EventWriteAdmissionStatus[] {
  const rows = runWrangler(
    "SELECT admission_id, admitted_storage_mode, created_at_ms, expires_at_ms, CASE WHEN expires_at_ms <= unixepoch() * 1000 THEN 1 ELSE 0 END AS expired FROM event_write_admissions ORDER BY created_at_ms, admission_id",
  );
  return rows.map((row) => {
    const admissionId = row.admission_id;
    const admittedStorageMode = row.admitted_storage_mode;
    const createdAtMs = Number(row.created_at_ms);
    const expiresAtMs = Number(row.expires_at_ms);
    const expired = Number(row.expired);
    if (
      !validAdmissionId(admissionId) ||
      (admittedStorageMode !== "firebase" && admittedStorageMode !== "d1") ||
      !Number.isSafeInteger(createdAtMs) ||
      createdAtMs < 0 ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= createdAtMs ||
      (expired !== 0 && expired !== 1)
    ) {
      throw new Error("invalid event write admission");
    }
    return {
      admissionId,
      admittedStorageMode,
      createdAtMs,
      expiresAtMs,
      expired: expired === 1,
    };
  });
}

function recoverRemoteStaleAdmission(
  admission: EventWriteAdmissionStatus,
  _nowMs: number,
): boolean {
  const rows = runWrangler(
    `DELETE FROM event_write_admissions WHERE admission_id = ${sqlText(admission.admissionId)} AND admitted_storage_mode = '${admission.admittedStorageMode}' AND created_at_ms = ${admission.createdAtMs} AND expires_at_ms = ${admission.expiresAtMs} AND expires_at_ms <= unixepoch() * 1000 RETURNING admission_id`,
  );
  return rows.length === 1 && rows[0]?.admission_id === admission.admissionId;
}

function readPendingTransitionRows(): PendingEventTransitionStatus[] {
  return runWrangler(
    `SELECT intent.transition_id, intent.event_id, intent.expected_revision,
            intent.attempts, intent.last_error, intent.created_at_ms,
            intent.updated_at_ms,
            lease.expires_at_ms AS application_lease_expires_at_ms
     FROM event_transition_intents AS intent
     LEFT JOIN event_leases AS lease
       ON lease.event_id = 'transition:' || intent.transition_id
     WHERE intent.status = 'pending'
     ORDER BY intent.updated_at_ms, intent.transition_id`,
  ).map((row) => {
    const transitionId = row.transition_id;
    const eventId = row.event_id;
    const expectedRevision = Number(row.expected_revision);
    const attempts = Number(row.attempts);
    const createdAtMs = Number(row.created_at_ms);
    const updatedAtMs = Number(row.updated_at_ms);
    const applicationLeaseExpiresAtMs = optionalTimestamp(
      row.application_lease_expires_at_ms,
    );
    const lastError = row.last_error;
    if (
      !validAdmissionId(transitionId) ||
      !validAdmissionId(eventId) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      !Number.isSafeInteger(attempts) ||
      attempts < 0 ||
      !Number.isSafeInteger(createdAtMs) ||
      createdAtMs < 0 ||
      !Number.isSafeInteger(updatedAtMs) ||
      updatedAtMs < createdAtMs ||
      (lastError !== null &&
        lastError !== undefined &&
        typeof lastError !== "string")
    ) {
      throw new Error("invalid pending event transition");
    }
    return {
      transitionId,
      eventId,
      expectedRevision,
      attempts,
      createdAtMs,
      updatedAtMs,
      lastError: typeof lastError === "string" ? lastError : null,
      applicationLeaseExpiresAtMs,
    };
  });
}

function readActiveLeases(nowMs: number): number {
  const count = Number(
    runWrangler(
      `SELECT COUNT(*) AS active_leases FROM event_leases WHERE expires_at_ms > ${nowMs}`,
    )[0]?.active_leases,
  );
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid event lease count");
  }
  return count;
}

function execute(argv = process.argv.slice(2)): void {
  manageEvents(parseArgs(argv), {
    activeLeases: readActiveLeases,
    listPendingTransitions: readPendingTransitionRows,
    listWriteAdmissions: readWriteAdmissionRows,
    log: console.log,
    now: Date.now,
    readControl: readRemoteControl,
    recoverStaleAdmission: recoverRemoteStaleAdmission,
    updateControl: updateRemoteControl,
    writeAdmissions: readWriteAdmissions,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    execute();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "management failed");
    process.exitCode = 1;
  }
}

export {
  execute,
  hasVerifiedImport,
  manageEvents,
  parseArgs,
  targetFor,
  type EventControl,
  type EventWriteAdmissionStatus,
  type ManagementDependencies,
  type ManagementOperation,
  type PendingEventTransitionStatus,
};
