import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isCanonicalFirebaseUid,
  isSafeFirebaseKey,
} from "../cloud/workers/api/src/firebaseKeys.ts";
import {
  parseProfileLinkProfileGameProjectionOutbox,
  salvageProfileLinkCleanupProfileIds,
} from "../cloud/workers/api/src/profileGameProjectionOutbox.ts";
import {
  d1Rows,
  integer,
  QUEUE_DRAIN_INTERVAL_MS,
  readCanonicalState,
  readDeployment,
  record,
  runTool,
  SOURCE_QUIET_INTERVAL_MS,
  sqlText,
  wranglerArgs,
  type Deployment,
  type JsonRecord,
} from "./manage-wager-reservations.ts";
import {
  digest,
  parseEvidence,
  persistArtifacts as persistProtectedArtifacts,
  readJson,
  type Evidence,
} from "./migrate-wager-reservations.ts";

type Phase = "preview" | "observe" | "final" | "verify" | "record-activation";
type Options = {
  phase: Phase;
  project: string;
  evidenceFile?: string;
  observationFile?: string;
  importFile?: string;
  versionId?: string;
  resumeAttempt?: string;
};
type Owners = Record<string, string>;
type Job = {
  loginUid: string;
  requestId: string;
  profileId: string;
  cleanupProfileIds: string[];
  matchCursor: string | null;
  sourceUpdatedAtMs: number;
  lastQueuedAtMs: number;
  revision: number;
};
type Observation = {
  schemaVersion: 1;
  project: string;
  exportedAtMs: number;
  sourceDigest: string;
  ownersDigest: string;
  evidence: Evidence;
  source: JsonRecord;
  owners: Owners;
};
type Import = Observation & {
  importAttemptId: string;
  finalExportedAtMs: number;
  importDigest: string;
  jobs: Job[];
};
type Proof = {
  importAttemptId: string | null;
  sourceDigest: string | null;
  importDigest: string | null;
  ownersDigest: string | null;
  jobCount: number | null;
  firstExportedAtMs: number | null;
  exportedAtMs: number | null;
  verifiedAtMs: number | null;
  activatedAtMs: number | null;
  activatedVersionId: string | null;
};
type Inspection = {
  canonicalState: string;
  activeProjectionLeases: number;
  deployment: Deployment;
};
type Dependencies = {
  now(): number;
  log(message: string): void;
  readJson(path: string): unknown;
  readSource(project: string): unknown;
  readOwners(loginUids: string[]): Owners;
  readJobs(): Job[];
  readProof(): Proof;
  inspect(): Inspection;
  executeSql(sql: string): void;
  persistArtifacts(
    files: Record<string, string>,
    phase: Phase,
    nowMs: number,
  ): string;
};

const PROJECT = "mons-link";
const INSTANCE = "mons-link-default-rtdb";
const SOURCE_ROOT = "/profileGameProjectionOutbox/profile";
const DATABASE = "mons-link-profiles";
const SQL_BATCH_BYTES = 80_000;
const DIGEST = /^[a-f0-9]{64}$/;

