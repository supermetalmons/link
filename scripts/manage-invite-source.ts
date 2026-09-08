import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  createFirebaseTokenProvider,
  createWranglerRunner,
  digest,
  privateDirectory,
  readPrivateJson,
  readResponseJson,
  writePrivateImmutable,
  type SqlRunner,
} from "./manage-wager-state.ts";
import { assertFirebaseInviteSourceAvailable } from "./invite-source-retirement.ts";
import {
  inventory,
  inventoryKeys,
  parseShallowKeys,
} from "./manage-login-match-discovery.ts";

const require = createRequire(import.meta.url);
const { normalizeInviteSource } =
  require("../cloud/workers/api/src/inviteSourceD1.ts") as {
    normalizeInviteSource(value: unknown): Record<string, unknown>;
  };
const DATABASE = "mons-link-profile-games";
const EVENT_DATABASE = "mons-link-events";
const FIREBASE_ROOT = "https://mons-link-default-rtdb.firebaseio.com";
const ROOT = resolve(import.meta.dirname, "..");
const VERSION = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 900_000;
const ROW_PAGE_SIZE = 20;
const MAX_WORKFLOW_PAGES = 100_000;
const WORKFLOW = "mons-link-event-progress";
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
  | "abort"
  | "inspect-admission"
  | "reconcile-admission";
type Arguments = {
  operation: Operation;
  directory?: string;
  candidateVersionId?: string;
  firebaseCredentials?: string;
  admissionId?: string;
  evidence?: string;
};
type Gate = { state: "active" | "frozen"; freezeGeneration: number };
type Control = Gate & {
  backend: "rtdb" | "d1";
  epoch: number;
  candidateVersionId: string | null;
  sourceDigest: string | null;
  importDigest: string | null;
  verifiedAtMs: number | null;
  activatedAtMs: number | null;
  metadata: JsonRecord;
};
type Status = {
  control: Control;
  automatch: Gate & { backend: "d1"; epoch: number };
  events: Gate;
  counts: {
    inviteAdmissions: number;
    sessionAdmissions: number;
    sessionIntents: number;
    sessionResources: number;
    sessionLocks: number;
    eventAdmissions: number;
    eventIntents: number;
    eventLeases: number;
  };
};
type Admission = {
  admissionId: string;
  backend: Control["backend"];
  epoch: number;
  freezeGeneration: number;
  kind: string;
  createdAtMs: number;
};
type AdmissionControls = Pick<Status, "control" | "automatch" | "events">;
type Maintenance = {
  schemaVersion: 1;
  maintenanceId: string;
  candidateVersionId: string;
  createdAtMs: number;
  prior: Pick<Status, "control" | "automatch" | "events">;
};
type Session = {
  schemaVersion: 1;
  projectId: "mons-link";
  firebaseRoot: typeof FIREBASE_ROOT;
  database: typeof DATABASE;
  exportId: string;
  createdAtMs: number;
  maintenance: Maintenance;
};
type SourceRow = { inviteId: string; source: JsonRecord };
type StoredRow = SourceRow & { revision: number; updatedAtMs: number };
type Page = { schemaVersion: 1; index: number; rows: SourceRow[] };
type PageProof = { index: number; count: number; digest: string };
type Manifest = {
  session: Session;
  inventory: Awaited<ReturnType<typeof inventory>>;
  pages: PageProof[];
  count: number;
  sourceDigest: string;
};
type WorkflowPage = {
  rows: Array<{ id: string; status: string; versionId: string }>;
  cursor: string | null;
};
type WorkflowAudit = {
  pages: number;
  instances: number;
  nonterminal: number;
  digest: string;
};
type Dependencies = {
  now(): number;
  log(value: JsonRecord): void;
  status(): Promise<Status>;
  listAdmissions(): Promise<Admission[]>;
  readAdmission(admissionId: string): Promise<Admission | null>;
  settleAdmission(
    admission: Admission,
    controls: AdmissionControls,
  ): Promise<void>;
  assertSourceReadable(): Promise<void>;
  assertDeployment(versionId: string): Promise<void>;
  workflowPage(cursor: string | null): Promise<WorkflowPage>;
  streamInviteKeys(): AsyncIterable<string>;
  readInvite(inviteId: string): Promise<unknown>;
  claimMaintenance(maintenance: Maintenance): Promise<void>;
  setGate(
    gate: "invite" | "automatch" | "events",
    expected: Gate,
    state: Gate["state"],
    maintenance: Maintenance,
  ): Promise<void>;
  beginImport(manifest: Manifest): Promise<void>;
  importRows(manifest: Manifest, rows: SourceRow[]): Promise<void>;
  readRows(inviteIds: string[]): Promise<StoredRow[]>;
  countRows(): Promise<number>;
  finishImport(manifest: Manifest): Promise<void>;
  recordVerification(manifest: Manifest, audit: WorkflowAudit): Promise<void>;
  activate(manifest: Manifest, audit: WorkflowAudit): Promise<void>;
  adoptResumeCandidate(
    maintenance: Maintenance,
    control: Control,
    versionId: string,
  ): Promise<void>;
  discardImport(maintenance: Maintenance): Promise<void>;
  completeAbort(maintenance: Maintenance): Promise<void>;
};

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "invalid invite-source record; private contents were not logged",
    );
  return value as JsonRecord;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sourceRow(value: unknown): SourceRow {
  const row = record(value);
  const inviteId = row.inviteId;
  if (
    typeof inviteId !== "string" ||
    !inviteId ||
    !inviteId.isWellFormed() ||
    Buffer.byteLength(inviteId) > 768 ||
    /[.#$[\]/]/.test(inviteId) ||
    Array.from(inviteId).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  )
    throw new Error("invalid invite-source key");
  const source = normalizeInviteSource(row.source);
  if (canonicalJson(source) !== canonicalJson(row.source))
    throw new Error("export contains retired invite fields");
  if (Buffer.byteLength(canonicalJson(source)) > MAX_SOURCE_BYTES)
    throw new Error("invite metadata exceeds the bounded D1 record size");
  return { inviteId, source };
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
      "inspect-admission",
      "reconcile-admission",
    ].includes(operation)
  )
    throw new Error("choose one invite-source operation; see --help");
  const admissionId = operation === "inspect-admission" ? argv[1] : undefined;
  if (
    operation === "inspect-admission" &&
    (!admissionId || !VERSION.test(admissionId))
  )
    throw new Error("inspect-admission requires one exact admission UUID");
  const options = new Map<string, string>();
  for (let index = admissionId ? 2 : 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !value ||
      value.startsWith("--") ||
      options.has(option) ||
      ![
        "--directory",
        "--candidate-version-id",
        "--firebase-credentials",
        "--evidence",
      ].includes(option)
    )
      throw new Error("invalid invite-source arguments");
    options.set(option, value);
  }
  const directory = options.get("--directory");
  const candidateVersionId = options.get("--candidate-version-id");
  const firebaseCredentials = options.get("--firebase-credentials");
  const evidence = options.get("--evidence");
  if (operation === "reconcile-admission") {
    if (!evidence || !isAbsolute(evidence) || options.size !== 1)
      throw new Error(
        "reconcile-admission requires only an absolute protected --evidence file",
      );
    return { operation, evidence };
  }
  if (
    evidence ||
    (operation === "inspect-admission" &&
      (options.size !== 1 || !directory || !isAbsolute(directory)))
  )
    throw new Error(
      "inspect-admission requires only an absolute protected --directory",
    );
  if (operation === "status" && options.size)
    throw new Error("status takes no options");
  if (operation === "preflight" && directory)
    throw new Error(
      "preflight does not retain artifacts or accept a directory",
    );
  if (
    !["status", "preflight"].includes(operation) &&
    (!directory || !isAbsolute(directory))
  )
    throw new Error("an absolute protected --directory is required");
  if (
    (["freeze", "verify", "activate", "resume", "abort"].includes(operation) &&
      !candidateVersionId) ||
    (candidateVersionId && !VERSION.test(candidateVersionId))
  )
    throw new Error("the exact --candidate-version-id UUID is required");
  if (
    firebaseCredentials &&
    (!isAbsolute(firebaseCredentials) ||
      !["preflight", "export", "verify", "activate"].includes(operation))
  )
    throw new Error(
      "Firebase credentials require an absolute path and a source-reading operation",
    );
  return {
    operation,
    directory,
    candidateVersionId,
    firebaseCredentials,
    ...(admissionId ? { admissionId } : {}),
  };
}

