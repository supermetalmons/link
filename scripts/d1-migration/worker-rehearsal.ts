import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  D1_BINDINGS,
  DEFAULT_API_CONFIG,
  type D1Binding,
} from "../operator/configuration.ts";
import {
  canonicalJson,
  privateDirectory,
  readPrivateJson,
  readResponseJson,
  writePrivateImmutable,
} from "../operator/runtime.ts";
import { captureSchema, type DatabaseSchema } from "./clone.ts";
import {
  apiRecord,
  CloudflareRequestFailure,
  type ApiRecord,
  type CloudflareProvider,
  type QueryParameter,
} from "./provider.ts";
import type { DatabaseMigration, MigrationManifest } from "./state.ts";
import {
  eventBookmarkConstraint,
  scopeEventBookmark,
} from "../../cloud/workers/api/src/eventBookmarks.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FENCE_PREFIX = "d1_migration_fence_";
const WORKFLOW_TAIL_STAGES = [
  "cleanup-delete-requested",
  "cleanup-deleted",
  "definition-delete-requested",
  "complete",
];

export type WorkerRehearsalEvidence = {
  formatVersion: 1;
  passed: true;
  resumed: boolean;
  attemptId?: string;
  workerName: string;
  namespaceId: string;
  versionId: string;
  url: string;
  retirementRequired: true;
  databases: Array<{
    binding: D1Binding;
    databaseId: string;
    schema: DatabaseSchema;
    fenceTriggers: string[];
  }>;
  barrier: ApiRecord;
  workflowHandoff: {
    workflowName: string;
    instanceId: string;
    params: ApiRecord;
    originalWorkerVersionId: string;
    replacementWorkerVersionId: string;
    originalWorkflowVersionId: string;
    replacementWorkflowVersionId: string;
    originalSleep: ApiRecord;
    recreatedSleep: ApiRecord;
    deleted: true;
  };
  bookmarkCompatibility: {
    sourceBinding: D1Binding;
    targetBinding: D1Binding;
    sourceDatabaseId: string;
    targetDatabaseId: string;
    sourceBookmark: string | null;
    targetBookmark: string | null;
    accepted: boolean | null;
    error?: string;
    recoveryVerified?: boolean;
    recoveryError?: string;
    recoveryChecks?: Array<{
      kind: string;
      constraint: string;
      nativeBookmark: string;
    }>;
  };
  checks: string[];
};

export type WorkerRehearsalOptions = {
  manifest: MigrationManifest;
  attemptId?: string;
  directory: string;
  provider: CloudflareProvider;
  runCommand: (
    label: string,
    executable: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ) => Promise<string>;
  persist?: () => Promise<void>;
  waitForPropagation?: (milliseconds: number) => Promise<void>;
};

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`Worker rehearsal missing ${name}`);
  return value;
}

function records(value: unknown): ApiRecord[] {
  if (!Array.isArray(value))
    throw new Error("Worker rehearsal expected an array");
  return value.map(apiRecord);
}

function quote(name: string): string {
  if (!name || name.includes("\0"))
    throw new Error("Worker rehearsal invalid schema identifier");
  return `"${name.replaceAll('"', '""')}"`;
}

function runtimeSourceEvidence(): {
  sha256: string;
  latestModifiedAtMs: number;
} {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        ["node_modules", ".cache", "test", "tests", "coverage"].includes(
          entry.name,
        )
      )
        continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        /\.(?:[cm]?[jt]s|json)$/.test(entry.name) &&
        !/\.test\./.test(entry.name)
      )
        files.push(path);
    }
  };
  visit(resolve(ROOT, "cloud/workers/api/src"));
  visit(resolve(ROOT, "cloud/runtime"));
  const digest = createHash("sha256");
  let latestModifiedAtMs = 0;
  for (const path of files.sort()) {
    digest.update(relative(ROOT, path));
    digest.update("\0");
    digest.update(readFileSync(path));
    digest.update("\0");
    latestModifiedAtMs = Math.max(latestModifiedAtMs, statSync(path).mtimeMs);
  }
  return { sha256: digest.digest("hex"), latestModifiedAtMs };
}

function privateText(path: string, text: string): void {
  if (existsSync(path)) {
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(descriptor);
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid?.() ||
        readFileSync(descriptor, "utf8") !== text
      )
        throw new Error("Worker rehearsal private artifact conflict");
    } finally {
      closeSync(descriptor);
    }
    return;
  }
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, text);
  } finally {
    closeSync(descriptor);
  }
}

function readyDestinations(
  manifest: MigrationManifest,
): Array<
  DatabaseMigration & { destinationId: string; schema: DatabaseSchema }
> {
  if (
    !manifest.phases.preflight ||
    ["quiesce", "copy", "verify", "cutover", "resume"].some((phase) =>
      Object.hasOwn(manifest.phases, phase),
    )
  )
    throw new Error("Worker rehearsal is allowed only before quiesce or copy");
  if (!UUID.test(manifest.runId) || manifest.workerName !== "mons-link-api")
    throw new Error("Worker rehearsal requires a canonical migration identity");
  const bindings = Object.values(D1_BINDINGS);
  if (
    manifest.databases.length !== bindings.length ||
    new Set(manifest.databases.map((db) => db.binding)).size !== bindings.length
  )
    throw new Error(
      "Worker rehearsal requires exactly six destination bindings",
    );
  const sources = new Set(manifest.databases.map((db) => db.sourceId));
  const destinations = new Set<string>();
  return manifest.databases.map((db) => {
    if (
      !bindings.includes(db.binding) ||
      !db.destinationId ||
      !UUID.test(db.destinationId) ||
      sources.has(db.destinationId) ||
      destinations.has(db.destinationId) ||
      !db.creationStartedAt ||
      db.copyStarted ||
      db.copied ||
      db.destinationName !== `${db.sourceName}-enam` ||
      !db.schema ||
      !db.schema.tables.some((table) => table.name === "d1_migrations")
    )
      throw new Error(
        "Worker rehearsal requires six owned never-live ENAM destinations",
      );
    destinations.add(db.destinationId);
    return { ...db, destinationId: db.destinationId, schema: db.schema };
  });
}

function frozenControl(value: ApiRecord): ApiRecord {
  const row = { ...value };
  const changed =
    (row.state !== undefined && row.state !== "frozen") ||
    (row.storage_mode !== undefined && row.storage_mode !== "frozen");
  if (row.state !== undefined) row.state = "frozen";
  if (row.storage_mode !== undefined) row.storage_mode = "frozen";
  if (Object.hasOwn(row, "previous_storage_mode"))
    row.previous_storage_mode = "d1";
  if (changed && row.freeze_generation !== undefined) {
    if (
      typeof row.freeze_generation !== "number" ||
      !Number.isSafeInteger(row.freeze_generation) ||
      row.freeze_generation < 0 ||
      row.freeze_generation === Number.MAX_SAFE_INTEGER
    )
      throw new Error("Worker rehearsal invalid freeze generation");
    row.freeze_generation++;
  }
  return row;
}