function parseArgs(argv: string[]): Options {
  const options: Options = { phase: "preview", project: PROJECT };
  let phaseSeen = false;
  const seen = new Set<string>();
  const values = {
    "--project": "project",
    "--evidence-file": "evidenceFile",
    "--observation": "observationFile",
    "--import-file": "importFile",
    "--version-id": "versionId",
    "--resume-attempt": "resumeAttempt",
  } as const;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (seen.has(arg)) throw new Error("duplicate migration argument");
    seen.add(arg);
    if (
      [
        "--preview",
        "--observe",
        "--final",
        "--verify",
        "--record-activation",
      ].includes(arg)
    ) {
      if (phaseSeen) throw new Error("choose exactly one migration phase");
      phaseSeen = true;
      options.phase = arg.slice(2) as Phase;
      continue;
    }
    if (!Object.hasOwn(values, arg))
      throw new Error("unknown profile-link migration argument");
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error("missing migration argument value");
    options[values[arg as keyof typeof values]] = value;
  }
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(options.project))
    throw new Error("invalid Firebase project");
  if (options.phase !== "preview" && options.project !== PROJECT)
    throw new Error("cutover requires the canonical Firebase project");
  const exporting = options.phase === "observe" || options.phase === "final";
  const verifying =
    options.phase === "verify" || options.phase === "record-activation";
  if (exporting !== Boolean(options.evidenceFile))
    throw new Error("observe and final require --evidence-file");
  if ((options.phase === "final") !== Boolean(options.observationFile))
    throw new Error("final requires --observation");
  if (verifying !== Boolean(options.importFile))
    throw new Error("verify and record-activation require --import-file");
  if (
    (options.phase === "record-activation" && !options.versionId) ||
    (options.versionId && !verifying)
  )
    throw new Error(
      "activation requires --version-id; only verification accepts a version override",
    );
  if (options.resumeAttempt && !exporting)
    throw new Error("only observe and final accept --resume-attempt");
  for (const value of [options.versionId, options.resumeAttempt]) {
    if (value !== undefined && !isSafeFirebaseKey(value))
      throw new Error("invalid version or import attempt ID");
  }
  return options;
}

function assertSource(options: Options, environment: NodeJS.ProcessEnv): void {
  if (options.project !== PROJECT) return;
  if (
    Object.keys(environment).some(
      (key) =>
        key === "FIREBASE_CONFIG" ||
        key === "FIREBASE_REALTIME_URL" ||
        /^FIREBASE_(?:DATABASE|REALTIME|RTDB)_/.test(key),
    )
  ) {
    throw new Error(
      "canonical profile-link migration rejects Firebase source overrides",
    );
  }
}

function sourceRecord(value: unknown): JsonRecord {
  if (value === null) return {};
  const source = record(value);
  if (!source) throw new Error("invalid profile-link source root");
  return source;
}

function normalizeOwners(value: unknown): Owners {
  const owners = record(value);
  if (
    !owners ||
    Object.entries(owners).some(
      ([uid, profileId]) =>
        !isCanonicalFirebaseUid(uid) ||
        typeof profileId !== "string" ||
        !isSafeFirebaseKey(profileId),
    )
  ) {
    throw new Error("invalid canonical owner snapshot");
  }
  return owners as Owners;
}

function rebuildJobs(
  source: JsonRecord,
  owners: Owners,
  timestamp: number,
): { jobs: Job[]; rebuilt: number; unresolved: string[] } {
  if (!integer(timestamp)) throw new Error("invalid rebuild timestamp");
  const jobs: Job[] = [];
  const unresolved: string[] = [];
  let rebuilt = 0;
  for (const loginUid of Object.keys(source).sort()) {
    const profileId = Object.hasOwn(owners, loginUid)
      ? owners[loginUid]
      : undefined;
    if (!isCanonicalFirebaseUid(loginUid) || !profileId) {
      unresolved.push(loginUid);
      continue;
    }
    const raw = source[loginUid];
    const parsed = parseProfileLinkProfileGameProjectionOutbox(raw);
    const rawTarget = record(raw)?.profileId;
    const cleanupProfileIds = [
      ...new Set([
        ...salvageProfileLinkCleanupProfileIds(raw),
        ...(typeof rawTarget === "string" && isSafeFirebaseKey(rawTarget)
          ? [rawTarget]
          : []),
      ]),
    ]
      .filter((id) => id !== profileId)
      .sort();
    const preserve = parsed?.profileId === profileId;
    if (!preserve) rebuilt++;
    jobs.push({
      loginUid,
      profileId,
      cleanupProfileIds,
      requestId: preserve
        ? parsed.requestId
        : `migration-${digest({ loginUid, raw, profileId })}`,
      matchCursor: preserve ? parsed.matchCursor : null,
      sourceUpdatedAtMs: preserve ? parsed.sourceUpdatedAtMs : timestamp,
      lastQueuedAtMs: preserve ? parsed.lastQueuedAtMs : timestamp,
      revision: 1,
    });
  }
  return { jobs, rebuilt, unresolved };
}

