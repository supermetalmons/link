import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  compareFirebaseKeys,
  createFirebaseTokenProvider,
  createWranglerRunner,
  digest,
  privateDirectory,
  readPrivateJson,
  readResponseJson,
  writePrivateImmutable,
  type SqlRunner,
} from "./manage-wager-state.ts";
import { resolveCloudflareToken } from "./manage-invite-source.ts";
import {
  normalizeEventTransitionReceiptRow,
  type EventTransitionReceiptRow,
} from "../cloud/workers/api/src/eventTransitionReceipts.ts";

type JsonRecord = Record<string, unknown>;
type Operation =
  | "status"
  | "preflight"
  | "freeze"
  | "export"
  | "import"
  | "verify"
  | "activate"
  | "resume"
  | "abort";
type Arguments = {
  operation: Operation;
  directory?: string;
  candidateVersionId?: string;
  firebaseCredentials?: string;
  pageSize: number;
};
type Gate = { storageMode: "d1" | "frozen"; freezeGeneration: number };
type Maintenance = Gate & {
  admissions: number;
  leases: number;
  intents: number;
  effectAdmissions: number;
  otherGates: JsonRecord;
};
type Control = {
  state: "absent" | "importing" | "active";
  [key: string]: unknown;
};
type SourceSummary = { count: number; digest: string };
type Session = {
  schemaVersion: 1;
  id: string;
  createdAtMs: number;
  previousVersionId: string;
  candidateVersionId: string;
  previousGate: Gate;
  freezeGeneration: number;
  otherGates: JsonRecord;
};
type SourcePage = {
  index: number;
  after: string | null;
  rows: EventTransitionReceiptRow[];
};
type Manifest = {
  schemaVersion: 1;
  sessionId: string;
  exportedAtMs: number;
  pageSize: number;
  source: SourceSummary;
  pages: { count: number; digest: string }[];
};
type Workflow = {
  id: string;
  version_id: string;
  status: string;
  [key: string]: unknown;
};
type WorkflowEvidence = {
  workflow: Workflow;
  outbox: JsonRecord;
  params: JsonRecord;
  sleepName: string;
  runAtMs: number;
};
type Dependencies = {
  now(): number;
  log(value: JsonRecord): void;
  run: SqlRunner;
  sourcePage(after: string | null, pageSize: number): Promise<unknown>;
  maintenance(): Promise<Maintenance>;
  control(): Promise<Control>;
  deployment(): Promise<string>;
  deploy(versionId: string): Promise<void>;
  workflowPage(
    page: number,
  ): Promise<{ rows: Workflow[]; totalPages: number; totalCount: number }>;
  workflow(id: string): Promise<Workflow | null>;
  workflowVersions(): Promise<string[]>;
  registerWorkflow(): Promise<string>;
  terminate(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  create(id: string, params: JsonRecord): Promise<void>;
  outbox(id: string): Promise<JsonRecord>;
};
const ROOT = resolve(import.meta.dirname, "..");
const GAMEPLAY_DB = "mons-link-profile-games";
const EVENT_DB = "mons-link-events";
const FIREBASE_ROOT = "https://mons-link-default-rtdb.firebaseio.com";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TERMINAL = new Set(["complete", "errored", "terminated"]);
const MAX_PAGES = 100_000;
const BATCH_SIZE = 10;
function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function parseArgs(argv: string[]): Arguments {
  const operation = argv[0]?.replace(/^--/, "") as Operation;
  if (
    ![
      "status",
      "preflight",
      "freeze",
      "export",
      "import",
      "verify",
      "activate",
      "resume",
      "abort",
    ].includes(operation)
  )
    throw new Error(
      "choose --status, --preflight, --freeze, --export, --import, --verify, --activate, --resume or --abort",
    );
  const options = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i],
      value = argv[i + 1];
    if (
      ![
        "--directory",
        "--candidate-version-id",
        "--firebase-credentials",
        "--page-size",
      ].includes(key) ||
      !value ||
      value.startsWith("--") ||
      options.has(key)
    )
      throw new Error("invalid receipt migration arguments");
    options.set(key, value);
  }
  const directory = options.get("--directory"),
    candidateVersionId = options.get("--candidate-version-id"),
    firebaseCredentials = options.get("--firebase-credentials");
  const pageSize = Number(options.get("--page-size") || 100);
  if (!integer(pageSize) || pageSize < 1 || pageSize > 100)
    throw new Error("page size must be 1 to 100");
  if (operation === "status" && options.size)
    throw new Error("status takes no options");
  if (
    !["status", "preflight"].includes(operation) &&
    (!directory || !isAbsolute(directory))
  )
    throw new Error(
      "an absolute private --directory outside the repository is required",
    );
  if (directory && operation === "preflight")
    throw new Error("preflight writes no artifacts");
  if (firebaseCredentials && !isAbsolute(firebaseCredentials))
    throw new Error("credential path must be absolute");
  if (candidateVersionId && !UUID.test(candidateVersionId))
    throw new Error("invalid candidate version UUID");
  if (operation === "freeze" && !candidateVersionId)
    throw new Error("freeze requires the uploaded --candidate-version-id");
  if (
    options.has("--page-size") &&
    !["preflight", "export"].includes(operation)
  )
    throw new Error("page size only applies to preflight and export");
  return {
    operation,
    directory,
    candidateVersionId,
    firebaseCredentials,
    pageSize,
  };
}
function parseSession(value: unknown): Session {
  const s = record(value),
    gate = record(s?.previousGate);
  if (
    !s ||
    s.schemaVersion !== 1 ||
    typeof s.id !== "string" ||
    !UUID.test(s.id) ||
    !integer(s.createdAtMs) ||
    typeof s.previousVersionId !== "string" ||
    !UUID.test(s.previousVersionId) ||
    typeof s.candidateVersionId !== "string" ||
    !UUID.test(s.candidateVersionId) ||
    !gate ||
    !["d1", "frozen"].includes(String(gate.storageMode)) ||
    !integer(gate.freezeGeneration) ||
    !integer(s.freezeGeneration) ||
    s.freezeGeneration !==
      gate.freezeGeneration + Number(gate.storageMode === "d1") ||
    !record(s.otherGates)
  )
    throw new Error("invalid immutable cutover session");
  return s as Session;
}
function assertDrained(state: Maintenance): void {
  if (
    state.admissions ||
    state.leases ||
    state.intents ||
    state.effectAdmissions
  )
    throw new Error(
      "event cutover has admissions, active leases or transition intents; keep current controls and reconcile before retry",
    );
}
async function assertFrozen(
  deps: Dependencies,
  session: Session,
): Promise<void> {
  const state = await deps.maintenance();
  assertDrained(state);
  if (
    state.storageMode !== "frozen" ||
    state.freezeGeneration !== session.freezeGeneration ||
    !equal(state.otherGates, session.otherGates)
  )
    throw new Error(
      "event freeze generation or unrelated maintenance gates changed",
    );
}
async function requireVersion(
  deps: Dependencies,
  version: string,
): Promise<void> {
  if ((await deps.deployment()) !== version)
    throw new Error("expected version is not the sole 100% API deployment");
}
async function listWorkflows(deps: Dependencies): Promise<Workflow[]> {
  const result: Workflow[] = [],
    ids = new Set<string>();
  let totalPages = 1,
    totalCount = -1;
  for (let page = 1; page <= totalPages; page++) {
    const response = await deps.workflowPage(page);
    if (
      !integer(response.totalCount) ||
      (page > 1 && response.totalCount !== totalCount) ||
      !integer(response.totalPages) ||
      response.totalPages < page ||
      response.totalPages > MAX_PAGES ||
      (page > 1 && response.totalPages !== totalPages)
    )
      throw new Error("Workflow pagination changed or is invalid");
    totalPages = response.totalPages;
    totalCount = response.totalCount;
    for (const row of response.rows) {
      if (ids.has(row.id))
        throw new Error("Workflow pagination returned duplicate instances");
      ids.add(row.id);
      result.push(row);
    }
  }
  if (result.length !== totalCount)
    throw new Error("Workflow pagination returned incomplete coverage");
  return result;
}
function parseWorkflow(value: unknown): Workflow {
  const row = record(value);
  if (
    !row ||
    typeof row.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(row.id) ||
    typeof row.version_id !== "string" ||
    !UUID.test(row.version_id) ||
    typeof row.status !== "string"
  )
    throw new Error("invalid Workflow response");
  return row as Workflow;
}
class WorkflowStartupPending extends Error {}
function auditWorkflow(
  workflow: Workflow,
  outbox: JsonRecord,
  nowMs: number,
): WorkflowEvidence {
  const params = record(workflow.params);
  if (
    !params ||
    params.schemaVersion !== 1 ||
    Object.keys(params).length !== 6 ||
    typeof params.eventId !== "string" ||
    typeof params.sourceKey !== "string" ||
    !params.sourceKey.trim() ||
    typeof params.reason !== "string" ||
    !integer(params.runAtMs) ||
    params.runAtMs <= nowMs
  )
    throw new Error(
      "Workflow is not a future scheduled instance with an intact payload",
    );
  const identity = createHash("sha256")
    .update(`${params.eventId}\n${params.sourceKey}`)
    .digest("hex");
  if (
    workflow.id !== `event-progress-${identity}` ||
    params.outboxId !== `ep_${identity}`
  )
    throw new Error("Workflow identity and payload conflict");
  const source = record(
    outbox.record_json && typeof outbox.record_json === "string"
      ? JSON.parse(outbox.record_json)
      : null,
  );
  if (
    !source ||
    outbox.status !== "pending" ||
    outbox.outbox_id !== params.outboxId ||
    outbox.event_id !== params.eventId ||
    outbox.run_at_ms !== params.runAtMs ||
    outbox.last_queued_at_ms !== source.lastQueuedAtMs ||
    !integer(source.firstQueuedAtMs) ||
    !integer(source.lastQueuedAtMs) ||
    source.firstQueuedAtMs > source.lastQueuedAtMs ||
    source.firstQueuedAtMs > params.runAtMs ||
    !equal(params, {
      schemaVersion: source.schemaVersion,
      eventId: source.eventId,
      sourceKey: source.sourceKey,
      reason: source.reason,
      runAtMs: source.runAtMs,
      outboxId: params.outboxId,
    })
  )
    throw new Error(
      "Workflow payload, source hash, schedule or outbox timestamps conflict",
    );
  const sleepName =
    params.reason === "event-prize-announcement"
      ? "wait for prize announcement"
      : params.reason === "sunday-mons-reminder"
        ? "wait for sunday mons reminder"
        : "wait for scheduled event";
  const steps = workflow.steps;
  if (
    Array.isArray(steps) &&
    steps.length === 0 &&
    workflow.step_count === 0 &&
    ["queued", "running", "waiting"].includes(workflow.status) &&
    workflow.end === null &&
    workflow.error === null
  )
    throw new WorkflowStartupPending(
      "Workflow initial scheduled sleep is not visible yet; keep events frozen and retry restoration",
    );
  if (!Array.isArray(steps) || steps.length !== 1)
    throw new Error(
      "Workflow has advanced beyond its initial scheduled sleep; reconcile without recreation",
    );
  const step = record(steps[0]);
  if (
    !step ||
    step.name !== `${sleepName}-1` ||
    step.type !== "sleep" ||
    !["waiting", "running"].includes(workflow.status) ||
    workflow.step_count !== 1 ||
    workflow.end !== null ||
    workflow.error !== null ||
    step.finished !== false ||
    step.error !== null ||
    typeof step.start !== "string" ||
    !Number.isFinite(Date.parse(step.start)) ||
    Date.parse(step.start) >= params.runAtMs ||
    typeof step.end !== "string" ||
    Date.parse(step.end) !== params.runAtMs
  )
    throw new Error(
      "Workflow has effect execution evidence or an unrecognized initial sleep",
    );
  return { workflow, outbox, params, sleepName, runAtMs: params.runAtMs };
}
async function captureWorkflows(
  deps: Dependencies,
): Promise<WorkflowEvidence[]> {
  const result: WorkflowEvidence[] = [];
  for (const row of await listWorkflows(deps)) {
    if (TERMINAL.has(row.status)) continue;
    const workflow = await deps.workflow(row.id);
    if (!workflow) throw new Error("Workflow disappeared during audit");
    const params = record(workflow.params);
    if (typeof params?.outboxId !== "string")
      throw new Error("Workflow payload missing");
    result.push(
      auditWorkflow(workflow, await deps.outbox(params.outboxId), deps.now()),
    );
  }
  return result;
}
function loadEvidence(directory: string): WorkflowEvidence[] {
  const value = readPrivateJson(resolve(directory, "workflows.json"));
  if (!Array.isArray(value))
    throw new Error("invalid Workflow evidence archive");
  const seen = new Set<string>();
  return value.map((entry) => {
    const saved = record(entry);
    if (
      !saved ||
      !record(saved.outbox) ||
      !record(saved.workflow) ||
      !integer(saved.runAtMs)
    )
      throw new Error("invalid Workflow evidence");
    const evidence = auditWorkflow(
      parseWorkflow(saved.workflow),
      saved.outbox as JsonRecord,
      saved.runAtMs - 1,
    );
    if (!equal(evidence, saved) || seen.has(evidence.workflow.id))
      throw new Error("conflicting Workflow evidence");
    seen.add(evidence.workflow.id);
    return evidence;
  });
}
async function terminateOriginals(
  deps: Dependencies,
  session: Session,
  evidence: WorkflowEvidence[],
): Promise<void> {
  for (const saved of evidence) {
    await assertFrozen(deps, session);
    let current = await deps.workflow(saved.workflow.id);
    if (!current || current.version_id !== saved.workflow.version_id)
      throw new Error(
        "original Workflow missing or version changed before termination",
      );
    if (current.status !== "terminated") {
      const checked = auditWorkflow(
        current,
        await deps.outbox(String(saved.params.outboxId)),
        deps.now(),
      );
      if (
        !equal(checked.params, saved.params) ||
        !equal(checked.outbox, saved.outbox)
      )
        throw new Error("Workflow changed since audit");
      await deps.terminate(current.id);
      current = await deps.workflow(current.id);
    }
    if (current?.status !== "terminated")
      throw new Error(
        "Workflow termination not yet confirmed; keep events frozen and retry freeze",
      );
  }
  await assertNoLiveOriginals(deps, evidence);
}
async function assertNoLiveOriginals(
  deps: Dependencies,
  evidence: WorkflowEvidence[],
): Promise<void> {
  const saved = new Map(evidence.map((entry) => [entry.workflow.id, entry]));
  for (const row of await listWorkflows(deps)) {
    if (!TERMINAL.has(row.status))
      throw new Error(
        "a live event-progress Workflow remains; activation requires every original terminated",
      );
    if (saved.has(row.id) && row.status !== "terminated")
      throw new Error("captured Workflow advanced during cutover");
  }
  for (const entry of evidence) {
    const row = await deps.workflow(entry.workflow.id);
    if (
      !row ||
      row.status !== "terminated" ||
      row.version_id !== entry.workflow.version_id
    )
      throw new Error("original Workflow termination evidence changed");
    if (!equal(await deps.outbox(String(entry.params.outboxId)), entry.outbox))
      throw new Error("preserved event outbox changed");
  }
}
function normalizeSourcePage(
  value: unknown,
  index: number,
  after: string | null,
  pageSize: number,
  recordedAtMs: number,
): SourcePage {
  const source = value === null ? {} : record(value);
  if (!source) throw new Error("invalid Firebase receipt page");
  const keys = Object.keys(source).sort(compareFirebaseKeys);
  if (
    keys.length > pageSize + Number(after !== null) ||
    (after !== null && keys[0] !== after)
  )
    throw new Error("Firebase receipt pagination cursor changed");
  const selected = after === null ? keys : keys.slice(1);
  if (
    selected.some(
      (key) => after !== null && compareFirebaseKeys(key, after) <= 0,
    )
  )
    throw new Error("Firebase receipt pagination failed to advance");
  return {
    index,
    after,
    rows: selected.map((key) =>
      normalizeEventTransitionReceiptRow(key, source[key], recordedAtMs),
    ),
  };
}
function sourceAccumulator() {
  const hash = createHash("sha256");
  let count = 0;
  return {
    add(page: SourcePage) {
      for (const row of page.rows) {
        hash.update(
          canonicalJson([row.transition_id, JSON.parse(row.receipt_json)]) +
            "\n",
        );
        count++;
      }
    },
    finish(): SourceSummary {
      return { count, digest: hash.digest("hex") };
    },
  };
}
async function scanSource(
  deps: Dependencies,
  pageSize: number,
  recordedAtMs: number,
  onPage?: (page: SourcePage) => void,
): Promise<SourceSummary> {
  const accumulator = sourceAccumulator();
  let after: string | null = null;
  for (let index = 0; index < MAX_PAGES; index++) {
    const page = normalizeSourcePage(
      await deps.sourcePage(after, pageSize),
      index,
      after,
      pageSize,
      recordedAtMs,
    );
    if (!page.rows.length) return accumulator.finish();
    accumulator.add(page);
    onPage?.(page);
    after = page.rows.at(-1)!.transition_id;
  }
  throw new Error("receipt source pagination limit exceeded");
}
function sourcePath(directory: string, index: number): string {
  return resolve(directory, `source-${String(index).padStart(6, "0")}.json`);
}
function loadExport(
  directory: string,
  session: Session,
): { manifest: Manifest; pages: SourcePage[] } {
  const raw = record(readPrivateJson(resolve(directory, "manifest.json")));
  if (
    !raw ||
    raw.schemaVersion !== 1 ||
    raw.sessionId !== session.id ||
    !integer(raw.exportedAtMs) ||
    raw.exportedAtMs < session.createdAtMs ||
    !integer(raw.pageSize) ||
    raw.pageSize < 1 ||
    raw.pageSize > 100 ||
    !Array.isArray(raw.pages) ||
    raw.pages.length > MAX_PAGES ||
    !record(raw.source)
  )
    throw new Error("invalid receipt export manifest");
  const manifest = raw as Manifest,
    accumulator = sourceAccumulator(),
    pages: SourcePage[] = [];
  let after: string | null = null;
  for (let index = 0; index < manifest.pages.length; index++) {
    const rawPage = record(readPrivateJson(sourcePath(directory, index)));
    if (
      !rawPage ||
      rawPage.index !== index ||
      rawPage.after !== after ||
      !Array.isArray(rawPage.rows) ||
      rawPage.rows.length < 1 ||
      rawPage.rows.length > manifest.pageSize
    )
      throw new Error("invalid immutable receipt page");
    const rows = rawPage.rows.map((value) => {
      const row = record(value);
      if (
        !row ||
        typeof row.transition_id !== "string" ||
        typeof row.receipt_json !== "string"
      )
        throw new Error("invalid exported receipt row");
      const parsed = normalizeEventTransitionReceiptRow(
        row.transition_id,
        JSON.parse(row.receipt_json),
        manifest.exportedAtMs,
      );
      if (
        !equal(parsed, row) ||
        (after !== null &&
          compareFirebaseKeys(parsed.transition_id, after) <= 0)
      )
        throw new Error("unordered, malformed or noncanonical receipt page");
      after = parsed.transition_id;
      return parsed;
    });
    const page: SourcePage = {
      index,
      after: rawPage.after as string | null,
      rows,
    };
    if (
      !equal(manifest.pages[index], {
        count: rows.length,
        digest: digest(page),
      })
    )
      throw new Error("receipt page content digest mismatch");
    accumulator.add(page);
    pages.push(page);
  }
  if (!equal(manifest.source, accumulator.finish()))
    throw new Error("receipt source coverage digest mismatch");
  return { manifest, pages };
}
async function verifyDestination(
  deps: Dependencies,
  manifest: Manifest,
  pages: SourcePage[],
): Promise<void> {
  for (const page of pages)
    for (let offset = 0; offset < page.rows.length; offset += BATCH_SIZE) {
      const rows = page.rows.slice(offset, offset + BATCH_SIZE);
      const stored = await deps.run(
        `SELECT * FROM event_transition_receipts WHERE transition_id IN (${rows.map(() => "?").join(",")})`,
        GAMEPLAY_DB,
        rows.map((row) => row.transition_id),
      );
      const map = new Map(stored.map((row) => [row.transition_id, row]));
      if (
        stored.length !== rows.length ||
        rows.some(
          (row) =>
            !map.has(row.transition_id) ||
            !integer(map.get(row.transition_id)?.recorded_at_ms) ||
            !equal(
              {
                ...map.get(row.transition_id),
                recorded_at_ms: row.recorded_at_ms,
              },
              row,
            ),
        )
      )
        throw new Error(
          "receipt destination is incomplete or conflicts with immutable source",
        );
    }
  const count = (
    await deps.run(
      "SELECT COUNT(*) AS count FROM event_transition_receipts",
      GAMEPLAY_DB,
    )
  )[0]?.count;
  if (count !== manifest.source.count)
    throw new Error("receipt destination has missing or extra keys");
}
async function restoreWorkflows(
  deps: Dependencies,
  session: Session,
  evidence: WorkflowEvidence[],
  versionId: string,
  expectedWorkflowVersion: string,
): Promise<void> {
  await requireVersion(deps, versionId);
  const savedIds = new Set(evidence.map((entry) => entry.workflow.id));
  for (const row of await listWorkflows(deps))
    if (!TERMINAL.has(row.status) && !savedIds.has(row.id))
      throw new Error("unexpected live Workflow during restoration");
  for (const saved of evidence) {
    await assertFrozen(deps, session);
    await requireVersion(deps, versionId);
    if (!equal(await deps.outbox(String(saved.params.outboxId)), saved.outbox))
      throw new Error(
        "original outbox changed; refusing to reset its schedule",
      );
    let current = await deps.workflow(saved.workflow.id);
    if (
      versionId === session.previousVersionId &&
      current?.version_id === saved.workflow.version_id &&
      current.status !== "terminated"
    ) {
      const checked = auditWorkflow(
        current,
        await deps.outbox(String(saved.params.outboxId)),
        deps.now(),
      );
      if (
        !equal(checked.params, saved.params) ||
        !equal(checked.outbox, saved.outbox)
      )
        throw new Error("untouched original Workflow changed during abort");
      continue;
    }
    if (current?.status === "terminated") {
      if (current.version_id !== saved.workflow.version_id)
        throw new Error("unexpected terminated Workflow version");
      await deps.delete(current.id);
      for (let attempt = 0; attempt < 3; attempt++) {
        current = await deps.workflow(saved.workflow.id);
        if (!current) break;
        if (
          current.status !== "terminated" ||
          current.version_id !== saved.workflow.version_id
        )
          throw new Error(
            "Workflow changed during deletion; keep events frozen and reconcile",
          );
      }
      if (current)
        throw new Error(
          "Workflow deletion is still propagating after bounded readback; keep events frozen and retry restoration",
        );
    }
    if (!current) {
      if (saved.runAtMs <= deps.now())
        throw new Error(
          "preserved Workflow schedule became due; reconcile before recreation",
        );
      await deps.create(saved.workflow.id, saved.params);
      current = null;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      current ||= await deps.workflow(saved.workflow.id);
      if (!current) {
        if (attempt === 2)
          throw new Error(
            "replacement Workflow is not visible yet after bounded readback; keep events frozen and retry restoration",
          );
        continue;
      }
      if (current.version_id !== expectedWorkflowVersion)
        throw new Error(
          "replacement Workflow version is not bound to the deployed API candidate",
        );
      try {
        const checked = auditWorkflow(
          current,
          await deps.outbox(String(saved.params.outboxId)),
          deps.now(),
        );
        if (
          !equal(checked.params, saved.params) ||
          !equal(checked.outbox, saved.outbox)
        )
          throw new Error("replacement Workflow changed payload or scheduling");
        break;
      } catch (error) {
        if (!(error instanceof WorkflowStartupPending) || attempt === 2)
          throw error;
        current = null;
      }
    }
  }
}
async function restoreGate(
  deps: Dependencies,
  session: Session,
): Promise<void> {
  await assertFrozen(deps, session);
  if (session.previousGate.storageMode === "d1")
    await deps.run(
      `UPDATE event_runtime_control SET storage_mode = 'd1', updated_at_ms = ? WHERE singleton = 1 AND storage_mode = 'frozen' AND freeze_generation = ? AND NOT EXISTS (SELECT 1 FROM event_write_admissions) RETURNING singleton`,
      EVENT_DB,
      [deps.now(), session.freezeGeneration],
    );
  const after = await deps.maintenance();
  if (
    after.storageMode !== session.previousGate.storageMode ||
    after.freezeGeneration !== session.freezeGeneration ||
    !equal(after.otherGates, session.otherGates)
  )
    throw new Error("prior event gate was not restored");
}
async function manageEventTransitionReceipts(
  args: Arguments,
  deps: Dependencies,
): Promise<void> {
  if (args.operation === "status" || args.operation === "preflight") {
    return runEventTransitionReceiptOperation(args, deps);
  }
  const ownerToken = randomUUID();
  let acquired: JsonRecord[];
  try {
    acquired = await deps.run(
      "INSERT INTO event_transition_receipt_operator_lock (singleton, owner_token, operation, created_at_ms) VALUES (1, ?, ?, ?) ON CONFLICT (singleton) DO NOTHING RETURNING owner_token",
      GAMEPLAY_DB,
      [ownerToken, args.operation, deps.now()],
    );
  } catch (error) {
    const lock = await readOperatorLock(deps);
    if (lock?.owner_token !== ownerToken) {
      throw new Error(
        `Receipt operator lock acquisition was not confirmed (${ownerToken}); check --status and ensure migration 0020 is applied.`,
        { cause: error },
      );
    }
    acquired = [lock];
  }
  if (acquired[0]?.owner_token !== ownerToken) {
    throw new Error(
      "Another receipt operation holds the lock; check --status.",
    );
  }
  let pendingWrite = false;
  const write = async <T>(operation: () => Promise<T>): Promise<T> => {
    pendingWrite = true;
    const result = await operation();
    pendingWrite = false;
    return result;
  };
  try {
    await runEventTransitionReceiptOperation(args, {
      ...deps,
      run: (sql, database, bindings) =>
        /^\s*SELECT\b/i.test(sql)
          ? deps.run(sql, database, bindings)
          : write(() => deps.run(sql, database, bindings)),
      deploy: (version) => write(() => deps.deploy(version)),
      registerWorkflow: () => write(() => deps.registerWorkflow()),
      terminate: (id) => write(() => deps.terminate(id)),
      delete: (id) => write(() => deps.delete(id)),
      create: (id, params) => write(() => deps.create(id, params)),
    });
  } finally {
    if (pendingWrite) {
      deps.log({
        operation: "operator-lock-retained",
        ownerToken,
        reason: "Reconcile the unconfirmed write before releasing this lock.",
      });
    } else {
      await releaseOperatorLock(deps, ownerToken);
    }
  }
}
async function releaseOperatorLock(
  deps: Dependencies,
  ownerToken: string,
): Promise<void> {
  try {
    await deps.run(
      "DELETE FROM event_transition_receipt_operator_lock WHERE singleton = 1 AND owner_token = ?",
      GAMEPLAY_DB,
      [ownerToken],
    );
  } catch (error) {
    if ((await readOperatorLock(deps))?.owner_token === ownerToken) {
      throw new Error(
        `Receipt operator lock release was not confirmed (${ownerToken}); check --status.`,
        { cause: error },
      );
    }
  }
}
async function readOperatorLock(
  deps: Dependencies,
): Promise<JsonRecord | null> {
  const tables = await deps.run(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_transition_receipt_operator_lock'",
    GAMEPLAY_DB,
  );
  if (!tables.length) return null;
  return (
    (
      await deps.run(
        "SELECT owner_token, operation, created_at_ms FROM event_transition_receipt_operator_lock WHERE singleton = 1",
        GAMEPLAY_DB,
      )
    )[0] ?? null
  );
}
async function runEventTransitionReceiptOperation(
  args: Arguments,
  deps: Dependencies,
): Promise<void> {
  const { operation } = args;
  if (operation === "status" || operation === "preflight") {
    const maintenance = await deps.maintenance(),
      control = await deps.control(),
      versionId = await deps.deployment();
    const workflows =
      operation === "preflight"
        ? await captureWorkflows(deps)
        : await listWorkflows(deps);
    if (operation === "preflight") assertDrained(maintenance);
    const source =
      operation === "preflight"
        ? await scanSource(deps, args.pageSize, deps.now())
        : undefined;
    deps.log({
      operation,
      maintenance,
      state: control.state,
      versionId,
      workflows: workflows.length,
      operatorLock: await readOperatorLock(deps),
      ...(source ? { source } : {}),
    });
    return;
  }
  const directory = privateDirectory(args.directory!);
  if (
    operation !== "abort" &&
    existsSync(resolve(directory, "abort-complete.json"))
  ) {
    throw new Error(
      "This receipt cutover was aborted; start a new attempt in a fresh evidence directory.",
    );
  }
  const sessionPath = resolve(directory, "cutover.json");
  if (operation === "freeze" && !existsSync(sessionPath)) {
    const state = await deps.maintenance();
    assertDrained(state);
    if ((await deps.control()).state !== "importing")
      throw new Error(
        "receipts already active; old-writer rollback is forbidden",
      );
    const session: Session = {
      schemaVersion: 1,
      id: randomUUID(),
      createdAtMs: deps.now(),
      previousVersionId: await deps.deployment(),
      candidateVersionId: args.candidateVersionId!,
      previousGate: {
        storageMode: state.storageMode,
        freezeGeneration: state.freezeGeneration,
      },
      freezeGeneration:
        state.freezeGeneration + Number(state.storageMode === "d1"),
      otherGates: state.otherGates,
    };
    if (session.previousVersionId === session.candidateVersionId)
      throw new Error("candidate was already promoted before migration freeze");
    writePrivateImmutable(sessionPath, session);
  }
  const session = parseSession(readPrivateJson(sessionPath));
  if (
    args.candidateVersionId &&
    args.candidateVersionId !== session.candidateVersionId
  )
    throw new Error("candidate version conflicts with immutable session");
  const control = await deps.control();
  if (operation === "freeze") {
    if (control.state !== "importing")
      throw new Error("receipt authority is already active");
    await requireVersion(deps, session.previousVersionId);
    const current = await deps.maintenance();
    if (
      current.storageMode === "d1" &&
      current.freezeGeneration === session.previousGate.freezeGeneration
    )
      await deps.run(
        "UPDATE event_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1, updated_at_ms = ? WHERE singleton = 1 AND storage_mode = 'd1' AND freeze_generation = ? AND NOT EXISTS (SELECT 1 FROM event_write_admissions) RETURNING singleton",
        EVENT_DB,
        [deps.now(), session.previousGate.freezeGeneration],
      );
    await assertFrozen(deps, session);
    const evidencePath = resolve(directory, "workflows.json");
    if (!existsSync(evidencePath))
      writePrivateImmutable(evidencePath, await captureWorkflows(deps));
    const evidence = loadEvidence(directory);
    await terminateOriginals(deps, session, evidence);
    writePrivateImmutable(resolve(directory, "frozen.json"), {
      sessionId: session.id,
      freezeGeneration: session.freezeGeneration,
    });
    deps.log({
      operation,
      freezeGeneration: session.freezeGeneration,
      workflows: evidence.length,
    });
    return;
  }
  if (operation === "abort" || operation === "resume") {
    if (operation === "abort" && control.state === "active")
      throw new Error(
        "receipt authority is active; rollback to an old receipt writer is forbidden; repair forward",
      );
    if (
      operation === "resume" &&
      (control.state !== "active" ||
        control.candidate_version_id !== session.candidateVersionId ||
        control.verified_event_freeze_generation !== session.freezeGeneration)
    )
      throw new Error("verified receipt activation is required before resume");
    const completedPath = resolve(directory, `${operation}-complete.json`);
    const expectedVersion =
      operation === "abort"
        ? session.previousVersionId
        : session.candidateVersionId;
    if (existsSync(completedPath)) {
      await requireVersion(deps, expectedVersion);
      deps.log({ operation, alreadyCompleted: true });
      return;
    }
    const gateNow = await deps.maintenance();
    if (
      gateNow.storageMode === session.previousGate.storageMode &&
      gateNow.freezeGeneration === session.freezeGeneration &&
      existsSync(resolve(directory, `${operation}-workflows-restored.json`))
    ) {
      await requireVersion(deps, expectedVersion);
      if (!equal(gateNow.otherGates, session.otherGates))
        throw new Error("unrelated maintenance gates changed");
      writePrivateImmutable(completedPath, {
        sessionId: session.id,
        versionId: expectedVersion,
      });
      deps.log({ operation, alreadyRestored: true });
      return;
    }
    if (
      operation === "abort" &&
      !existsSync(resolve(directory, "workflows.json")) &&
      equal(
        {
          storageMode: gateNow.storageMode,
          freezeGeneration: gateNow.freezeGeneration,
        },
        session.previousGate,
      )
    ) {
      await requireVersion(deps, expectedVersion);
      writePrivateImmutable(completedPath, {
        sessionId: session.id,
        versionId: expectedVersion,
      });
      deps.log({ operation, beforeFreeze: true });
      return;
    }
    await assertFrozen(deps, session);
    if (operation === "abort" && (await deps.deployment()) !== expectedVersion)
      await deps.deploy(expectedVersion);
    if (
      operation === "abort" &&
      !existsSync(resolve(directory, "workflows.json"))
    ) {
      await requireVersion(deps, expectedVersion);
      writePrivateImmutable(
        resolve(directory, `${operation}-workflows-restored.json`),
        {
          sessionId: session.id,
          versionId: expectedVersion,
          workflowVersion: null,
        },
      );
      await restoreGate(deps, session);
      writePrivateImmutable(completedPath, {
        sessionId: session.id,
        versionId: expectedVersion,
      });
      deps.log({ operation, workflows: 0, beforeWorkflowTermination: true });
      return;
    }
    const evidence = loadEvidence(directory);
    const workflowVersion = await registerWorkflow(
      deps,
      directory,
      operation,
      expectedVersion,
    );
    await restoreWorkflows(
      deps,
      session,
      evidence,
      expectedVersion,
      workflowVersion,
    );
    writePrivateImmutable(
      resolve(directory, `${operation}-workflows-restored.json`),
      { sessionId: session.id, versionId: expectedVersion, workflowVersion },
    );
    await requireVersion(deps, expectedVersion);
    await restoreGate(deps, session);
    writePrivateImmutable(completedPath, {
      sessionId: session.id,
      versionId: expectedVersion,
    });
    deps.log({
      operation,
      workflows: evidence.length,
      versionId: expectedVersion,
      eventStorageMode: session.previousGate.storageMode,
    });
    return;
  }
  await assertFrozen(deps, session);
  const evidence = loadEvidence(directory);
  if (control.state === "active") {
    if (
      operation !== "activate" ||
      control.candidate_version_id !== session.candidateVersionId
    )
      throw new Error(
        "receipt authority is already active; import metadata is immutable",
      );
    await requireVersion(deps, session.candidateVersionId);
    deps.log({ operation, alreadyActive: true });
    return;
  }
  await assertNoLiveOriginals(deps, evidence);
  if (operation === "export") {
    const exportPath = resolve(directory, "export.json");
    if (!existsSync(exportPath))
      writePrivateImmutable(exportPath, {
        sessionId: session.id,
        exportedAtMs: deps.now(),
        pageSize: args.pageSize,
      });
    const exported = record(readPrivateJson(exportPath));
    if (
      !exported ||
      exported.sessionId !== session.id ||
      !integer(exported.exportedAtMs) ||
      exported.pageSize !== args.pageSize
    )
      throw new Error("export settings conflict with saved session");
    const proofs: Manifest["pages"] = [];
    const source = await scanSource(
      deps,
      args.pageSize,
      exported.exportedAtMs,
      (page) => {
        writePrivateImmutable(sourcePath(directory, page.index), page);
        proofs.push({ count: page.rows.length, digest: digest(page) });
      },
    );
    await assertFrozen(deps, session);
    if (existsSync(sourcePath(directory, proofs.length)))
      throw new Error(
        "saved source has extra pages; source changed during export resumption",
      );
    writePrivateImmutable(resolve(directory, "manifest.json"), {
      schemaVersion: 1,
      sessionId: session.id,
      exportedAtMs: exported.exportedAtMs,
      pageSize: args.pageSize,
      source,
      pages: proofs,
    } satisfies Manifest);
    deps.log({ operation, source, pages: proofs.length });
    return;
  }
  const { manifest, pages } = loadExport(directory, session);
  if (operation === "import") {
    for (const page of pages)
      for (let offset = 0; offset < page.rows.length; offset += BATCH_SIZE) {
        await assertFrozen(deps, session);
        const rows = page.rows.slice(offset, offset + BATCH_SIZE);
        await deps.run(
          `WITH imported(transition_id,schema_version,event_id,expected_revision,payload_digest,receipt_json,recorded_at_ms) AS (VALUES ${rows.map(() => "(?,?,?,?,?,?,?)").join(",")}) INSERT INTO event_transition_receipts SELECT * FROM imported WHERE EXISTS (SELECT 1 FROM event_transition_receipt_control WHERE singleton = 1 AND state = 'importing') ON CONFLICT(transition_id) DO NOTHING`,
          GAMEPLAY_DB,
          rows.flatMap((row) => [
            row.transition_id,
            row.schema_version,
            row.event_id,
            row.expected_revision,
            row.payload_digest,
            row.receipt_json,
            row.recorded_at_ms,
          ]),
        );
      }
    await verifyDestination(deps, manifest, pages);
    await assertFrozen(deps, session);
    const result = await deps.run(
      "UPDATE event_transition_receipt_control SET source_count = ?, source_digest = ?, import_count = ?, import_digest = ?, source_exported_at_ms = ?, imported_at_ms = ?, candidate_version_id = NULL, verified_event_freeze_generation = NULL, verified_at_ms = NULL WHERE singleton = 1 AND state = 'importing' RETURNING singleton",
      GAMEPLAY_DB,
      [
        manifest.source.count,
        manifest.source.digest,
        manifest.source.count,
        manifest.source.digest,
        manifest.exportedAtMs,
        deps.now(),
      ],
    );
    if (result.length !== 1)
      throw new Error("receipt import control conflicted");
    deps.log({ operation, source: manifest.source });
    return;
  }
  await verifyDestination(deps, manifest, pages);
  const source = await scanSource(
    deps,
    manifest.pageSize,
    manifest.exportedAtMs,
  );
  if (!equal(source, manifest.source))
    throw new Error("Firebase receipt source changed after export");
  await assertFrozen(deps, session);
  await assertNoLiveOriginals(deps, evidence);
  if (operation === "verify") {
    const result = await deps.run(
      "UPDATE event_transition_receipt_control SET candidate_version_id = ?, verified_event_freeze_generation = ?, verified_at_ms = ? WHERE singleton = 1 AND state = 'importing' AND source_count = ? AND import_count = source_count AND source_digest = ? AND import_digest = source_digest AND source_exported_at_ms = ? AND imported_at_ms IS NOT NULL RETURNING singleton",
      GAMEPLAY_DB,
      [
        session.candidateVersionId,
        session.freezeGeneration,
        deps.now(),
        manifest.source.count,
        manifest.source.digest,
        manifest.exportedAtMs,
      ],
    );
    if (result.length !== 1)
      throw new Error(
        "receipt verification requires a completed matching import",
      );
  } else if (operation === "activate") {
    await requireVersion(deps, session.candidateVersionId);
    const result = await deps.run(
      "UPDATE event_transition_receipt_control SET state = 'active', activated_at_ms = ? WHERE singleton = 1 AND state = 'importing' AND source_count = ? AND import_count = source_count AND source_digest = ? AND import_digest = source_digest AND source_exported_at_ms = ? AND verified_event_freeze_generation = ? AND candidate_version_id = ? AND verified_at_ms IS NOT NULL RETURNING singleton",
      GAMEPLAY_DB,
      [
        deps.now(),
        manifest.source.count,
        manifest.source.digest,
        manifest.exportedAtMs,
        session.freezeGeneration,
        session.candidateVersionId,
      ],
    );
    if (result.length !== 1)
      throw new Error("receipt activation prerequisites conflicted");
    if ((await deps.control()).state !== "active")
      throw new Error("receipt activation was not confirmed");
  }
  deps.log({
    operation,
    source,
    candidateVersionId: session.candidateVersionId,
  });
}
async function registerWorkflow(
  deps: Dependencies,
  directory: string,
  operation: string,
  versionId: string,
): Promise<string> {
  await requireVersion(deps, versionId);
  const resultPath = resolve(directory, `${operation}-registration.json`);
  if (!existsSync(resultPath)) {
    const workflowVersion = await deps.registerWorkflow();
    await requireVersion(deps, versionId);
    if (!(await deps.workflowVersions()).includes(workflowVersion))
      throw new Error("Workflow registration version is not confirmed");
    writePrivateImmutable(resultPath, { versionId, workflowVersion });
  }
  const result = record(readPrivateJson(resultPath));
  if (
    !result ||
    result.versionId !== versionId ||
    typeof result.workflowVersion !== "string" ||
    !UUID.test(result.workflowVersion) ||
    !(await deps.workflowVersions()).includes(result.workflowVersion)
  )
    throw new Error("invalid saved Workflow registration");
  await requireVersion(deps, versionId);
  return result.workflowVersion;
}
function createSqlDependencies(
  run: SqlRunner,
  provider: Omit<
    Dependencies,
    "run" | "now" | "log" | "maintenance" | "control" | "outbox"
  >,
  now = Date.now,
): Dependencies {
  return {
    ...provider,
    run,
    now,
    log: (value) => console.log(JSON.stringify(value)),
    async maintenance() {
      const event = (
        await run(
          "SELECT storage_mode, freeze_generation, (SELECT COUNT(*) FROM event_write_admissions) AS admissions, (SELECT COUNT(*) FROM event_leases WHERE expires_at_ms > ?) AS leases, (SELECT COUNT(*) FROM event_transition_intents) AS intents FROM event_runtime_control WHERE singleton = 1",
          EVENT_DB,
          [now()],
        )
      )[0];
      const effect = (
        await run(
          "SELECT COUNT(*) AS count FROM invite_source_write_admissions WHERE kind IN ('event-effects', 'event-effects-d1-receipts')",
          GAMEPLAY_DB,
        )
      )[0];
      if (
        !event ||
        !["d1", "frozen"].includes(String(event.storage_mode)) ||
        !integer(event.freeze_generation) ||
        !integer(event.admissions) ||
        !integer(event.leases) ||
        !integer(event.intents) ||
        !integer(effect?.count)
      )
        throw new Error("invalid event maintenance state");
      const otherGates: JsonRecord = {};
      for (const [key, db, sql] of [
        [
          "profiles",
          "mons-link-profiles",
          "SELECT state FROM profile_canonical_control WHERE singleton = 1",
        ],
        [
          "wagers",
          "mons-link-profiles",
          "SELECT storage_mode, freeze_generation FROM wager_reservation_runtime_control WHERE singleton = 1",
        ],
        [
          "invites",
          GAMEPLAY_DB,
          "SELECT backend, state, epoch, freeze_generation FROM invite_source_control WHERE singleton = 1",
        ],
        [
          "automatch",
          GAMEPLAY_DB,
          "SELECT backend, state, epoch, freeze_generation FROM automatch_runtime_control WHERE singleton = 1",
        ],
        [
          "withdrawals",
          "mons-link-event-prize-withdrawals",
          "SELECT storage_mode, previous_storage_mode FROM event_prize_withdrawal_runtime_control WHERE singleton = 1",
        ],
        [
          "telegram",
          "mons-link-telegram",
          "SELECT storage_mode FROM telegram_runtime_control WHERE singleton = 1",
        ],
      ]) {
        const rows = await run(sql, db);
        if (rows.length !== 1)
          throw new Error("unrelated maintenance control is missing");
        otherGates[key] = rows[0];
      }
      return {
        storageMode: event.storage_mode as Gate["storageMode"],
        freezeGeneration: event.freeze_generation,
        admissions: event.admissions,
        leases: event.leases,
        intents: event.intents,
        effectAdmissions: effect.count,
        otherGates,
      };
    },
    async control() {
      const tables = await run(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_transition_receipt_control'",
        GAMEPLAY_DB,
      );
      if (!tables.length) return { state: "absent" };
      const row = (
        await run(
          "SELECT * FROM event_transition_receipt_control WHERE singleton = 1",
          GAMEPLAY_DB,
        )
      )[0];
      if (!row || !["importing", "active"].includes(String(row.state)))
        throw new Error(
          "receipt migration control is missing; apply the additive schema first",
        );
      return row as Control;
    },
    async outbox(id) {
      const rows = await run(
        "SELECT * FROM event_progress_outboxes WHERE status = 'pending' AND outbox_id = ?",
        EVENT_DB,
        [id],
      );
      if (rows.length !== 1)
        throw new Error("scheduled Workflow outbox is missing or ambiguous");
      return rows[0];
    },
  };
}
function createProvider({
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  firebaseCredentials,
  fetcher = fetch,
}: {
  apiToken?: string;
  firebaseCredentials?: string;
  fetcher?: typeof fetch;
} = {}): Omit<
  Dependencies,
  "run" | "now" | "log" | "maintenance" | "control" | "outbox"
