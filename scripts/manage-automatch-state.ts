import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertFirebaseInviteSourceAvailable } from "./invite-source-retirement.ts";
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

const DATABASE = "mons-link-profile-games";
const FIREBASE_ROOT = "https://mons-link-default-rtdb.firebaseio.com";
const LEGACY_RETIREMENT_MS = 15 * 60 * 1000;
const VERSION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PAGES = 100_000;
const MAX_RECORD_BYTES = 900_000;
const LEGACY_WRITER_PREDICATE =
  "(writer_generation != 2 OR (writer_owner_id IS NOT owner_id AND EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = 'rtdb')))";
const ROOTS = [
  "automatch",
  "telegramAutomatches",
  "telegramProjectionOutbox/automatch",
  "profileGameProjectionOutbox/automatch",
  "gameplayMutationReceipts",
  "gameplayMutationReceiptExpirations",
] as const;
const TABLES = [
  "automatch_entries",
  "automatch_telegram_sources",
  "automatch_telegram_projection_outbox",
  "game_session_projection_outbox",
  "game_session_mutation_receipts",
  "game_session_mutation_receipts",
] as const;
type Root = (typeof ROOTS)[number];
type RecordValue = Record<string, unknown>;
type Operation =
  | "status"
  | "preflight"
  | "stage"
  | "freeze"
  | "export"
  | "import"
  | "verify"
  | "activate"
  | "resume"
  | "inspect-legacy"
  | "reconcile-legacy"
  | "inspect-admissions"
  | "reconcile-admission";