function normalizeJobs(value: unknown): Job[] {
  if (!Array.isArray(value)) throw new Error("invalid imported jobs");
  const seen = new Set<string>();
  return value
    .map((raw) => {
      const job = record(raw);
      if (
        !job ||
        !isCanonicalFirebaseUid(job.loginUid) ||
        typeof job.profileId !== "string" ||
        !isSafeFirebaseKey(job.profileId) ||
        typeof job.requestId !== "string" ||
        !isSafeFirebaseKey(job.requestId) ||
        !(
          job.matchCursor === null ||
          (typeof job.matchCursor === "string" &&
            isSafeFirebaseKey(job.matchCursor))
        ) ||
        !integer(job.sourceUpdatedAtMs) ||
        !integer(job.lastQueuedAtMs) ||
        !integer(job.revision) ||
        job.revision < 1 ||
        !Array.isArray(job.cleanupProfileIds) ||
        job.cleanupProfileIds.some(
          (id) =>
            typeof id !== "string" ||
            !isSafeFirebaseKey(id) ||
            id === job.profileId,
        ) ||
        seen.has(job.loginUid)
      ) {
        throw new Error("invalid imported job record");
      }
      seen.add(job.loginUid);
      return {
        ...job,
        cleanupProfileIds: [...new Set(job.cleanupProfileIds)].sort(),
      } as Job;
    })
    .sort((a, b) =>
      a.loginUid < b.loginUid ? -1 : a.loginUid > b.loginUid ? 1 : 0,
    );
}

function parseObservation(value: unknown, evidence?: Evidence): Observation {
  const input = record(value);
  if (
    !input ||
    input.schemaVersion !== 1 ||
    input.project !== PROJECT ||
    !integer(input.exportedAtMs) ||
    !DIGEST.test(String(input.sourceDigest)) ||
    !DIGEST.test(String(input.ownersDigest))
  )
    throw new Error("invalid first source observation");
  const source = sourceRecord(input.source);
  const owners = normalizeOwners(input.owners);
  const storedEvidence = parseEvidence(input.evidence, input.exportedAtMs);
  if (
    digest(source) !== input.sourceDigest ||
    digest(owners) !== input.ownersDigest ||
    (evidence && digest(evidence) !== digest(storedEvidence))
  )
    throw new Error("source observation or cutover evidence changed");
  return {
    schemaVersion: 1,
    project: PROJECT,
    exportedAtMs: input.exportedAtMs,
    sourceDigest: input.sourceDigest as string,
    ownersDigest: input.ownersDigest as string,
    evidence: storedEvidence,
    source,
    owners,
  };
}

function parseImport(value: unknown): Import {
  const observation = parseObservation(value);
  const input = record(value)!;
  if (
    typeof input.importAttemptId !== "string" ||
    !isSafeFirebaseKey(input.importAttemptId) ||
    !integer(input.finalExportedAtMs) ||
    input.finalExportedAtMs - observation.exportedAtMs <
      SOURCE_QUIET_INTERVAL_MS ||
    !DIGEST.test(String(input.importDigest))
  )
    throw new Error("invalid verified import artifact");
  const jobs = normalizeJobs(input.jobs);
  const rebuilt = rebuildJobs(
    observation.source,
    observation.owners,
    observation.exportedAtMs,
  );
  if (
    rebuilt.unresolved.length ||
    digest(jobs) !== input.importDigest ||
    digest(jobs) !== digest(rebuilt.jobs)
  )
    throw new Error(
      "import artifact does not match canonical source reconstruction",
    );
  return {
    ...observation,
    importAttemptId: input.importAttemptId,
    finalExportedAtMs: input.finalExportedAtMs,
    importDigest: input.importDigest as string,
    jobs,
  };
}

function assertFrozen(
  inspection: Inspection,
  evidence: Evidence,
  versionId = evidence.bridgeVersionId,
): void {
  if (inspection.canonicalState !== "frozen")
    throw new Error(
      "profile-link import requires frozen canonical profile writes",
    );
  if (inspection.activeProjectionLeases !== 0)
    throw new Error("profile-game projection leases are not drained");
  if (
    inspection.deployment.versionId !== versionId ||
    (versionId === evidence.bridgeVersionId &&
      inspection.deployment.deployedAtMs !== evidence.bridgeDeployedAtMs)
  )
    throw new Error(
      "recorded Worker version is not the current complete deployment",
    );
}

