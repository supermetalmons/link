import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  createWranglerRunner,
  digest,
  privateDirectory,
  readPrivateJson,
  readResponseJson,
  writePrivateImmutable,
  type SqlRunner,
} from "./operator/runtime.ts";

const DATABASE = "mons-link-profile-games";

const VERSION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const LEGACY_WRITER_PREDICATE = "writer_generation != 2";

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
  "status" | "freeze" | "resume" | "inspect-admissions" | "reconcile-admission";

type Arguments = {
  operation: Operation;
  directory?: string;
  evidence?: string;
  candidateVersionId?: string;
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
  readAdmissions(admissionId?: string): Promise<AdmissionRow[]>;
  readAdmissionPath(admission: AdmissionRow, path: string): Promise<unknown>;
  settleAdmission(admission: AdmissionRow): Promise<void>;
  now(): number;
  log(value: RecordValue): void;
  status(): Promise<Status>;
  freeze(control: Control): Promise<void>;
  resume(control: Control, versionId: string): Promise<void>;
  assertDeployment(versionId: string): Promise<void>;
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
    "freeze",
    "resume",
    "inspect-admissions",
    "reconcile-admission",
  ];
  const operation = argv[0]?.slice(2) as Operation;
  if (!operations.includes(operation) || argv[0] !== `--${operation}`)
    throw new Error(
      "initial automatch migration commands are retired; choose --status, --freeze, --resume, --inspect-admissions or --reconcile-admission",
    );
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index],
      value = argv[index + 1];
    if (
      !["--directory", "--evidence", "--candidate-version-id"].includes(name) ||
      !value ||
      value.startsWith("--") ||
      options.has(name)
    )
      throw new Error("invalid, duplicate or missing automatch argument");
    options.set(name, value);
  }
  const directory = options.get("--directory"),
    evidence = options.get("--evidence"),
    candidateVersionId = options.get("--candidate-version-id");
  if (
    (operation === "inspect-admissions") !== Boolean(directory) ||
    (directory && !isAbsolute(directory))
  )
    throw new Error("inspection requires an absolute protected --directory");
  if (
    (operation === "reconcile-admission") !== Boolean(evidence) ||
    (evidence && !isAbsolute(evidence))
  )
    throw new Error(
      "reconciliation requires an absolute protected --evidence file",
    );
  if (
    (operation === "resume" && !candidateVersionId) ||
    (candidateVersionId &&
      (!["freeze", "resume"].includes(operation) ||
        !VERSION_PATTERN.test(candidateVersionId)))
  )
    throw new Error(
      "resume requires the exact --candidate-version-id UUID; freeze optionally accepts it",
    );
  return {
    operation,
    directory,
    evidence,
    candidateVersionId,
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
    ROOTS.some((root) => value === root || value.startsWith(`${root}/`))
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
    throw new Error("retired or invalid admission source-proof path");
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
  if (admission.backend !== "d1")
    throw new Error("legacy admissions are retired");
  if (digest(admission) !== evidence.admissionDigest)
    throw new Error("admission evidence digest mismatch");
  const expected = admissionTargetPaths(admission);
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
    admission.phase === "completed" &&
    admission.completedAtMs !== null &&
    admission.completedAtMs >= admission.createdAtMs &&
    admission.completedAtMs <= dependencies.now();
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
    if (!parsed) throw new Error("invalid automatch control metadata");
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

function assertD1Control(status: Status): void {
  if (
    status.control.backend !== "d1" ||
    !status.control.candidateVersionId ||
    !status.control.activatedAtMs ||
    status.control.sourceDigest !== status.control.importDigest ||
    !status.control.sourceDigest ||
    !integer(status.control.metadata.verifiedAtMs) ||
    typeof status.control.metadata.activationCandidateVersionId !== "string" ||
    !VERSION_PATTERN.test(status.control.metadata.activationCandidateVersionId)
  )
    throw new Error(
      "D1 activation is unverified; legacy maintenance is retired",
    );
  if (!status.legacyFence || status.legacyLocks !== 0)
    throw new Error("unexpected legacy writer evidence; inspect status");
}

async function manageAutomatchState(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  if (args.operation === "inspect-admissions") {
    const directory = privateDirectory(args.directory!);
    const admissions = await dependencies.readAdmissions();
    for (const admission of admissions) {
      if (admission.backend !== "d1")
        throw new Error("legacy admissions are retired");
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
  if (args.operation === "status") {
    dependencies.log({ operation: "status", ...(await dependencies.status()) });
    return;
  }
  if (args.operation !== "freeze" && args.operation !== "resume")
    throw new Error("initial automatch migration commands are retired");
  const status = await dependencies.status();
  assertD1Control(status);
  const versionId =
    args.candidateVersionId || status.control.candidateVersionId!;
  await dependencies.assertDeployment(versionId);
  if (args.operation === "freeze") {
    if (status.control.state !== "frozen")
      await dependencies.freeze(status.control);
  } else {
    if (status.admissions !== 0)
      throw new Error("unresolved admissions prevent resume");
    if (
      status.control.state === "active" &&
      status.control.candidateVersionId !== versionId
    )
      throw new Error("freeze D1 writes before adopting a repair candidate");
    if (status.control.state !== "active")
      await dependencies.resume(status.control, versionId);
  }
  dependencies.log({
    operation: args.operation,
    ...(await dependencies.status()),
  });
}

function createSqlDependencies(
  run: SqlRunner,
  remote: Pick<Dependencies, "assertDeployment">,
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
      throw new Error("automatch control or record changed; inspect status");
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
  return {
    ...remote,
    now,
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
      if (admission.backend !== "d1")
        throw new Error("legacy admissions are retired");
      if (!root)
        throw new Error(
          "retired admission source-proof path; only canonical D1 records can be inspected",
        );
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
    async freeze(control) {
      await requireOne(
        "UPDATE automatch_runtime_control SET state = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1 AND backend = 'd1' AND state = 'active' AND epoch = ? AND freeze_generation = ? AND candidate_version_id = ? RETURNING singleton",
        [control.epoch, control.freezeGeneration, control.candidateVersionId],
      );
    },
    async resume(control, versionId) {
      if (control.backend !== "d1")
        throw new Error("legacy maintenance is retired");
      const guard = `singleton = 1 AND backend = 'd1' AND state = 'frozen' AND epoch = ? AND freeze_generation = ? AND candidate_version_id = ? AND NOT EXISTS (SELECT 1 FROM automatch_write_admissions) AND EXISTS (SELECT 1 FROM game_session_legacy_fence WHERE singleton = 1 AND enabled = 1) AND NOT EXISTS (SELECT 1 FROM game_session_mutation_locks WHERE ${LEGACY_WRITER_PREDICATE}) AND NOT EXISTS (SELECT 1 FROM game_session_legacy_releases WHERE reconciled_at_ms IS NULL)`;
      await requireOne(
        `UPDATE automatch_runtime_control SET state = 'active', candidate_version_id = ? WHERE ${guard} RETURNING singleton`,
        [
          versionId,
          control.epoch,
          control.freezeGeneration,
          control.candidateVersionId,
        ],
      );
    },
  };
}

function createRemoteDependencies(
  options: {
    fetcher?: typeof fetch;
    apiToken?: string;
    config?: RecordValue;
  } = {},
): Pick<Dependencies, "assertDeployment"> {
  const fetcher = options.fetcher || fetch,
    apiToken = options.apiToken || process.env.CLOUDFLARE_API_TOKEN;
  const require = createRequire(import.meta.url),
    typescript = require("typescript") as typeof import("typescript");
  const config =
    options.config ||
    record(
      typescript.parseConfigFileTextToJson(
        "wrangler.jsonc",
        readFileSync(
          resolve(import.meta.dirname, "../cloud/workers/api/wrangler.jsonc"),
          "utf8",
        ),
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
      throw new Error("set CLOUDFLARE_API_TOKEN for deployment verification");
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/${path}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    const payload = record(await readResponseJson(response, 1024 * 1024));
    if (!payload || payload.success !== true)
      throw new Error("Cloudflare deployment verification failed");
    return payload.result;
  };
  return {
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
  };
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const dependencies = createSqlDependencies(
    createWranglerRunner(),
    createRemoteDependencies(),
  );
  await manageAutomatchState(args, dependencies);
}

export {
  ROOTS,
  parseArgs,
  parseControl,
  createSqlDependencies,
  createRemoteDependencies,
  manageAutomatchState,
  execute,
  type Arguments,
  type Control,
  type Dependencies,
  type RecordValue,
  type Root,
  type Status,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  execute().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "automatch operation failed; inspect status",
    );
    process.exitCode = 1;
  });