type Arguments = {
  operation: Operation;
  directory?: string;
  evidence?: string;
  candidateVersionId?: string;
  firebaseCredentials?: string;
  pageSize: number;
};
type Control = {
  backend: "rtdb" | "d1";
  state: "active" | "frozen";
  epoch: number;
  freezeGeneration: number;
  stagedAtMs: number | null;
  candidateVersionId: string | null;
  sourceDigest: string | null;
  importDigest: string | null;
  importedAtMs: number | null;
  activatedAtMs: number | null;
  metadata: RecordValue;
};
type Status = {
  control: Control;
  admissions: number;
  legacyLocks: number;
  legacyFence: boolean;
};
type Entry = { key: string; value: unknown };
type StoredEntry = Entry & { revision: number; updatedAtMs: number };
type SourcePage = {
  schemaVersion: 1;
  root: Root;
  index: number;
  after: string | null;
  entries: Entry[];
  references: Record<string, unknown>;
};
type PageProof = {
  root: Root;
  index: number;
  count: number;
  after: string | null;
  lastKey: string;
  digest: string;
};
type Summary = { root: Root; count: number; digest: string };
type Session = {
  schemaVersion: 1;
  exportId: string;
  projectId: "mons-link";
  firebaseRoot: typeof FIREBASE_ROOT;
  database: typeof DATABASE;
  createdAtMs: number;
  epoch: number;
  freezeGeneration: number;
  candidateVersionId: string;
  pageSize: number;
};
type Manifest = {
  session: Session;
  roots: Summary[];
  pages: PageProof[];
  sourceDigest: string;
};
type LegacyRow = {
  lockId: string;
  ownerId: string;
  operationId: string;
  expiresAtMs: number;
  releasedAtMs: number | null;
};
type AdmissionRow = {
  admissionId: string;
  backend: "rtdb" | "d1";
  epoch: number;
  freezeGeneration: number;
  kind: string;
  createdAtMs: number;
  phase: "prepared" | "dispatching" | "uncertain" | "completed";
  proofJson: string | null;
  auditRevision: number;
  updatedAtMs: number;
  completedAtMs: number | null;
};
type Dependencies = {
  assertInviteSourceAvailable?(): Promise<void>;
  readAdmissions(admissionId?: string): Promise<AdmissionRow[]>;
  readAdmissionPath(admission: AdmissionRow, path: string): Promise<unknown>;
  settleAdmission(admission: AdmissionRow): Promise<void>;
  readLegacyRows(): Promise<LegacyRow[]>;
  readEvidencePath(path: string): Promise<unknown>;
  settleLegacy(row: LegacyRow, evidenceDigest: string): Promise<void>;
  now(): number;
  log(value: RecordValue): void;
  status(): Promise<Status>;
  stage(versionId: string, nowMs: number): Promise<void>;
  freeze(control: Control): Promise<void>;
  resume(control: Control, versionId: string): Promise<void>;
  assertDeployment(versionId: string): Promise<void>;
  assertQueuesPaused(): Promise<void>;
  assertRules(): Promise<void>;
  readSource(
    root: Root,
    after: string | null,
    pageSize: number,
  ): Promise<unknown>;
  readReference(inviteId: string, queue: unknown): Promise<unknown>;
  readDestination(root: Root, keys: string[]): Promise<StoredEntry[]>;
  countDestination(root: Root): Promise<number>;
  beginImport(manifest: Manifest): Promise<void>;
  importEntry(root: Root, entry: Entry, session: Session): Promise<void>;
  recordImport(manifest: Manifest): Promise<void>;
  recordVerification(manifest: Manifest): Promise<void>;
  activate(manifest: Manifest): Promise<void>;
};

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function safeKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 768 &&
    !/[.#$[\]/]/.test(value) &&
    value.isWellFormed() &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
function parseArgs(argv: string[]): Arguments {
  const operations: Operation[] = [
    "status",
    "preflight",
    "stage",
    "freeze",
    "export",
    "import",
    "verify",
    "activate",
    "resume",
    "inspect-legacy",
    "reconcile-legacy",
    "inspect-admissions",
    "reconcile-admission",
  ];
  const operation = argv[0]?.replace(/^--/, "") as Operation;
  if (!operations.includes(operation) || argv[0] !== `--${operation}`)
    throw new Error(
      `choose exactly one operation: ${operations.map((value) => `--${value}`).join(", ")}`,
    );
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      ![
        "--directory",
        "--evidence",
        "--candidate-version-id",
        "--firebase-credentials",
        "--page-size",
      ].includes(name) ||
      options.has(name) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error("invalid, duplicate or missing migration argument");
    options.set(name, value);
  }
  const directory = options.get("--directory");
  const evidence = options.get("--evidence");
  if (
    Boolean(evidence) !==
    ["reconcile-legacy", "reconcile-admission"].includes(operation)
  )
    throw new Error(
      "reconciliation requires a protected --evidence file; no other operation accepts it",
    );
  const candidateVersionId = options.get("--candidate-version-id");
  const firebaseCredentials = options.get("--firebase-credentials");
  const pageSize = Number(options.get("--page-size") || 100);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500)
    throw new Error("page size must be between 1 and 500");
  const artifactOperation = [
    "export",
    "import",
    "verify",
    "activate",
    "inspect-legacy",
    "inspect-admissions",
  ].includes(operation);
  if (artifactOperation !== Boolean(directory))
    throw new Error(
      "export/import/verify/activate require a protected directory; other operations do not accept one",
    );
  if (
    ["stage", "export", "verify", "activate", "resume"].includes(operation) &&
    !candidateVersionId
  )
    throw new Error("this operation requires --candidate-version-id");
  if (candidateVersionId && !VERSION_PATTERN.test(candidateVersionId))
    throw new Error("candidate must be an uploaded Worker version UUID");
  if (
    candidateVersionId &&
    !["stage", "export", "verify", "activate", "resume", "freeze"].includes(
      operation,
    )
  )
    throw new Error("candidate version is not valid for this operation");
  if (
    options.has("--page-size") &&
    !["export", "preflight"].includes(operation)
  )
    throw new Error("page size is only valid for export and preflight");
  if (
    firebaseCredentials &&
    ["status", "stage", "import", "resume"].includes(operation)
  )
    throw new Error("this operation does not use Firebase credentials");
  return {
    operation,
    directory,
    evidence,
    candidateVersionId,
    firebaseCredentials,
    pageSize,
  };
}
function parseAdmission(value: unknown): AdmissionRow {
  const row = record(value);
  if (
    !row ||
    !safeKey(row.admissionId) ||
    !["rtdb", "d1"].includes(String(row.backend)) ||
    !integer(row.epoch) ||
    row.epoch < 1 ||
    !integer(row.freezeGeneration) ||
    typeof row.kind !== "string" ||
    !row.kind ||
    !integer(row.createdAtMs) ||
    !["prepared", "dispatching", "uncertain", "completed"].includes(
      String(row.phase),
    ) ||
    !(row.proofJson === null || typeof row.proofJson === "string") ||
    !integer(row.auditRevision) ||
    !integer(row.updatedAtMs) ||
    !(row.completedAtMs === null || integer(row.completedAtMs))
  )
    throw new Error("invalid exact admission evidence");
  if (typeof row.proofJson === "string") {
    try {
      canonicalJson(JSON.parse(row.proofJson));
    } catch {
      throw new Error("invalid private admission proof JSON");
    }
  }
  return row as AdmissionRow;
}
function evidencePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    value.split("/").every(safeKey) &&
    (ROOTS.some((root) => value === root || value.startsWith(`${root}/`)) ||
      value.startsWith("invites/") ||
      value.startsWith("players/"))
  );
}
function admissionTargetPaths(admission: AdmissionRow): string[] | null {
  if (admission.proofJson === null) return null;
  const proof = record(JSON.parse(admission.proofJson));
  if (!proof || proof.schemaVersion !== 1)
    throw new Error("unsupported admission target proof");
  const paths =
    proof.kind === "patch" && record(proof.updates)
      ? Object.keys(record(proof.updates)!)
      : proof.kind === "transaction" && typeof proof.path === "string"
        ? [proof.path]
        : null;
  if (
    paths === null ||
    paths.length > 10000 ||
    paths.some((path) => !evidencePath(path))
  )
    throw new Error("invalid recorded admission target scope");
  return [...new Set(paths)].sort();
}
async function admissionSources(
  admission: AdmissionRow,
  paths: string[],
  dependencies: Dependencies,
): Promise<Array<{ path: string; digest: string }>> {
  const sources: Array<{ path: string; digest: string }> = [];
  for (let index = 0; index < paths.length; index += 8) {
    const results = await Promise.allSettled(
      paths.slice(index, index + 8).map(async (path) => ({
        path,
        digest: digest(await dependencies.readAdmissionPath(admission, path)),
      })),
    );
    for (const result of results) {
      if (result.status === "rejected")
        throw new Error(
          "admission source evidence read failed; no admission was cleared",
        );
      sources.push(result.value);
    }
  }
  return sources;
}
function validCompletionEvidence(value: unknown): boolean {
  const evidence = record(value);
  return Boolean(
    evidence &&
    ["provider-completion", "operator-investigation"].includes(
      String(evidence.kind),
    ) &&
    typeof evidence.reference === "string" &&
    evidence.reference.trim() &&
    typeof evidence.explanation === "string" &&
    evidence.explanation.trim(),
  );
}
async function reconcileAdmission(
  evidencePathname: string,
  dependencies: Dependencies,
): Promise<void> {
  const evidence = record(readPrivateJson(evidencePathname));
  if (!evidence || evidence.schemaVersion !== 1)
    throw new Error("invalid admission recovery evidence");
  const admission = parseAdmission(evidence.admission);
  if (admission.backend === "rtdb")
    await dependencies.assertInviteSourceAvailable?.();
  if (digest(admission) !== evidence.admissionDigest)
    throw new Error("admission evidence digest mismatch");
  const currentRows = await dependencies.readAdmissions(admission.admissionId);
  if (currentRows.length === 0) {
    dependencies.log({
      operation: "reconcile-admission",
      alreadyAbsent: true,
      evidenceDigest: digest(evidence),
    });
    return;
  }
  if (
    currentRows.length !== 1 ||
    canonicalJson(currentRows[0]) !== canonicalJson(admission)
  )
    throw new Error(
      "admission changed after inspection; recover only the current exact proof",
    );
  const safePhase =
    (admission.backend === "rtdb" && admission.phase === "prepared") ||
    (admission.phase === "completed" &&
      admission.completedAtMs !== null &&
      admission.completedAtMs >= admission.createdAtMs &&
      admission.completedAtMs <= dependencies.now());
  if (!safePhase) {
    if (
      !integer(evidence.requestFinishedAtMs) ||
      evidence.requestFinishedAtMs < admission.createdAtMs ||
      evidence.requestFinishedAtMs > dependencies.now() ||
      !validCompletionEvidence(evidence.completionEvidence)
    )
      throw new Error(
        "uncertain admission requires finished-request evidence; age or a timeout is not completion evidence",
      );
    const expected = admissionTargetPaths(admission);
    const noSourceEffects = evidence.noSourceEffects === true;
    if (
      (evidence.noSourceEffects !== undefined &&
        typeof evidence.noSourceEffects !== "boolean") ||
      !Array.isArray(evidence.sources) ||
      (evidence.sources.length === 0) !== noSourceEffects ||
      evidence.sources.length > 10000
    )
      throw new Error(
        "uncertain admission requires a complete bounded target snapshot or explicit noSourceEffects with an empty source list",
      );
    const supplied = evidence.sources.map((value) => {
      const source = record(value);
      if (
        !source ||
        !evidencePath(source.path) ||
        typeof source.digest !== "string" ||
        !DIGEST_PATTERN.test(source.digest)
      )
        throw new Error("invalid admission source digest evidence");
      return { path: source.path, digest: source.digest };
    });
    const paths = supplied.map((source) => source.path);
    if (new Set(paths).size !== paths.length)
      throw new Error("duplicate admission source evidence");
    if (expected === null || noSourceEffects) {
      const scope = record(evidence.scopeEvidence);
      if (
        !scope ||
        typeof scope.reference !== "string" ||
        !scope.reference.trim() ||
        typeof scope.explanation !== "string" ||
        !scope.explanation.trim()
      )
        throw new Error(
          "admission without durable targets or source effects requires an audited complete request scope",
        );
    }
    if (expected?.some((path) => !paths.includes(path)))
      throw new Error(
        "admission evidence omits a recorded write target or operation receipt",
      );
    const actual = await admissionSources(admission, paths, dependencies);
    if (canonicalJson(actual) !== canonicalJson(supplied))
      throw new Error(
        "admission sources changed after investigation; refresh evidence before recovery",
      );
  }
  const auditPath = resolve(
    evidencePathname,
    "..",
    `admission-reconciliation-${digest(evidence)}.json`,
  );
  const audit = {
    schemaVersion: 1,
    evidence,
    evidenceDigest: digest(evidence),
    resolution: safePhase ? admission.phase : "operator-reconciled",
  };
  if (existsSync(auditPath)) {
    if (canonicalJson(readPrivateJson(auditPath)) !== canonicalJson(audit))
      throw new Error("admission recovery audit artifact conflict");
  } else writePrivateImmutable(auditPath, audit);
  await dependencies.settleAdmission(admission);
  dependencies.log({
    operation: "reconcile-admission",
    resolution: audit.resolution,
    evidenceDigest: digest(evidence),
  });
}
function parseControl(value: unknown): Control {
  const row = record(value);
  if (
    !row ||
    !["rtdb", "d1"].includes(String(row.backend)) ||
    !["active", "frozen"].includes(String(row.state)) ||
    !integer(row.epoch) ||
    row.epoch < 1 ||
    !integer(row.freeze_generation)
  )
    throw new Error(
      "automatch control missing or invalid; apply reviewed schema first",
    );
  const nullableNumber = (key: string): number | null => {
    if (row[key] === null) return null;
    if (!integer(row[key]))
      throw new Error("invalid automatch control timestamp");
    return row[key] as number;
  };
  const nullableString = (key: string): string | null => {
    if (row[key] === null) return null;
    if (typeof row[key] !== "string" || !row[key])
      throw new Error("invalid automatch control text");
    return row[key] as string;
  };
  let metadata: RecordValue = {};
  if (row.metadata_json !== null) {
    const parsed =
      typeof row.metadata_json === "string"
        ? record(JSON.parse(row.metadata_json))
        : null;
    if (!parsed) throw new Error("invalid automatch migration metadata");
    metadata = parsed;
  }
  return {
    backend: row.backend as Control["backend"],
    state: row.state as Control["state"],
    epoch: row.epoch,
    freezeGeneration: row.freeze_generation,
    stagedAtMs: nullableNumber("staged_at_ms"),
    candidateVersionId: nullableString("candidate_version_id"),
    sourceDigest: nullableString("source_digest"),
    importDigest: nullableString("import_digest"),
    importedAtMs: nullableNumber("imported_at_ms"),
    activatedAtMs: nullableNumber("activated_at_ms"),
    metadata,
  };
}
function assertStaged(status: Status, nowMs: number): void {
  if (
    !status.legacyFence ||
    !status.control.candidateVersionId ||
    status.control.stagedAtMs === null
  )
    throw new Error(
      "stage the control-aware candidate and legacy writer fence first",
    );
  if (nowMs < status.control.stagedAtMs + LEGACY_RETIREMENT_MS)
    throw new Error(
      "legacy Cron/Queue retirement prerequisite not met; leave service active and finish preparation before starting maintenance",
    );
  if (status.legacyLocks !== 0)
    throw new Error(
      "legacy writer evidence remains; confirm each request finished and reconcile its source effects before recovery",
    );
}
async function assertFrozen(
  dependencies: Dependencies,
  session?: Session,
): Promise<Status> {
  const status = await dependencies.status();
  assertStaged(status, dependencies.now());
  if (Object.hasOwn(status.control.metadata, "importResetGeneration"))
    throw new Error("RTDB import reset is incomplete; retry --resume first");
  if (status.control.state !== "frozen" || status.admissions !== 0)
    throw new Error(
      "automatch gate must remain frozen with zero unresolved admissions; expired admissions do not count as drained",
    );
  if (
    session &&
    (status.control.epoch !== session.epoch ||
      status.control.freezeGeneration !== session.freezeGeneration ||
      status.control.candidateVersionId !== session.candidateVersionId)
  )
    throw new Error(
      "frozen writer epoch or candidate changed; do not reuse this export",
    );
  await dependencies.assertDeployment(
    session?.candidateVersionId || status.control.candidateVersionId!,
  );
  await dependencies.assertQueuesPaused();
  return status;
}
function normalizeSourcePage(
  raw: unknown,
  root: Root,
  index: number,
  after: string | null,
  pageSize: number,
): SourcePage {
  const value = raw === null ? {} : record(raw);
  if (!value)
    throw new Error(
      "source root must be a keyed object; reconcile malformed root before export",
    );
  const keys = Object.keys(value).sort(compareFirebaseKeys);
  if (keys.length > pageSize + (after === null ? 0 : 1))
    throw new Error("source page exceeds requested bound");
  if (after !== null && keys[0] !== after)
    throw new Error("source cursor changed during export");
  const selected = after === null ? keys : keys.slice(1);
  const entries = selected.map((key) => {
    if (
      !safeKey(key) ||
      (after !== null && compareFirebaseKeys(key, after) <= 0) ||
      value[key] === null
    )
      throw new Error("invalid source record key or value");
    const json = canonicalJson(value[key]);
    if (Buffer.byteLength(json) > MAX_RECORD_BYTES)
      throw new Error(
        "source record exceeds supported D1 migration bound; reconcile without truncating data",
      );
    return { key, value: JSON.parse(json) as unknown };
  });
  return { schemaVersion: 1, root, index, after, entries, references: {} };
}
function pagePath(directory: string, root: Root, index: number): string {
  return resolve(
    directory,
    `root-${ROOTS.indexOf(root)}-page-${String(index).padStart(6, "0")}.json`,
  );
}
function assertSession(value: unknown): Session {
  const data = record(value);
  if (
    !data ||
    data.schemaVersion !== 1 ||
    data.projectId !== "mons-link" ||
    data.firebaseRoot !== FIREBASE_ROOT ||
    data.database !== DATABASE ||
    typeof data.exportId !== "string" ||
    !VERSION_PATTERN.test(data.exportId) ||
    typeof data.candidateVersionId !== "string" ||
    !VERSION_PATTERN.test(data.candidateVersionId) ||
    !integer(data.createdAtMs) ||
    !integer(data.epoch) ||
    !integer(data.freezeGeneration) ||
    !integer(data.pageSize) ||
    data.pageSize < 1 ||
    data.pageSize > 500
  )
    throw new Error("invalid export session");
  return data as Session;
}
function loadPage(directory: string, proof: PageProof): SourcePage {
  const value = readPrivateJson(pagePath(directory, proof.root, proof.index));
  const data = record(value);
  if (
    !data ||
    digest(data) !== proof.digest ||
    data.schemaVersion !== 1 ||
    data.root !== proof.root ||
    data.index !== proof.index ||
    data.after !== proof.after ||
    !Array.isArray(data.entries) ||
    data.entries.length !== proof.count ||
    !record(data.references)
  )
    throw new Error("export page proof mismatch");
  let last = proof.after;
  for (const item of data.entries) {
    const entry = record(item);
    if (
      !entry ||
      !safeKey(entry.key) ||
      entry.value === null ||
      entry.value === undefined ||
      (last !== null && compareFirebaseKeys(entry.key, last) <= 0)
    )
      throw new Error("invalid exported entry ordering");
    last = entry.key;
  }
  if (last !== proof.lastKey) throw new Error("export page final key mismatch");
  return data as SourcePage;
}
function summarizePages(directory: string, pages: PageProof[]): Summary[] {
  return ROOTS.map((root) => {
    const hash = createHash("sha256");
    let count = 0;
    let after: string | null = null;
    for (const [index, proof] of pages
      .filter((value) => value.root === root)
      .entries()) {
      if (proof.index !== index || proof.after !== after || proof.count < 1)
        throw new Error("export pagination evidence is incomplete");
      const page = loadPage(directory, proof);
      for (const entry of page.entries) {
        hash.update(canonicalJson(entry) + "\n");
        count++;
      }
      after = proof.lastKey;
    }
    return { root, count, digest: hash.digest("hex") };
  });
}
function loadExport(directory: string): Manifest {
  const value = record(readPrivateJson(resolve(directory, "manifest.json")));
  if (
    !value ||
    !Array.isArray(value.pages) ||
    !Array.isArray(value.roots) ||
    typeof value.sourceDigest !== "string" ||
    !DIGEST_PATTERN.test(value.sourceDigest)
  )
    throw new Error("invalid export manifest");
  const session = assertSession(value.session);
  if (
    canonicalJson(session) !==
    canonicalJson(readPrivateJson(resolve(directory, "session.json")))
  )
    throw new Error("export session differs from manifest");
  const pages = value.pages as PageProof[];
  for (const proof of pages) {
    if (
      !ROOTS.includes(proof.root) ||
      !integer(proof.index) ||
      !integer(proof.count) ||
      typeof proof.digest !== "string" ||
      !DIGEST_PATTERN.test(proof.digest)
    )
      throw new Error("invalid page proof");
  }
  const roots = summarizePages(directory, pages);
  if (
    canonicalJson(roots) !== canonicalJson(value.roots) ||
    digest({ roots, pages }) !== value.sourceDigest
  )
    throw new Error("export source summary mismatch");
  const allowed = new Set(
    pages.map((proof) => pagePath(directory, proof.root, proof.index)),
  );
  for (const name of readdirSync(directory)) {
    if (name.startsWith("root-") && !allowed.has(resolve(directory, name)))
      throw new Error("export contains an unmanifested page");
  }
  return { session, pages, roots, sourceDigest: value.sourceDigest };
}
async function buildSourcePage(
  dependencies: Dependencies,
  root: Root,
  index: number,
  after: string | null,
  pageSize: number,
): Promise<SourcePage> {
  const page = normalizeSourcePage(
    await dependencies.readSource(root, after, pageSize),
    root,
    index,
    after,
    pageSize,
  );
  if (root === "automatch") {
    const references: Array<[string, unknown]> = [];
    for (const entry of page.entries)
      references.push([
        entry.key,
        await dependencies.readReference(entry.key, entry.value),
      ]);
    page.references = Object.fromEntries(references);
  }
  return page;
}
async function exportSource(
  directory: string,
  args: Arguments,
  dependencies: Dependencies,
): Promise<Manifest> {
  const status = await assertFrozen(dependencies);
  if (status.control.backend !== "rtdb")
    throw new Error("source export is retired after D1 activation");
  if (status.control.candidateVersionId !== args.candidateVersionId)
    throw new Error("export candidate differs from staged deployment");
  await dependencies.assertRules();
  const path = resolve(directory, "session.json");
  const session: Session = existsSync(path)
    ? assertSession(readPrivateJson(path))
    : {
        schemaVersion: 1 as const,
        exportId: randomUUID(),
        projectId: "mons-link" as const,
        firebaseRoot: FIREBASE_ROOT,
        database: DATABASE,
        createdAtMs: dependencies.now(),
        epoch: status.control.epoch,
        freezeGeneration: status.control.freezeGeneration,
        candidateVersionId: args.candidateVersionId!,
        pageSize: args.pageSize,
      };
  if (session.pageSize !== args.pageSize)
    throw new Error("resume export with the original page size");
  await assertFrozen(dependencies, session);
  if (!existsSync(path)) writePrivateImmutable(path, session);
  if (existsSync(resolve(directory, "manifest.json")))
    return loadExport(directory);
  const pages: PageProof[] = [];
  for (const root of ROOTS) {
    let after: string | null = null;
    for (let index = 0; ; index++) {
      if (index >= MAX_PAGES) throw new Error("export page limit exceeded");
      await assertFrozen(dependencies, session);
      const page = await buildSourcePage(
        dependencies,
        root,
        index,
        after,
        args.pageSize,
      );
      if (page.entries.length === 0) break;
      const path = pagePath(directory, root, index);
      if (existsSync(path)) {
        if (canonicalJson(readPrivateJson(path)) !== canonicalJson(page))
          throw new Error("source changed while resuming export");
      } else writePrivateImmutable(path, page);
      const lastKey = page.entries.at(-1)!.key;
      pages.push({
        root,
        index,
        count: page.entries.length,
        after,
        lastKey,
        digest: digest(page),
      });
      after = lastKey;
      dependencies.log({
        operation: "export-progress",
        root,
        page: index,
        count: page.entries.length,
      });
    }
  }
  await assertFrozen(dependencies, session);
  const roots = summarizePages(directory, pages);
  const manifest: Manifest = {
    session,
    roots,
    pages,
    sourceDigest: digest({ roots, pages }),
  };
  writePrivateImmutable(resolve(directory, "manifest.json"), manifest);
  return loadExport(directory);
}
async function verifySource(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  for (const root of ROOTS) {
    let after: string | null = null;
    const proofs = manifest.pages.filter((proof) => proof.root === root);
    for (let index = 0; ; index++) {
      if (index >= MAX_PAGES)
        throw new Error("source verification page limit exceeded");
      await assertFrozen(dependencies, manifest.session);
      const page = await buildSourcePage(
        dependencies,
        root,
        index,
        after,
        manifest.session.pageSize,
      );
      if (page.entries.length === 0) {
        if (index !== proofs.length)
          throw new Error("source shrank after export");
        break;
      }
      const proof = proofs[index];
      if (
        !proof ||
        digest(page) !== proof.digest ||
        canonicalJson(page) !== canonicalJson(loadPage(directory, proof))
      )
        throw new Error(
          "source or stable invite references changed after export",
        );
      after = page.entries.at(-1)!.key;
    }
  }
}
async function verifyDestination(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  for (const root of ROOTS) {
    let count = 0;
    for (const proof of manifest.pages.filter((proof) => proof.root === root)) {
      const entries = loadPage(directory, proof).entries;
      for (let offset = 0; offset < entries.length; offset += 50) {
        const expected = entries.slice(offset, offset + 50);
        const actual = await dependencies.readDestination(
          root,
          expected.map((entry) => entry.key),
        );
        const values = new Map(
          actual.map((entry) => [entry.key, canonicalJson(entry.value)]),
        );
        if (
          actual.some(
            (entry) =>
              entry.revision !== 1 ||
              entry.updatedAtMs !== manifest.session.createdAtMs,
          ) ||
          actual.length !== expected.length ||
          values.size !== expected.length ||
          expected.some(
            (entry) => values.get(entry.key) !== canonicalJson(entry.value),
          )
        )
          throw new Error("destination differs from exported source");
        count += expected.length;
      }
    }
    if (
      count !==
        manifest.roots.find((summary) => summary.root === root)!.count ||
      (await dependencies.countDestination(root)) !== count
    )
      throw new Error("destination has missing or extra records");
  }
}
async function verifyImport(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  const status = await assertFrozen(dependencies, manifest.session);
  if (
    status.control.backend !== "rtdb" ||
    status.control.sourceDigest !== manifest.sourceDigest ||
    status.control.importDigest !== manifest.sourceDigest ||
    status.control.metadata.exportId !== manifest.session.exportId
  )
    throw new Error("import is incomplete or belongs to another export");
  await dependencies.assertRules();
  await verifySource(directory, manifest, dependencies);
  await verifyDestination(directory, manifest, dependencies);
  await assertFrozen(dependencies, manifest.session);
  await dependencies.recordVerification(manifest);
}
function activationProof(control: Control, manifest: Manifest): void {
  if (
    (control.backend === "d1"
      ? control.metadata.activationCandidateVersionId
      : control.candidateVersionId) !== manifest.session.candidateVersionId ||
    control.sourceDigest !== manifest.sourceDigest ||
    control.importDigest !== manifest.sourceDigest ||
    control.metadata.exportId !== manifest.session.exportId ||
    control.metadata.verifiedEpoch !== manifest.session.epoch ||
    control.metadata.verifiedFreezeGeneration !==
      manifest.session.freezeGeneration ||
    control.metadata.verifiedSourceDigest !== manifest.sourceDigest ||
    !integer(control.metadata.verifiedAtMs)
  )
    throw new Error(
      "activation proof does not match this candidate/export/frozen epoch",
    );
}
async function manageAutomatchState(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  if (args.operation === "inspect-admissions") {
    const directory = privateDirectory(args.directory!);
    const admissions = await dependencies.readAdmissions();
    for (const admission of admissions) {
      if (admission.backend === "rtdb")
        await dependencies.assertInviteSourceAvailable?.();
      const paths = admissionTargetPaths(admission);
      const sources =
        paths === null
          ? []
          : await admissionSources(admission, paths, dependencies);
      const evidence = {
        schemaVersion: 1,
        admission,
        admissionDigest: digest(admission),
        requestFinishedAtMs: null,
        completionEvidence: null,
        scopeEvidence: null,
        noSourceEffects: false,
        sources,
      };
      const path = resolve(directory, `admission-${digest(admission)}.json`);
      if (existsSync(path)) {
        if (canonicalJson(readPrivateJson(path)) !== canonicalJson(evidence))
          throw new Error(
            "admission source changed; inspect into a new protected directory",
          );
      } else writePrivateImmutable(path, evidence);
    }
    dependencies.log({
      operation: "inspect-admissions",
      count: admissions.length,
    });
    return;
  }
  if (args.operation === "reconcile-admission") {
    await reconcileAdmission(args.evidence!, dependencies);
    return;
  }
  if (!["status", "freeze", "resume"].includes(args.operation))
    await dependencies.assertInviteSourceAvailable?.();
  if (args.operation === "inspect-legacy") {
    const directory = privateDirectory(args.directory!);
    const rows = await dependencies.readLegacyRows();
    for (const row of rows) {
      const receiptPath = `gameplayMutationReceipts/${row.operationId}`;
      const receipt = await dependencies.readEvidencePath(receiptPath);
      const paths = [receiptPath];
      const inviteId = record(receipt)?.inviteId;
      if (safeKey(inviteId)) paths.push(`invites/${inviteId}`);
      const sources = [];
      for (const path of paths)
        sources.push({
          path,
          digest: digest(await dependencies.readEvidencePath(path)),
        });
      const evidence = {
        schemaVersion: 1,
        row,
        rowDigest: digest(row),
        requestFinishedAtMs: null,
        completionEvidence: null,
        sources,
      };
      writePrivateImmutable(
        resolve(directory, `legacy-${digest(row)}.json`),
        evidence,
      );
    }
    dependencies.log({ operation: "inspect-legacy", count: rows.length });
    return;
  }
  if (args.operation === "reconcile-legacy") {
    const evidence = record(readPrivateJson(args.evidence!));
    const row = record(evidence?.row);
    const completion = record(evidence?.completionEvidence);
    if (
      !evidence ||
      evidence.schemaVersion !== 1 ||
      !row ||
      !safeKey(row.lockId) ||
      typeof row.ownerId !== "string" ||
      !row.ownerId ||
      !safeKey(row.operationId) ||
      !integer(row.expiresAtMs) ||
      !(row.releasedAtMs === null || integer(row.releasedAtMs)) ||
      digest(row) !== evidence.rowDigest ||
      !integer(evidence.requestFinishedAtMs) ||
      evidence.requestFinishedAtMs > dependencies.now() ||
      !completion ||
      !["provider-completion", "operator-investigation"].includes(
        String(completion.kind),
      ) ||
      typeof completion.reference !== "string" ||
      !completion.reference.trim() ||
      typeof completion.explanation !== "string" ||
      !completion.explanation.trim() ||
      !Array.isArray(evidence.sources) ||
      evidence.sources.length < 1 ||
      evidence.sources.length > 100
    )
      throw new Error(
        "legacy reconciliation requires exact row proof, completed-request evidence, and current source digests; a lease expiry is not completion evidence",
      );
    const sources = evidence.sources.map((value) => {
      const source = record(value);
      if (
        !source ||
        typeof source.path !== "string" ||
        !source.path.split("/").every(safeKey) ||
        !(
          ROOTS.some(
            (root) =>
              source.path === root ||
              String(source.path).startsWith(`${root}/`),
          ) ||
          source.path.startsWith("invites/") ||
          source.path.startsWith("players/")
        ) ||
        typeof source.digest !== "string" ||
        !DIGEST_PATTERN.test(source.digest)
      )
        throw new Error("invalid legacy source proof");
      return { path: source.path, digest: source.digest };
    });
    if (
      !sources.some(
        (source) =>
          source.path === `gameplayMutationReceipts/${row.operationId}`,
      )
    )
      throw new Error(
        "legacy evidence must include the exact operation receipt",
      );
    const current = (await dependencies.readLegacyRows()).find(
      (value) => value.lockId === row.lockId && value.ownerId === row.ownerId,
    );
    if (!current || canonicalJson(current) !== canonicalJson(row))
      throw new Error(
        "legacy writer evidence changed; inspect and reconcile the current exact tuple",
      );
    for (const source of sources) {
      if (
        digest(await dependencies.readEvidencePath(source.path)) !==
        source.digest
      )
        throw new Error(
          "legacy source changed since investigation; refresh reconciliation evidence",
        );
    }
    await dependencies.settleLegacy(current, digest(evidence));
    dependencies.log({
      operation: "reconcile-legacy",
      evidenceDigest: digest(evidence),
    });
    return;
  }
  if (args.operation === "status") {
    dependencies.log({ operation: "status", ...(await dependencies.status()) });
    return;
  }
  if (args.operation === "stage") {
    await dependencies.assertDeployment(args.candidateVersionId!);
    await dependencies.stage(args.candidateVersionId!, dependencies.now());
    dependencies.log({ operation: "stage", ...(await dependencies.status()) });
    return;
  }
  if (args.operation === "preflight") {
    const status = await dependencies.status();
    const counts: Partial<Record<Root, number>> = {};
    for (const root of ROOTS) {
      let after: string | null = null;
      let count = 0;
      for (let index = 0; ; index++) {
        if (index >= MAX_PAGES)
          throw new Error("preflight page limit exceeded");
        const page = await buildSourcePage(
          dependencies,
          root,
          index,
          after,
          args.pageSize,
        );
        if (page.entries.length === 0) break;
        count += page.entries.length;
        after = page.entries.at(-1)!.key;
      }
      counts[root] = count;
    }
    dependencies.log({
      operation: "preflight",
      ...status,
      counts,
      retirementReady:
        status.control.stagedAtMs !== null &&
        dependencies.now() >= status.control.stagedAtMs + LEGACY_RETIREMENT_MS,
      activationProof: false,
    });
    return;
  }
  if (args.operation === "freeze") {
    const status = await dependencies.status();
    assertStaged(status, dependencies.now());
    if (
      status.control.backend === "rtdb" &&
      args.candidateVersionId &&
      args.candidateVersionId !== status.control.candidateVersionId
    )
      throw new Error("freeze candidate differs from staged version");
    await dependencies.assertDeployment(
      args.candidateVersionId || status.control.candidateVersionId!,
    );
    await dependencies.assertRules();
    if (status.control.state !== "frozen")
      await dependencies.freeze(status.control);
    dependencies.log({ operation: "freeze", ...(await dependencies.status()) });
    return;
  }
  if (args.operation === "resume") {
    const status = await dependencies.status();
    if (
      status.control.backend === "rtdb" &&
      status.control.candidateVersionId !== args.candidateVersionId
    )
      throw new Error("resume candidate differs from migration control");
    await dependencies.assertDeployment(args.candidateVersionId!);
    assertStaged(status, dependencies.now());
    if (status.admissions !== 0)
      throw new Error("unresolved admissions prevent resume");
    if (
      status.control.backend === "d1" &&
      (!status.control.activatedAtMs ||
        status.control.sourceDigest !== status.control.importDigest ||
        !integer(status.control.metadata.verifiedAtMs) ||
        typeof status.control.metadata.activationCandidateVersionId !==
          "string" ||
        !VERSION_PATTERN.test(
          status.control.metadata.activationCandidateVersionId,
        ))
    )
      throw new Error("D1 activation is unverified");
    if (
      status.control.state === "active" &&
      status.control.candidateVersionId !== args.candidateVersionId
    )
      throw new Error("freeze D1 writes before adopting a repair candidate");
    if (status.control.state !== "active")
      await dependencies.resume(status.control, args.candidateVersionId!);
    dependencies.log({ operation: "resume", ...(await dependencies.status()) });
    return;
  }
  const directory = privateDirectory(args.directory!);
  const manifest =
    args.operation === "export"
      ? await exportSource(directory, args, dependencies)
      : loadExport(directory);
  if (
    args.candidateVersionId &&
    args.candidateVersionId !== manifest.session.candidateVersionId
  )
    throw new Error("candidate differs from immutable export");
  if (args.operation === "import") {
    const status = await assertFrozen(dependencies, manifest.session);
    if (status.control.backend !== "rtdb")
      throw new Error("imports are retired after activation");
    if (
      status.control.metadata.exportId &&
      status.control.metadata.exportId !== manifest.session.exportId
    )
      throw new Error("another export owns this import");
    await dependencies.beginImport(manifest);
    for (const proof of manifest.pages) {
      await assertFrozen(dependencies, manifest.session);
      for (const entry of loadPage(directory, proof).entries)
        await dependencies.importEntry(proof.root, entry, manifest.session);
    }
    await verifyDestination(directory, manifest, dependencies);
    await dependencies.recordImport(manifest);
  }
  if (args.operation === "verify")
    await verifyImport(directory, manifest, dependencies);
  if (args.operation === "activate") {
    const before = await dependencies.status();
    if (before.control.backend === "d1") {
      activationProof(before.control, manifest);
      if (
        before.control.epoch !== manifest.session.epoch + 1 ||
        before.control.activatedAtMs === null
      )
        throw new Error("D1 activation outcome is unconfirmed");
    } else {
      await verifyImport(directory, manifest, dependencies);
      await dependencies.activate(manifest);
      const after = await dependencies.status();
      activationProof(after.control, manifest);
      if (
        after.control.backend !== "d1" ||
        after.control.state !== "frozen" ||
        after.control.epoch !== manifest.session.epoch + 1
      )
        throw new Error(
          "activation outcome is unconfirmed; keep frozen and retry the same command",
        );
    }
  }
  dependencies.log({
    operation: args.operation,
    exportId: manifest.session.exportId,
    roots: manifest.roots,
    sourceDigest: manifest.sourceDigest,
    control: (await dependencies.status()).control,
  });
}