function importGuard(attemptId: string): string {
  if (!isSafeFirebaseKey(attemptId))
    throw new Error("invalid import attempt ID");
  return `EXISTS (SELECT 1 FROM profile_link_catchup_import WHERE singleton = 1 AND import_attempt_id = ${sqlText(attemptId)} AND activated_at_ms IS NULL) AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen')`;
}

function assertion(guard: string): string {
  return `INSERT INTO profile_link_catchup_import_guards (singleton) SELECT 0 WHERE NOT (${guard});`;
}

function buildClaimSql(
  input: Import,
  startedAtMs: number,
  resumeAttempt?: string,
): string {
  if (!integer(startedAtMs)) throw new Error("invalid import timestamp");
  const previous = resumeAttempt
    ? `import_attempt_id = ${sqlText(resumeAttempt)}`
    : "import_attempt_id IS NULL";
  const guard = `EXISTS (SELECT 1 FROM profile_link_catchup_import WHERE singleton = 1 AND activated_at_ms IS NULL AND ${previous}) AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen')`;
  return `${assertion(guard)}\nUPDATE profile_link_catchup_import SET import_attempt_id = ${sqlText(input.importAttemptId)}, import_started_at_ms = ${startedAtMs}, source_digest = ${sqlText(input.sourceDigest)}, import_digest = ${sqlText(input.importDigest)}, owners_digest = ${sqlText(input.ownersDigest)}, job_count = ${input.jobs.length}, first_exported_at_ms = ${input.exportedAtMs}, exported_at_ms = ${input.finalExportedAtMs}, verified_at_ms = NULL, source_version_id = ${sqlText(input.evidence.bridgeVersionId)}, source_deployed_at_ms = ${input.evidence.bridgeDeployedAtMs}, evidence_json = ${sqlText(JSON.stringify(input.evidence))} WHERE singleton = 1 AND ${guard};`;
}

function buildImportBatches(jobs: Job[], attemptId: string): string[] {
  const guard = importGuard(attemptId);
  const statements = [`DELETE FROM profile_link_catchup_jobs WHERE ${guard};`];
  for (const job of normalizeJobs(jobs)) {
    statements.push(
      `INSERT INTO profile_link_catchup_jobs (login_uid, request_id, profile_id, cleanup_profile_ids_json, match_cursor, source_updated_at_ms, last_queued_at_ms, revision) SELECT ${sqlText(job.loginUid)}, ${sqlText(job.requestId)}, ${sqlText(job.profileId)}, ${sqlText(JSON.stringify(job.cleanupProfileIds))}, ${job.matchCursor === null ? "NULL" : sqlText(job.matchCursor)}, ${job.sourceUpdatedAtMs}, ${job.lastQueuedAtMs}, ${job.revision} WHERE ${guard};`,
    );
  }
  const prefix = `${assertion(guard)}\n`;
  const batches: string[] = [];
  let current = prefix;
  for (const statement of statements) {
    if (Buffer.byteLength(prefix + statement + "\n") > SQL_BATCH_BYTES)
      throw new Error("profile-link job exceeds bounded SQL import size");
    if (Buffer.byteLength(current + statement + "\n") > SQL_BATCH_BYTES) {
      batches.push(current);
      current = prefix;
    }
    current += statement + "\n";
  }
  batches.push(current);
  return batches;
}

function buildVerificationSql(input: Import, nowMs: number): string {
  if (!integer(nowMs)) throw new Error("invalid verification timestamp");
  const guard = `${importGuard(input.importAttemptId)} AND EXISTS (SELECT 1 FROM profile_link_catchup_import WHERE singleton = 1 AND source_digest = ${sqlText(input.sourceDigest)} AND import_digest = ${sqlText(input.importDigest)} AND owners_digest = ${sqlText(input.ownersDigest)} AND job_count = ${input.jobs.length}) AND (SELECT COUNT(*) FROM profile_link_catchup_jobs) = ${input.jobs.length}`;
  return `${assertion(guard)}\nUPDATE profile_link_catchup_import SET verified_at_ms = ${nowMs}, import_attempt_id = NULL, import_started_at_ms = NULL WHERE singleton = 1 AND ${guard};`;
}