function parseAdmission(value: unknown): Admission {
  const row = record(value);
  if (
    typeof row.admissionId !== "string" ||
    !VERSION.test(row.admissionId) ||
    !["rtdb", "d1"].includes(String(row.backend)) ||
    !integer(row.epoch) ||
    !integer(row.freezeGeneration) ||
    !integer(row.createdAtMs) ||
    typeof row.kind !== "string" ||
    !row.kind ||
    row.kind.length > 128
  )
    throw new Error("invalid exact invite-source admission evidence");
  return {
    admissionId: row.admissionId,
    backend: row.backend as Admission["backend"],
    epoch: row.epoch,
    freezeGeneration: row.freezeGeneration,
    kind: row.kind,
    createdAtMs: row.createdAtMs,
  };
}

function admissionControls(status: Status): AdmissionControls {
  return {
    control: status.control,
    automatch: status.automatch,
    events: status.events,
  };
}

function assertAdmissionWorkDrained(status: Status): void {
  assertDrained({
    ...status,
    counts: {
      ...status.counts,
      inviteAdmissions: 0,
      sessionAdmissions: 0,
      eventAdmissions: 0,
    },
  });
}

function boundedProof(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = record(value);
  return [proof.reference, proof.explanation].every(
    (text) =>
      typeof text === "string" && text.trim().length > 0 && text.length <= 4000,
  );
}

async function inspectAdmission(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  const directory = privateDirectory(args.directory!);
  const admission = await dependencies.readAdmission(args.admissionId!);
  if (!admission)
    throw new Error("named invite-source admission does not exist");
  const controls = admissionControls(await dependencies.status());
  if (
    canonicalJson(await dependencies.readAdmission(admission.admissionId)) !==
    canonicalJson(admission)
  )
    throw new Error(
      "invite-source admission changed during inspection; inspect again",
    );
  const inspection = {
    schemaVersion: 1,
    admission,
    admissionDigest: digest(admission),
    controls,
  };
  const inspectionDigest = digest(inspection);
  const inspectionFile = resolve(
    directory,
    `invite-admission-${admission.admissionId}-${inspectionDigest}.json`,
  );
  writePrivateImmutable(inspectionFile, inspection);
  const evidenceFile = resolve(
    directory,
    `invite-admission-${admission.admissionId}-${inspectionDigest}-evidence.json`,
  );
  if (!existsSync(evidenceFile))
    writePrivateImmutable(evidenceFile, {
      schemaVersion: 1,
      inspectionFile,
      inspectionDigest,
      requestFinishedAtMs: null,
      completionEvidence: { reference: "", explanation: "" },
      sourceReconciliation: {
        scopeComplete: false,
        noSourceEffects: false,
        reference: "",
        explanation: "",
        sources: [],
      },
    });
  dependencies.log({
    operation: "inspect-admission",
    admissionId: admission.admissionId,
    inspectionDigest,
    evidenceFile,
  });
}

async function reconcileAdmission(
  evidenceFile: string,
  dependencies: Dependencies,
): Promise<void> {
  const directory = privateDirectory(resolve(evidenceFile, ".."));
  const evidence = record(readPrivateJson(evidenceFile));
  if (
    evidence.schemaVersion !== 1 ||
    typeof evidence.inspectionFile !== "string" ||
    !isAbsolute(evidence.inspectionFile)
  )
    throw new Error("invalid protected invite-source inspection reference");
  privateDirectory(resolve(evidence.inspectionFile, ".."));
  const inspection = record(readPrivateJson(evidence.inspectionFile));
  const admission = parseAdmission(inspection.admission);
  if (
    inspection.schemaVersion !== 1 ||
    digest(inspection) !== evidence.inspectionDigest ||
    digest(admission) !== inspection.admissionDigest
  )
    throw new Error("invite-source inspection digest mismatch");
  if (
    !integer(evidence.requestFinishedAtMs) ||
    evidence.requestFinishedAtMs < admission.createdAtMs ||
    evidence.requestFinishedAtMs > dependencies.now() ||
    !boundedProof(evidence.completionEvidence)
  )
    throw new Error(
      "completed-request evidence requires a timestamp, reference, and explanation; age or timeout is not completion proof",
    );
  const reconciliation = record(evidence.sourceReconciliation);
  if (
    reconciliation.scopeComplete !== true ||
    !boundedProof(reconciliation) ||
    !Array.isArray(reconciliation.sources) ||
    reconciliation.sources.length > 100 ||
    typeof reconciliation.noSourceEffects !== "boolean" ||
    (reconciliation.sources.length === 0) !== reconciliation.noSourceEffects
  )
    throw new Error(
      "explicit source reconciliation proof must cover the complete request scope or establish no source effects",
    );
  const sources = reconciliation.sources.map((value) => {
    const source = record(value);
    const { inviteId } = sourceRow({ inviteId: source.inviteId, source: {} });
    if (typeof source.digest !== "string" || !HASH.test(source.digest))
      throw new Error("invalid invite-source reconciliation digest");
    return { inviteId, digest: source.digest };
  });
  if (new Set(sources.map((source) => source.inviteId)).size !== sources.length)
    throw new Error("duplicate invite-source reconciliation target");
  const evidenceDigest = digest(evidence);
  const preparedFile = resolve(
    directory,
    `invite-admission-prepared-${evidenceDigest}.json`,
  );
  const completedFile = resolve(
    directory,
    `invite-admission-completed-${evidenceDigest}.json`,
  );
  const audit = { schemaVersion: 1, inspection, evidence, evidenceDigest };
  const current = await dependencies.readAdmission(admission.admissionId);
  if (current && canonicalJson(current) !== canonicalJson(admission))
    throw new Error("invite-source admission tuple changed after inspection");
  if (!current) {
    if (
      !existsSync(preparedFile) ||
      canonicalJson(readPrivateJson(preparedFile)) !== canonicalJson(audit)
    )
      throw new Error(
        "missing admission has no matching protected pre-delete evidence; inspection alone cannot confirm reconciliation",
      );
  } else {
    const before = await dependencies.status();
    if (
      canonicalJson(admissionControls(before)) !==
      canonicalJson(inspection.controls)
    )
      throw new Error(
        "invite-source control or writer epoch changed after inspection",
      );
    assertAdmissionWorkDrained(before);
    for (const source of sources) {
      const currentSource =
        before.control.backend === "d1"
          ? ((await dependencies.readRows([source.inviteId]))[0]?.source ??
            null)
          : await dependencies.readInvite(source.inviteId);
      const normalized =
        currentSource === null ? null : normalizeInviteSource(currentSource);
      if (digest(normalized) !== source.digest)
        throw new Error(
          "invite source changed after investigation; refresh the source reconciliation proof",
        );
    }
    const checked = await dependencies.status();
    if (
      canonicalJson(admissionControls(checked)) !==
      canonicalJson(inspection.controls)
    )
      throw new Error(
        "invite-source control or writer epoch changed during reconciliation",
      );
    assertAdmissionWorkDrained(checked);
    writePrivateImmutable(preparedFile, audit);
    await dependencies.settleAdmission(admission, admissionControls(checked));
  }
  writePrivateImmutable(completedFile, {
    schemaVersion: 1,
    admissionId: admission.admissionId,
    evidenceDigest,
  });
  dependencies.log({
    operation: "reconcile-admission",
    admissionId: admission.admissionId,
    evidenceDigest,
    alreadyAbsent: current === null,
  });
}

function frozenGate(gate: Gate): Gate {
  return {
    state: "frozen",
    freezeGeneration: gate.freezeGeneration + Number(gate.state === "active"),
  };
}

