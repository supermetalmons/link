import { runGuardedOperatorSqlSync } from "./operator/guardedSql.ts";
import {
  DEFAULT_API_CONFIG,
  resolveD1Binding,
} from "./operator/configuration.ts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readStoredWithdrawalDocument } from "../cloud/runtime/eventPrizes/records.js";

type JsonRecord = Record<string, unknown>;
type ManagementOperation = "freeze" | "resume" | "status";
type DataEpoch = 1;
type WithdrawalSnapshot = Record<string, Record<string, JsonRecord>>;

type StorageControl = {
  previousStorageMode: "d1" | null;
  storageMode: "d1" | "frozen";
};

type ManagementDependencies = {
  log(message: string): void;
  now(): number;
  readControl(): StorageControl;
  readSnapshot(): WithdrawalSnapshot;
  updateMode(input: {
    expected: StorageControl;
    next: StorageControl;
    updatedAtMs: number;
  }): void;
};

const DATABASE = "mons-link-event-prize-withdrawals";
const CONFIG_PATH = DEFAULT_API_CONFIG;
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

function validKey(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    !value.includes("/")
  );
}

function normalizeSnapshot(value: unknown): WithdrawalSnapshot {
  const source = record(value);
  if (!source) throw new Error("invalid event prize withdrawal snapshot");
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

function parseArgs(argv: string[]): ManagementOperation {
  if (argv.length !== 1) {
    throw new TypeError(
      "choose exactly one of --status, --freeze, or --resume",
    );
  }
  if (argv[0] === "--status") return "status";
  if (argv[0] === "--freeze") return "freeze";
  if (argv[0] === "--resume") return "resume";
  throw new TypeError("choose exactly one of --status, --freeze, or --resume");
}

function parseManagementArgs(argv: string[]): {
  operation: ManagementOperation;
  dataEpoch: DataEpoch;
} {
  if (argv.length === 1) return { operation: parseArgs(argv), dataEpoch: 1 };
  if (argv.length !== 3 || argv[1] !== "--data-epoch" || argv[2] !== "1")
    throw new TypeError(
      "choose --status, --freeze, or --resume and optional --data-epoch 1",
    );
  return {
    operation: parseArgs(argv.slice(0, 1)),
    dataEpoch: 1,
  };
}

function withdrawalManagementTable(
  dataEpoch: DataEpoch,
): "event_prize_withdrawals_canonical" {
  if (dataEpoch !== 1) throw new TypeError("invalid-withdrawal-data-epoch");
  return "event_prize_withdrawals_canonical";
}

function sameControl(left: StorageControl, right: StorageControl): boolean {
  return (
    left.storageMode === right.storageMode &&
    left.previousStorageMode === right.previousStorageMode
  );
}

function manageEventPrizeWithdrawals(
  operation: ManagementOperation,
  dependencies: ManagementDependencies,
  dataEpoch: DataEpoch = 1,
): void {
  const current = dependencies.readControl();
  if (operation === "freeze") {
    const next = {
      storageMode: "frozen" as const,
      previousStorageMode: "d1" as const,
    };
    if (!sameControl(current, next)) {
      if (
        current.storageMode !== "d1" ||
        current.previousStorageMode !== null
      ) {
        throw new Error("event prize withdrawals cannot be frozen");
      }
      dependencies.updateMode({
        expected: current,
        next,
        updatedAtMs: dependencies.now(),
      });
    }
  } else if (operation === "resume") {
    const next = {
      storageMode: "d1" as const,
      previousStorageMode: null,
    };
    if (!sameControl(current, next)) {
      if (
        current.storageMode !== "frozen" ||
        current.previousStorageMode !== "d1"
      ) {
        throw new Error("event prize withdrawals cannot be resumed");
      }
      dependencies.updateMode({
        expected: current,
        next,
        updatedAtMs: dependencies.now(),
      });
    }
  }
  const control = dependencies.readControl();
  const summary = summarize(dependencies.readSnapshot(), dependencies.now());
  dependencies.log(
    JSON.stringify({ operation, dataEpoch, ...control, ...summary }),
  );
}

function runWrangler(args: string[]): JsonRecord[] {
  const result = spawnSync(
    resolve("node_modules/.bin/wrangler"),
    [
      "d1",
      "execute",
      resolveD1Binding(DATABASE),
      "--remote",
      "--config",
      CONFIG_PATH,
      "--env-file",
      RELEASE_ENV_PATH,
      ...args,
      "--json",
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    },
  );
  if (result.status !== 0) {
    throw new Error("wrangler command failed");
  }
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

function readRemoteControl(): StorageControl {
  const row = runWrangler([
    "--command",
    "SELECT storage_mode, previous_storage_mode FROM event_prize_withdrawal_runtime_control WHERE singleton = 1",
  ])[0];
  if (
    row?.storage_mode === "d1" &&
    (row.previous_storage_mode === null ||
      row.previous_storage_mode === undefined)
  ) {
    return { storageMode: "d1", previousStorageMode: null };
  }
  if (row?.storage_mode === "frozen" && row.previous_storage_mode === "d1") {
    return { storageMode: "frozen", previousStorageMode: "d1" };
  }
  throw new Error("invalid event prize withdrawal storage mode");
}

function readRemoteSnapshot(
  dataEpoch: DataEpoch,
  executeSql: typeof runWrangler = runWrangler,
): WithdrawalSnapshot {
  const snapshot: WithdrawalSnapshot = {};
  for (const row of executeSql([
    "--command",
    `SELECT event_id, prize_id, record_json FROM ${withdrawalManagementTable(dataEpoch)} ORDER BY event_id, prize_id`,
  ])) {
    const eventId = String(row.event_id);
    const prizeId = String(row.prize_id);
    const withdrawal = JSON.parse(String(row.record_json)) as unknown;
    if (!readStoredWithdrawalDocument(withdrawal))
      throw new Error("invalid canonical withdrawal record");
    snapshot[eventId] ||= {};
    snapshot[eventId][prizeId] = record(withdrawal) || {};
  }
  return normalizeSnapshot(snapshot);
}

function sqlValue(value: string | null): string {
  return value === null ? "NULL" : `'${value}'`;
}

function updateRemoteMode({
  expected,
  next,
  updatedAtMs,
}: {
  expected: StorageControl;
  next: StorageControl;
  updatedAtMs: number;
}): void {
  runGuardedOperatorSqlSync(
    `UPDATE event_prize_withdrawal_runtime_control SET storage_mode = '${next.storageMode}', previous_storage_mode = ${sqlValue(next.previousStorageMode)}, updated_at_ms = ${updatedAtMs} WHERE singleton = 1 AND storage_mode = '${expected.storageMode}' AND previous_storage_mode IS ${sqlValue(expected.previousStorageMode)}`,
    DATABASE,
  );
  const actual = readRemoteControl();
  if (!sameControl(actual, next)) {
    throw new Error("event prize withdrawal storage transition failed");
  }
}

function execute(argv = process.argv.slice(2)): void {
  const { operation, dataEpoch } = parseManagementArgs(argv);
  const table = withdrawalManagementTable(dataEpoch);
  const tables = runWrangler([
    "--command",
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('application_data_control', '${table}')`,
  ]);
  if (!tables.some((row) => row.name === table))
    throw new Error("selected withdrawal generation is unavailable");
  if (
    operation !== "status" &&
    tables.some((row) => row.name === "application_data_control")
  ) {
    const control = runWrangler([
      "--command",
      "SELECT data_epoch FROM application_data_control WHERE singleton = 1",
    ])[0];
    if (control?.data_epoch !== dataEpoch)
      throw new Error("withdrawal management generation mismatch");
  } else if (operation !== "status")
    throw new Error("canonical withdrawal control is unavailable");
  manageEventPrizeWithdrawals(
    operation,
    {
      log: console.log,
      now: Date.now,
      readControl: readRemoteControl,
      readSnapshot: () => readRemoteSnapshot(dataEpoch),
      updateMode: updateRemoteMode,
    },
    dataEpoch,
  );
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
  canonicalize,
  execute,
  manageEventPrizeWithdrawals,
  normalizeSnapshot,
  parseArgs,
  parseManagementArgs,
  withdrawalManagementTable,
  readRemoteSnapshot,
  snapshotDigest,
  summarize,
  type ManagementDependencies,
  type StorageControl,
  type WithdrawalSnapshot,
};