function buildActivationSql(
  input: Import,
  versionId: string,
  nowMs: number,
): string {
  if (!isSafeFirebaseKey(versionId) || !integer(nowMs))
    throw new Error("invalid activation evidence");
  if (versionId === input.evidence.bridgeVersionId)
    throw new Error("activation requires the new D1 Worker version");
  const guard = `EXISTS (SELECT 1 FROM profile_link_catchup_import WHERE singleton = 1 AND (activated_at_ms IS NULL OR activated_version_id = ${sqlText(versionId)}) AND import_attempt_id IS NULL AND verified_at_ms IS NOT NULL AND source_digest = ${sqlText(input.sourceDigest)} AND import_digest = ${sqlText(input.importDigest)} AND owners_digest = ${sqlText(input.ownersDigest)} AND job_count = ${input.jobs.length}) AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen')`;
  return `${assertion(guard)}\nUPDATE profile_link_catchup_import SET activated_at_ms = ${nowMs}, activated_version_id = ${sqlText(versionId)} WHERE singleton = 1 AND activated_at_ms IS NULL AND ${guard};`;
}

function assertProof(input: Import, proof: Proof): void {
  if (
    proof.importAttemptId !== null ||
    proof.verifiedAtMs === null ||
    proof.sourceDigest !== input.sourceDigest ||
    proof.importDigest !== input.importDigest ||
    proof.ownersDigest !== input.ownersDigest ||
    proof.jobCount !== input.jobs.length ||
    proof.firstExportedAtMs !== input.exportedAtMs ||
    proof.exportedAtMs !== input.finalExportedAtMs
  )
    throw new Error(
      "durable verified import proof does not match the artifact",
    );
}

function assertSourceUnchanged(
  input: Observation,
  dependencies: Dependencies,
): void {
  if (
    digest(sourceRecord(dependencies.readSource(input.project))) !==
    input.sourceDigest
  )
    throw new Error(
      "Firebase profile-link source changed; remain frozen and investigate legacy writers",
    );
  if (
    digest(
      normalizeOwners(dependencies.readOwners(Object.keys(input.source))),
    ) !== input.ownersDigest
  )
    throw new Error("canonical profile ownership changed during the cutover");
}

function verifyImport(
  input: Import,
  dependencies: Dependencies,
  versionId?: string,
): void {
  assertFrozen(dependencies.inspect(), input.evidence, versionId);
  assertProof(input, dependencies.readProof());
  if (digest(normalizeJobs(dependencies.readJobs())) !== input.importDigest)
    throw new Error("D1 job readback differs from the verified import");
  assertSourceUnchanged(input, dependencies);
  assertFrozen(dependencies.inspect(), input.evidence, versionId);
}