function sameGate(left: Gate, right: Gate): boolean {
  return (
    left.state === right.state &&
    left.freezeGeneration === right.freezeGeneration
  );
}

function assertDrained(
  status: Status,
  gate?: "invite" | "automatch" | "events",
): void {
  const counts =
    gate === "invite"
      ? [status.counts.inviteAdmissions]
      : gate === "automatch"
        ? [
            status.counts.sessionAdmissions,
            status.counts.sessionIntents,
            status.counts.sessionResources,
            status.counts.sessionLocks,
          ]
        : gate === "events"
          ? [
              status.counts.eventAdmissions,
              status.counts.eventIntents,
              status.counts.eventLeases,
            ]
          : Object.values(status.counts);
  if (counts.some((count) => !integer(count) || count !== 0))
    throw new Error(
      "invite-source work is not drained; reconcile admissions, pending intents, resources, and leases after proving request completion",
    );
}

function assertMaintenance(
  status: Status,
  maintenance: Maintenance,
  frozen = true,
): void {
  const control = status.control;
  if (
    control.candidateVersionId !== maintenance.candidateVersionId ||
    control.metadata.maintenanceId !== maintenance.maintenanceId ||
    status.automatch.backend !== "d1" ||
    status.automatch.epoch !== maintenance.prior.automatch.epoch ||
    control.epoch !==
      maintenance.prior.control.epoch + Number(control.backend === "d1")
  )
    throw new Error(
      "invite-source maintenance ownership, candidate, or writer epoch changed",
    );
  if (frozen) {
    if (
      !sameGate(control, frozenGate(maintenance.prior.control)) ||
      !sameGate(status.automatch, frozenGate(maintenance.prior.automatch)) ||
      !sameGate(status.events, frozenGate(maintenance.prior.events))
    )
      throw new Error(
        "all three affected writer gates must remain in the same frozen generation",
      );
    assertDrained(status);
  }
}

function loadMaintenance(directory: string): Maintenance {
  const value = record(readPrivateJson(resolve(directory, "maintenance.json")));
  if (
    value.schemaVersion !== 1 ||
    typeof value.maintenanceId !== "string" ||
    !VERSION.test(value.maintenanceId) ||
    typeof value.candidateVersionId !== "string" ||
    !VERSION.test(value.candidateVersionId) ||
    !integer(value.createdAtMs)
  )
    throw new Error("invalid maintenance evidence");
  const prior = record(value.prior);
  for (const gateName of ["control", "automatch", "events"]) {
    const gate = record(prior[gateName]);
    if (
      !["active", "frozen"].includes(String(gate.state)) ||
      !integer(gate.freezeGeneration)
    )
      throw new Error("invalid prior writer gate");
  }
  if (
    record(prior.control).backend !== "rtdb" ||
    !integer(record(prior.control).epoch) ||
    record(prior.automatch).backend !== "d1" ||
    !integer(record(prior.automatch).epoch)
  )
    throw new Error("invalid prior storage authority");
  return value as Maintenance;
}

