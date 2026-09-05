import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;
type StorageMode = "frozen" | "d1";
type StorageManagementOperation = "status" | "freeze" | "resume-d1";
type RecoverStaleAdmissionOperation = {
  admissionId: string;
  kind: "recover-stale-admission";
};
type ManagementOperation =
  StorageManagementOperation | RecoverStaleAdmissionOperation;

type EventWriteAdmissionStatus = {
  admissionId: string;
  freezeGeneration: number;
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
  freezeGeneration: number;
  storageMode: StorageMode;
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
    expected: EventControl;
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
    operation !== "resume-d1"
  ) {
    throw new TypeError("choose exactly one event storage control operation");
  }
  return operation;
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
    const nextStorageMode = operation === "freeze" ? "frozen" : "d1";
    if (control.storageMode !== nextStorageMode) {
      if (dependencies.writeAdmissions() !== 0) {
        throw new Error("event storage transition has write admissions");
      }
      const nextGeneration =
        control.freezeGeneration + Number(nextStorageMode === "frozen");
      dependencies.updateControl({
        expected: control,
        nextStorageMode,
        updatedAtMs: nowMs,
      });
      control = dependencies.readControl();
      if (
        control.storageMode !== nextStorageMode ||
        control.freezeGeneration !== nextGeneration
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
      freezeGeneration: control.freezeGeneration,
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
    "SELECT storage_mode, freeze_generation FROM event_runtime_control WHERE singleton = 1",
  )[0];
  const storageMode = row?.storage_mode;
  const freezeGeneration = optionalCount(row?.freeze_generation);
  if (
    (storageMode !== "frozen" && storageMode !== "d1") ||
    freezeGeneration === null
  ) {
    throw new Error("invalid event storage control");
  }
  return { storageMode, freezeGeneration };
}

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function updateRemoteControl({
  expected,
  nextStorageMode,
  updatedAtMs,
}: Parameters<ManagementDependencies["updateControl"]>[0]): void {
  runWrangler(
    `UPDATE event_runtime_control SET storage_mode = '${nextStorageMode}', freeze_generation = freeze_generation + ${Number(nextStorageMode === "frozen")}, updated_at_ms = ${updatedAtMs} WHERE singleton = 1 AND storage_mode = '${expected.storageMode}' AND freeze_generation = ${expected.freezeGeneration}`,
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
    "SELECT admission_id, freeze_generation, created_at_ms, expires_at_ms, CASE WHEN expires_at_ms <= unixepoch() * 1000 THEN 1 ELSE 0 END AS expired FROM event_write_admissions ORDER BY created_at_ms, admission_id",
  );
  return rows.map((row) => {
    const admissionId = row.admission_id;
    const freezeGeneration = Number(row.freeze_generation);
    const createdAtMs = Number(row.created_at_ms);
    const expiresAtMs = Number(row.expires_at_ms);
    const expired = Number(row.expired);
    if (
      !validAdmissionId(admissionId) ||
      !Number.isSafeInteger(freezeGeneration) ||
      freezeGeneration < 0 ||
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
      freezeGeneration,
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
    `DELETE FROM event_write_admissions WHERE admission_id = ${sqlText(admission.admissionId)} AND freeze_generation = ${admission.freezeGeneration} AND created_at_ms = ${admission.createdAtMs} AND expires_at_ms = ${admission.expiresAtMs} AND expires_at_ms <= unixepoch() * 1000 RETURNING admission_id`,
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
  manageEvents,
  parseArgs,
  type EventControl,
  type EventWriteAdmissionStatus,
  type ManagementDependencies,
  type ManagementOperation,
  type PendingEventTransitionStatus,
};
