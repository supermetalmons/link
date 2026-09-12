import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  canonicalJson,
  privateDirectory,
  readPrivateJson,
  writePrivateImmutable,
} from "../operator/runtime.ts";
import type { D1Binding } from "../operator/configuration.ts";
import type { DatabaseSchema, DatabaseDigest } from "./clone.ts";
import type { WorkflowHandoffManifest } from "./workflows.ts";

export const PHASES = [
  "preflight",
  "prepare",
  "quiesce",
  "copy",
  "verify",
  "cutover",
  "resume",
  "status",
] as const;
export type MigrationPhase = (typeof PHASES)[number];

export type DatabaseMigration = {
  binding: D1Binding;
  sourceId: string;
  sourceName: string;
  sourceRegion: string;
  destinationName: string;
  destinationId?: string;
  creationStartedAt?: string;
  schema?: DatabaseSchema;
  fenceTriggers?: string[];
  digest?: DatabaseDigest;
  copyStarted?: boolean;
  copied?: boolean;
};

export type MigrationManifest = {
  schemaVersion: 1;
  revision: number;
  previousDigest: string | null;
  runId: string;
  createdAt: string;
  accountId: string;
  workerName: string;
  originalVersionId: string;
  namespaceId: string;
  configuration: Record<string, unknown>;
  databases: DatabaseMigration[];
  workflows?: WorkflowHandoffManifest;
  queues: Array<Record<string, unknown>>;
  controls: Record<string, Record<string, unknown>[]>;
  phases: Partial<Record<MigrationPhase, string>>;
  versions: Partial<
    Record<
      "source-maintenance" | "destination-maintenance" | "destination-live",
      string
    >
  >;
  records: Record<string, unknown>;
};

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function manifestFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => /^manifest-\d{6}\.json$/.test(name))
    .sort();
}

export function loadManifest(directory: string): MigrationManifest | null {
  const files = manifestFiles(directory);
  let previous: MigrationManifest | null = null;
  for (const name of files) {
    const value = readPrivateJson(
      resolve(directory, name),
    ) as MigrationManifest;
    if (
      value.schemaVersion !== 1 ||
      value.revision !== (previous?.revision || 0) + 1 ||
      name !== `manifest-${String(value.revision).padStart(6, "0")}.json` ||
      value.previousDigest !== (previous ? hash(previous) : null) ||
      (previous && value.runId !== previous.runId)
    )
      throw new Error("migration manifest chain is invalid");
    previous = value;
  }
  return previous;
}

export function saveManifest(
  directory: string,
  manifest: MigrationManifest,
): void {
  const previous = loadManifest(directory);
  if (
    (previous &&
      (previous.revision !== manifest.revision ||
        previous.runId !== manifest.runId)) ||
    (!previous && (manifest.revision !== 0 || manifest.previousDigest !== null))
  )
    throw new Error("migration manifest changed concurrently");
  if (previous) {
    for (const key of [
      "accountId",
      "workerName",
      "originalVersionId",
      "namespaceId",
      "createdAt",
    ] as const)
      if (previous[key] !== manifest[key])
        throw new Error("migration manifest identity changed");
    if (
      canonicalJson(previous.configuration) !==
        canonicalJson(manifest.configuration) ||
      previous.databases.length !== manifest.databases.length
    )
      throw new Error("migration manifest source configuration changed");
    for (const source of previous.databases) {
      const current = manifest.databases.find(
        (db) => db.binding === source.binding,
      );
      if (
        !current ||
        current.sourceId !== source.sourceId ||
        current.sourceName !== source.sourceName ||
        current.destinationName !== source.destinationName ||
        (source.destinationId && current.destinationId !== source.destinationId)
      )
        throw new Error("migration manifest database identity changed");
    }
  }
  const next = {
    ...manifest,
    previousDigest: previous ? hash(previous) : null,
    revision: manifest.revision + 1,
  };
  writePrivateImmutable(
    resolve(
      directory,
      `manifest-${String(next.revision).padStart(6, "0")}.json`,
    ),
    next,
  );
  manifest.previousDigest = next.previousDigest;
  manifest.revision = next.revision;
}

export function openMigrationDirectory(path: string) {
  const directory = privateDirectory(path);
  const lockPath = resolve(directory, "operator.lock");
  if (existsSync(lockPath)) {
    const lock = readPrivateJson(lockPath) as { pid: number };
    if (!Number.isSafeInteger(lock.pid) || lock.pid < 1)
      throw new Error("invalid migration operator lock");
    try {
      process.kill(lock.pid, 0);
      throw new Error("another migration operator process is still running");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    throw new Error(
      "stale migration operator lock; verify the recorded process has finished before removing this lock",
    );
  }
  const lock = canonicalJson({ pid: process.pid, token: randomUUID() });
  const descriptor = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, lock);
  } finally {
    closeSync(descriptor);
  }
  return {
    directory,
    release() {
      if (readFileSync(lockPath, "utf8") !== lock)
        throw new Error("migration operator lock changed");
      unlinkSync(lockPath);
    },
  };
}

export function artifact(
  directory: string,
  name: string,
  value: unknown,
): void {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(name))
    throw new Error("invalid migration artifact name");
  writePrivateImmutable(resolve(directory, name), value);
}