function migrateProfileLinkCatchup(
  options: Options,
  dependencies: Dependencies,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  assertSource(options, environment);
  const startedAtMs = dependencies.now();
  if (!integer(startedAtMs)) throw new Error("invalid migration timestamp");
  if (options.phase === "verify" || options.phase === "record-activation") {
    const imported = parseImport(dependencies.readJson(options.importFile!));
    if (options.phase === "record-activation") {
      const deployment = dependencies.inspect().deployment;
      if (
        options.versionId === imported.evidence.bridgeVersionId ||
        deployment.deployedAtMs < imported.finalExportedAtMs
      )
        throw new Error(
          "activation requires the D1 Worker promoted after final import",
        );
    }
    verifyImport(imported, dependencies, options.versionId);
    if (options.phase === "record-activation") {
      dependencies.executeSql(
        buildActivationSql(imported, options.versionId!, dependencies.now()),
      );
      const proof = dependencies.readProof();
      if (
        proof.activatedAtMs === null ||
        proof.activatedVersionId !== options.versionId
      )
        throw new Error("activation recording failed");
    }
    dependencies.log(
      JSON.stringify({
        phase: options.phase,
        verified: true,
        activated: options.phase === "record-activation",
        jobs: imported.jobs.length,
        digest: imported.importDigest,
      }),
    );
    return;
  }
  const evidence = options.evidenceFile
    ? parseEvidence(dependencies.readJson(options.evidenceFile), startedAtMs)
    : null;
  const observation = options.observationFile
    ? parseObservation(
        dependencies.readJson(options.observationFile),
        evidence!,
      )
    : null;
  if (evidence) {
    assertFrozen(dependencies.inspect(), evidence);
    const proof = dependencies.readProof();
    if (proof.activatedAtMs !== null)
      throw new Error(
        "activated profile-link jobs can never be overwritten by legacy import",
      );
    if (
      proof.importAttemptId !== null &&
      proof.importAttemptId !== options.resumeAttempt
    )
      throw new Error(
        "an import attempt is retained; resume only after confirming its runner stopped",
      );
    if (
      options.resumeAttempt &&
      proof.importAttemptId !== options.resumeAttempt
    )
      throw new Error(
        "retained import attempt does not match --resume-attempt",
      );
  }
  if (
    observation &&
    startedAtMs - observation.exportedAtMs < SOURCE_QUIET_INTERVAL_MS
  )
    throw new Error(
      "second source observation must start at least six minutes after the first export finished",
    );
  if (
    options.phase === "final" &&
    evidence &&
    startedAtMs - Math.max(...Object.values(evidence.queuesPausedAtMs)) <
      QUEUE_DRAIN_INTERVAL_MS
  )
    throw new Error(
      "all four queues must remain paused for at least fifteen minutes before final import",
    );
  const source = sourceRecord(dependencies.readSource(options.project));
  const owners = normalizeOwners(dependencies.readOwners(Object.keys(source)));
  const exportedAtMs = dependencies.now();
  if (!integer(exportedAtMs) || exportedAtMs < startedAtMs)
    throw new Error("invalid completed export timestamp");
  const sourceDigest = digest(source);
  const ownersDigest = digest(owners);
  const plan = rebuildJobs(
    source,
    owners,
    observation?.exportedAtMs ?? exportedAtMs,
  );
  const summary = {
    jobs: plan.jobs.length,
    rebuilt: plan.rebuilt,
    unresolved: plan.unresolved.length,
    sourceDigest,
    ownersDigest,
    importDigest: digest(plan.jobs),
  };
  const files: Record<string, string> = {
    "source.json": JSON.stringify(source) + "\n",
    "owners.json": JSON.stringify(owners) + "\n",
    "jobs.json": JSON.stringify(plan.jobs) + "\n",
    "unresolved.json": JSON.stringify(plan.unresolved) + "\n",
    "metadata.json":
      JSON.stringify({
        phase: options.phase,
        exportedAtMs,
        ...summary,
        evidence,
      }) + "\n",
  };
  if (options.phase === "observe" && evidence)
    files["observation.json"] =
      JSON.stringify({
        schemaVersion: 1,
        project: options.project,
        exportedAtMs,
        sourceDigest,
        ownersDigest,
        evidence,
        source,
        owners,
      } satisfies Observation) + "\n";
  let imported: Import | null = null;
  let batches: string[] = [];
  if (options.phase === "final" && evidence && observation) {
    imported = {
      ...observation,
      importAttemptId: randomUUID(),
      finalExportedAtMs: exportedAtMs,
      importDigest: summary.importDigest,
      jobs: plan.jobs,
    };
    files["import.json"] = JSON.stringify(imported) + "\n";
    batches = buildImportBatches(plan.jobs, imported.importAttemptId);
    files["claim.sql"] = buildClaimSql(
      imported,
      startedAtMs,
      options.resumeAttempt,
    );
    batches.forEach((sql, index) => {
      files[`import-${String(index).padStart(5, "0")}.sql`] = sql;
    });
  }
  const directory = dependencies.persistArtifacts(
    files,
    options.phase,
    exportedAtMs,
  );
  dependencies.log(
    JSON.stringify({ phase: options.phase, ...summary, artifacts: directory }),
  );
  if (evidence) assertFrozen(dependencies.inspect(), evidence);
  if (
    observation &&
    (sourceDigest !== observation.sourceDigest ||
      ownersDigest !== observation.ownersDigest)
  )
    throw new Error(
      "source or canonical ownership changed; investigate writers and start a new observation",
    );
  if (plan.unresolved.length && options.phase !== "preview")
    throw new Error(
      "unresolvable source records block cutover; inspect the protected unresolved artifact",
    );
  if (!imported || !evidence) return;
  dependencies.executeSql(files["claim.sql"]);
  for (const batch of batches) {
    assertFrozen(dependencies.inspect(), evidence);
    dependencies.executeSql(batch);
  }
  if (digest(normalizeJobs(dependencies.readJobs())) !== imported.importDigest)
    throw new Error(
      "D1 profile-link import readback differs from the source plan",
    );
  assertSourceUnchanged(imported, dependencies);
  assertFrozen(dependencies.inspect(), evidence);
  dependencies.executeSql(buildVerificationSql(imported, dependencies.now()));
  assertProof(imported, dependencies.readProof());
  dependencies.log(
    JSON.stringify({
      phase: "final",
      verified: true,
      jobs: imported.jobs.length,
      digest: imported.importDigest,
      artifacts: directory,
    }),
  );
}

