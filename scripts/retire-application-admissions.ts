import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_API_CONFIG,
  resolveD1Coordinates,
} from "./operator/configuration.ts";
import {
  privateDirectory,
  readPrivateJson,
  writePrivateImmutable,
} from "./operator/runtime.ts";
import { openRemoteD1Transport } from "./operator/remoteMaintenanceBinding.ts";
import {
  executeAdmissionRetirement,
  parseAdmissionRetirementManifest,
  RETIREMENT_BINDINGS,
  RETIREMENT_MIGRATIONS,
  type RetirementBinding,
  type RetirementOperation,
  type RetirementSchemaEntry,
} from "./operator/applicationAdmissionRetirement.ts";

export function parseAdmissionRetirementArgs(argv: string[]): {
  operation: RetirementOperation;
  manifest: string;
  manifestSha256: string;
  directory: string;
} {
  const operation = argv[0]?.slice(2);
  if (
    argv.length !== 7 ||
    argv[0] !== `--${operation}` ||
    !["inspect", "arm-central", "arm-replicas", "finalize"].includes(
      operation || "",
    ) ||
    argv[1] !== "--manifest" ||
    argv[3] !== "--manifest-sha256" ||
    argv[5] !== "--directory" ||
    !isAbsolute(argv[2] || "") ||
    !isAbsolute(argv[6] || "") ||
    !/^[a-f0-9]{64}$/.test(argv[4] || "")
  )
    throw new Error("admission-retirement-invalid-arguments");
  return {
    operation: operation as RetirementOperation,
    manifest: argv[2]!,
    manifestSha256: argv[4]!,
    directory: argv[6]!,
  };
}
export function admissionRetirementSchema(
  binding: RetirementBinding,
): RetirementSchemaEntry[] {
  const sql = readFileSync(
    resolve(
      import.meta.dirname,
      "../cloud/workers/api",
      RETIREMENT_MIGRATIONS[binding],
    ),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE TABLE application_write_context (singleton INTEGER PRIMARY KEY, generation INTEGER, data_epoch INTEGER, operation_id TEXT, migration_id TEXT); CREATE TABLE application_data_admissions (operation_id TEXT PRIMARY KEY, generation INTEGER, data_epoch INTEGER, kind TEXT, started_at_ms INTEGER, status TEXT, failure_code TEXT, parent_operation_id TEXT)",
    );
    database.exec(sql);
    return database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('application_write_context', 'application_data_admissions') ORDER BY name",
      )
      .all() as RetirementSchemaEntry[];
  } finally {
    database.close();
  }
}
export async function retireApplicationAdmissions(
  argv = process.argv.slice(2),
): Promise<void> {
  process.umask(0o077);
  const args = parseAdmissionRetirementArgs(argv);
  const hash = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const manifest = parseAdmissionRetirementManifest(
    readPrivateJson(args.manifest, { maximumBytes: 64 * 1024 }),
  );
  if (hash(args.manifest) !== args.manifestSha256)
    throw new Error("admission-retirement-manifest-changed");
  if (existsSync(args.directory))
    throw new Error("admission-retirement-output-exists");
  const directory = privateDirectory(args.directory),
    configSha256 = hash(DEFAULT_API_CONFIG);
  for (const binding of RETIREMENT_BINDINGS) {
    const actual = resolveD1Coordinates(binding),
      expected = manifest.databases.find((row) => row.binding === binding)!;
    if (
      actual.databaseId !== expected.databaseId ||
      actual.accountId !== manifest.accountId
    )
      throw new Error("admission-retirement-config-identity");
  }
  const schemas = Object.fromEntries(
    RETIREMENT_BINDINGS.map((binding) => [
      binding,
      admissionRetirementSchema(binding),
    ]),
  ) as Record<RetirementBinding, RetirementSchemaEntry[]>;
  const sessions = new Map<
    RetirementBinding,
    Awaited<ReturnType<typeof openRemoteD1Transport>>
  >();
  let sequence = 0,
    result: Awaited<ReturnType<typeof executeAdmissionRetirement>> | undefined,
    failure = false;
  const record = (value: Record<string, unknown>) =>
    writePrivateImmutable(
      resolve(directory, String(++sequence).padStart(3, "0") + ".json"),
      { schemaVersion: 1, at: new Date().toISOString(), ...value },
    );
  const pin = () => {
    if (
      hash(DEFAULT_API_CONFIG) !== configSha256 ||
      hash(args.manifest) !== args.manifestSha256
    )
      throw new Error("admission-retirement-input-changed");
  };
  record({
    kind: "operation-intent",
    operation: args.operation,
    manifest,
    manifestSha256: args.manifestSha256,
    configSha256,
    schemas,
    ownRpcAdmissionCreated: false,
    applicationControlChanges: false,
    queuePauses: false,
  });
  try {
    result = await executeAdmissionRetirement(args.operation, manifest, {
      now: Date.now,
      expectedSchema: (binding) => schemas[binding],
      record,
      async transport(binding) {
        pin();
        let session = sessions.get(binding);
        if (!session) {
          session = await openRemoteD1Transport(binding);
          sessions.set(binding, session);
        }
        pin();
        return session.transport;
      },
    });
    pin();
    record({ kind: "operation-result", result });
  } catch {
    failure = true;
    record({
      kind: "operation-unconfirmed",
      automaticMutationRetry: false,
      instruction:
        "Read existing receipts and exact rows before another mutation; preserve any installed tombstones.",
    });
  } finally {
    const disposed = await Promise.allSettled(
      [...sessions.values()].map((session) => session.dispose()),
    );
    if (disposed.some((item) => item.status !== "fulfilled")) failure = true;
    writePrivateImmutable(resolve(directory, "complete.json"), {
      schemaVersion: 1,
      passed: !failure,
      operation: args.operation,
      retirementId: manifest.retirementId,
      manifestSha256: args.manifestSha256,
      mutationsConfirmed: result?.confirmed ?? false,
      sessionDisposalConfirmed: disposed.every(
        (item) => item.status === "fulfilled",
      ),
      result: result ?? null,
      completedAt: new Date().toISOString(),
    });
  }
  console.log(
    JSON.stringify({
      operation: args.operation,
      passed: !failure,
      retirementId: manifest.retirementId,
      receiptDirectory: directory,
    }),
  );
  if (failure)
    throw new Error("admission-retirement-unconfirmed-see-protected-evidence");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  retireApplicationAdmissions().catch((error) => {
    console.error(
      error instanceof Error &&
        error.message.startsWith("admission-retirement-")
        ? error.message
        : "admission-retirement-failed",
    );
    process.exitCode = 1;
  });