function migrationGuard(session: Session): string {
  return `EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = 'rtdb' AND state = 'frozen' AND epoch = ${session.epoch} AND freeze_generation = ${session.freezeGeneration} AND json_type(metadata_json, '$.importResetGeneration') IS NULL) AND NOT EXISTS (SELECT 1 FROM automatch_write_admissions) AND EXISTS (SELECT 1 FROM game_session_legacy_fence WHERE singleton = 1 AND enabled = 1) AND NOT EXISTS (SELECT 1 FROM game_session_mutation_locks WHERE ${LEGACY_WRITER_PREDICATE}) AND NOT EXISTS (SELECT 1 FROM game_session_legacy_releases WHERE reconciled_at_ms IS NULL)`;
}
function createSqlDependencies(
  run: SqlRunner,
  remote: Pick<
    Dependencies,
    | "assertDeployment"
    | "assertQueuesPaused"
    | "assertRules"
    | "readSource"
    | "readReference"
    | "readEvidencePath"
  >,
  now = Date.now,
): Dependencies {
  const query = (sql: string, bindings: Array<string | number | null> = []) =>
    run(sql, DATABASE, bindings);
  const requireOne = async (
    sql: string,
    bindings: Array<string | number | null> = [],
  ): Promise<RecordValue> => {
    const rows = await query(sql, bindings);
    if (rows.length !== 1)
      throw new Error(
        "automatch migration control or record changed; keep frozen and inspect status",
      );
    return rows[0];
  };
  const status = async (): Promise<Status> => {
    const row = (
      await query(
        `SELECT control.*, (SELECT COUNT(*) FROM automatch_write_admissions) AS admissions, (SELECT COUNT(*) FROM game_session_mutation_locks WHERE ${LEGACY_WRITER_PREDICATE}) AS legacy_locks, (SELECT COUNT(*) FROM game_session_legacy_releases WHERE reconciled_at_ms IS NULL) AS legacy_releases, (SELECT enabled FROM game_session_legacy_fence WHERE singleton = 1) AS legacy_fence FROM automatch_runtime_control AS control WHERE singleton = 1`,
      )
    )[0];
    if (
      !row ||
      !integer(row.admissions) ||
      !integer(row.legacy_locks) ||
      !integer(row.legacy_releases) ||
      ![0, 1].includes(Number(row.legacy_fence))
    )
      throw new Error("invalid automatch admission/fence status");
    return {
      control: parseControl(row),
      admissions: row.admissions,
      legacyLocks: row.legacy_locks + row.legacy_releases,
      legacyFence: row.legacy_fence === 1,
    };
  };
  const metadata = (manifest: Manifest): string =>
    canonicalJson({
      exportId: manifest.session.exportId,
      sourceDigest: manifest.sourceDigest,
      roots: manifest.roots,
      exportEpoch: manifest.session.epoch,
      exportFreezeGeneration: manifest.session.freezeGeneration,
    });
  const candidateGuard = "candidate_version_id = ?";
  return {
    ...remote,
    now,
    assertInviteSourceAvailable: () => assertFirebaseInviteSourceAvailable(run),
    status,
    log: (value) => console.log(JSON.stringify(value)),
    async readAdmissions(admissionId) {
      if (admissionId !== undefined && !safeKey(admissionId))
        throw new Error("invalid admission ID");
      const rows = await query(
        `SELECT * FROM automatch_write_admissions ${admissionId === undefined ? "" : "WHERE admission_id = ?"} ORDER BY admission_id LIMIT 1000`,
        admissionId === undefined ? [] : [admissionId],
      );
      return rows.map((row) =>
        parseAdmission({
          admissionId: row.admission_id,
          backend: row.backend,
          epoch: row.epoch,
          freezeGeneration: row.freeze_generation,
          kind: row.kind,
          createdAtMs: row.created_at_ms,
          phase: row.phase,
          proofJson: row.proof_json,
          auditRevision: row.audit_revision,
          updatedAtMs: row.updated_at_ms,
          completedAtMs: row.completed_at_ms,
        }),
      );
    },
    async readAdmissionPath(admission, path) {
      const root = [...ROOTS]
        .sort((left, right) => right.length - left.length)
        .find((root) => path === root || path.startsWith(`${root}/`));
      if (admission.backend === "rtdb" || !root) {
        if (admission.backend === "rtdb" || path.startsWith("invites/"))
          await assertFirebaseInviteSourceAvailable(run);
        return remote.readEvidencePath(path);
      }
      const [key, ...nested] = path.slice(root.length + 1).split("/");
      if (!safeKey(key))
        throw new Error("D1 admission proof must identify an exact record");
      const index = ROOTS.indexOf(root);
      const column = index === 5 ? "expiration_json" : "payload_json";
      const row = (
        await query(
          `SELECT ${column} AS value FROM ${TABLES[index]} WHERE record_key = ?`,
          [key],
        )
      )[0];
      let value: unknown =
        typeof row?.value === "string" ? JSON.parse(row.value) : null;
      for (const field of nested) {
        const parent = record(value);
        value = parent && Object.hasOwn(parent, field) ? parent[field] : null;
      }
      return value;
    },
    async settleAdmission(admission) {
      await requireOne(
        "DELETE FROM automatch_write_admissions WHERE admission_id = ? AND backend = ? AND epoch = ? AND freeze_generation = ? AND kind = ? AND created_at_ms = ? AND phase = ? AND proof_json IS ? AND audit_revision = ? AND updated_at_ms = ? AND completed_at_ms IS ? RETURNING admission_id",
        [
          admission.admissionId,
          admission.backend,
          admission.epoch,
          admission.freezeGeneration,
          admission.kind,
          admission.createdAtMs,
          admission.phase,
          admission.proofJson,
          admission.auditRevision,
          admission.updatedAtMs,
          admission.completedAtMs,
        ],
      );
    },
    async readLegacyRows() {
      const rows = await query(
        `SELECT lock_id, owner_id, operation_id, expires_at_ms, NULL AS released_at_ms FROM game_session_mutation_locks WHERE ${LEGACY_WRITER_PREDICATE} UNION ALL SELECT lock_id, owner_id, operation_id, expires_at_ms, released_at_ms FROM game_session_legacy_releases WHERE reconciled_at_ms IS NULL ORDER BY lock_id, owner_id LIMIT 1000`,
      );
      return rows.map((row) => {
        if (
          !safeKey(row.lock_id) ||
          typeof row.owner_id !== "string" ||
          !safeKey(row.operation_id) ||
          !integer(row.expires_at_ms) ||
          !(row.released_at_ms === null || integer(row.released_at_ms))
        )
          throw new Error("invalid legacy writer evidence row");
        return {
          lockId: row.lock_id,
          ownerId: row.owner_id,
          operationId: row.operation_id,
          expiresAtMs: row.expires_at_ms,
          releasedAtMs: row.released_at_ms,
        };
      });
    },
    async settleLegacy(row, evidenceDigest) {
      const statusValue = await status();
      if (!statusValue.legacyFence)
        throw new Error(
          "enable the legacy writer fence before settling legacy evidence",
        );
      if (row.releasedAtMs === null) {
        await requireOne(
          `DELETE FROM game_session_mutation_locks WHERE lock_id = ? AND owner_id = ? AND operation_id = ? AND expires_at_ms = ? AND ${LEGACY_WRITER_PREDICATE} AND EXISTS (SELECT 1 FROM game_session_legacy_fence WHERE singleton = 1 AND enabled = 1) RETURNING lock_id`,
          [row.lockId, row.ownerId, row.operationId, row.expiresAtMs],
        );
      }
      await requireOne(
        `UPDATE game_session_legacy_releases SET reconciled_at_ms = ?, evidence_digest = ? WHERE lock_id = ? AND owner_id = ? AND operation_id = ? AND expires_at_ms = ? AND reconciled_at_ms IS NULL ${row.releasedAtMs === null ? "" : "AND released_at_ms = ?"} RETURNING lock_id`,
        [
          now(),
          evidenceDigest,
          row.lockId,
          row.ownerId,
          row.operationId,
          row.expiresAtMs,
          ...(row.releasedAtMs === null ? [] : [row.releasedAtMs]),
        ],
      );
    },
    async stage(versionId, nowMs) {
      const before = await status();
      if (
        before.control.backend !== "rtdb" ||
        before.control.state !== "active" ||
        before.control.metadata.exportId ||
        before.control.sourceDigest !== null
      )
        throw new Error("stage requires active RTDB control before any import");
      const retainLegacyStage =
        before.legacyFence && before.control.stagedAtMs !== null;
      const legacyVersion = retainLegacyStage
        ? before.control.metadata.legacyStagedVersionId ||
          before.control.candidateVersionId ||
          versionId
        : versionId;
      await requireOne(
        "UPDATE game_session_legacy_fence SET enabled = 1, enabled_at_ms = COALESCE(enabled_at_ms, ?), candidate_version_id = ? WHERE singleton = 1 AND EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = 'rtdb' AND state = 'active' AND source_digest IS NULL AND json_extract(metadata_json, '$.exportId') IS NULL) RETURNING singleton",
        [nowMs, versionId],
      );
      await requireOne(
        "UPDATE automatch_runtime_control SET staged_at_ms = CASE WHEN ? = 1 THEN staged_at_ms ELSE ? END, metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.legacyStagedVersionId', ?), candidate_version_id = ? WHERE singleton = 1 AND backend = 'rtdb' AND state = 'active' AND source_digest IS NULL AND json_extract(metadata_json, '$.exportId') IS NULL AND EXISTS (SELECT 1 FROM game_session_legacy_fence WHERE singleton = 1 AND enabled = 1 AND candidate_version_id = ?) RETURNING singleton",
        [
          retainLegacyStage ? 1 : 0,
          nowMs,
          String(legacyVersion),
          versionId,
          versionId,
        ],
      );
    },
    async freeze(control) {
      await requireOne(
        "UPDATE automatch_runtime_control SET state = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1 AND state = 'active' AND epoch = ? AND freeze_generation = ? AND candidate_version_id = ? RETURNING singleton",
        [control.epoch, control.freezeGeneration, control.candidateVersionId],
      );
    },
    async resume(control, versionId) {
      const guard = `singleton = 1 AND backend = ? AND state = 'frozen' AND epoch = ? AND freeze_generation = ? AND candidate_version_id = ? AND NOT EXISTS (SELECT 1 FROM automatch_write_admissions) AND EXISTS (SELECT 1 FROM game_session_legacy_fence WHERE singleton = 1 AND enabled = 1) AND NOT EXISTS (SELECT 1 FROM game_session_mutation_locks WHERE ${LEGACY_WRITER_PREDICATE}) AND NOT EXISTS (SELECT 1 FROM game_session_legacy_releases WHERE reconciled_at_ms IS NULL)`;
      let freezeGeneration = control.freezeGeneration;
      const guardValues = () => [
        control.backend,
        control.epoch,
        freezeGeneration,
        control.candidateVersionId,
      ];
      if (control.backend === "rtdb") {
        if (control.candidateVersionId !== versionId)
          throw new Error("resume candidate differs from migration control");
        if (Object.hasOwn(control.metadata, "importResetGeneration")) {
          if (control.metadata.importResetGeneration !== freezeGeneration)
            throw new Error("invalid RTDB import reset generation");
        } else {
          if (!integer(freezeGeneration + 1))
            throw new Error("automatch freeze generation exhausted");
          await requireOne(
            `UPDATE automatch_runtime_control SET freeze_generation = freeze_generation + 1, metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.importResetGeneration', freeze_generation + 1) WHERE ${guard} AND activated_at_ms IS NULL AND json_type(metadata_json, '$.importResetGeneration') IS NULL RETURNING singleton`,
            guardValues(),
          );
          freezeGeneration++;
        }
        const resetGuard = `${guard} AND activated_at_ms IS NULL AND json_type(metadata_json, '$.importResetGeneration') = 'integer' AND json_extract(metadata_json, '$.importResetGeneration') = freeze_generation`;
        const tables = [...new Set(TABLES)];
        for (const table of tables) {
          for (;;) {
            const deleted = await query(
              `DELETE FROM ${table} WHERE record_key IN (SELECT record_key FROM ${table} ORDER BY record_key LIMIT 500) AND EXISTS (SELECT 1 FROM automatch_runtime_control WHERE ${resetGuard}) RETURNING record_key`,
              guardValues(),
            );
            if (deleted.length === 0) break;
          }
        }
        await requireOne(
          `UPDATE automatch_runtime_control SET state = 'active', source_digest = NULL, import_digest = NULL, imported_at_ms = NULL, metadata_json = json_remove(metadata_json, '$.exportId', '$.sourceDigest', '$.roots', '$.exportEpoch', '$.exportFreezeGeneration', '$.verifiedEpoch', '$.verifiedFreezeGeneration', '$.verifiedSourceDigest', '$.verifiedAtMs', '$.importResetGeneration') WHERE ${resetGuard} AND ${tables.map((table) => `NOT EXISTS (SELECT 1 FROM ${table})`).join(" AND ")} RETURNING singleton`,
          guardValues(),
        );
        return;
      }
      await requireOne(
        `UPDATE automatch_runtime_control SET state = 'active', candidate_version_id = ? WHERE ${guard} RETURNING singleton`,
        [versionId, ...guardValues()],
      );
    },
    async readDestination(root, keys) {
      if (!keys.length || keys.length > 50 || keys.some((key) => !safeKey(key)))
        throw new Error("invalid bounded destination key query");
      const index = ROOTS.indexOf(root);
      const column = index === 5 ? "expiration_json" : "payload_json";
      const rows = await query(
        `SELECT record_key, ${column} AS value, ${index === 5 ? "expiration_revision" : "revision"} AS revision, updated_at_ms FROM ${TABLES[index]} WHERE ${column} IS NOT NULL AND record_key IN (${keys.map(() => "?").join(",")})`,
        keys,
      );
      return rows.map((row) => {
        if (!safeKey(row.record_key) || typeof row.value !== "string")
          throw new Error("invalid D1 export record");
        if (!integer(row.revision) || !integer(row.updated_at_ms))
          throw new Error("invalid imported revision metadata");
        return {
          key: row.record_key,
          value: JSON.parse(row.value) as unknown,
          revision: row.revision,
          updatedAtMs: row.updated_at_ms,
        };
      });
    },
    async countDestination(root) {
      const index = ROOTS.indexOf(root);
      const column = index === 5 ? "expiration_json" : "payload_json";
      const count = (
        await query(
          `SELECT COUNT(*) AS count FROM ${TABLES[index]} WHERE ${column} IS NOT NULL`,
        )
      )[0]?.count;
      if (!integer(count)) throw new Error("invalid destination count");
      return count;
    },
    async beginImport(manifest) {
      await requireOne(
        `UPDATE automatch_runtime_control SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.exportId', ?) WHERE singleton = 1 AND ${migrationGuard(manifest.session)} AND ${candidateGuard} AND (json_extract(metadata_json, '$.exportId') IS NULL OR json_extract(metadata_json, '$.exportId') = ?) RETURNING singleton`,
        [
          manifest.session.exportId,
          manifest.session.candidateVersionId,
          manifest.session.exportId,
        ],
      );
    },
    async importEntry(root, entry, session) {
      const index = ROOTS.indexOf(root);
      const table = TABLES[index];
      const column = index === 5 ? "expiration_json" : "payload_json";
      const revision = index === 5 ? "expiration_revision" : "revision";
      const json = canonicalJson(entry.value);
      const guard = `${migrationGuard(session)} AND EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND ${candidateGuard} AND json_extract(metadata_json, '$.exportId') = ?)`;
      const conflict =
        index >= 4
          ? `((${table}.${column} IS NULL AND ${table}.${revision} = 0) OR (${table}.${column} IS excluded.${column} AND ${table}.${revision} = 1))`
          : `${table}.${column} IS excluded.${column} AND ${table}.${revision} = 1`;
      await requireOne(
        `INSERT INTO ${table} (record_key, ${column}, ${revision}, updated_at_ms) SELECT ?, ?, 1, ? WHERE ${guard} ON CONFLICT (record_key) DO UPDATE SET ${column} = excluded.${column}, ${revision} = 1 WHERE ${conflict} AND ${table}.updated_at_ms = excluded.updated_at_ms AND ${guard} RETURNING record_key`,
        [
          entry.key,
          json,
          session.createdAtMs,
          session.candidateVersionId,
          session.exportId,
          session.candidateVersionId,
          session.exportId,
        ],
      );
    },
    async recordImport(manifest) {
      await requireOne(
        `UPDATE automatch_runtime_control SET source_digest = ?, import_digest = ?, imported_at_ms = ?, metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?) WHERE singleton = 1 AND ${migrationGuard(manifest.session)} AND ${candidateGuard} AND json_extract(metadata_json, '$.exportId') = ? RETURNING singleton`,
        [
          manifest.sourceDigest,
          manifest.sourceDigest,
          now(),
          metadata(manifest),
          manifest.session.candidateVersionId,
          manifest.session.exportId,
        ],
      );
    },
    async recordVerification(manifest) {
      await requireOne(
        `UPDATE automatch_runtime_control SET metadata_json = json_set(metadata_json, '$.verifiedEpoch', CAST(? AS INTEGER), '$.verifiedFreezeGeneration', CAST(? AS INTEGER), '$.verifiedSourceDigest', ?, '$.verifiedAtMs', CAST(? AS INTEGER)) WHERE singleton = 1 AND ${migrationGuard(manifest.session)} AND ${candidateGuard} AND source_digest = ? AND import_digest = ? AND json_extract(metadata_json, '$.exportId') = ? RETURNING singleton`,
        [
          manifest.session.epoch,
          manifest.session.freezeGeneration,
          manifest.sourceDigest,
          now(),
          manifest.session.candidateVersionId,
          manifest.sourceDigest,
          manifest.sourceDigest,
          manifest.session.exportId,
        ],
      );
    },
    async activate(manifest) {
      await requireOne(
        `UPDATE automatch_runtime_control SET backend = 'd1', epoch = epoch + 1, activated_at_ms = ?, metadata_json = json_set(metadata_json, '$.activationCandidateVersionId', candidate_version_id) WHERE singleton = 1 AND ${migrationGuard(manifest.session)} AND ${candidateGuard} AND source_digest = ? AND import_digest = ? AND json_extract(metadata_json, '$.exportId') = ? AND json_extract(metadata_json, '$.verifiedEpoch') = ? AND json_extract(metadata_json, '$.verifiedFreezeGeneration') = ? AND json_extract(metadata_json, '$.verifiedSourceDigest') = ? AND json_type(metadata_json, '$.verifiedAtMs') = 'integer' RETURNING singleton`,
        [
          now(),
          manifest.session.candidateVersionId,
          manifest.sourceDigest,
          manifest.sourceDigest,
          manifest.session.exportId,
          manifest.session.epoch,
          manifest.session.freezeGeneration,
          manifest.sourceDigest,
        ],
      );
    },
  };
}