function persistArtifacts(
  files: Record<string, string>,
  phase: Phase,
  nowMs: number,
  root = resolve(".cache/profile-link-catchup-migration"),
): string {
  return persistProtectedArtifacts(
    files,
    phase === "observe" ? "observe" : phase === "final" ? "final" : "preview",
    nowMs,
    root,
  );
}

function firebaseDatabaseGetArgs(project: string): string[] {
  return [
    "database:get",
    SOURCE_ROOT,
    "--project",
    project,
    ...(project === PROJECT ? ["--instance", INSTANCE] : []),
  ];
}

function readRemoteSource(project: string): unknown {
  return JSON.parse(
    runTool(
      resolve("node_modules/.bin/firebase"),
      firebaseDatabaseGetArgs(project),
      64 * 1024 * 1024,
    ),
  );
}

function readRemoteOwners(loginUids: string[]): Owners {
  const uids = loginUids.filter(isCanonicalFirebaseUid).sort();
  const owners: Owners = Object.create(null) as Owners;
  for (let offset = 0; offset < uids.length; offset += 32) {
    const rows = d1Rows(
      `SELECT o.login_uid, o.profile_id FROM profile_login_owners o JOIN profile_records p ON p.profile_id = o.profile_id AND p.state = 'active' WHERE o.login_uid IN (${uids
        .slice(offset, offset + 32)
        .map(sqlText)
        .join(",")}) ORDER BY o.login_uid`,
    );
    for (const row of rows) {
      if (
        !isCanonicalFirebaseUid(row.login_uid) ||
        typeof row.profile_id !== "string" ||
        !isSafeFirebaseKey(row.profile_id) ||
        Object.hasOwn(owners, row.login_uid)
      )
        throw new Error("invalid canonical owner query result");
      owners[row.login_uid] = row.profile_id;
    }
  }
  return owners;
}

function readRemoteJobs(
  readRows: (sql: string) => JsonRecord[] = d1Rows,
): Job[] {
  const jobs: unknown[] = [];
  let cursor: string | null = null;
  for (;;) {
    const rows = readRows(
      `SELECT * FROM profile_link_catchup_jobs ${cursor === null ? "" : `WHERE login_uid > ${sqlText(cursor)}`} ORDER BY login_uid LIMIT 100`,
    );
    if (!rows.length) break;
    const nextCursor = rows[rows.length - 1].login_uid;
    if (
      !isCanonicalFirebaseUid(nextCursor) ||
      (cursor !== null &&
        Buffer.compare(Buffer.from(nextCursor), Buffer.from(cursor)) <= 0)
    )
      throw new Error("invalid D1 job pagination");
    jobs.push(
      ...rows.map((row) => ({
        loginUid: row.login_uid,
        requestId: row.request_id,
        profileId: row.profile_id,
        cleanupProfileIds: JSON.parse(String(row.cleanup_profile_ids_json)),
        matchCursor: row.match_cursor,
        sourceUpdatedAtMs: row.source_updated_at_ms,
        lastQueuedAtMs: row.last_queued_at_ms,
        revision: row.revision,
      })),
    );
    cursor = nextCursor;
  }
  return normalizeJobs(jobs);
}