async function auditWorkflows(
  dependencies: Dependencies,
): Promise<WorkflowAudit> {
  let cursor: string | null = null;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  const hash = createHash("sha256");
  let pages = 0;
  let nonterminal = 0;
  for (;;) {
    if (++pages > MAX_WORKFLOW_PAGES)
      throw new Error(
        "Workflow inventory exceeds its bound; audit remains incomplete",
      );
    const page = await dependencies.workflowPage(cursor);
    if (!Array.isArray(page.rows) || page.rows.length > 100)
      throw new Error("invalid Workflow inventory page");
    for (const row of page.rows) {
      if (
        !row.id ||
        !VERSION.test(row.versionId) ||
        ids.has(row.id) ||
        ![
          "queued",
          "running",
          "paused",
          "errored",
          "terminated",
          "complete",
          "waitingForPause",
          "waiting",
          "rollingBack",
        ].includes(row.status)
      )
        throw new Error("duplicate or invalid Workflow inventory evidence");
      ids.add(row.id);
      hash.update(canonicalJson(row) + "\n");
      if (!["complete", "terminated", "errored"].includes(row.status)) {
        nonterminal++;
        throw new Error(
          "nonterminal event-progress Workflow remains; reconcile it before invite-source activation",
        );
      }
    }
    if (page.cursor === null) break;
    if (!page.cursor || cursors.has(page.cursor) || !page.rows.length)
      throw new Error(
        "Workflow pagination did not advance; audit remains incomplete",
      );
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
  return {
    pages,
    instances: ids.size,
    nonterminal,
    digest: hash.digest("hex"),
  };
}

async function assertFrozen(
  dependencies: Dependencies,
  maintenance: Maintenance,
): Promise<Status> {
  const status = await dependencies.status();
  assertMaintenance(status, maintenance);
  await dependencies.assertDeployment(maintenance.candidateVersionId);
  return status;
}

async function buildInventory(directory: string, dependencies: Dependencies) {
  return inventory(directory, "invites", {
    streamKeys: () => dependencies.streamInviteKeys(),
  });
}

async function readSources(
  inviteIds: string[],
  dependencies: Dependencies,
): Promise<SourceRow[]> {
  const rows = new Array<SourceRow>(inviteIds.length);
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, inviteIds.length) }, async () => {
      while (next < inviteIds.length) {
        const index = next++;
        const inviteId = inviteIds[index];
        rows[index] = sourceRow({
          inviteId,
          source: normalizeInviteSource(
            await dependencies.readInvite(inviteId),
          ),
        });
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return rows;
}

function pagePath(directory: string, index: number): string {
  if (!integer(index) || index >= 100_000)
    throw new Error("invalid export page index");
  return resolve(directory, `source-${index}.json`);
}

function readPage(directory: string, proof: PageProof): Page {
  if (
    !integer(proof.count) ||
    proof.count < 1 ||
    proof.count > ROW_PAGE_SIZE ||
    !HASH.test(proof.digest)
  )
    throw new Error("invalid export page proof");
  const value = record(readPrivateJson(pagePath(directory, proof.index)));
  if (
    value.schemaVersion !== 1 ||
    value.index !== proof.index ||
    !Array.isArray(value.rows) ||
    value.rows.length !== proof.count ||
    digest(value) !== proof.digest
  )
    throw new Error("export page proof mismatch");
  return {
    schemaVersion: 1,
    index: proof.index,
    rows: value.rows.map(sourceRow),
  };
}

function* exportedPages(
  directory: string,
  manifest: Manifest,
): Generator<Page> {
  const keys = inventoryKeys(directory, manifest.inventory);
  const hash = createHash("sha256");
  let count = 0;
  for (const [index, proof] of manifest.pages.entries()) {
    if (proof.index !== index)
      throw new Error("export page coverage is incomplete");
    const page = readPage(directory, proof);
    for (const row of page.rows) {
      if (keys.next().value !== row.inviteId)
        throw new Error("export does not cover the exact invite inventory");
      hash.update(canonicalJson(row) + "\n");
      count++;
    }
    yield page;
  }
  if (
    !keys.next().done ||
    count !== manifest.count ||
    hash.digest("hex") !== manifest.sourceDigest
  )
    throw new Error("export source coverage or digest is incomplete");
}

function loadExport(directory: string): Manifest {
  const value = record(readPrivateJson(resolve(directory, "manifest.json")));
  const session = record(value.session);
  if (
    session.schemaVersion !== 1 ||
    session.projectId !== "mons-link" ||
    session.firebaseRoot !== FIREBASE_ROOT ||
    session.database !== DATABASE ||
    typeof session.exportId !== "string" ||
    !VERSION.test(session.exportId) ||
    !integer(session.createdAtMs) ||
    !Array.isArray(value.pages) ||
    !integer(value.count) ||
    typeof value.sourceDigest !== "string" ||
    !HASH.test(value.sourceDigest) ||
    canonicalJson(session.maintenance) !==
      canonicalJson(loadMaintenance(directory)) ||
    canonicalJson(session) !==
      canonicalJson(readPrivateJson(resolve(directory, "export-session.json")))
  )
    throw new Error("invalid or conflicting invite-source manifest");
  const manifest = value as Manifest;
  for (const page of exportedPages(directory, manifest)) void page;
  return manifest;
}

async function exportSource(
  directory: string,
  maintenance: Maintenance,
  dependencies: Dependencies,
): Promise<Manifest> {
  if (
    (await assertFrozen(dependencies, maintenance)).control.backend !== "rtdb"
  )
    throw new Error("Firebase invite export is retired after D1 activation");
  if (existsSync(resolve(directory, "manifest.json")))
    return loadExport(directory);
  const sessionPath = resolve(directory, "export-session.json");
  if (!existsSync(sessionPath))
    writePrivateImmutable(sessionPath, {
      schemaVersion: 1,
      projectId: "mons-link",
      firebaseRoot: FIREBASE_ROOT,
      database: DATABASE,
      exportId: randomUUID(),
      createdAtMs: dependencies.now(),
      maintenance,
    });
  const session = readPrivateJson(sessionPath) as Session;
  if (canonicalJson(session.maintenance) !== canonicalJson(maintenance))
    throw new Error("export belongs to another maintenance session");
  const sourceInventory = await buildInventory(directory, dependencies);
  const pages: PageProof[] = [];
  const hash = createHash("sha256");
  let rows: SourceRow[] = [];
  let count = 0;
  const publish = async () => {
    const index = pages.length;
    const path = pagePath(directory, index);
    let page: Page;
    if (existsSync(path)) {
      const saved = record(readPrivateJson(path));
      page = readPage(directory, {
        index,
        count: rows.length,
        digest: digest(saved),
      });
      if (
        page.rows.some((row, offset) => row.inviteId !== rows[offset].inviteId)
      )
        throw new Error("resumed export inventory changed");
    } else {
      page = {
        schemaVersion: 1,
        index,
        rows: await readSources(
          rows.map((row) => row.inviteId),
          dependencies,
        ),
      };
      writePrivateImmutable(path, page);
    }
    for (const row of page.rows) hash.update(canonicalJson(row) + "\n");
    count += page.rows.length;
    pages.push({ index, count: page.rows.length, digest: digest(page) });
    rows = [];
    dependencies.log({
      operation: "export-progress",
      pages: pages.length,
      count,
    });
  };
  for (const inviteId of inventoryKeys(directory, sourceInventory)) {
    rows.push({ inviteId, source: {} });
    if (rows.length === ROW_PAGE_SIZE) await publish();
  }
  if (rows.length) await publish();
  await assertFrozen(dependencies, maintenance);
  const manifest: Manifest = {
    session,
    inventory: sourceInventory,
    pages,
    count,
    sourceDigest: hash.digest("hex"),
  };
  writePrivateImmutable(resolve(directory, "manifest.json"), manifest);
  return loadExport(directory);
}

async function verifyDestination(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  for (const page of exportedPages(directory, manifest)) {
    const stored = await dependencies.readRows(
      page.rows.map((row) => row.inviteId),
    );
    const byId = new Map(stored.map((row) => [row.inviteId, row]));
    if (stored.length !== page.rows.length || byId.size !== stored.length)
      throw new Error("destination invite coverage differs from export");
    for (const row of page.rows) {
      const target = byId.get(row.inviteId);
      if (
        !target ||
        target.revision !== 1 ||
        target.updatedAtMs !== manifest.session.createdAtMs ||
        canonicalJson(target.source) !== canonicalJson(row.source)
      )
        throw new Error(
          "destination invite data differs from immutable export",
        );
    }
  }
  if ((await dependencies.countRows()) !== manifest.count)
    throw new Error("destination contains missing or unexpected invites");
}

async function verifySource(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  const verificationDirectory = privateDirectory(
    resolve(directory, `verify-${randomUUID()}`),
  );
  const liveInventory = await buildInventory(
    verificationDirectory,
    dependencies,
  );
  if (
    liveInventory.count !== manifest.inventory.count ||
    liveInventory.digest !== manifest.inventory.digest
  )
    throw new Error("Firebase invite inventory changed after export");
  const hash = createHash("sha256");
  for (const page of exportedPages(directory, manifest)) {
    const liveRows = await readSources(
      page.rows.map((row) => row.inviteId),
      dependencies,
    );
    for (const [index, row] of page.rows.entries()) {
      const live = liveRows[index];
      if (canonicalJson(live.source) !== canonicalJson(row.source))
        throw new Error("Firebase invite metadata changed after export");
      hash.update(canonicalJson(live) + "\n");
    }
  }
  if (hash.digest("hex") !== manifest.sourceDigest)
    throw new Error("Firebase source digest differs from export");
  writePrivateImmutable(resolve(verificationDirectory, "verified.json"), {
    exportId: manifest.session.exportId,
    sourceDigest: manifest.sourceDigest,
    count: manifest.count,
    verifiedAtMs: dependencies.now(),
  });
}

function assertImportProof(
  control: Control,
  manifest: Manifest,
  verified = false,
): void {
  if (
    control.sourceDigest !== manifest.sourceDigest ||
    control.importDigest !== manifest.sourceDigest ||
    control.metadata.exportId !== manifest.session.exportId ||
    control.metadata.sourceCount !== manifest.count ||
    (verified &&
      (!integer(control.verifiedAtMs) ||
        control.metadata.verifiedSourceDigest !== manifest.sourceDigest))
  )
    throw new Error(
      "import or verification evidence does not match this export",
    );
}

async function verifyImport(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<WorkflowAudit> {
  const before = await assertFrozen(dependencies, manifest.session.maintenance);
  if (before.control.backend !== "rtdb")
    throw new Error("source verification is retired after activation");
  assertImportProof(before.control, manifest);
  await verifySource(directory, manifest, dependencies);
  await verifyDestination(directory, manifest, dependencies);
  const audit = await auditWorkflows(dependencies);
  await assertFrozen(dependencies, manifest.session.maintenance);
  await dependencies.recordVerification(manifest, audit);
  assertImportProof((await dependencies.status()).control, manifest, true);
  return audit;
}

async function freeze(
  directory: string,
  versionId: string,
  dependencies: Dependencies,
): Promise<void> {
  await dependencies.assertDeployment(versionId);
  await auditWorkflows(dependencies);
  const evidence = resolve(directory, "maintenance.json");
  if (!existsSync(evidence)) {
    const status = await dependencies.status();
    if (
      status.control.backend !== "rtdb" ||
      (status.control.metadata.maintenanceId &&
        status.control.metadata.abortComplete !== true)
    )
      throw new Error(
        "initial invite maintenance requires unclaimed RTDB authority",
      );
    writePrivateImmutable(evidence, {
      schemaVersion: 1,
      maintenanceId: randomUUID(),
      candidateVersionId: versionId,
      createdAtMs: dependencies.now(),
      prior: {
        control: status.control,
        automatch: status.automatch,
        events: status.events,
      },
    });
  }
  const maintenance = loadMaintenance(directory);
  if (maintenance.candidateVersionId !== versionId)
    throw new Error("candidate differs from protected maintenance evidence");
  await dependencies.claimMaintenance(maintenance);
  for (const gate of ["events", "automatch", "invite"] as const) {
    const status = await dependencies.status();
    assertMaintenance(status, maintenance, false);
    const current = gate === "invite" ? status.control : status[gate];
    const prior =
      gate === "invite" ? maintenance.prior.control : maintenance.prior[gate];
    if (sameGate(current, frozenGate(prior))) continue;
    if (!sameGate(current, prior))
      throw new Error("writer gate changed outside this maintenance session");
    const affectedCounts =
      gate === "events"
        ? [
            status.counts.eventAdmissions,
            status.counts.eventIntents,
            status.counts.eventLeases,
          ]
        : gate === "automatch"
          ? [
              status.counts.sessionAdmissions,
              status.counts.sessionIntents,
              status.counts.sessionResources,
              status.counts.sessionLocks,
              status.counts.inviteAdmissions,
            ]
          : Object.values(status.counts);
    if (affectedCounts.some((count) => count !== 0))
      throw new Error(
        "affected invite-source work is not drained; finish or reconcile it before freezing this gate",
      );
    if (gate === "invite") assertDrained(status);
    await dependencies.setGate(gate, current, "frozen", maintenance);
  }
  await assertFrozen(dependencies, maintenance);
}

async function restore(
  directory: string,
  maintenance: Maintenance,
  dependencies: Dependencies,
  abort: boolean,
  versionId: string,
): Promise<void> {
  await dependencies.assertDeployment(versionId);
  let status = await dependencies.status();
  assertMaintenance(status, maintenance, false);
  if (abort) {
    if (status.control.backend !== "rtdb")
      throw new Error("activated invite authority cannot be rolled back");
    if (
      status.control.sourceDigest !== null ||
      (await dependencies.countRows()) !== 0
    )
      await dependencies.discardImport(maintenance);
  } else if (
    status.control.backend !== "d1" ||
    !status.control.activatedAtMs ||
    !status.control.verifiedAtMs ||
    status.control.sourceDigest !== status.control.importDigest
  ) {
    throw new Error(
      "resume requires verified D1 activation; use --abort only before activation",
    );
  }
  const resumeCandidate =
    status.control.metadata.resumeCandidateVersionId ??
    maintenance.candidateVersionId;
  if (!abort && versionId !== resumeCandidate) {
    assertMaintenance(status, maintenance);
    assertImportProof(status.control, loadExport(directory), true);
    await auditWorkflows(dependencies);
    await dependencies.adoptResumeCandidate(
      maintenance,
      status.control,
      versionId,
    );
    status = await dependencies.status();
    assertMaintenance(status, maintenance);
    if (status.control.metadata.resumeCandidateVersionId !== versionId)
      throw new Error(
        "repair candidate adoption is unconfirmed; retry the same resume command",
      );
  }
  const pendingGates = (["invite", "automatch", "events"] as const).filter(
    (gate) => {
      const current = gate === "invite" ? status.control : status[gate];
      const prior =
        gate === "invite" ? maintenance.prior.control : maintenance.prior[gate];
      const frozen = frozenGate(prior);
      if (
        sameGate(current, { ...frozen, state: prior.state }) ||
        (abort && sameGate(current, prior))
      )
        return false;
      if (!sameGate(current, frozen))
        throw new Error(
          "writer gate changed; refusing to restore another operator's state",
        );
      return true;
    },
  );
  if (!abort) {
    for (const gate of pendingGates) assertDrained(status, gate);
    if (pendingGates.includes("events")) await auditWorkflows(dependencies);
  }
  for (const gate of pendingGates) {
    status = await dependencies.status();
    assertMaintenance(status, maintenance, false);
    const current = gate === "invite" ? status.control : status[gate];
    const prior =
      gate === "invite" ? maintenance.prior.control : maintenance.prior[gate];
    const frozen = frozenGate(prior);
    const restored = { ...frozen, state: prior.state };
    if (sameGate(current, restored) || (abort && sameGate(current, prior)))
      continue;
    if (!sameGate(current, frozen))
      throw new Error(
        "writer gate changed; refusing to restore another operator's state",
      );
    if (!abort) assertDrained(status, gate);
    await dependencies.setGate(gate, current, prior.state, maintenance);
  }
  if (abort) await dependencies.completeAbort(maintenance);
  writePrivateImmutable(
    resolve(directory, abort ? "aborted.json" : `resumed-${versionId}.json`),
    {
      maintenanceId: maintenance.maintenanceId,
      candidateVersionId: versionId,
      backend: abort ? "rtdb" : "d1",
    },
  );
}

async function manageInviteSource(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  if (args.operation === "inspect-admission") {
    await inspectAdmission(args, dependencies);
    return;
  }
  if (args.operation === "reconcile-admission") {
    await reconcileAdmission(args.evidence!, dependencies);
    return;
  }
  if (args.operation === "status") {
    dependencies.log({
      operation: "status",
      ...(await dependencies.status()),
      admissions: await dependencies.listAdmissions(),
    });
    return;
  }
  if (args.operation === "preflight") {
    await dependencies.assertSourceReadable();
    if (args.candidateVersionId) {
      await dependencies.assertDeployment(args.candidateVersionId);
      await auditWorkflows(dependencies);
    }
    const directory = privateDirectory(
      mkdtempSync(resolve(tmpdir(), "mons-invite-preflight-")),
    );
    try {
      const sourceInventory = await buildInventory(directory, dependencies);
      let count = 0;
      let metadataBytes = 0;
      let largestMetadataBytes = 0;
      let pending: string[] = [];
      const readBatch = async () => {
        for (const row of await readSources(pending, dependencies)) {
          const bytes = Buffer.byteLength(canonicalJson(row.source));
          count++;
          metadataBytes += bytes;
          largestMetadataBytes = Math.max(largestMetadataBytes, bytes);
        }
        dependencies.log({
          operation: "preflight-progress",
          count,
          totalCount: sourceInventory.count,
          metadataBytes,
        });
        pending = [];
      };
      for (const inviteId of inventoryKeys(directory, sourceInventory)) {
        pending.push(inviteId);
        if (pending.length === ROW_PAGE_SIZE) await readBatch();
      }
      if (pending.length) await readBatch();
      dependencies.log({
        operation: "preflight",
        count,
        metadataBytes,
        largestMetadataBytes,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    return;
  }
  const directory = privateDirectory(args.directory!);
  if (args.operation === "freeze") {
    await freeze(directory, args.candidateVersionId!, dependencies);
  } else {
    const maintenance = loadMaintenance(directory);
    if (
      args.operation !== "resume" &&
      args.candidateVersionId &&
      args.candidateVersionId !== maintenance.candidateVersionId
    )
      throw new Error("candidate differs from protected maintenance evidence");
    if (args.operation === "resume" || args.operation === "abort") {
      await restore(
        directory,
        maintenance,
        dependencies,
        args.operation === "abort",
        args.candidateVersionId!,
      );
    } else {
      const manifest =
        args.operation === "export"
          ? await exportSource(directory, maintenance, dependencies)
          : loadExport(directory);
      const before = await assertFrozen(dependencies, maintenance);
      if (args.operation === "import") {
        if (before.control.backend !== "rtdb")
          throw new Error("activated invite data cannot be reimported");
        await dependencies.beginImport(manifest);
        for (const page of exportedPages(directory, manifest)) {
          await dependencies.importRows(manifest, page.rows);
        }
        await verifyDestination(directory, manifest, dependencies);
        await dependencies.finishImport(manifest);
      }
      if (args.operation === "verify")
        await verifyImport(directory, manifest, dependencies);
      if (args.operation === "activate") {
        if (before.control.backend === "d1") {
          assertImportProof(before.control, manifest, true);
          if (!before.control.activatedAtMs)
            throw new Error("activation is unconfirmed");
          await auditWorkflows(dependencies);
        } else {
          const audit = await verifyImport(directory, manifest, dependencies);
          await dependencies.activate(manifest, audit);
          const after = await assertFrozen(dependencies, maintenance);
          assertImportProof(after.control, manifest, true);
          if (after.control.backend !== "d1" || !after.control.activatedAtMs)
            throw new Error(
              "activation outcome is unconfirmed; keep gates frozen and retry the same command",
            );
        }
      }
      dependencies.log({
        operation: args.operation,
        exportId: manifest.session.exportId,
        count: manifest.count,
        sourceDigest: manifest.sourceDigest,
      });
    }
  }
  dependencies.log({
    operation: args.operation,
    ...(await dependencies.status()),
  });
}

function parseStatus(
  inviteValue: unknown,
  automatchValue: unknown,
  eventValue: unknown,
): Status {
  const invite = record(inviteValue);
  const automatch = record(automatchValue);
  const events = record(eventValue);
  const gate = (row: JsonRecord, state: unknown): Gate => {
    if (
      !["active", "frozen"].includes(String(state)) ||
      !integer(row.freeze_generation)
    )
      throw new Error("invalid invite migration writer gate");
    return {
      state: state as Gate["state"],
      freezeGeneration: row.freeze_generation,
    };
  };
  if (
    !["rtdb", "d1"].includes(String(invite.backend)) ||
    automatch.backend !== "d1" ||
    !integer(invite.epoch) ||
    !integer(automatch.epoch)
  )
    throw new Error("invalid invite-source or automatch authority");
  if (!["d1", "frozen"].includes(String(events.storage_mode)))
    throw new Error("events must already use canonical D1 storage");
  const nullable = <T extends "string" | "number">(
    field: string,
    type: T,
  ): (T extends "string" ? string : number) | null => {
    if (invite[field] === null) return null;
    if (
      typeof invite[field] !== type ||
      (type === "number" && !integer(invite[field]))
    )
      throw new Error("invalid invite-source control evidence");
    return invite[field] as T extends "string" ? string : number;
  };
  const count = (row: JsonRecord, field: string): number => {
    if (!integer(row[field]))
      throw new Error("invalid invite-source drain count");
    return row[field];
  };
  return {
    control: {
      ...gate(invite, invite.state),
      backend: invite.backend as Control["backend"],
      epoch: invite.epoch,
      candidateVersionId: nullable("candidate_version_id", "string"),
      sourceDigest: nullable("source_digest", "string"),
      importDigest: nullable("import_digest", "string"),
      verifiedAtMs: nullable("verified_at_ms", "number"),
      activatedAtMs: nullable("activated_at_ms", "number"),
      metadata:
        invite.metadata_json === null
          ? {}
          : record(JSON.parse(String(invite.metadata_json))),
    },
    automatch: {
      ...gate(automatch, automatch.state),
      backend: "d1",
      epoch: automatch.epoch,
    },
    events: gate(events, events.storage_mode === "d1" ? "active" : "frozen"),
    counts: {
      inviteAdmissions: count(invite, "invite_admissions"),
      sessionAdmissions: count(automatch, "session_admissions"),
      sessionIntents: count(automatch, "session_intents"),
      sessionResources: count(automatch, "session_resources"),
      sessionLocks: count(automatch, "session_locks"),
      eventAdmissions: count(events, "event_admissions"),
      eventIntents: count(events, "event_intents"),
      eventLeases: count(events, "event_leases"),
    },
  };
}

function resolveCloudflareToken(): string {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const directory = privateDirectory(
    mkdtempSync(resolve(tmpdir(), "mons-invite-auth-")),
  );
  try {
    const result = spawnSync(
      resolve(ROOT, "node_modules/.bin/wrangler"),
      ["auth", "token", "--json"],
      {
        cwd: ROOT,
        encoding: "utf8",
        shell: false,
        timeout: 60_000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"),
        },
      },
    );
    if (result.status !== 0)
      throw new Error(
        "Cloudflare authentication unavailable; use the existing Wrangler login or CLOUDFLARE_API_TOKEN",
      );
    let credentials: JsonRecord;
    try {
      credentials = record(JSON.parse(result.stdout));
    } catch {
      throw new Error(
        "Cloudflare credential response was invalid; contents were not logged",
      );
    }
    if (
      !["oauth", "api_token"].includes(String(credentials.type)) ||
      typeof credentials.token !== "string" ||
      !credentials.token
    )
      throw new Error("invite migration requires an OAuth or API bearer token");
    return credentials.token;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createSqlDependencies(
  run: SqlRunner,
  remote: Pick<
    Dependencies,
    "assertDeployment" | "workflowPage" | "streamInviteKeys" | "readInvite"
  >,
  now = Date.now,
): Dependencies {
  const query = (sql: string, bindings: (string | number | null)[] = []) =>
    run(sql, DATABASE, bindings);
  const requireOne = async (
    sql: string,
    bindings: (string | number | null)[] = [],
    database = DATABASE,
  ) => {
    if ((await run(sql, database, bindings)).length !== 1)
      throw new Error(
        "invite-source state change was not confirmed; retain the same evidence and inspect status",
      );
  };
  const sessionDrained =
    "NOT EXISTS (SELECT 1 FROM invite_source_write_admissions) AND NOT EXISTS (SELECT 1 FROM automatch_write_admissions) AND NOT EXISTS (SELECT 1 FROM game_session_transitions WHERE status = 'pending') AND NOT EXISTS (SELECT 1 FROM game_session_transition_resources) AND NOT EXISTS (SELECT 1 FROM game_session_mutation_locks)";
  const ownership =
    "singleton = 1 AND candidate_version_id = ? AND json_extract(metadata_json, '$.maintenanceId') = ?";
  const identity = (maintenance: Maintenance) => [
    maintenance.candidateVersionId,
    maintenance.maintenanceId,
  ];
  const importGuard = `${ownership} AND backend = 'rtdb' AND state = 'frozen' AND epoch = ? AND freeze_generation = ? AND ${sessionDrained} AND EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = 'd1' AND state = 'frozen' AND epoch = ? AND freeze_generation = ?)`;
  const importBindings = (maintenance: Maintenance) => [
    ...identity(maintenance),
    maintenance.prior.control.epoch,
    frozenGate(maintenance.prior.control).freezeGeneration,
    maintenance.prior.automatch.epoch,
    frozenGate(maintenance.prior.automatch).freezeGeneration,
  ];
  return {
    ...remote,
    now,
    log: (value) => console.log(JSON.stringify(value)),
    assertSourceReadable: () => assertFirebaseInviteSourceAvailable(run),
    async listAdmissions() {
      return (
        await query(
          "SELECT admission_id AS admissionId, backend, epoch, freeze_generation AS freezeGeneration, kind, created_at_ms AS createdAtMs FROM invite_source_write_admissions ORDER BY created_at_ms, admission_id LIMIT 100",
        )
      ).map(parseAdmission);
    },
    async readAdmission(admissionId) {
      const row = (
        await query(
          "SELECT admission_id AS admissionId, backend, epoch, freeze_generation AS freezeGeneration, kind, created_at_ms AS createdAtMs FROM invite_source_write_admissions WHERE admission_id = ?",
          [admissionId],
        )
      )[0];
      return row ? parseAdmission(row) : null;
    },
    async settleAdmission(admission, controls) {
      const current = await this.status();
      if (canonicalJson(admissionControls(current)) !== canonicalJson(controls))
        throw new Error(
          "invite-source control or writer epoch changed before admission removal",
        );
      assertAdmissionWorkDrained(current);
      const control = controls.control;
      await requireOne(
        `DELETE FROM invite_source_write_admissions WHERE admission_id = ? AND backend = ? AND epoch = ? AND freeze_generation = ? AND kind = ? AND created_at_ms = ? AND NOT EXISTS (SELECT 1 FROM game_session_transitions WHERE status = 'pending') AND NOT EXISTS (SELECT 1 FROM game_session_transition_resources) AND NOT EXISTS (SELECT 1 FROM game_session_mutation_locks) AND EXISTS (SELECT 1 FROM invite_source_control WHERE singleton = 1 AND backend = ? AND state = ? AND epoch = ? AND freeze_generation = ? AND candidate_version_id IS ? AND source_digest IS ? AND import_digest IS ? AND verified_at_ms IS ? AND activated_at_ms IS ?) AND EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = ? AND state = ? AND epoch = ? AND freeze_generation = ?) RETURNING admission_id`,
        [
          admission.admissionId,
          admission.backend,
          admission.epoch,
          admission.freezeGeneration,
          admission.kind,
          admission.createdAtMs,
          control.backend,
          control.state,
          control.epoch,
          control.freezeGeneration,
          control.candidateVersionId,
          control.sourceDigest,
          control.importDigest,
          control.verifiedAtMs,
          control.activatedAtMs,
          controls.automatch.backend,
          controls.automatch.state,
          controls.automatch.epoch,
          controls.automatch.freezeGeneration,
        ],
      );
    },
    async status() {
      const invite = (
        await query(
          "SELECT *, (SELECT COUNT(*) FROM invite_source_write_admissions) AS invite_admissions FROM invite_source_control WHERE singleton = 1",
        )
      )[0];
      const automatch = (
        await query(
          "SELECT *, (SELECT COUNT(*) FROM automatch_write_admissions) AS session_admissions, (SELECT COUNT(*) FROM game_session_transitions WHERE status = 'pending') AS session_intents, (SELECT COUNT(*) FROM game_session_transition_resources) AS session_resources, (SELECT COUNT(*) FROM game_session_mutation_locks) AS session_locks FROM automatch_runtime_control WHERE singleton = 1",
        )
      )[0];
      const events = (
        await run(
          "SELECT *, (SELECT COUNT(*) FROM event_write_admissions) AS event_admissions, (SELECT COUNT(*) FROM event_transition_intents) AS event_intents, (SELECT COUNT(*) FROM event_leases) AS event_leases FROM event_runtime_control WHERE singleton = 1",
          EVENT_DATABASE,
        )
      )[0];
      return parseStatus(invite, automatch, events);
    },
    async claimMaintenance(maintenance) {
      const status = await this.status();
      if (status.control.metadata.maintenanceId === maintenance.maintenanceId) {
        assertMaintenance(status, maintenance, false);
        return;
      }
      await requireOne(
        `UPDATE invite_source_control SET candidate_version_id = ?, metadata_json = ? WHERE singleton = 1 AND backend = 'rtdb' AND epoch = ? AND state = ? AND freeze_generation = ? AND (json_extract(metadata_json, '$.maintenanceId') IS NULL OR json_extract(metadata_json, '$.abortComplete') = 1) AND source_digest IS NULL RETURNING singleton`,
        [
          maintenance.candidateVersionId,
          canonicalJson({
            maintenanceId: maintenance.maintenanceId,
            prior: maintenance.prior,
          }),
          maintenance.prior.control.epoch,
          maintenance.prior.control.state,
          maintenance.prior.control.freezeGeneration,
        ],
      );
    },
    async setGate(gate, expected, state, maintenance) {
      const nextGeneration =
        expected.freezeGeneration +
        Number(state === "frozen" && expected.state !== state);
      if (gate === "events") {
        await requireOne(
          `UPDATE event_runtime_control SET storage_mode = ?, freeze_generation = ?, updated_at_ms = ? WHERE singleton = 1 AND storage_mode = ? AND freeze_generation = ? AND NOT EXISTS (SELECT 1 FROM event_write_admissions) ${state === "frozen" ? "AND NOT EXISTS (SELECT 1 FROM event_transition_intents) AND NOT EXISTS (SELECT 1 FROM event_leases)" : ""} RETURNING singleton`,
          [
            state === "active" ? "d1" : "frozen",
            nextGeneration,
            now(),
            expected.state === "active" ? "d1" : "frozen",
            expected.freezeGeneration,
          ],
          EVENT_DATABASE,
        );
      } else if (gate === "automatch") {
        await requireOne(
          `UPDATE automatch_runtime_control SET state = ?, freeze_generation = ? WHERE singleton = 1 AND backend = 'd1' AND state = ? AND freeze_generation = ? AND epoch = ? ${state === "frozen" ? `AND ${sessionDrained}` : ""} RETURNING singleton`,
          [
            state,
            nextGeneration,
            expected.state,
            expected.freezeGeneration,
            maintenance.prior.automatch.epoch,
          ],
        );
      } else {
        await requireOne(
          `UPDATE invite_source_control SET state = ?, freeze_generation = ? WHERE ${ownership} AND state = ? AND freeze_generation = ? AND ${sessionDrained} RETURNING singleton`,
          [
            state,
            nextGeneration,
            ...identity(maintenance),
            expected.state,
            expected.freezeGeneration,
          ],
        );
      }
    },
    async beginImport(manifest) {
      const { maintenance } = manifest.session;
      await requireOne(
        `UPDATE invite_source_control SET source_digest = ?, metadata_json = json_set(metadata_json, '$.exportId', ?, '$.sourceCount', ?) WHERE ${importGuard} AND (json_extract(metadata_json, '$.exportId') IS NULL OR json_extract(metadata_json, '$.exportId') = ?) AND (source_digest IS NULL OR source_digest = ?) RETURNING singleton`,
        [
          manifest.sourceDigest,
          manifest.session.exportId,
          manifest.count,
          ...importBindings(maintenance),
          manifest.session.exportId,
          manifest.sourceDigest,
        ],
      );
    },
    async importRows(manifest, rows) {
      let group: SourceRow[] = [];
      let bytes = 2;
      const insert = async () => {
        if (!group.length) return;
        await query(
          `INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms) SELECT json_extract(value, '$.inviteId'), json_extract(value, '$.source'), 1, ? FROM json_each(?) WHERE EXISTS (SELECT 1 FROM invite_source_control WHERE ${importGuard} AND source_digest = ? AND json_extract(metadata_json, '$.exportId') = ?) ON CONFLICT(invite_id) DO NOTHING`,
          [
            manifest.session.createdAtMs,
            canonicalJson(group),
            ...importBindings(manifest.session.maintenance),
            manifest.sourceDigest,
            manifest.session.exportId,
          ],
        );
        group = [];
        bytes = 2;
      };
      for (const value of rows) {
        const row = sourceRow(value);
        const rowBytes = Buffer.byteLength(canonicalJson(row)) + 1;
        if (bytes + rowBytes > 1_000_000) await insert();
        group.push(row);
        bytes += rowBytes;
      }
      await insert();
    },
    async readRows(inviteIds) {
      return (
        await query(
          "SELECT invite_id, source_json, revision, updated_at_ms FROM invite_sources WHERE invite_id IN (SELECT value FROM json_each(?))",
          [canonicalJson(inviteIds)],
        )
      ).map((row) => ({
        ...sourceRow({
          inviteId: row.invite_id,
          source: JSON.parse(String(row.source_json)),
        }),
        revision: Number(row.revision),
        updatedAtMs: Number(row.updated_at_ms),
      }));
    },
    async countRows() {
      const row = (
        await query("SELECT COUNT(*) AS count FROM invite_sources")
      )[0];
      if (!integer(row?.count))
        throw new Error("invalid invite source row count");
      return row.count;
    },
    async finishImport(manifest) {
      await requireOne(
        `UPDATE invite_source_control SET import_digest = ? WHERE ${importGuard} AND source_digest = ? AND json_extract(metadata_json, '$.exportId') = ? AND (SELECT COUNT(*) FROM invite_sources) = ? RETURNING singleton`,
        [
          manifest.sourceDigest,
          ...importBindings(manifest.session.maintenance),
          manifest.sourceDigest,
          manifest.session.exportId,
          manifest.count,
        ],
      );
    },
    async recordVerification(manifest, audit) {
      await requireOne(
        `UPDATE invite_source_control SET verified_at_ms = ?, metadata_json = json_set(metadata_json, '$.verifiedSourceDigest', ?, '$.workflowAudit', json(?)) WHERE ${importGuard} AND source_digest = ? AND import_digest = ? AND json_extract(metadata_json, '$.exportId') = ? RETURNING singleton`,
        [
          now(),
          manifest.sourceDigest,
          canonicalJson(audit),
          ...importBindings(manifest.session.maintenance),
          manifest.sourceDigest,
          manifest.sourceDigest,
          manifest.session.exportId,
        ],
      );
    },
    async activate(manifest, audit) {
      await requireOne(
        `UPDATE invite_source_control SET backend = 'd1', epoch = epoch + 1, activated_at_ms = ? WHERE ${importGuard} AND source_digest = ? AND import_digest = ? AND verified_at_ms IS NOT NULL AND json_extract(metadata_json, '$.verifiedSourceDigest') = ? AND json_extract(metadata_json, '$.workflowAudit.digest') = ? AND json_extract(metadata_json, '$.exportId') = ? AND (SELECT COUNT(*) FROM invite_sources) = ? RETURNING singleton`,
        [
          now(),
          ...importBindings(manifest.session.maintenance),
          manifest.sourceDigest,
          manifest.sourceDigest,
          manifest.sourceDigest,
          audit.digest,
          manifest.session.exportId,
          manifest.count,
        ],
      );
    },
    async adoptResumeCandidate(maintenance, control, versionId) {
      assertMaintenance(await this.status(), maintenance);
      await requireOne(
        `UPDATE invite_source_control SET metadata_json = json_set(metadata_json, '$.resumeCandidateVersionId', ?, '$.resumeCandidateAdoptedAtMs', ?) WHERE ${ownership} AND backend = 'd1' AND state = 'frozen' AND epoch = ? AND freeze_generation = ? AND source_digest = ? AND import_digest = ? AND verified_at_ms = ? AND activated_at_ms = ? AND json_extract(metadata_json, '$.resumeCandidateVersionId') IS ? AND ${sessionDrained} AND EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = 'd1' AND state = 'frozen' AND epoch = ? AND freeze_generation = ?) RETURNING singleton`,
        [
          versionId,
          now(),
          ...identity(maintenance),
          control.epoch,
          control.freezeGeneration,
          control.sourceDigest,
          control.importDigest,
          control.verifiedAtMs,
          control.activatedAtMs,
          typeof control.metadata.resumeCandidateVersionId === "string"
            ? control.metadata.resumeCandidateVersionId
            : null,
          maintenance.prior.automatch.epoch,
          frozenGate(maintenance.prior.automatch).freezeGeneration,
        ],
      );
    },
    async discardImport(maintenance) {
      const status = await this.status();
      assertMaintenance(status, maintenance);
      if (status.control.backend !== "rtdb")
        throw new Error("activated invite data is permanent");
      for (;;) {
        const deleted = await query(
          `DELETE FROM invite_sources WHERE invite_id IN (SELECT invite_id FROM invite_sources LIMIT 100) AND EXISTS (SELECT 1 FROM invite_source_control WHERE ${importGuard}) RETURNING invite_id`,
          importBindings(maintenance),
        );
        if (!deleted.length) break;
      }
      await requireOne(
        `UPDATE invite_source_control SET source_digest = NULL, import_digest = NULL, verified_at_ms = NULL, metadata_json = json_remove(metadata_json, '$.exportId', '$.sourceCount', '$.verifiedSourceDigest', '$.workflowAudit') WHERE ${importGuard} AND NOT EXISTS (SELECT 1 FROM invite_sources) RETURNING singleton`,
        importBindings(maintenance),
      );
    },
    async completeAbort(maintenance) {
      await requireOne(
        `UPDATE invite_source_control SET metadata_json = json_set(metadata_json, '$.abortComplete', json('true')) WHERE ${ownership} AND backend = 'rtdb' AND source_digest IS NULL AND import_digest IS NULL AND NOT EXISTS (SELECT 1 FROM invite_sources) RETURNING singleton`,
        identity(maintenance),
      );
    },
  };
}

function createProductionDependencies(
  firebaseCredentials?: string,
  {
    apiToken = resolveCloudflareToken(),
    fetcher = fetch,
  }: { apiToken?: string; fetcher?: typeof fetch } = {},
): Dependencies {
  const typescript = require("typescript") as typeof import("typescript");
  const configPath = resolve(ROOT, "cloud/workers/api/wrangler.jsonc");
  const parsed = typescript.parseConfigFileTextToJson(
    configPath,
    readFileSync(configPath, "utf8"),
  );
  const accountId = record(parsed.config).account_id;
  if (
    parsed.error ||
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(accountId)
  )
    throw new Error("invalid tracked Cloudflare account");
  const token = createFirebaseTokenProvider(
    firebaseCredentials || process.env.GOOGLE_APPLICATION_CREDENTIALS,
  );
  const cloudflare = async (path: string): Promise<JsonRecord> => {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`,
      {
        headers: { Authorization: `Bearer ${apiToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      },
    );
    const payload = record(await readResponseJson(response));
    if (payload.success !== true)
      throw new Error("Cloudflare invite migration evidence request failed");
    return payload;
  };
  return createSqlDependencies(createWranglerRunner({ apiToken, fetcher }), {
    async assertDeployment(versionId) {
      const payload = await cloudflare(
        "workers/scripts/mons-link-api/deployments",
      );
      const deployments = record(payload.result).deployments;
      const latest = Array.isArray(deployments) ? record(deployments[0]) : {};
      const versions = latest.versions;
      if (
        !Array.isArray(versions) ||
        versions.length !== 1 ||
        record(versions[0]).version_id !== versionId ||
        record(versions[0]).percentage !== 100
      )
        throw new Error(
          "invite-source candidate must be the sole 100% deployed API version",
        );
      const subdomain = record(
        (await cloudflare("workers/scripts/mons-link-api/subdomain")).result,
      );
      if (subdomain.enabled !== false || subdomain.previews_enabled !== false)
        throw new Error(
          "Worker subdomain and preview URLs must remain disabled",
        );
    },
    async workflowPage(cursor) {
      const query = new URLSearchParams({ per_page: "100", direction: "asc" });
      if (cursor !== null) query.set("cursor", cursor);
      const payload = await cloudflare(
        `workflows/${WORKFLOW}/instances?${query}`,
      );
      if (!Array.isArray(payload.result))
        throw new Error("invalid Workflow instance inventory");
      const info = record(payload.result_info);
      if (
        info.count !== payload.result.length ||
        (info.cursor !== undefined &&
          info.cursor !== null &&
          typeof info.cursor !== "string")
      )
        throw new Error("invalid Workflow pagination metadata");
      const next =
        typeof info.cursor === "string" && info.cursor ? info.cursor : null;
      if (!next && payload.result.length === 100)
        throw new Error(
          "full Workflow page has no continuation proof; audit remains incomplete",
        );
      return {
        rows: payload.result.map((value) => {
          const row = record(value);
          if (
            typeof row.id !== "string" ||
            typeof row.status !== "string" ||
            typeof row.version_id !== "string"
          )
            throw new Error("invalid Workflow instance evidence");
          return { id: row.id, status: row.status, versionId: row.version_id };
        }),
        cursor: next,
      };
    },
    async *streamInviteKeys() {
      const url = new URL(`${FIREBASE_ROOT}/invites.json`);
      url.searchParams.set("shallow", "true");
      const response = await fetcher(url, {
        headers: {
          Authorization: `Bearer ${await token()}`,
          Accept: "application/json",
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok || !response.body)
        throw new Error(
          "Firebase invite inventory failed; export remains incomplete",
        );
      yield* parseShallowKeys(
        Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        ),
      );
    },
    async readInvite(inviteId) {
      sourceRow({ inviteId, source: {} });
      const response = await fetcher(
        `${FIREBASE_ROOT}/invites/${encodeURIComponent(inviteId)}.json`,
        {
          headers: {
            Authorization: `Bearer ${await token()}`,
            Accept: "application/json",
          },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        },
      );
      return readResponseJson(response);
    },
  });
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(
      "manage:invite-source --status | --inspect-admission <UUID> --directory /secure/admission-evidence | --reconcile-admission --evidence /secure/completed-evidence.json | --preflight [--candidate-version-id <deployed-version>] [--firebase-credentials /secure/firebase.json] | --freeze --directory /secure/invite-source --candidate-version-id <deployed-version> | --export --directory /secure/invite-source [--firebase-credentials /secure/firebase.json] | --import --directory /secure/invite-source | --verify|--activate --directory /secure/invite-source --candidate-version-id <deployed-version> [--firebase-credentials /secure/firebase.json] | --resume|--abort --directory /secure/invite-source --candidate-version-id <deployed-version>",
    );
    return;
  }
  const args = parseArgs(argv);
  await manageInviteSource(
    args,
    createProductionDependencies(args.firebaseCredentials),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  execute().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "invite-source migration failed; retain the protected evidence and inspect status",
    );
    process.exitCode = 1;
  });
}

export {
  parseArgs,
  sourceRow,
  parseStatus,
  frozenGate,
  assertDrained,
  auditWorkflows,
  loadExport,
  exportedPages,
  createSqlDependencies,
  createProductionDependencies,
  manageInviteSource,
  type Arguments,
  type Control,
  type Status,
  type Maintenance,
  type Manifest,
  type SourceRow,
  type StoredRow,
  type WorkflowPage,
  type Dependencies,
};
