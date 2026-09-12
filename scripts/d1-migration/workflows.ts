import { createHash } from "node:crypto";
import { isSafeRecordKey } from "@mons/shared/ids";
import { canonicalJson } from "../operator/runtime.ts";

export type CloudflareRequest = (
  path: string,
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
) => Promise<unknown>;

export type SqlQuery = (
  databaseId: string,
  sql: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

type JsonRecord = Record<string, unknown>;

export const EVENT_PROGRESS_WORKFLOW_NAME = "mons-link-event-progress";
export const WITHDRAWAL_WORKFLOW_NAME = "mons-link-event-prize-withdrawal";
export const WORKFLOW_HANDOFF_MINIMUM_LEAD_MS = 60_000;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const INSTANCE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/;
const WORKFLOW_NAMES = [
  EVENT_PROGRESS_WORKFLOW_NAME,
  WITHDRAWAL_WORKFLOW_NAME,
] as const;
const RETENTION = {
  success_retention: "1 day",
  error_retention: "30 days",
} as const;
const STAGES = [
  "captured",
  "pause-requested",
  "paused",
  "terminate-requested",
  "terminated",
  "delete-requested",
  "deleted",
  "create-requested",
  "recreated",
  "completed",
] as const;

export type WorkflowHandoffStage = (typeof STAGES)[number];

export type WorkflowInstanceSnapshot = {
  workflowName: string;
  id: string;
  versionId: string;
  status: string;
  summary: JsonRecord;
  detail: JsonRecord;
};

export type EventProgressHandoffParams = {
  schemaVersion: 1;
  eventId: string;
  outboxId: string;
  reason: string;
  runAtMs: number;
  sourceKey: string;
};

export type WorkflowHandoffEntry = {
  id: string;
  original: WorkflowInstanceSnapshot;
  params: EventProgressHandoffParams;
  outbox: JsonRecord;
  fingerprint: string;
  retention: typeof RETENTION;
  stage: WorkflowHandoffStage;
  pausedDetail?: JsonRecord;
  terminatedDetail?: JsonRecord;
  recreatedDetail?: JsonRecord;
  completedDetail?: JsonRecord;
};

export type WorkflowHandoffManifest = {
  schemaVersion: 1;
  capturedAtMs: number;
  eventDatabaseId: string;
  withdrawalDatabaseId: string;
  entries: WorkflowHandoffEntry[];
  completed: WorkflowInstanceSnapshot[];
  targetWorkflowVersionId?: string;
};

export type WorkflowHandoffVerification = {
  migrated: number;
  completedDuringHandoff: number;
  completedHistoriesPreserved: number;
  expiredCompletedHistories: Array<{ workflowName: string; id: string }>;
  oldVersionNonterminal: 0;
};

type ReadDependencies = {
  request: CloudflareRequest;
  isNotFound?: (error: unknown) => boolean;
};

type MutationDependencies = ReadDependencies & {
  manifest: WorkflowHandoffManifest;
  persist(manifest: WorkflowHandoffManifest): Promise<void>;
  now?: () => number;
};

export class WorkflowHandoffPendingError extends Error {
  constructor(operation: string) {
    super(
      `workflow-handoff-${operation}-pending; resume from the saved manifest`,
    );
    this.name = "WorkflowHandoffPendingError";
  }
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("workflow-handoff-invalid-provider-record");
  return value as JsonRecord;
}

function clone<T>(value: T): T {
  canonicalJson(value);
  return structuredClone(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function version(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new Error("workflow-handoff-invalid-version");
  return value;
}

function instancePath(name: string, id: string): string {
  if (!WORKFLOW_NAMES.includes(name as (typeof WORKFLOW_NAMES)[number]))
    throw new Error("workflow-handoff-unowned-workflow");
  if (!INSTANCE_ID.test(id)) throw new Error("workflow-handoff-invalid-id");
  return `/workflows/${name}/instances/${encodeURIComponent(id)}`;
}

export async function listWorkflowInstances(
  request: CloudflareRequest,
  workflowName: string,
): Promise<JsonRecord[]> {
  if (!WORKFLOW_NAMES.includes(workflowName as (typeof WORKFLOW_NAMES)[number]))
    throw new Error("workflow-handoff-unowned-workflow");
  const instances: JsonRecord[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 10_000; page++) {
    const result = await request(
      `/workflows/${workflowName}/instances?per_page=100&page=${page}`,
    );
    if (!Array.isArray(result) || result.length > 100)
      throw new Error("workflow-handoff-invalid-instance-page");
    for (const value of result) {
      const item = record(value);
      if (
        typeof item.id !== "string" ||
        !INSTANCE_ID.test(item.id) ||
        typeof item.status !== "string" ||
        seen.has(item.id)
      )
        throw new Error("workflow-handoff-inconsistent-instance-pages");
      version(item.version_id);
      seen.add(item.id);
      instances.push(clone(item));
    }
    if (result.length < 100) return instances;
  }
  throw new Error("workflow-handoff-instance-pagination-limit");
}

async function readDetail(
  dependencies: ReadDependencies,
  name: string,
  id: string,
): Promise<JsonRecord | null> {
  try {
    const detail = record(await dependencies.request(instancePath(name, id)));
    version(detail.versionId);
    if (typeof detail.status !== "string" || !Array.isArray(detail.steps))
      throw new Error("workflow-handoff-invalid-instance-detail");
    return clone(detail);
  } catch (error) {
    const missing = dependencies.isNotFound
      ? dependencies.isNotFound(error)
      : error !== null &&
        typeof error === "object" &&
        (("status" in error && error.status === 404) ||
          ("statusCode" in error && error.statusCode === 404));
    if (missing) return null;
    throw error;
  }
}

function parseParams(value: unknown, id: string): EventProgressHandoffParams {
  const params = record(value);
  if (
    Object.keys(params).sort().join(",") !==
      "eventId,outboxId,reason,runAtMs,schemaVersion,sourceKey" ||
    params.schemaVersion !== 1 ||
    !isSafeRecordKey(params.eventId) ||
    typeof params.outboxId !== "string" ||
    typeof params.reason !== "string" ||
    !params.reason.trim() ||
    typeof params.sourceKey !== "string" ||
    !params.sourceKey.trim() ||
    !positiveInteger(params.runAtMs)
  )
    throw new Error("workflow-handoff-invalid-event-params");
  const digest = createHash("sha256")
    .update(`${params.eventId}\n${params.sourceKey}`)
    .digest("hex");
  if (id !== `event-progress-${digest}` || params.outboxId !== `ep_${digest}`)
    throw new Error("workflow-handoff-event-identity-mismatch");
  if (params.reason === "sunday-mons-reminder") {
    if (
      ![10_800_000, 14_400_000].some(
        (lead) =>
          params.sourceKey ===
          `reminder:${params.eventId}:${Number(params.runAtMs) + lead}`,
      )
    )
      throw new Error("workflow-handoff-reminder-schedule-mismatch");
  } else if (
    params.reason === "event-prize-announcement" &&
    params.sourceKey !==
      `prizes:${params.eventId}:${params.runAtMs + 3_600_000}`
  ) {
    throw new Error("workflow-handoff-prize-schedule-mismatch");
  }
  return clone(params) as EventProgressHandoffParams;
}

function assertInitialSleep(
  detail: JsonRecord,
  params: EventProgressHandoffParams,
  allowTermination = false,
): void {
  if (!Array.isArray(detail.steps))
    throw new Error("workflow-handoff-instance-not-in-initial-sleep");
  const allSteps = detail.steps as unknown[];
  const steps = allowTermination
    ? allSteps.filter((step) => record(step).type !== "termination")
    : allSteps;
  const expectedName =
    params.reason === "sunday-mons-reminder"
      ? "wait for sunday mons reminder"
      : params.reason === "event-prize-announcement"
        ? "wait for prize announcement"
        : "wait for scheduled event";
  const sleep = steps.length === 1 ? record(steps[0]) : null;
  if (
    !sleep ||
    sleep.type !== "sleep" ||
    ![expectedName, `${expectedName}-1`].includes(String(sleep.name)) ||
    (allowTermination
      ? typeof sleep.finished !== "boolean"
      : sleep.finished !== false) ||
    (!allowTermination &&
      (sleep.error != null ||
        typeof sleep.end !== "string" ||
        Date.parse(sleep.end) !== params.runAtMs)) ||
    detail.output != null ||
    (!allowTermination && detail.error != null) ||
    (detail.step_count !== undefined &&
      (!positiveInteger(detail.step_count) ||
        (!allowTermination && detail.step_count !== allSteps.length)))
  )
    throw new Error("workflow-handoff-instance-not-in-initial-sleep");
}

export function assertRecreatedEventSleep(
  detail: unknown,
  params: EventProgressHandoffParams,
  nowMs = Date.now(),
): void {
  const value = record(detail);
  if (
    !["running", "waiting"].includes(String(value.status)) ||
    !positiveInteger(nowMs) ||
    !positiveInteger(params.runAtMs) ||
    params.runAtMs <= nowMs ||
    value.step_count !== 1 ||
    value.end != null ||
    value.success != null ||
    value.rollback != null ||
    canonicalJson(value.params) !== canonicalJson(params)
  )
    throw new Error("workflow-handoff-instance-not-in-future-initial-sleep");
  assertInitialSleep(value, params);
}

function assertOutbox(
  row: JsonRecord,
  params: EventProgressHandoffParams,
): void {
  if (
    row.outbox_id !== params.outboxId ||
    row.event_id !== params.eventId ||
    row.status !== "pending" ||
    row.run_at_ms !== params.runAtMs ||
    !positiveInteger(row.last_queued_at_ms) ||
    typeof row.record_json !== "string"
  )
    throw new Error("workflow-handoff-outbox-row-mismatch");
  let value: JsonRecord;
  try {
    value = record(JSON.parse(row.record_json));
  } catch {
    throw new Error("workflow-handoff-invalid-outbox-json");
  }
  if (
    value.schemaVersion !== params.schemaVersion ||
    value.eventId !== params.eventId ||
    value.reason !== params.reason ||
    value.sourceKey !== params.sourceKey ||
    value.runAtMs !== params.runAtMs ||
    !positiveInteger(value.firstQueuedAtMs) ||
    !positiveInteger(value.lastQueuedAtMs) ||
    value.lastQueuedAtMs !== row.last_queued_at_ms ||
    ((params.reason === "sunday-mons-reminder" ||
      params.reason === "event-prize-announcement") &&
      value.firstQueuedAtMs > params.runAtMs)
  )
    throw new Error("workflow-handoff-outbox-payload-mismatch");
}

async function readOutbox(
  query: SqlQuery,
  databaseId: string,
  params: EventProgressHandoffParams,
): Promise<JsonRecord> {
  const rows = await query(
    databaseId,
    `SELECT outbox_id, event_id, status, run_at_ms, last_queued_at_ms, record_json
     FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'pending'`,
    [params.outboxId],
  );
  if (rows.length !== 1) throw new Error("workflow-handoff-outbox-missing");
  const row = clone(record(rows[0]));
  assertOutbox(row, params);
  return row;
}

function validateManifest(manifest: WorkflowHandoffManifest): void {
  if (
    manifest.schemaVersion !== 1 ||
    !positiveInteger(manifest.capturedAtMs) ||
    !UUID.test(manifest.eventDatabaseId) ||
    !UUID.test(manifest.withdrawalDatabaseId) ||
    !Array.isArray(manifest.entries) ||
    !Array.isArray(manifest.completed)
  )
    throw new Error("workflow-handoff-invalid-manifest");
  if (manifest.targetWorkflowVersionId)
    version(manifest.targetWorkflowVersionId);
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    const params = parseParams(entry.params, entry.id);
    if (
      entry.original.workflowName !== EVENT_PROGRESS_WORKFLOW_NAME ||
      entry.original.id !== entry.id ||
      !["waiting", "running"].includes(entry.original.status) ||
      entry.original.detail.status !== entry.original.status ||
      entry.original.versionId !== entry.original.detail.versionId ||
      canonicalJson(params) !== canonicalJson(entry.original.detail.params) ||
      canonicalJson(entry.retention) !== canonicalJson(RETENTION) ||
      !STAGES.includes(entry.stage) ||
      seen.has(entry.id) ||
      entry.fingerprint !==
        fingerprint({ original: entry.original, outbox: entry.outbox })
    )
      throw new Error("workflow-handoff-manifest-entry-conflict");
    version(entry.original.versionId);
    assertRecreatedEventSleep(
      entry.original.detail,
      params,
      manifest.capturedAtMs,
    );
    assertOutbox(entry.outbox, params);
    if (!["captured", "pause-requested", "completed"].includes(entry.stage)) {
      if (!entry.pausedDetail || entry.pausedDetail.status !== "paused")
        throw new Error("workflow-handoff-paused-evidence-missing");
      assertIdentity(entry.pausedDetail, entry, entry.original.versionId);
      assertInitialSleep(entry.pausedDetail, params);
    }
    if (
      [
        "terminated",
        "delete-requested",
        "deleted",
        "create-requested",
        "recreated",
      ].includes(entry.stage)
    ) {
      if (
        !entry.terminatedDetail ||
        entry.terminatedDetail.status !== "terminated"
      )
        throw new Error("workflow-handoff-termination-evidence-missing");
      assertIdentity(entry.terminatedDetail, entry, entry.original.versionId);
      assertInitialSleep(entry.terminatedDetail, params, true);
    }
    if (entry.stage === "completed") {
      if (!entry.completedDetail || entry.completedDetail.status !== "complete")
        throw new Error("workflow-handoff-completion-evidence-missing");
      assertIdentity(entry.completedDetail, entry, entry.original.versionId);
    }
    seen.add(entry.id);
  }
  for (const item of manifest.completed) {
    instancePath(item.workflowName, item.id);
    if (
      item.status !== "complete" ||
      item.detail.status !== "complete" ||
      item.detail.versionId !== item.versionId ||
      (item.workflowName === EVENT_PROGRESS_WORKFLOW_NAME && seen.has(item.id))
    )
      throw new Error("workflow-handoff-completed-history-conflict");
    version(item.versionId);
  }
  clone(manifest);
}

export function assertWorkflowHandoffDeadlines(
  manifest: WorkflowHandoffManifest,
  nowMs = Date.now(),
  minimumLeadMs = WORKFLOW_HANDOFF_MINIMUM_LEAD_MS,
): void {
  if (!positiveInteger(nowMs) || !positiveInteger(minimumLeadMs))
    throw new Error("workflow-handoff-invalid-clock");
  for (const entry of manifest.entries) {
    if (
      ["captured", "pause-requested", "paused"].includes(entry.stage) &&
      entry.params.runAtMs - nowMs <= minimumLeadMs
    )
      throw new Error("workflow-handoff-scheduled-deadline-too-close");
  }
}

export async function captureWorkflowHandoff(
  dependencies: ReadDependencies & {
    query: SqlQuery;
    eventDatabaseId: string;
    withdrawalDatabaseId: string;
    now?: () => number;
  },
): Promise<WorkflowHandoffManifest> {
  const manifest: WorkflowHandoffManifest = {
    schemaVersion: 1,
    capturedAtMs: (dependencies.now || Date.now)(),
    eventDatabaseId: dependencies.eventDatabaseId,
    withdrawalDatabaseId: dependencies.withdrawalDatabaseId,
    entries: [],
    completed: [],
  };
  for (const workflowName of WORKFLOW_NAMES) {
    const instances = await listWorkflowInstances(
      dependencies.request,
      workflowName,
    );
    for (const summary of instances) {
      const id = String(summary.id);
      const detail = await readDetail(dependencies, workflowName, id);
      if (
        !detail ||
        detail.versionId !== summary.version_id ||
        (detail.status !== summary.status &&
          !(
            ["running", "waiting"].includes(String(detail.status)) &&
            ["running", "waiting"].includes(String(summary.status))
          ))
      )
        throw new Error("workflow-handoff-inventory-changed-during-capture");
      const snapshot: WorkflowInstanceSnapshot = {
        workflowName,
        id,
        versionId: version(summary.version_id),
        status: String(detail.status),
        summary,
        detail,
      };
      if (snapshot.status === "complete") {
        manifest.completed.push(snapshot);
        continue;
      }
      if (workflowName === WITHDRAWAL_WORKFLOW_NAME)
        throw new Error("workflow-handoff-noncomplete-withdrawal");
      if (!["waiting", "running"].includes(snapshot.status))
        throw new Error("workflow-handoff-unexpected-event-instance-status");
      const params = parseParams(detail.params, id);
      assertRecreatedEventSleep(
        detail,
        params,
        (dependencies.now || Date.now)(),
      );
      const outbox = await readOutbox(
        dependencies.query,
        dependencies.eventDatabaseId,
        params,
      );
      manifest.entries.push({
        id,
        original: snapshot,
        params,
        outbox,
        fingerprint: fingerprint({ original: snapshot, outbox }),
        retention: { ...RETENTION },
        stage: "captured",
      });
    }
  }
  const pending = await dependencies.query(
    dependencies.withdrawalDatabaseId,
    `SELECT COUNT(*) AS pending_count FROM event_prize_withdrawals
     WHERE json_extract(record_json, '$.status') IN ('processing', 'submitted')`,
  );
  if (pending.length !== 1 || pending[0].pending_count !== 0)
    throw new Error("workflow-handoff-pending-withdrawal-records");
  validateManifest(manifest);
  assertWorkflowHandoffDeadlines(manifest, (dependencies.now || Date.now)());
  return manifest;
}

async function checkpoint(
  dependencies: MutationDependencies,
  manifest: WorkflowHandoffManifest,
): Promise<void> {
  await dependencies.persist(clone(manifest));
}

function assertIdentity(
  detail: JsonRecord,
  entry: WorkflowHandoffEntry,
  expectedVersion: string,
): void {
  if (
    detail.versionId !== expectedVersion ||
    canonicalJson(parseParams(detail.params, entry.id)) !==
      canonicalJson(entry.params)
  )
    throw new Error("workflow-handoff-live-instance-identity-conflict");
}

async function assertNoUnexpectedInstances(
  dependencies: ReadDependencies,
  manifest: WorkflowHandoffManifest,
): Promise<void> {
  const ids = new Set(manifest.entries.map((entry) => entry.id));
  for (const name of WORKFLOW_NAMES) {
    for (const item of await listWorkflowInstances(
      dependencies.request,
      name,
    )) {
      if (item.status === "complete") continue;
      if (name === WITHDRAWAL_WORKFLOW_NAME || !ids.has(String(item.id)))
        throw new Error("workflow-handoff-unexpected-live-instance");
    }
  }
}

export async function pauseWorkflowHandoff(
  dependencies: MutationDependencies,
): Promise<WorkflowHandoffManifest> {
  const manifest = clone(dependencies.manifest);
  validateManifest(manifest);
  assertWorkflowHandoffDeadlines(manifest, (dependencies.now || Date.now)());
  await assertNoUnexpectedInstances(dependencies, manifest);
  for (const entry of manifest.entries) {
    if (!["captured", "pause-requested", "paused"].includes(entry.stage))
      continue;
    let detail = await readDetail(
      dependencies,
      EVENT_PROGRESS_WORKFLOW_NAME,
      entry.id,
    );
    if (!detail) throw new Error("workflow-handoff-original-instance-missing");
    assertIdentity(detail, entry, entry.original.versionId);
    if (detail.status === "complete") {
      entry.stage = "completed";
      entry.completedDetail = detail;
      await checkpoint(dependencies, manifest);
      continue;
    }
    assertInitialSleep(detail, entry.params);
    if (detail.status === "paused") {
      if (entry.stage === "captured")
        throw new Error("workflow-handoff-preexisting-pause-detected");
    } else {
      if (
        !["waiting", "running", "waitingForPause"].includes(
          String(detail.status),
        )
      )
        throw new Error("workflow-handoff-instance-not-pausable");
      if (detail.status === "waiting" || detail.status === "running")
        assertRecreatedEventSleep(
          detail,
          entry.params,
          (dependencies.now || Date.now)(),
        );
      entry.stage = "pause-requested";
      await checkpoint(dependencies, manifest);
      if (detail.status !== "waitingForPause") {
        await dependencies
          .request(
            instancePath(EVENT_PROGRESS_WORKFLOW_NAME, entry.id) + "/status",
            "PATCH",
            { status: "pause" },
          )
          .catch(() => undefined);
      }
      detail = await readDetail(
        dependencies,
        EVENT_PROGRESS_WORKFLOW_NAME,
        entry.id,
      );
      if (!detail)
        throw new Error("workflow-handoff-original-instance-missing");
      assertIdentity(detail, entry, entry.original.versionId);
      if (detail.status === "complete") {
        entry.stage = "completed";
        entry.completedDetail = detail;
        await checkpoint(dependencies, manifest);
        continue;
      }
      if (detail.status !== "paused")
        throw new WorkflowHandoffPendingError("pause");
      assertInitialSleep(detail, entry.params);
    }
    entry.stage = "paused";
    entry.pausedDetail = detail;
    await checkpoint(dependencies, manifest);
  }
  return manifest;
}

export async function getPublishedWorkflowVersion(
  request: CloudflareRequest,
  workflowName: string,
): Promise<string> {
  const className =
    workflowName === EVENT_PROGRESS_WORKFLOW_NAME
      ? "EventProgressWorkflow"
      : workflowName === WITHDRAWAL_WORKFLOW_NAME
        ? "EventPrizeWithdrawalWorkflow"
        : null;
  if (!className) throw new Error("workflow-handoff-unowned-workflow");
  const resource = record(await request(`/workflows/${workflowName}`));
  if (
    typeof resource.id !== "string" ||
    !UUID.test(resource.id) ||
    resource.name !== workflowName ||
    resource.script_name !== "mons-link-api" ||
    resource.class_name !== className ||
    (resource.is_deleted !== undefined && resource.is_deleted !== 0) ||
    (resource.terminator_running !== undefined &&
      resource.terminator_running !== 0)
  )
    throw new Error("workflow-handoff-definition-ownership-conflict");
  if (resource.version_id !== undefined) return version(resource.version_id);
  const versions = await request(
    `/workflows/${workflowName}/versions?per_page=1`,
  );
  if (!Array.isArray(versions) || versions.length !== 1)
    throw new Error("workflow-handoff-published-version-unavailable");
  const current = record(versions[0]);
  if (current.workflow_id !== resource.id || current.class_name !== className)
    throw new Error("workflow-handoff-published-version-owner-conflict");
  return version(current.id);
}

async function assertPublished(
  request: CloudflareRequest,
  target: string,
): Promise<void> {
  if (
    (await getPublishedWorkflowVersion(
      request,
      EVENT_PROGRESS_WORKFLOW_NAME,
    )) !== target
  )
    throw new Error("workflow-handoff-target-definition-not-published");
}

export async function executeWorkflowHandoff(
  dependencies: MutationDependencies & {
    query: SqlQuery;
    eventDatabaseId: string;
    targetWorkflowVersionId: string;
  },
): Promise<WorkflowHandoffManifest> {
  const manifest = clone(dependencies.manifest);
  validateManifest(manifest);
  const target = version(dependencies.targetWorkflowVersionId);
  if (
    manifest.entries.some((entry) => entry.original.versionId === target) ||
    (manifest.targetWorkflowVersionId &&
      manifest.targetWorkflowVersionId !== target) ||
    manifest.entries.some((entry) =>
      ["captured", "pause-requested"].includes(entry.stage),
    )
  )
    throw new Error("workflow-handoff-not-ready-for-replacement");
  await assertPublished(dependencies.request, target);
  await assertNoUnexpectedInstances(dependencies, manifest);
  manifest.targetWorkflowVersionId = target;
  await checkpoint(dependencies, manifest);
  for (const entry of manifest.entries) {
    if (entry.stage === "completed") continue;
    let detail = await readDetail(
      dependencies,
      EVENT_PROGRESS_WORKFLOW_NAME,
      entry.id,
    );
    if (
      detail?.versionId === entry.original.versionId &&
      detail.status === "complete"
    ) {
      assertIdentity(detail, entry, entry.original.versionId);
      entry.stage = "completed";
      entry.completedDetail = detail;
      await checkpoint(dependencies, manifest);
      continue;
    }
    const outbox = await readOutbox(
      dependencies.query,
      dependencies.eventDatabaseId,
      entry.params,
    );
    if (canonicalJson(outbox) !== canonicalJson(entry.outbox))
      throw new Error("workflow-handoff-destination-outbox-changed");
    if (detail?.versionId === target) {
      assertIdentity(detail, entry, target);
      if (!["create-requested", "recreated"].includes(entry.stage))
        throw new Error("workflow-handoff-unexpected-replacement-instance");
      if (detail.status === "queued")
        throw new WorkflowHandoffPendingError("recreation-start");
      assertRecreatedEventSleep(
        detail,
        entry.params,
        (dependencies.now || Date.now)(),
      );
      entry.stage = "recreated";
      entry.recreatedDetail = detail;
      await checkpoint(dependencies, manifest);
      continue;
    }
    if (detail) {
      assertIdentity(detail, entry, entry.original.versionId);
      if (detail.status === "complete") {
        entry.stage = "completed";
        entry.completedDetail = detail;
        await checkpoint(dependencies, manifest);
        continue;
      }
      if (["deleted", "create-requested", "recreated"].includes(entry.stage))
        throw new Error("workflow-handoff-deleted-instance-reappeared");
      if (detail.status === "paused") {
        assertInitialSleep(detail, entry.params);
        if (entry.stage === "paused")
          assertWorkflowHandoffDeadlines(
            { ...manifest, entries: [entry] },
            (dependencies.now || Date.now)(),
          );
        entry.stage = "terminate-requested";
        await checkpoint(dependencies, manifest);
        await dependencies
          .request(
            instancePath(EVENT_PROGRESS_WORKFLOW_NAME, entry.id) + "/status",
            "PATCH",
            { status: "terminate", rollback: false },
          )
          .catch(() => undefined);
        detail = await readDetail(
          dependencies,
          EVENT_PROGRESS_WORKFLOW_NAME,
          entry.id,
        );
        if (!detail)
          throw new Error("workflow-handoff-original-instance-missing");
        assertIdentity(detail, entry, entry.original.versionId);
        if (detail.status === "complete") {
          entry.stage = "completed";
          entry.completedDetail = detail;
          await checkpoint(dependencies, manifest);
          continue;
        }
      }
      if (detail.status !== "terminated")
        throw new WorkflowHandoffPendingError("termination");
      if (
        !["terminate-requested", "terminated", "delete-requested"].includes(
          entry.stage,
        )
      )
        throw new Error("workflow-handoff-unexpected-termination");
      assertInitialSleep(detail, entry.params, true);
      entry.stage = "terminated";
      entry.terminatedDetail = detail;
      await checkpoint(dependencies, manifest);
      await assertPublished(dependencies.request, target);
      entry.stage = "delete-requested";
      await checkpoint(dependencies, manifest);
      await dependencies
        .request(
          `/workflows/${EVENT_PROGRESS_WORKFLOW_NAME}/instances/batch/delete`,
          "POST",
          { instances: [entry.id] },
        )
        .catch(() => undefined);
      detail = await readDetail(
        dependencies,
        EVENT_PROGRESS_WORKFLOW_NAME,
        entry.id,
      );
      if (detail) throw new WorkflowHandoffPendingError("deletion");
    } else if (
      !["delete-requested", "deleted", "create-requested"].includes(entry.stage)
    ) {
      throw new Error("workflow-handoff-instance-disappeared-before-delete");
    }
    entry.stage = "deleted";
    await checkpoint(dependencies, manifest);
    await assertPublished(dependencies.request, target);
    entry.stage = "create-requested";
    await checkpoint(dependencies, manifest);
    await dependencies
      .request(`/workflows/${EVENT_PROGRESS_WORKFLOW_NAME}/instances`, "POST", {
        instance_id: entry.id,
        params: entry.params,
        instance_retention: entry.retention,
      })
      .catch(() => undefined);
    detail = await readDetail(
      dependencies,
      EVENT_PROGRESS_WORKFLOW_NAME,
      entry.id,
    );
    if (!detail) throw new WorkflowHandoffPendingError("creation");
    assertIdentity(detail, entry, target);
    if (detail.status === "queued")
      throw new WorkflowHandoffPendingError("recreation-start");
    assertRecreatedEventSleep(
      detail,
      entry.params,
      (dependencies.now || Date.now)(),
    );
    entry.stage = "recreated";
    entry.recreatedDetail = detail;
    await checkpoint(dependencies, manifest);
  }
  await verifyWorkflowHandoff({ ...dependencies, manifest });
  return manifest;
}

export async function verifyWorkflowHandoff(
  dependencies: ReadDependencies & {
    manifest: WorkflowHandoffManifest;
    targetWorkflowVersionId: string;
    now?: () => number;
  },
): Promise<WorkflowHandoffVerification> {
  const { manifest } = dependencies;
  validateManifest(manifest);
  const target = version(dependencies.targetWorkflowVersionId);
  if (manifest.targetWorkflowVersionId !== target)
    throw new Error("workflow-handoff-target-version-mismatch");
  await assertPublished(dependencies.request, target);
  const planned = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const present = new Set<string>();
  for (const name of WORKFLOW_NAMES) {
    for (const item of await listWorkflowInstances(
      dependencies.request,
      name,
    )) {
      if (name === EVENT_PROGRESS_WORKFLOW_NAME) present.add(String(item.id));
      if (item.status === "complete") continue;
      if (
        name === WITHDRAWAL_WORKFLOW_NAME ||
        item.version_id !== target ||
        !planned.has(String(item.id))
      )
        throw new Error(
          "workflow-handoff-old-or-unexpected-nonterminal-instance",
        );
    }
  }
  let migrated = 0;
  let completedDuringHandoff = 0;
  for (const entry of manifest.entries) {
    if (!present.has(entry.id))
      throw new Error("workflow-handoff-replacement-not-listed");
    const detail = await readDetail(
      dependencies,
      EVENT_PROGRESS_WORKFLOW_NAME,
      entry.id,
    );
    if (!detail) throw new Error("workflow-handoff-replacement-missing");
    if (entry.stage === "completed") {
      assertIdentity(detail, entry, entry.original.versionId);
      if (
        detail.status !== "complete" ||
        canonicalJson(detail) !== canonicalJson(entry.completedDetail)
      )
        throw new Error("workflow-handoff-completed-result-changed");
      completedDuringHandoff++;
    } else {
      if (entry.stage !== "recreated")
        throw new Error("workflow-handoff-replacement-unfinished");
      assertIdentity(detail, entry, target);
      assertRecreatedEventSleep(
        detail,
        entry.params,
        (dependencies.now || Date.now)(),
      );
      migrated++;
    }
  }
  let completedHistoriesPreserved = 0;
  const expiredCompletedHistories: WorkflowHandoffVerification["expiredCompletedHistories"] =
    [];
  for (const item of manifest.completed) {
    const detail = await readDetail(dependencies, item.workflowName, item.id);
    if (!detail) {
      expiredCompletedHistories.push({
        workflowName: item.workflowName,
        id: item.id,
      });
      continue;
    }
    if (canonicalJson(detail) !== canonicalJson(item.detail))
      throw new Error("workflow-handoff-completed-history-changed");
    completedHistoriesPreserved++;
  }
  return {
    migrated,
    completedDuringHandoff,
    completedHistoriesPreserved,
    expiredCompletedHistories,
    oldVersionNonterminal: 0,
  };
}