function parseProof(row: JsonRecord | undefined): Proof {
  if (!row)
    throw new Error(
      "missing profile-link import proof table; apply migration 0012 first",
    );
  const nullableInteger = (key: string): number | null => {
    if (row[key] === null) return null;
    if (!integer(row[key]))
      throw new Error("invalid import proof timestamp or count");
    return row[key];
  };
  const nullableText = (key: string, isDigest = false): string | null => {
    if (row[key] === null) return null;
    if (
      typeof row[key] !== "string" ||
      (isDigest ? !DIGEST.test(row[key]) : !isSafeFirebaseKey(row[key]))
    )
      throw new Error("invalid import proof identifier");
    return row[key];
  };
  return {
    importAttemptId: nullableText("import_attempt_id"),
    sourceDigest: nullableText("source_digest", true),
    importDigest: nullableText("import_digest", true),
    ownersDigest: nullableText("owners_digest", true),
    jobCount: nullableInteger("job_count"),
    firstExportedAtMs: nullableInteger("first_exported_at_ms"),
    exportedAtMs: nullableInteger("exported_at_ms"),
    verifiedAtMs: nullableInteger("verified_at_ms"),
    activatedAtMs: nullableInteger("activated_at_ms"),
    activatedVersionId: nullableText("activated_version_id"),
  };
}

function executeSql(sql: string): void {
  const directory = persistArtifacts(
    { "statement.sql": sql },
    "final",
    Date.now(),
    resolve(tmpdir(), "mons-profile-link-catchup-sql"),
  );
  try {
    runTool(
      resolve("node_modules/.bin/wrangler"),
      wranglerArgs([
        "d1",
        "execute",
        DATABASE,
        "--remote",
        "--file",
        resolve(directory, "statement.sql"),
        "--yes",
      ]),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function execute(argv = process.argv.slice(2)): void {
  migrateProfileLinkCatchup(parseArgs(argv), {
    now: Date.now,
    log: console.log,
    readJson,
    readSource: readRemoteSource,
    readOwners: readRemoteOwners,
    readJobs: readRemoteJobs,
    readProof: () =>
      parseProof(
        d1Rows(
          "SELECT * FROM profile_link_catchup_import WHERE singleton = 1",
        )[0],
      ),
    inspect: () => {
      const count = d1Rows(
        "SELECT COUNT(*) AS count FROM profile_game_projection_locks WHERE expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)",
        "mons-link-profile-games",
      )[0]?.count;
      if (!integer(count)) throw new Error("invalid projection lease count");
      return {
        canonicalState: readCanonicalState(),
        activeProjectionLeases: count,
        deployment: readDeployment(),
      };
    },
    executeSql,
    persistArtifacts,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    execute();
  } catch (error) {
    console.error(
      error instanceof SyntaxError
        ? "invalid JSON in migration source or protected artifact"
        : error instanceof Error
          ? error.message
          : "profile-link migration failed",
    );
    process.exitCode = 1;
  }
}

export {
  assertSource,
  buildActivationSql,
  buildClaimSql,
  buildImportBatches,
  buildVerificationSql,
  execute,
  firebaseDatabaseGetArgs,
  migrateProfileLinkCatchup,
  normalizeJobs,
  parseArgs,
  parseImport,
  parseObservation,
  parseProof,
  persistArtifacts,
  readRemoteJobs,
  rebuildJobs,
  SQL_BATCH_BYTES,
  type Dependencies,
  type Import,
  type Inspection,
  type Job,
  type Observation,
  type Options,
  type Owners,
  type Proof,
};