> {
  if (!apiToken)
    throw new Error(
      "CLOUDFLARE_API_TOKEN is required for protected parameterized migration operations",
    );
  const require = createRequire(import.meta.url),
    typescript = require("typescript") as typeof import("typescript");
  const parsed = typescript.parseConfigFileTextToJson(
    resolve(ROOT, "cloud/workers/api/wrangler.jsonc"),
    readFileSync(resolve(ROOT, "cloud/workers/api/wrangler.jsonc"), "utf8"),
  );
  const config = record(parsed.config),
    accountId = config?.account_id;
  const workflows = config?.workflows;
  const workflow = Array.isArray(workflows)
    ? workflows
        .map(record)
        .find((row) => row?.name === "mons-link-event-progress")
    : null;
  if (
    parsed.error ||
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(accountId) ||
    config?.name !== "mons-link-api" ||
    workflow?.class_name !== "EventProgressWorkflow"
  )
    throw new Error("invalid tracked API or Workflow configuration");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`,
    workflowPath = "/workflows/mons-link-event-progress",
    workerPath = "/workers/scripts/mons-link-api";
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    missingAllowed = false,
  ): Promise<JsonRecord | null> {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (missingAllowed && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    const payload = record(await readResponseJson(response));
    if (!payload || payload.success !== true)
      throw new Error(
        "Cloudflare management operation failed; response and credentials were not logged",
      );
    return payload;
  }
  const firebaseToken = createFirebaseTokenProvider(firebaseCredentials);
  return {
    async sourcePage(after, pageSize) {
      const url = new URL(`${FIREBASE_ROOT}/eventTransitionReceipts.json`);
      url.searchParams.set("orderBy", JSON.stringify("$key"));
      url.searchParams.set(
        "limitToFirst",
        String(pageSize + Number(after !== null)),
      );
      if (after !== null)
        url.searchParams.set("startAt", JSON.stringify(after));
      return readResponseJson(
        await fetcher(url, {
          headers: {
            Authorization: `Bearer ${await firebaseToken()}`,
            Accept: "application/json",
          },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        }),
      );
    },
    async deployment() {
      const result = record(
          (await request(`${workerPath}/deployments`))?.result,
        ),
        deployments = result?.deployments;
      if (!Array.isArray(deployments) || !deployments.length)
        throw new Error("API deployment history is unavailable");
      const latest = deployments
          .map(record)
          .sort((a, b) =>
            String(b?.created_on).localeCompare(String(a?.created_on)),
          )[0],
        versions = latest?.versions;
      const version =
        Array.isArray(versions) && versions.length === 1
          ? record(versions[0])
          : null;
      if (
        !version ||
        version.percentage !== 100 ||
        typeof version.version_id !== "string" ||
        !UUID.test(version.version_id)
      )
        throw new Error("API requires exactly one deployment at 100%");
      return version.version_id;
    },
    async deploy(versionId) {
      await request(`${workerPath}/deployments`, "POST", {
        strategy: "percentage",
        versions: [{ version_id: versionId, percentage: 100 }],
        annotations: {
          "workers/message":
            "Abort event transition receipt migration before activation",
        },
      });
    },
    async workflowPage(page) {
      const payload = await request(
          `${workflowPath}/instances?page=${page}&per_page=100`,
        ),
        info = record(payload?.result_info);
      if (
        !Array.isArray(payload?.result) ||
        !info ||
        !integer(info.total_count) ||
        info.per_page !== 100 ||
        (info.page !== undefined && info.page !== page) ||
        payload.result.length > 100 ||
        info.count !== payload.result.length
      )
        throw new Error("invalid Workflow page or pagination metadata");
      return {
        rows: payload.result.map(parseWorkflow),
        totalPages: Math.max(1, Math.ceil(info.total_count / 100)),
        totalCount: info.total_count,
      };
    },
    async workflow(id) {
      const payload = await request(
        `${workflowPath}/instances/${encodeURIComponent(id)}`,
        "GET",
        undefined,
        true,
      );
      if (!payload) return null;
      const result = record(payload.result);
      if (!result) throw new Error("invalid Workflow detail response");
      return parseWorkflow({ ...result, id, version_id: result.versionId });
    },
    async workflowVersions() {
      const registered = record((await request(workflowPath))?.result);
      if (
        !registered ||
        registered.script_name !== "mons-link-api" ||
        registered.class_name !== "EventProgressWorkflow"
      )
        throw new Error("Workflow registration target changed");
      const versions: string[] = [];
      let totalPages = 1,
        totalCount = -1;
      for (let page = 1; page <= totalPages; page++) {
        const payload = await request(
            `${workflowPath}/versions?page=${page}&per_page=100`,
          ),
          info = record(payload?.result_info);
        if (
          !Array.isArray(payload?.result) ||
          !info ||
          !integer(info.total_count) ||
          info.per_page !== 100 ||
          info.page !== page ||
          info.count !== payload.result.length ||
          payload.result.length > 100 ||
          (page > 1 && info.total_count !== totalCount)
        )
          throw new Error("invalid or changed Workflow version pagination");
        totalCount = info.total_count;
        totalPages = Math.max(1, Math.ceil(totalCount / 100));
        if (totalPages > MAX_PAGES || info.total_pages !== totalPages)
          throw new Error("invalid Workflow version page count");
        for (const value of payload.result) {
          const row = record(value);
          if (!row || typeof row.id !== "string" || !UUID.test(row.id))
            throw new Error("invalid Workflow version identity");
          versions.push(row.id);
        }
      }
      if (
        new Set(versions).size !== versions.length ||
        versions.length !== totalCount
      )
        throw new Error("incomplete or duplicate Workflow version inventory");
      return versions;
    },
    async registerWorkflow() {
      const result = record(
        (
          await request(workflowPath, "PUT", {
            script_name: "mons-link-api",
            class_name: "EventProgressWorkflow",
            ...(workflow?.limits ? { limits: workflow.limits } : {}),
          })
        )?.result,
      );
      if (
        !result ||
        typeof result.version_id !== "string" ||
        !UUID.test(result.version_id)
      )
        throw new Error(
          "targeted Workflow registration response was not confirmed; reconcile the write before retrying registration",
        );
      return result.version_id;
    },
    async terminate(id) {
      await request(
        `${workflowPath}/instances/${encodeURIComponent(id)}/status`,
        "PATCH",
        { status: "terminate" },
      );
    },
    async delete(id) {
      const result = record(
        (
          await request(`${workflowPath}/instances/batch/delete`, "POST", {
            instances: [id],
          })
        )?.result,
      );
      if (
        !result ||
        !Array.isArray(result.deleted) ||
        result.deleted.length !== 1 ||
        record(result.deleted[0])?.id !== id ||
        !Array.isArray(result.errors) ||
        result.errors.length
      )
        throw new Error(
          "Workflow deletion is incomplete; retry after inspecting current instance",
        );
    },
    async create(id, params) {
      const result = record(
        (
          await request(`${workflowPath}/instances`, "POST", {
            instance_id: id,
            params,
          })
        )?.result,
      );
      if (!result || result.id !== id)
        throw new Error(
          "Workflow recreation response is uncertain; read existing instance before retrying",
        );
    },
  };
}
async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const apiToken = resolveCloudflareToken();
  await manageEventTransitionReceipts(
    args,
    createSqlDependencies(
      createWranglerRunner({ apiToken }),
      createProvider({
        apiToken,
        firebaseCredentials:
          args.firebaseCredentials ||
          process.env.GOOGLE_APPLICATION_CREDENTIALS,
      }),
    ),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  execute().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "receipt migration failed; keep events frozen",
    );
    process.exitCode = 1;
  });
export {
  auditWorkflow,
  createProvider,
  createSqlDependencies,
  execute,
  listWorkflows,
  loadExport,
  manageEventTransitionReceipts,
  normalizeSourcePage,
  parseArgs,
  parseWorkflow,
  registerWorkflow,
  verifyDestination,
  type Arguments,
  type Dependencies,
  type Manifest,
  type Maintenance,
  type Session,
  type SourcePage,
  type Workflow,
  type WorkflowEvidence,
};