function normalizeReference(
  queue: unknown,
  inviteValue: unknown,
  matchValue: unknown,
): unknown {
  const entry = record(queue);
  const invite = record(inviteValue);
  const match = record(matchValue);
  if (
    !entry ||
    !safeKey(entry.uid) ||
    !invite ||
    invite.hostId !== entry.uid ||
    !match ||
    typeof match.fen !== "string" ||
    !match.fen
  )
    throw new Error(
      "queued player lacks matching invite/host-match source; reconcile before migration",
    );
  if (entry.password !== undefined && entry.password !== invite.password)
    throw new Error("queue/invite password mismatch");
  if (entry.hostColor !== undefined && entry.hostColor !== invite.hostColor)
    throw new Error("queue/invite host color mismatch");
  return {
    hostId: invite.hostId,
    guestId: invite.guestId ?? null,
    password: invite.password ?? null,
    hostColor: invite.hostColor ?? null,
    automatchStateHint: invite.automatchStateHint ?? null,
    automatchOperationIds: invite.automatchOperationIds ?? null,
    matchExists: true,
    gameVariant: match.gameVariant ?? null,
    sessionCreation: match.sessionCreation ?? null,
  };
}
function createRemoteDependencies(
  credentialsPath?: string,
  options: {
    fetcher?: typeof fetch;
    apiToken?: string;
    firebaseToken?: () => Promise<string>;
    config?: RecordValue;
  } = {},
): Pick<
  Dependencies,
  | "assertDeployment"
  | "assertQueuesPaused"
  | "assertRules"
  | "readSource"
  | "readReference"
  | "readEvidencePath"