async function insertRows(
  provider: CloudflareProvider,
  databaseId: string,
  table: string,
  rows: ApiRecord[],
): Promise<void> {
  for (const row of rows) {
    const columns = Object.keys(row);
    if (!columns.length || columns.length > 100)
      throw new Error("Worker rehearsal invalid fixture columns");
    const params: QueryParameter[] = columns.map((column) => {
      const value = row[column];
      if (
        value === null ||
        typeof value === "string" ||
        (typeof value === "number" &&
          Number.isFinite(value) &&
          (!Number.isInteger(value) || Number.isSafeInteger(value)))
      )
        return value;
      throw new Error("Worker rehearsal fixture requires exact scalar values");
    });
    await provider.query(
      databaseId,
      `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      params,
    );
  }
}

async function deployedVersion(
  provider: CloudflareProvider,
  workerName: string,
): Promise<string> {
  const result = apiRecord(
    await provider.request(`workers/scripts/${workerName}/deployments`),
  );
  const deployment = records(result.deployments)[0];
  if (!deployment) throw new Error("Worker rehearsal deployment is absent");
  const versions = records(deployment.versions);
  if (
    versions.length !== 1 ||
    versions[0].percentage !== 100 ||
    !UUID.test(String(versions[0].version_id))
  )
    throw new Error(
      "Worker rehearsal requires an exact version at 100 percent",
    );
  return String(versions[0].version_id);
}

async function optionalResource(
  provider: CloudflareProvider,
  path: string,
): Promise<ApiRecord | null> {
  try {
    return apiRecord(await provider.request(path));
  } catch (error) {
    if (error instanceof CloudflareRequestFailure && error.status === 404)
      return null;
    throw error;
  }
}

async function boundedProgress<T>(
  operation: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  waitForPropagation: (milliseconds: number) => Promise<void> = delay,
): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const value = await read();
      if (ready(value)) return value;
    } catch (error) {
      if (
        !(error instanceof CloudflareRequestFailure) ||
        (error.status !== 429 && error.status < 500)
      )
        throw error;
    }
    if (attempt === 119 || Date.now() + 500 > deadline) break;
    await waitForPropagation(500);
  }
  throw new Error(
    `Worker rehearsal ${operation} remains pending; inspect the private stage journal`,
  );
}

async function rehearseWorkflow(options: {
  provider: CloudflareProvider;
  workerName: string;
  workflowName: string;
  originalWorkerVersionId: string;
  runId: string;
  directory: string;
  configuration: ApiRecord;
  commandEnv: NodeJS.ProcessEnv;
  wrangler: string;
  releaseEnv: string;
  runCommand: WorkerRehearsalOptions["runCommand"];
  waitForPropagation?: WorkerRehearsalOptions["waitForPropagation"];
  resumeInitialSleep?: boolean;
  progress: ApiRecord;
  persist: () => Promise<void>;
}): Promise<WorkerRehearsalEvidence["workflowHandoff"]> {
  const { provider, workerName, workflowName, progress, persist } = options;
  const readProgress = <T>(
    operation: string,
    read: () => Promise<T>,
    ready: (value: T) => boolean,
  ) => boundedProgress(operation, read, ready, options.waitForPropagation);
  if (
    workflowName !== `${workerName}-progress` ||
    !workerName.startsWith("mons-link-d1-enam-rehearsal-")
  )
    throw new Error("Worker rehearsal refuses an unowned Workflow");
  const path = `workflows/${workflowName}`;
  const savedJournal = options.resumeInitialSleep
    ? apiRecord(progress.workflow)
    : null;
  const resumeTail =
    savedJournal !== null &&
    WORKFLOW_TAIL_STAGES.includes(String(savedJournal.stage));
  const savedParams = savedJournal ? apiRecord(savedJournal.params) : null;
  const runAtMs = savedParams
    ? Number(savedParams.runAtMs)
    : Math.ceil((Date.now() + 86_400_000) / 1000) * 1000;
  if (!Number.isSafeInteger(runAtMs) || runAtMs - Date.now() <= 60_000)
    throw new Error(
      "Worker rehearsal synthetic sleep is too close to its deadline",
    );
  const eventId = `rehearsal-${options.runId}`;
  const sourceKey = `start:${eventId}:${runAtMs}`;
  const digest = createHash("sha256")
    .update(`${eventId}\n${sourceKey}`)
    .digest("hex");
  const instanceId = `event-progress-${digest}`;
  const instancePath = `${path}/instances/${instanceId}`;
  const params = {
    schemaVersion: 1,
    eventId,
    outboxId: `ep_${digest}`,
    reason: "scheduled-start",
    runAtMs,
    sourceKey,
  };
  if (
    savedJournal &&
    ((!resumeTail && savedJournal.stage !== "create-requested") ||
      savedJournal.workflowName !== workflowName ||
      savedJournal.instanceId !== instanceId ||
      savedJournal.originalWorkerVersionId !==
        options.originalWorkerVersionId ||
      canonicalJson(savedParams) !== canonicalJson(params))
  )
    throw new Error("Worker rehearsal saved Workflow create intent changed");
  const journal: ApiRecord = savedJournal || {
    workflowName,
    instanceId,
    params,
    stage: "definition-inspection",
    originalWorkerVersionId: options.originalWorkerVersionId,
  };
  progress.workflow = journal;
  const checkpoint = async (stage: string, detail?: ApiRecord) => {
    journal.stage = stage;
    if (detail) journal[`${stage}Detail`] = detail;
    progress.phase = `workflow:${stage}`;
    await persist();
  };
  if (!savedJournal) await checkpoint("definition-inspection");
  const readDefinition = async () => {
    const resource = await optionalResource(provider, path);
    if (!resource) return null;
    if (resource.is_deleted === 1) return resource;
    if (
      typeof resource.id !== "string" ||
      !UUID.test(resource.id) ||
      resource.script_name !== workerName ||
      resource.class_name !== "EventProgressWorkflow" ||
      (resource.name !== undefined && resource.name !== workflowName)
    )
      throw new Error("Worker rehearsal Workflow definition ownership changed");
    const validateVersion = (value: unknown, expectedId?: string) => {
      const version = apiRecord(value);
      if (
        typeof version.id !== "string" ||
        !UUID.test(version.id) ||
        (expectedId !== undefined && version.id !== expectedId) ||
        version.workflow_id !== resource.id ||
        version.class_name !== "EventProgressWorkflow"
      )
        throw new Error("Worker rehearsal Workflow version metadata conflict");
      return version.id;
    };
    let versionId =
      resource.version_id ??
      (resource.version ? apiRecord(resource.version).id : undefined);
    if (versionId === undefined) {
      const versions = records(
        await provider.request(`${path}/versions?per_page=1`),
      );
      if (versions.length === 0) return resource;
      if (versions.length !== 1)
        throw new Error(
          "Worker rehearsal current Workflow version is ambiguous",
        );
      versionId = validateVersion(versions[0]);
    }
    if (typeof versionId !== "string" || !UUID.test(versionId))
      throw new Error("Worker rehearsal invalid Workflow version ID");
    validateVersion(
      await provider.request(`${path}/versions/${versionId}`),
      versionId,
    );
    return { ...resource, version_id: versionId };
  };
  const definitionVersion = (value: ApiRecord | null): string | null => {
    if (value?.is_deleted === 1) return null;
    const version =
      value?.version_id ??
      (value?.version ? apiRecord(value.version).id : null);
    return typeof version === "string" && UUID.test(version) ? version : null;
  };
  const originalDefinition = resumeTail
    ? null
    : await readProgress(
        "initial Workflow publication",
        readDefinition,
        (value) => definitionVersion(value) !== null,
      );
  const originalWorkflowVersionId = resumeTail
    ? string(
        savedJournal?.originalWorkflowVersionId,
        "saved original Workflow version",
      )
    : definitionVersion(originalDefinition)!;
  if (!UUID.test(originalWorkflowVersionId))
    throw new Error("Worker rehearsal invalid saved Workflow version");
  if (
    savedJournal &&
    savedJournal.originalWorkflowVersionId !== originalWorkflowVersionId
  )
    throw new Error(
      "Worker rehearsal saved Workflow version changed before resume",
    );
  journal.originalWorkflowVersionId = originalWorkflowVersionId;
  const existingInstances = resumeTail
    ? []
    : records(await provider.request(`${path}/instances?per_page=100&page=1`));
  if (
    !resumeTail &&
    (savedJournal
      ? existingInstances.length !== 1 ||
        existingInstances[0].id !== instanceId ||
        existingInstances[0].version_id !== originalWorkflowVersionId
      : existingInstances.length > 0)
  )
    throw new Error("Worker rehearsal Workflow contains an unowned instance");
  const knownVersions = new Set([originalWorkflowVersionId]);
  const assertIdentity = (detail: ApiRecord) => {
    if (
      !knownVersions.has(String(detail.versionId)) ||
      canonicalJson(detail.params) !== canonicalJson(params)
    )
      throw new Error("Worker rehearsal Workflow instance identity changed");
    const steps = records(detail.steps);
    if (
      steps.some(
        (step) => !["sleep", "termination"].includes(String(step.type)),
      )
    )
      throw new Error("Worker rehearsal Workflow executed a business step");
    if (detail.output != null)
      throw new Error("Worker rehearsal Workflow unexpectedly completed");
  };
  const assertInitialSleep = (detail: ApiRecord) => {
    const steps = records(detail.steps);
    const sleep = steps.length === 1 ? steps[0] : null;
    if (
      !sleep ||
      sleep.type !== "sleep" ||
      !["wait for scheduled event", "wait for scheduled event-1"].includes(
        String(sleep.name),
      ) ||
      sleep.finished !== false ||
      sleep.error != null ||
      detail.error != null ||
      detail.output != null ||
      detail.end != null ||
      detail.success != null ||
      detail.rollback != null ||
      typeof sleep.end !== "string" ||
      Date.parse(sleep.end) !== runAtMs ||
      runAtMs <= Date.now() ||
      (detail.step_count !== undefined && detail.step_count !== 1)
    )
      throw new Error(
        "Worker rehearsal Workflow is not in its exact initial sleep",
      );
  };
  const waitState = async (versionId: string, status: string) => {
    const value = await readProgress(
      `Workflow ${status}`,
      () => optionalResource(provider, instancePath),
      (detail) => {
        if (!detail) return false;
        if (
          detail.params === undefined ||
          detail.versionId === undefined ||
          !Array.isArray(detail.steps)
        )
          return false;
        assertIdentity(detail);
        if (
          ["complete", "errored", "rollingBack"].includes(String(detail.status))
        )
          throw new Error(
            "Worker rehearsal Workflow left the controlled sleep",
          );
        if (
          detail.versionId !== versionId ||
          (detail.status !== status &&
            !(status === "waiting" && detail.status === "running"))
        )
          return false;
        if (status !== "terminated") {
          const steps = records(detail.steps);
          if (
            !steps.length ||
            typeof steps[0].end !== "string" ||
            typeof steps[0].finished !== "boolean"
          )
            return false;
          assertInitialSleep(detail);
        }
        return true;
      },
    );
    if (!value) throw new Error("Worker rehearsal lost its synthetic instance");
    return value;
  };
  const mutate = async (
    stage: string,
    resource: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ) => {
    if (runAtMs - Date.now() <= 60_000)
      throw new Error(
        "Worker rehearsal synthetic sleep is too close to its deadline",
      );
    await checkpoint(stage);
    try {
      await provider.request(resource, method, body);
    } catch (error) {
      journal.mutationFailure =
        error instanceof CloudflareRequestFailure
          ? { status: error.status, codes: error.codes }
          : { kind: "unconfirmed" };
      await persist();
    }
  };
  if (resumeTail) {
    const replacementWorkerVersionId = string(
      journal.replacementWorkerVersionId,
      "saved replacement Worker version",
    );
    const replacementWorkflowVersionId = string(
      journal.replacementWorkflowVersionId,
      "saved replacement Workflow version",
    );
    if (
      !UUID.test(replacementWorkerVersionId) ||
      !UUID.test(replacementWorkflowVersionId) ||
      replacementWorkerVersionId === options.originalWorkerVersionId ||
      replacementWorkflowVersionId === originalWorkflowVersionId
    )
      throw new Error(
        "Worker rehearsal saved handoff did not advance versions",
      );
    knownVersions.add(replacementWorkflowVersionId);
    const proof = (
      key: string,
      expectedVersion: string,
      expectedStatus: "sleep" | "paused" | "terminated",
    ) => {
      const detail = apiRecord(journal[key]);
      assertIdentity(detail);
      if (
        detail.versionId !== expectedVersion ||
        (expectedStatus === "sleep"
          ? !["waiting", "running"].includes(String(detail.status))
          : detail.status !== expectedStatus)
      )
        throw new Error("Worker rehearsal saved handoff proof status changed");
      if (expectedStatus !== "terminated") assertInitialSleep(detail);
      else {
        const steps = records(detail.steps);
        const sleeps = steps.filter((step) => step.type === "sleep");
        if (
          sleeps.length !== 1 ||
          steps.filter((step) => step.type === "termination").length > 1 ||
          !["wait for scheduled event", "wait for scheduled event-1"].includes(
            String(sleeps[0].name),
          )
        )
          throw new Error("Worker rehearsal saved termination proof changed");
      }
      return detail;
    };
    const originalSleep = proof(
      "initial-sleepDetail",
      originalWorkflowVersionId,
      "sleep",
    );
    proof("pausedDetail", originalWorkflowVersionId, "paused");
    proof("terminatedDetail", originalWorkflowVersionId, "terminated");
    const recreatedSleep = proof(
      "recreated-initial-sleepDetail",
      replacementWorkflowVersionId,
      "sleep",
    );
    proof("cleanup-pausedDetail", replacementWorkflowVersionId, "paused");
    proof(
      "cleanup-terminatedDetail",
      replacementWorkflowVersionId,
      "terminated",
    );
    const definition = await readDefinition();
    if (
      definition &&
      definition.is_deleted !== 1 &&
      definitionVersion(definition) !== replacementWorkflowVersionId
    )
      throw new Error("Worker rehearsal cleanup definition version changed");
    const detail = await optionalResource(provider, instancePath);
    if (detail) {
      assertIdentity(detail);
      if (
        detail.versionId !== replacementWorkflowVersionId ||
        detail.status !== "terminated"
      )
        throw new Error(
          "Worker rehearsal tail refuses an unterminated or foreign instance",
        );
      await mutate(
        "cleanup-delete-requested",
        `${path}/instances/batch/delete`,
        "POST",
        { instances: [instanceId] },
      );
    }
    await readProgress(
      "synthetic instance cleanup deletion",
      () => optionalResource(provider, instancePath),
      (value) => {
        if (value) {
          assertIdentity(value);
          if (
            value.versionId !== replacementWorkflowVersionId ||
            value.status !== "terminated"
          )
            throw new Error("Worker rehearsal cleanup instance changed");
        }
        return value === null;
      },
    );
    await checkpoint("cleanup-deleted");
    if (definition && definition.is_deleted !== 1) {
      await readProgress(
        "empty synthetic Workflow",
        () => provider.request(`${path}/instances?per_page=100&page=1`),
        (value) => {
          const rows = records(value);
          if (
            rows.some(
              (row) =>
                row.id !== instanceId ||
                row.version_id !== replacementWorkflowVersionId,
            )
          )
            throw new Error(
              "Worker rehearsal cleanup found an unowned instance",
            );
          return rows.length === 0;
        },
      );
      await mutate("definition-delete-requested", path, "DELETE");
    }
    await readProgress(
      "scratch Workflow deletion",
      readDefinition,
      (value) => value === null || value.is_deleted === 1,
    );
    const evidence = {
      workflowName,
      instanceId,
      params,
      originalWorkerVersionId: options.originalWorkerVersionId,
      replacementWorkerVersionId,
      originalWorkflowVersionId,
      replacementWorkflowVersionId,
      originalSleep,
      recreatedSleep,
      deleted: true as const,
    };
    progress.workflowHandoff = evidence;
    await checkpoint("complete");
    return evidence;
  }
  const create = (stage: string) =>
    mutate(stage, `${path}/instances`, "POST", {
      instance_id: instanceId,
      params,
      instance_retention: {
        success_retention: "1 day",
        error_retention: "30 days",
      },
    });
  if (!savedJournal) await create("create-requested");
  const originalSleep = await waitState(originalWorkflowVersionId, "waiting");
  await checkpoint("initial-sleep", originalSleep);
  await mutate("pause-requested", `${instancePath}/status`, "PATCH", {
    status: "pause",
  });
  await checkpoint(
    "paused",
    await waitState(originalWorkflowVersionId, "paused"),
  );
  const replacementPath = resolve(
    options.directory,
    "worker-rehearsal-generation-2.json",
  );
  writePrivateImmutable(replacementPath, {
    ...options.configuration,
    vars: {
      ...apiRecord(options.configuration.vars),
      REHEARSAL_BINDING_GENERATION: "2",
    },
  });
  journal.replacementConfigPath = replacementPath;
  await checkpoint("replacement-deploy-requested");
  await options.runCommand(
    "worker-rehearsal-generation-2",
    process.execPath,
    [
      options.wrangler,
      "deploy",
      "--config",
      replacementPath,
      "--env-file",
      options.releaseEnv,
    ],
    options.commandEnv,
  );
  const replacementWorkerVersionId = await readProgress(
    "replacement Worker deployment",
    () => deployedVersion(provider, workerName),
    (value) => value !== options.originalWorkerVersionId,
  );
  journal.replacementWorkerVersionId = replacementWorkerVersionId;
  await checkpoint("replacement-worker-deployed");
  const replacementDefinition = await readProgress(
    "replacement Workflow publication",
    readDefinition,
    (value) =>
      definitionVersion(value) !== null &&
      definitionVersion(value) !== originalWorkflowVersionId,
  );
  if (
    originalDefinition?.id !== undefined &&
    replacementDefinition?.id !== originalDefinition.id
  )
    throw new Error("Worker rehearsal replaced its Workflow resource identity");
  const replacementWorkflowVersionId = definitionVersion(
    replacementDefinition,
  )!;
  knownVersions.add(replacementWorkflowVersionId);
  Object.assign(journal, {
    replacementWorkerVersionId,
    replacementWorkflowVersionId,
  });
  await checkpoint("replacement-published");
  await waitState(originalWorkflowVersionId, "paused");
  const removeInstance = async (prefix: string, versionId: string) => {
    await mutate(
      `${prefix}terminate-requested`,
      `${instancePath}/status`,
      "PATCH",
      { status: "terminate", rollback: false },
    );
    await checkpoint(
      `${prefix}terminated`,
      await waitState(versionId, "terminated"),
    );
    await mutate(
      `${prefix}delete-requested`,
      `${path}/instances/batch/delete`,
      "POST",
      { instances: [instanceId] },
    );
    await readProgress(
      "synthetic instance deletion",
      () => optionalResource(provider, instancePath),
      (value) => {
        if (value) assertIdentity(value);
        return value === null;
      },
    );
    await checkpoint(`${prefix}deleted`);
  };
  await removeInstance("", originalWorkflowVersionId);
  await create("recreate-requested");
  const recreatedSleep = await waitState(
    replacementWorkflowVersionId,
    "waiting",
  );
  await checkpoint("recreated-initial-sleep", recreatedSleep);
  await mutate("cleanup-pause-requested", `${instancePath}/status`, "PATCH", {
    status: "pause",
  });
  await checkpoint(
    "cleanup-paused",
    await waitState(replacementWorkflowVersionId, "paused"),
  );
  await removeInstance("cleanup-", replacementWorkflowVersionId);
  if (
    records(await provider.request(`${path}/instances?per_page=100&page=1`))
      .length
  )
    throw new Error(
      "Worker rehearsal refuses to delete a Workflow with unexpected instances",
    );
  await mutate("definition-delete-requested", path, "DELETE");
  await readProgress(
    "scratch Workflow deletion",
    readDefinition,
    (value) => value === null || value.is_deleted === 1,
  );
  const evidence = {
    workflowName,
    instanceId,
    params,
    originalWorkerVersionId: options.originalWorkerVersionId,
    replacementWorkerVersionId,
    originalWorkflowVersionId,
    replacementWorkflowVersionId,
    originalSleep,
    recreatedSleep,
    deleted: true as const,
  };
  progress.workflowHandoff = evidence;
  await checkpoint("complete");
  return evidence;
}

async function fetchEvidence(
  url: string,
  body: string | undefined,
  secret: string,
  expectedStatus: number,
  accepts: (value: ApiRecord) => boolean,
  attempts = 8,
  waitForPropagation: (milliseconds: number) => Promise<void> = delay,
): Promise<ApiRecord> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers:
          body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "X-Mons-Telegram-Timestamp": timestamp,
                "X-Mons-Telegram-Signature": createHmac("sha256", secret)
                  .update(`${timestamp}.${body}`)
                  .digest("base64url"),
              },
        ...(body === undefined ? {} : { body }),
      });
      lastStatus = response.status;
      const value = apiRecord(
        await readResponseJson(
          new Response(response.body, { headers: response.headers }),
          12 * 1024 * 1024,
        ),
      );
      if (lastStatus === expectedStatus && accepts(value)) return value;
    } catch (error) {
      if (attempt === attempts - 1)
        throw new Error("Worker rehearsal HTTP verification failed", {
          cause: error,
        });
    }
    if (attempt < attempts - 1) await waitForPropagation(500);
  }
  throw new Error(
    `Worker rehearsal HTTP verification remained unconfirmed (HTTP ${lastStatus})`,
  );
}

export async function runWorkerRehearsal(
  options: WorkerRehearsalOptions,
): Promise<WorkerRehearsalEvidence> {
  const { manifest, provider, runCommand } = options;
  if (
    options.attemptId !== undefined &&
    (typeof options.attemptId !== "string" || !UUID.test(options.attemptId))
  )
    throw new Error("Worker rehearsal attemptId must be a UUID");
  const destinations = readyDestinations(manifest);
  const directory = privateDirectory(options.directory);
  const workerName = `mons-link-d1-enam-rehearsal-${manifest.runId.slice(0, 8).toLowerCase()}${options.attemptId ? `-${options.attemptId.slice(0, 8).toLowerCase()}` : ""}`;
  const workflowName = `${workerName}-progress`;
  const sourceEvidence = runtimeSourceEvidence();
  const saved = manifest.records.workerRehearsal
    ? apiRecord(manifest.records.workerRehearsal)
    : null;
  const savedWorkflow = saved ? apiRecord(saved.workflow) : null;
  const savedTail =
    savedWorkflow !== null &&
    WORKFLOW_TAIL_STAGES.includes(String(savedWorkflow.stage));
  const savedVersionId = savedTail
    ? savedWorkflow?.replacementWorkerVersionId
    : saved?.versionId;
  if (
    saved &&
    (saved.formatVersion !== 1 ||
      saved.runId !== manifest.runId ||
      saved.attemptId !== options.attemptId ||
      saved.workerName !== workerName ||
      saved.workflowName !== workflowName ||
      saved.phase !== `workflow:${String(savedWorkflow?.stage)}` ||
      (!savedTail && savedWorkflow?.stage !== "create-requested"))
  )
    throw new Error(
      "Worker rehearsal existing intent is not an exact resumable create attempt",
    );
  const progressFiles = readdirSync(directory)
    .filter((name) => /^worker-rehearsal-progress-\d{4}\.json$/.test(name))
    .sort();
  if (saved) {
    if (
      !progressFiles.length ||
      canonicalJson(
        readPrivateJson(resolve(directory, progressFiles.at(-1)!)),
      ) !== canonicalJson(saved)
    )
      throw new Error(
        "Worker rehearsal resume requires matching protected progress evidence",
      );
    const expectedDatabases = destinations.map((db) => ({
      binding: db.binding,
      databaseId: db.destinationId,
      schema: db.schema,
      fenceTriggers: [],
    }));
    if (canonicalJson(saved.databases) !== canonicalJson(expectedDatabases))
      throw new Error("Worker rehearsal saved destination identities changed");
    if (
      saved.sourceSha256 !== undefined &&
      saved.sourceSha256 !== sourceEvidence.sha256
    )
      throw new Error(
        "Worker rehearsal runtime source changed after its saved deployment",
      );
    if (saved.sourceSha256 === undefined) {
      if (typeof savedVersionId !== "string" || !UUID.test(savedVersionId))
        throw new Error("Worker rehearsal saved version is invalid");
      const metadata = apiRecord(
        await provider.request(
          `workers/scripts/${workerName}/versions/${savedVersionId}`,
        ),
      );
      const createdOn =
        metadata.created_on ??
        (metadata.metadata
          ? apiRecord(metadata.metadata).created_on
          : undefined);
      const createdAtMs =
        typeof createdOn === "string" ? Date.parse(createdOn) : NaN;
      if (
        !Number.isFinite(createdAtMs) ||
        sourceEvidence.latestModifiedAtMs > createdAtMs
      )
        throw new Error(
          "Worker rehearsal cannot verify unchanged runtime source for the older saved attempt",
        );
    }
  } else if (progressFiles.length)
    throw new Error(
      "Worker rehearsal directory already contains attempt evidence",
    );
  const workerPath = `workers/scripts/${workerName}`;
  const sourceSettings = apiRecord(
    await provider.request(`workers/scripts/${manifest.workerName}/settings`),
  );
  const destinationIds = new Set(destinations.map((db) => db.destinationId));
  if (
    records(sourceSettings.bindings).some((binding) =>
      destinationIds.has(String(binding.id || binding.database_id)),
    )
  )
    throw new Error(
      "Worker rehearsal destination is already bound to the live API",
    );
  const scripts = records(await provider.request("workers/scripts"));
  const existingWorker = scripts.some(
    (script) => script.id === workerName || script.name === workerName,
  );
  if (saved ? !existingWorker : existingWorker)
    throw new Error(
      "Worker rehearsal name already exists without owned creation evidence",
    );
  const existingWorkflow = await optionalResource(
    provider,
    `workflows/${workflowName}`,
  );
  if (saved ? !savedTail && !existingWorkflow : existingWorkflow)
    throw new Error(
      "Worker rehearsal Workflow name already exists without owned creation evidence",
    );
  for (const db of destinations) {
    const info = apiRecord(
      await provider.request(`d1/database/${db.destinationId}`),
    );
    if (
      info.uuid !== db.destinationId ||
      info.name !== db.destinationName ||
      info.running_in_region !== "ENAM"
    )
      throw new Error(
        "Worker rehearsal destination identity or ENAM placement changed",
      );
    const schema = await captureSchema((sql, params) =>
      provider.query(db.destinationId, sql, params),
    );
    if (
      saved
        ? canonicalJson(schema) !== canonicalJson(db.schema)
        : schema.objects.length > 0
    )
      throw new Error(
        "Worker rehearsal requires empty destination application schemas",
      );
    if (saved) {
      const ledger = await provider.query(
        db.sourceId,
        'SELECT * FROM "d1_migrations" ORDER BY id',
      );
      const actualLedger = await provider.query(
        db.destinationId,
        'SELECT * FROM "d1_migrations" ORDER BY id',
      );
      if (
        !ledger.length ||
        canonicalJson(ledger) !== canonicalJson(actualLedger)
      )
        throw new Error("Worker rehearsal resume migration ledger changed");
      const controlTables = new Set<string>();
      for (const [key, rows] of Object.entries(manifest.controls)) {
        if (!key.startsWith(`${db.binding}.`)) continue;
        const table = key.slice(db.binding.length + 1);
        controlTables.add(table);
        const actual = await provider.query(
          db.destinationId,
          `SELECT * FROM ${quote(table)}`,
        );
        if (canonicalJson(actual) !== canonicalJson(rows.map(frozenControl)))
          throw new Error("Worker rehearsal resume control fixture changed");
      }
      for (const table of db.schema.tables) {
        if (table.name === "d1_migrations" || controlTables.has(table.name))
          continue;
        const count = await provider.query(
          db.destinationId,
          `SELECT COUNT(*) AS count FROM ${quote(table.name)}`,
        );
        if (count.length !== 1 || count[0].count !== 0)
          throw new Error(
            "Worker rehearsal resume found unexpected application data",
          );
      }
    }
  }
  const progress: ApiRecord = saved || {
    formatVersion: 1,
    ...(options.attemptId === undefined
      ? {}
      : { attemptId: options.attemptId }),
    runId: manifest.runId,
    workerName,
    workflowName,
    workflow: { workflowName, stage: "definition-create-requested" },
    startedAt: new Date().toISOString(),
    phase: "intent",
    sourceSha256: sourceEvidence.sha256,
    databases: destinations.map((db) => ({
      binding: db.binding,
      databaseId: db.destinationId,
      schema: db.schema,
      fenceTriggers: [],
    })),
  };
  let revision = progressFiles.length
    ? Number(
        progressFiles
          .at(-1)!
          .slice("worker-rehearsal-progress-".length, -".json".length),
      )
    : 0;
  const persist = async () => {
    manifest.records.workerRehearsal = progress;
    writePrivateImmutable(
      resolve(
        directory,
        `worker-rehearsal-progress-${String(++revision).padStart(4, "0")}.json`,
      ),
      structuredClone(progress),
    );
    await options.persist?.();
  };
  if (!saved) await persist();
  for (const db of saved ? [] : destinations) {
    progress.phase = `fixture:${db.binding}`;
    await persist();
    for (const type of ["table", "index", "view"] as const)
      for (const object of db.schema.objects.filter(
        (entry) => entry.type === type,
      ))
        await provider.query(db.destinationId, object.sql);
    const ledger = await provider.query(
      db.sourceId,
      'SELECT * FROM "d1_migrations" ORDER BY id',
    );
    if (!ledger.length)
      throw new Error("Worker rehearsal source migration ledger is empty");
    await insertRows(provider, db.destinationId, "d1_migrations", ledger);
    for (const [key, rows] of Object.entries(manifest.controls)) {
      if (!key.startsWith(`${db.binding}.`)) continue;
      const table = key.slice(db.binding.length + 1);
      if (
        !db.schema.tables.some((entry) => entry.name === table) ||
        rows.length !== 1
      )
        throw new Error("Worker rehearsal control fixture is ambiguous");
      await insertRows(
        provider,
        db.destinationId,
        table,
        rows.map((row) => frozenControl(row)),
      );
    }
    for (const name of db.schema.triggerOrder) {
      const trigger = db.schema.objects.find(
        (entry) => entry.type === "trigger" && entry.name === name,
      );
      if (!trigger)
        throw new Error("Worker rehearsal missing original trigger definition");
      await provider.query(db.destinationId, trigger.sql);
    }
    const fixtureSchema = await captureSchema((sql, params) =>
      provider.query(db.destinationId, sql, params),
    );
    if (canonicalJson(fixtureSchema) !== canonicalJson(db.schema))
      throw new Error("Worker rehearsal fixture schema differs from preflight");
    await provider.query(
      db.destinationId,
      "UPDATE d1_migrations SET name = name",
    );
  }
  const secretPath = resolve(directory, "worker-rehearsal-secrets.json");
  if (saved && !existsSync(secretPath))
    throw new Error("Worker rehearsal saved secret file is missing");
  if (!existsSync(secretPath))
    writePrivateImmutable(secretPath, {
      TELEGRAM_QUEUE_BRIDGE_SECRET: randomBytes(32).toString("hex"),
    });
  const secrets = apiRecord(readPrivateJson(secretPath));
  if (
    Object.keys(secrets).length !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(secrets.TELEGRAM_QUEUE_BRIDGE_SECRET))
  )
    throw new Error("Worker rehearsal test secret artifact is invalid");
  const secret = String(secrets.TELEGRAM_QUEUE_BRIDGE_SECRET);
  const entrypoint = resolve(
    dirname(DEFAULT_API_CONFIG),
    string(manifest.configuration.main, "main entrypoint"),
  );
  if (entrypoint !== resolve(ROOT, "cloud/workers/api/src/index.ts"))
    throw new Error("Worker rehearsal must use the canonical API entrypoint");
  const configPath = resolve(directory, "worker-rehearsal-config.json");
  const releaseEnv = resolve(directory, "worker-rehearsal.env");
  if (
    saved &&
    (saved.configPath !== configPath ||
      saved.secretPath !== secretPath ||
      saved.entrypoint !== entrypoint ||
      !existsSync(configPath) ||
      !existsSync(releaseEnv))
  )
    throw new Error("Worker rehearsal saved configuration paths changed");
  privateText(releaseEnv, "");
  const configuration = {
    $schema: resolve(ROOT, "node_modules/wrangler/config-schema.json"),
    name: workerName,
    account_id: manifest.accountId,
    main: entrypoint,
    compatibility_date: string(
      manifest.configuration.compatibility_date,
      "compatibility date",
    ),
    compatibility_flags: manifest.configuration.compatibility_flags,
    workers_dev: true,
    preview_urls: false,
    exports: { InviteReactions: { type: "durable-object", storage: "sqlite" } },
    durable_objects: {
      bindings: [{ name: "INVITE_REACTIONS", class_name: "InviteReactions" }],
    },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      API_MAINTENANCE: "true",
      D1_MIGRATION_RUN_ID: manifest.runId,
      REHEARSAL_BINDING_GENERATION: "1",
    },
    workflows: [
      {
        binding: "EVENT_PROGRESS_WORKFLOW",
        name: workflowName,
        class_name: "EventProgressWorkflow",
      },
    ],
    d1_databases: destinations.map((db) => ({
      binding: db.binding,
      database_name: db.destinationName,
      database_id: db.destinationId,
    })),
  };
  writePrivateImmutable(configPath, configuration);
  if (savedTail) {
    const replacementPath = resolve(
      directory,
      "worker-rehearsal-generation-2.json",
    );
    if (
      savedWorkflow?.replacementConfigPath !== replacementPath ||
      !existsSync(replacementPath)
    )
      throw new Error(
        "Worker rehearsal saved replacement configuration is missing",
      );
    const expected = {
      ...configuration,
      vars: { ...configuration.vars, REHEARSAL_BINDING_GENERATION: "2" },
    };
    if (
      canonicalJson(readPrivateJson(replacementPath)) !==
      canonicalJson(expected)
    )
      throw new Error(
        "Worker rehearsal saved replacement configuration changed",
      );
  }
  if (!saved)
    Object.assign(progress, {
      phase: "deploy",
      configPath,
      entrypoint,
      secretPath,
    });
  if (!saved) await persist();
  const declaredSecrets = apiRecord(manifest.configuration.secrets).required;
  if (
    !Array.isArray(declaredSecrets) ||
    declaredSecrets.some(
      (name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name),
    )
  )
    throw new Error("Worker rehearsal secret declarations are invalid");
  const commandEnv: NodeJS.ProcessEnv = Object.fromEntries(
    declaredSecrets.map((name) => [name, ""]),
  );
  const wrangler = resolve(ROOT, "node_modules/wrangler/bin/wrangler.js");
  const flags = ["--config", configPath, "--env-file", releaseEnv];
  if (!saved)
    await runCommand(
      "worker-rehearsal-deploy",
      process.execPath,
      [wrangler, "deploy", ...flags],
      commandEnv,
    );
  if (!saved) {
    progress.phase = "secret";
    await persist();
  }
  if (!saved)
    await runCommand(
      "worker-rehearsal-secret",
      process.execPath,
      [wrangler, "secret", "bulk", secretPath, ...flags],
      commandEnv,
    );
  let versionId = await deployedVersion(provider, workerName);
  if (saved && savedVersionId !== versionId)
    throw new Error("Worker rehearsal saved Worker version changed");
  const namespaces = records(
    await provider.request("workers/durable_objects/namespaces"),
  );
  const owned = namespaces.filter(
    (entry) => entry.script === workerName && entry.class === "InviteReactions",
  );
  if (owned.length !== 1 || owned[0].id === manifest.namespaceId)
    throw new Error(
      "Worker rehearsal did not receive a fresh isolated Durable Object namespace",
    );
  const namespaceId = string(owned[0].id, "scratch namespace ID");
  if (saved && saved.namespaceId !== namespaceId)
    throw new Error("Worker rehearsal saved namespace changed");
  const settings = apiRecord(await provider.request(`${workerPath}/settings`));
  const bindingList = records(settings.bindings);
  for (const db of destinations) {
    const binding = bindingList.filter(
      (entry) => entry.name === db.binding && entry.type === "d1",
    );
    if (
      binding.length !== 1 ||
      String(binding[0].id || binding[0].database_id) !== db.destinationId
    )
      throw new Error(
        "Worker rehearsal deployed D1 bindings differ from owned destinations",
      );
  }
  if (
    bindingList.some(
      (entry) =>
        ["queue", "service"].includes(String(entry.type)) ||
        (entry.type === "workflow" &&
          (entry.name !== "EVENT_PROGRESS_WORKFLOW" ||
            entry.workflow_name !== workflowName)),
    ) ||
    bindingList.filter((entry) => entry.type === "workflow").length !== 1
  )
    throw new Error(
      "Worker rehearsal unexpectedly acquired a non-isolated binding",
    );
  const subdomain = string(
    apiRecord(await provider.request("workers/subdomain")).subdomain,
    "workers.dev subdomain",
  );
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain))
    throw new Error("Worker rehearsal invalid workers.dev subdomain");
  const url = `https://${workerName}.${subdomain}.workers.dev`;
  if (saved && saved.url !== url)
    throw new Error("Worker rehearsal saved URL changed");
  if (!saved) {
    Object.assign(progress, { phase: "verify", versionId, namespaceId, url });
    await persist();
  } else {
    const status = await fetchEvidence(
      url + "/internal/d1-migration",
      JSON.stringify({
        schemaVersion: 1,
        kind: "d1-migration",
        runId: manifest.runId,
        operation: "status",
        expectedVersionId: versionId,
      }),
      secret,
      200,
      (value) =>
        value.ok === true &&
        value.runId === manifest.runId &&
        value.versionId === versionId,
      8,
      options.waitForPropagation,
    );
    if (
      records(status.databases).length !== 6 ||
      records(status.databases).some(
        (entry) =>
          entry.drained !== true ||
          apiRecord(entry.fence).installedTriggers !== 0,
      )
    )
      throw new Error(
        "Worker rehearsal resume status is not unfenced and drained",
      );
  }
  const workflowHandoff = await rehearseWorkflow({
    provider,
    workerName,
    workflowName,
    originalWorkerVersionId: savedTail
      ? string(
          savedWorkflow?.originalWorkerVersionId,
          "saved original Worker version",
        )
      : versionId,
    runId: manifest.runId,
    directory,
    configuration,
    commandEnv,
    wrangler,
    releaseEnv,
    runCommand,
    waitForPropagation: options.waitForPropagation,
    resumeInitialSleep: Boolean(saved),
    progress,
    persist,
  });
  versionId = workflowHandoff.replacementWorkerVersionId;
  const replacementNamespaces = records(
    await provider.request("workers/durable_objects/namespaces"),
  ).filter(
    (entry) => entry.script === workerName && entry.class === "InviteReactions",
  );
  if (
    replacementNamespaces.length !== 1 ||
    replacementNamespaces[0].id !== namespaceId
  )
    throw new Error(
      "Worker rehearsal second deployment changed its Durable Object namespace",
    );
  Object.assign(progress, { phase: "verify", versionId, workflowHandoff });
  await persist();
  const identity = (value: ApiRecord) =>
    value.runId === manifest.runId && value.versionId === versionId;
  await fetchEvidence(
    url + "/sessions/anonymous",
    undefined,
    secret,
    503,
    (value) => identity(value) && value.message === "api-maintenance",
    8,
    options.waitForPropagation,
  );
  const signed = (operation: string, extra: ApiRecord = {}, attempts = 8) =>
    fetchEvidence(
      url + "/internal/d1-migration",
      JSON.stringify({
        schemaVersion: 1,
        kind: "d1-migration",
        runId: manifest.runId,
        operation,
        expectedVersionId: versionId,
        ...extra,
      }),
      secret,
      200,
      (value) => value.ok === true && identity(value),
      attempts,
      options.waitForPropagation,
    );
  const initial = records((await signed("status")).databases);
  if (initial.length !== destinations.length)
    throw new Error("Worker rehearsal status omitted a binding");
  for (const db of destinations) {
    const status = initial.find((entry) => entry.binding === db.binding);
    if (
      !status ||
      status.drained !== true ||
      apiRecord(status.fence).installedTriggers !== 0
    )
      throw new Error("Worker rehearsal fixture is not ready for fencing");
    const fenceTriggers = apiRecord(status.fence).triggerNames;
    if (
      !Array.isArray(fenceTriggers) ||
      fenceTriggers.some(
        (name) => typeof name !== "string" || !name.startsWith(FENCE_PREFIX),
      )
    )
      throw new Error("Worker rehearsal fence manifest is invalid");
    const entry = records(progress.databases).find(
      (item) => item.binding === db.binding,
    );
    if (!entry) throw new Error("Worker rehearsal lost destination progress");
    entry.fenceTriggers = fenceTriggers;
    await persist();
    const fenced = records(
      (
        await signed("fence", {
          binding: db.binding,
          schemaDigest: status.schemaDigest,
        })
      ).databases,
    );
    if (
      fenced.length !== 1 ||
      apiRecord(fenced[0].fence).complete !== true ||
      fenced[0].schemaDigest !== status.schemaDigest
    )
      throw new Error("Worker rehearsal source fence was not confirmed");
    try {
      await provider.query(
        db.destinationId,
        "UPDATE d1_migrations SET name = name",
      );
      throw new Error("Worker rehearsal fence allowed a known valid write");
    } catch (error) {
      if (
        !(error instanceof CloudflareRequestFailure) ||
        !error.codes.includes(7500)
      )
        throw error;
    }
  }
  const verified = records((await signed("verify")).databases);
  if (
    verified.length !== destinations.length ||
    verified.some(
      (entry) =>
        entry.valid !== true ||
        entry.bookmarkAccepted !== true ||
        entry.foreignKeyViolations !== 0 ||
        entry.integrityCheckKind !== "quick_check" ||
        canonicalJson(entry.integrityCheck) !== '["ok"]' ||
        apiRecord(entry.fence).complete !== true,
    )
  )
    throw new Error("Worker rehearsal integrity or fence verification failed");
  const sourceBinding = "PROFILE_GAMES_DB";
  const targetBinding = "AUTH_STATE_DB";
  const source = verified.find((entry) => entry.binding === sourceBinding);
  const sourceDatabase = destinations.find(
    (entry) => entry.binding === sourceBinding,
  );
  const targetDatabase = destinations.find(
    (entry) => entry.binding === targetBinding,
  );
  if (
    !source ||
    !sourceDatabase ||
    !targetDatabase ||
    (source.bookmark !== null && typeof source.bookmark !== "string")
  )
    throw new Error("Worker rehearsal native bookmark evidence is missing");
  const bookmarkCompatibility: WorkerRehearsalEvidence["bookmarkCompatibility"] =
    {
      sourceBinding,
      targetBinding,
      sourceDatabaseId: sourceDatabase.destinationId,
      targetDatabaseId: targetDatabase.destinationId,
      sourceBookmark: source.bookmark,
      targetBookmark: null,
      accepted: null,
    };
  if (typeof source.bookmark === "string" && source.bookmark.length > 0) {
    try {
      const response = records(
        (
          await signed(
            "verify",
            { binding: targetBinding, bookmark: source.bookmark },
            1,
          )
        ).databases,
      );
      const target = response.length === 1 ? response[0] : null;
      if (
        !target ||
        target.binding !== targetBinding ||
        typeof target.bookmarkAccepted !== "boolean" ||
        (target.bookmark !== null && typeof target.bookmark !== "string")
      )
        throw new Error("invalid native bookmark probe result");
      bookmarkCompatibility.accepted = target.bookmarkAccepted;
      bookmarkCompatibility.targetBookmark = target.bookmark;
      if (typeof target.bookmarkError === "string")
        bookmarkCompatibility.error = target.bookmarkError;
    } catch (error) {
      bookmarkCompatibility.error = `transport-unconfirmed: ${error instanceof Error ? error.message.slice(0, 240) : "request failed"}`;
    }
  } else
    bookmarkCompatibility.error =
      "native first-primary read returned no bookmark";
  try {
    const targetBaseline = verified.find(
      (entry) => entry.binding === targetBinding,
    );
    if (
      typeof source.bookmark !== "string" ||
      !source.bookmark ||
      typeof targetBaseline?.bookmark !== "string" ||
      !targetBaseline.bookmark
    )
      throw new Error(
        "native source or target bookmark is unavailable for recovery verification",
      );
    const foreign = scopeEventBookmark(
      source.bookmark,
      sourceDatabase.destinationId,
    );
    const current = scopeEventBookmark(
      targetBaseline.bookmark,
      targetDatabase.destinationId,
    );
    const cases = [
      { kind: "legacy-raw", input: source.bookmark, expected: "first-primary" },
      { kind: "foreign-scope", input: foreign, expected: "first-primary" },
      {
        kind: "current-scope",
        input: current,
        expected: targetBaseline.bookmark,
      },
    ];
    bookmarkCompatibility.recoveryChecks = [];
    for (const entry of cases) {
      const constraint = eventBookmarkConstraint(
        entry.input,
        targetDatabase.destinationId,
      );
      if (constraint !== entry.expected)
        throw new Error(`unexpected ${entry.kind} bookmark constraint`);
      const response = records(
        (
          await signed(
            "verify",
            { binding: targetBinding, bookmark: constraint },
            1,
          )
        ).databases,
      );
      const target = response.length === 1 ? response[0] : null;
      if (
        !target ||
        target.binding !== targetBinding ||
        target.valid !== true ||
        target.bookmarkAccepted !== true ||
        typeof target.migrationCount !== "number" ||
        target.migrationCount <= 0 ||
        typeof target.bookmark !== "string" ||
        !target.bookmark
      )
        throw new Error(`${entry.kind} native bookmark recovery read failed`);
      bookmarkCompatibility.recoveryChecks.push({
        kind: entry.kind,
        constraint,
        nativeBookmark: target.bookmark,
      });
    }
    bookmarkCompatibility.recoveryVerified = true;
  } catch (error) {
    bookmarkCompatibility.recoveryVerified = false;
    bookmarkCompatibility.recoveryError =
      error instanceof Error
        ? error.message.slice(0, 240)
        : "bookmark recovery verification failed";
  }
  Object.assign(progress, {
    phase: "bookmark-compatibility",
    bookmarkCompatibility,
  });
  await persist();
  const probe = await signed("barrier", { inviteId: "migration-rehearsal" });
  if (!/^[a-f0-9]{64}$/.test(String(probe.objectId)))
    throw new Error("Worker rehearsal returned an invalid object ID");
  const barrier = await signed("barrier", { objectId: probe.objectId });
  if (
    barrier.objectId !== probe.objectId ||
    barrier.canonicalDigest !== probe.canonicalDigest ||
    barrier.effectDigest !== probe.effectDigest ||
    barrier.pendingEffects !== 0
  )
    throw new Error(
      "Worker rehearsal Durable Object barrier changed canonical state",
    );
  const databases: WorkerRehearsalEvidence["databases"] = [];
  for (const db of destinations) {
    const status = verified.find((entry) => entry.binding === db.binding);
    if (!status)
      throw new Error("Worker rehearsal verification omitted a binding");
    const fenceTriggers = apiRecord(status.fence).triggerNames;
    if (
      !Array.isArray(fenceTriggers) ||
      fenceTriggers.some((name) => typeof name !== "string")
    )
      throw new Error("Worker rehearsal invalid final fence names");
    databases.push({
      binding: db.binding,
      databaseId: db.destinationId,
      schema: await captureSchema((sql, params) =>
        provider.query(db.destinationId, sql, params),
      ),
      fenceTriggers: fenceTriggers.map(String),
    });
  }
  const evidence: WorkerRehearsalEvidence = {
    formatVersion: 1,
    passed: true,
    resumed: Boolean(saved),
    ...(options.attemptId === undefined
      ? {}
      : { attemptId: options.attemptId }),
    workerName,
    namespaceId,
    versionId,
    url,
    retirementRequired: true,
    databases,
    barrier,
    workflowHandoff,
    bookmarkCompatibility,
    checks: [
      "isolated-never-live-destinations",
      "original-schema-and-trigger-order",
      "frozen-control-and-ledger-fixtures",
      "full-http-maintenance",
      "signed-six-binding-status",
      "atomic-six-database-fences",
      "known-valid-write-rejected",
      "quick-check-foreign-keys-topology",
      "fresh-namespace-version-pinned-barrier",
      "real-workflow-pause-delete-recreate-version-handoff",
      "synthetic-workflow-retired",
      "cross-database-bookmark-native-result-recorded",
      "scoped-bookmark-recovery-result-recorded",
    ],
  };
  Object.assign(progress, { phase: "complete", evidence });
  await persist();
  writePrivateImmutable(
    resolve(directory, "worker-rehearsal-evidence.json"),
    evidence,
  );
  return evidence;
}