> {
  const fetcher = options.fetcher || fetch;
  const apiToken = options.apiToken || process.env.CLOUDFLARE_API_TOKEN;
  const token =
    options.firebaseToken || createFirebaseTokenProvider(credentialsPath);
  const require = createRequire(import.meta.url);
  const typescript = require("typescript") as typeof import("typescript");
  const configPath = resolve(
    import.meta.dirname,
    "../cloud/workers/api/wrangler.jsonc",
  );
  const config =
    options.config ||
    record(
      typescript.parseConfigFileTextToJson(
        configPath,
        readFileSync(configPath, "utf8"),
      ).config,
    );
  if (
    !config ||
    typeof config.account_id !== "string" ||
    !/^[a-f0-9]{32}$/.test(config.account_id) ||
    config.name !== "mons-link-api"
  )
    throw new Error("invalid tracked Cloudflare Worker configuration");
  const cloudflare = async (path: string): Promise<unknown> => {
    if (!apiToken)
      throw new Error(
        "set CLOUDFLARE_API_TOKEN for deployment/Queue verification and parameterized D1 migration writes",
      );
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/${path}`,
      {
        headers: { Authorization: `Bearer ${apiToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    const payload = record(await readResponseJson(response, 1024 * 1024));
    if (!payload || payload.success !== true)
      throw new Error("Cloudflare deployment/Queue verification failed");
    return payload.result;
  };
  const firebase = async (
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown> => {
    const url = new URL(
      `${FIREBASE_ROOT}/${path.split("/").map(encodeURIComponent).join("/")}.json`,
    );
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    return readResponseJson(
      await fetcher(url, {
        headers: {
          Authorization: `Bearer ${await token()}`,
          Accept: "application/json",
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      }),
    );
  };
  return {
    readEvidencePath: (path) => firebase(path),
    async assertDeployment(versionId) {
      const result = record(
        await cloudflare("workers/scripts/mons-link-api/deployments"),
      );
      const deployments = result?.deployments;
      const deployment = Array.isArray(deployments)
        ? record(deployments[0])
        : null;
      const versions = deployment?.versions;
      if (
        !Array.isArray(versions) ||
        versions.length !== 1 ||
        record(versions[0])?.version_id !== versionId ||
        record(versions[0])?.percentage !== 100
      )
        throw new Error("candidate must be the sole 100% deployed API version");
      const subdomain = record(
        await cloudflare("workers/scripts/mons-link-api/subdomain"),
      );
      if (subdomain?.enabled !== false || subdomain.previews_enabled !== false)
        throw new Error(
          "Worker subdomain and version previews must remain disabled",
        );
    },
    async assertQueuesPaused() {
      const required = new Set([
        "mons-link-telegram-projection",
        "mons-link-profile-game-projection",
      ]);
      for (let page = 1; required.size && page <= 100; page++) {
        const results = await cloudflare(`queues?page=${page}&per_page=100`);
        if (!Array.isArray(results))
          throw new Error("invalid Cloudflare Queue inventory");
        for (const value of results) {
          const item = record(value);
          if (!item || !required.has(String(item.queue_name))) continue;
          const details =
            typeof item.queue_id === "string"
              ? record(await cloudflare(`queues/${item.queue_id}`))
              : null;
          if (record(details?.settings)?.delivery_paused !== true)
            throw new Error(
              "pause the two automatch projection Queues before export/import/activation; preserve unrelated Queue states",
            );
          required.delete(String(item.queue_name));
        }
        if (results.length < 100) break;
      }
      if (required.size)
        throw new Error("affected projection Queues could not be verified");
    },
    async assertRules() {
      const rules = record(record(await firebase(".settings/rules"))?.rules);
      const queue = record(rules?.automatch);
      const players = record(
        record(record(record(rules?.players)?.$userId)?.matches)?.$matchId,
      );
      const validate = players?.[".validate"];
      const expected =
        "newData.child('sessionCreation').exists() === data.child('sessionCreation').exists() && newData.child('sessionCreation').val() === data.child('sessionCreation').val()";
      if (
        rules?.[".write"] !== false ||
        queue?.[".write"] !== false ||
        typeof validate !== "string" ||
        !validate.includes(expected)
      )
        throw new Error(
          "deployed Firebase rules must deny browser automatch writes and preserve sessionCreation evidence",
        );
      const hasNestedGrant = (value: unknown): boolean => {
        const row = record(value);
        return Boolean(
          row &&
          Object.entries(row).some(([key, child]) =>
            key === ".write"
              ? child !== false
              : key.startsWith(".")
                ? false
                : hasNestedGrant(child),
          ),
        );
      };
      if (hasNestedGrant(queue))
        throw new Error(
          "nested Firebase automatch browser write grant remains",
        );
    },
    async readSource(root, after, pageSize) {
      const query: Record<string, string> = {
        orderBy: JSON.stringify("$key"),
        limitToFirst: String(pageSize + (after === null ? 0 : 1)),
      };
      if (after !== null) query.startAt = JSON.stringify(after);
      return firebase(root, query);
    },
    async readReference(inviteId, queue) {
      const uid = record(queue)?.uid;
      if (!safeKey(uid)) throw new Error("invalid queued player UID");
      const [invite, match] = await Promise.all([
        firebase(`invites/${inviteId}`),
        firebase(`players/${uid}/matches/${inviteId}`),
      ]);
      return normalizeReference(queue, invite, match);
    },
  };
}
async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const dependencies = createSqlDependencies(
    createWranglerRunner(),
    createRemoteDependencies(
      args.firebaseCredentials || process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ),
  );
  await manageAutomatchState(args, dependencies);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  execute().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "automatch migration failed; keep frozen and inspect status",
    );
    process.exitCode = 1;
  });
}
export {
  ROOTS,
  LEGACY_RETIREMENT_MS,
  parseArgs,
  parseControl,
  normalizeSourcePage,
  normalizeReference,
  loadExport,
  createSqlDependencies,
  createRemoteDependencies,
  manageAutomatchState,
  execute,
  type Arguments,
  type Control,
  type Dependencies,
  type Entry,
  type Manifest,
  type RecordValue,
  type Root,
  type Session,
  type Status,
};
