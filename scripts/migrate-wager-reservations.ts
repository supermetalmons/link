import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { importPKCS8, SignJWT } from "jose";
import { MATERIAL_KEYS, type MiningMaterials } from "@mons/shared/mining";
import { parseFrozenOperation } from "../cloud/workers/api/src/wagerFrozenRecords.ts";
import {
  activeGameplayLeases,
  d1Rows,
  integer,
  QUEUE_DRAIN_INTERVAL_MS,
  readCanonicalState,
  readDeployment,
  readRemoteAdmissions,
  readRemoteControl,
  record,
  runTool,
  SOURCE_QUIET_INTERVAL_MS,
  sqlText,
  validIdentifier,
  wranglerArgs,
  type Control,
  type Deployment,
  type JsonRecord,
} from "./manage-wager-reservations.ts";

type Snapshot = Record<
  string,
  { frozen: MiningMaterials; operations: Record<string, JsonRecord> }
>;
type Evidence = {
  bridgeVersionId: string;
  bridgeDeployedAtMs: number;
  queuesPausedAtMs: Record<string, number>;
  legacyWritersDrained: true;
  recordedAtMs: number;
};
type Observation = {
  schemaVersion: 1;
  project: string;
  freezeGeneration: number;
  exportedAtMs: number;
  sourceDigest: string;
  evidence: Evidence;
  snapshot: Snapshot;
};
type Options = {
  phase: "preview" | "observe" | "final";
  project: string;
  evidenceFile?: string;
  observationFile?: string;
};
type Inspection = {
  control: Control;
  canonicalState: string;
  writeAdmissions: number;
  activeGameplayLeases: number;
  deployment: Deployment;
};
type Proof = {
  importAttemptId: string;
  freezeGeneration: number;
  sourceDigest: string;
  sourceBalanceCount: number;
  sourceOperationCount: number;
  sourceFirstExportedAtMs: number;
  sourceExportedAtMs: number;
  queuesPausedAtMs: number;
  bridgeDeployedAtMs: number;
  bridgeVersionId: string;
};
type Dependencies = {
  now(): number;
  log(message: string): void;
  readJson(path: string): unknown;
  readSource(project: string): Snapshot;
  inspect(): Inspection;
  persistArtifacts(
    files: Readonly<Record<string, string>>,
    phase: Options["phase"],
    nowMs: number,
  ): string;
  importSql(path: string): void;
  readImportedSnapshot(): Snapshot;
  claimImport(
    freezeGeneration: number,
    importAttemptId: string,
    startedAtMs: number,
  ): void;
  markVerified(proof: Proof): void;
};

const CANONICAL_PROJECT = "mons-link";
const CANONICAL_INSTANCE = "mons-link-default-rtdb";
const QUEUE_NAMES = [
  "mons-link-auth-recovery",
  "mons-link-profile-game-projection",
  "mons-link-telegram-projection",
  "mons-link-telegram-delivery",
] as const;
const SOURCE_MAX_BYTES = 8 * 1024 * 1024;
const SQL_BATCH_BYTES = 80_000;
const D1_PAGE_SIZE = 500;
const SOURCE_READ_CONCURRENCY = 4;
const MAX_SOURCE_READ_CONCURRENCY = 16;
const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function parseArgs(argv: string[]): Options {
  let phase: Options["phase"] | undefined;
  const options: Options = { phase: "preview", project: CANONICAL_PROJECT };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (seen.has(arg)) throw new Error("duplicate migration argument");
    seen.add(arg);
    if (["--preview", "--observe", "--final"].includes(arg)) {
      if (phase) throw new Error("choose exactly one migration phase");
      phase = arg.slice(2) as Options["phase"];
      options.phase = phase;
      continue;
    }
    if (!["--project", "--evidence-file", "--observation"].includes(arg))
      throw new Error("unknown wager reservation migration argument");
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error("missing migration argument value");
    if (arg === "--project") options.project = value;
    if (arg === "--evidence-file") options.evidenceFile = value;
    if (arg === "--observation") options.observationFile = value;
  }
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(options.project))
    throw new Error("invalid Firebase project");
  if (options.phase === "preview") {
    if (options.evidenceFile || options.observationFile)
      throw new Error("preview does not accept cutover evidence");
  } else {
    if (options.project !== CANONICAL_PROJECT)
      throw new Error("wager cutover requires the canonical Firebase project");
    if (!options.evidenceFile)
      throw new Error("cutover requires --evidence-file");
    if ((options.phase === "final") !== Boolean(options.observationFile))
      throw new Error("only final import requires --observation");
  }
  return options;
}

function assertSource(
  options: Options,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (options.project !== CANONICAL_PROJECT) return;
  if (
    Object.keys(environment).some(
      (key) =>
        key === "FIREBASE_CONFIG" ||
        key === "FIREBASE_REALTIME_URL" ||
        /^FIREBASE_(?:DATABASE|REALTIME|RTDB)_/.test(key),
    )
  ) {
    throw new Error(
      "canonical wager reservation migration rejects Firebase source overrides",
    );
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = record(value);
  return source
    ? Object.fromEntries(
        Object.keys(source)
          .sort()
          .map((key) => [key, canonicalize(source[key])]),
      )
    : value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function normalizeFrozen(value: unknown): MiningMaterials {
  const source = value === null || value === undefined ? {} : record(value);
  if (
    !source ||
    Object.entries(source).some(
      ([key, count]) =>
        !(MATERIAL_KEYS as readonly string[]).includes(key) || !integer(count),
    )
  )
    throw new Error("invalid frozen wager materials");
  return Object.fromEntries(
    MATERIAL_KEYS.map((key) => [key, source[key] ?? 0]),
  ) as MiningMaterials;
}

function normalizeOperations(value: unknown): Record<string, JsonRecord> {
  const source = value === null || value === undefined ? {} : record(value);
  if (!source) throw new Error("invalid wager operation map");
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([operationId, value]) => {
        const operation = record(value);
        const consumed =
          operation &&
          Object.keys(operation).length === 1 &&
          operation.consumed === true;
        if (
          !validIdentifier(operationId) ||
          !operation ||
          (!consumed && !parseFrozenOperation(operation))
        )
          throw new Error("invalid wager reservation operation");
        return [operationId, structuredClone(operation)];
      }),
  );
}

function normalizeSnapshot(value: unknown): Snapshot {
  const source = record(value);
  if (!source) throw new Error("invalid wager reservation snapshot");
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([uid, value]) => {
        const player = record(value);
        if (
          !validIdentifier(uid) ||
          !player ||
          Object.keys(player).length !== 2 ||
          !Object.hasOwn(player, "frozen") ||
          !Object.hasOwn(player, "operations")
        )
          throw new Error("invalid wager reservation player");
        return [
          uid,
          {
            frozen: normalizeFrozen(player.frozen),
            operations: normalizeOperations(player.operations),
          },
        ];
      }),
  );
}

function summarize(snapshot: Snapshot) {
  const players = Object.values(snapshot);
  const operations = players.flatMap((player) =>
    Object.values(player.operations),
  );
  return {
    balances: players.length,
    operations: operations.length,
    consumedOperations: operations.filter(
      (operation) => operation.consumed === true,
    ).length,
    digest: digest(snapshot),
  };
}

function parseEvidence(value: unknown, nowMs: number): Evidence {
  const evidence = record(value);
  const pauses = record(evidence?.queuesPausedAtMs);
  if (
    !evidence ||
    Object.keys(evidence).length !== 5 ||
    !validIdentifier(evidence.bridgeVersionId) ||
    !integer(evidence.bridgeDeployedAtMs) ||
    !integer(evidence.recordedAtMs) ||
    evidence.recordedAtMs > nowMs ||
    evidence.bridgeDeployedAtMs > evidence.recordedAtMs ||
    evidence.legacyWritersDrained !== true ||
    !pauses ||
    Object.keys(pauses).length !== QUEUE_NAMES.length ||
    QUEUE_NAMES.some(
      (queue) =>
        !integer(pauses[queue]) ||
        Number(pauses[queue]) > Number(evidence.recordedAtMs),
    )
  )
    throw new Error(
      "invalid cutover evidence; record the deployed bridge, all four queue pauses, and verified legacy writer drain",
    );
  return {
    bridgeVersionId: evidence.bridgeVersionId,
    bridgeDeployedAtMs: evidence.bridgeDeployedAtMs,
    queuesPausedAtMs: Object.fromEntries(
      QUEUE_NAMES.map((queue) => [queue, pauses[queue] as number]),
    ),
    legacyWritersDrained: true,
    recordedAtMs: evidence.recordedAtMs,
  };
}

function parseObservation(value: unknown, evidence: Evidence): Observation {
  const observation = record(value);
  if (
    !observation ||
    observation.schemaVersion !== 1 ||
    observation.project !== CANONICAL_PROJECT ||
    !integer(observation.freezeGeneration) ||
    observation.freezeGeneration < 1 ||
    !integer(observation.exportedAtMs) ||
    !/^[a-f0-9]{64}$/.test(String(observation.sourceDigest))
  )
    throw new Error("invalid first source observation");
  const storedEvidence = parseEvidence(
    observation.evidence,
    observation.exportedAtMs,
  );
  const snapshot = normalizeSnapshot(observation.snapshot);
  if (
    digest(snapshot) !== observation.sourceDigest ||
    digest(storedEvidence) !== digest(evidence)
  )
    throw new Error("source observation or cutover evidence changed");
  return {
    schemaVersion: 1,
    project: CANONICAL_PROJECT,
    freezeGeneration: observation.freezeGeneration,
    exportedAtMs: observation.exportedAtMs,
    sourceDigest: observation.sourceDigest as string,
    evidence: storedEvidence,
    snapshot,
  };
}

function assertFrozen(
  inspection: Inspection,
  evidence: Evidence,
  generation?: number,
  importAttemptId: string | null = null,
): void {
  const control = inspection.control;
  if (
    control.storageMode !== "frozen" ||
    control.previousStorageMode !== "firebase" ||
    control.activatedAtMs !== null ||
    control.freezeGeneration < 1 ||
    (generation !== undefined && control.freezeGeneration !== generation)
  )
    throw new Error(
      "reservation import requires the same frozen Firebase generation",
    );
  if (inspection.canonicalState !== "frozen")
    throw new Error(
      "reservation import requires frozen canonical profile writes",
    );
  if (inspection.writeAdmissions !== 0 || inspection.activeGameplayLeases !== 0)
    throw new Error("reservation writers or gameplay leases are not drained");
  if (control.importAttemptId !== importAttemptId)
    throw new Error("reservation import attempt is already active or changed");
  if (
    inspection.deployment.versionId !== evidence.bridgeVersionId ||
    inspection.deployment.deployedAtMs !== evidence.bridgeDeployedAtMs
  )
    throw new Error(
      "the recorded bridge is not the current complete deployment",
    );
}

function importGuard(
  generation: number,
  importAttemptId: string | null,
): string {
  if (!integer(generation) || generation < 1)
    throw new Error("invalid import freeze generation");
  if (importAttemptId !== null && !validIdentifier(importAttemptId))
    throw new Error("invalid import attempt ID");
  return `EXISTS (SELECT 1 FROM wager_reservation_runtime_control WHERE singleton = 1 AND storage_mode = 'frozen' AND previous_storage_mode = 'firebase' AND activated_at_ms IS NULL AND freeze_generation = ${generation} AND import_attempt_id IS ${importAttemptId === null ? "NULL" : sqlText(importAttemptId)}) AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen') AND NOT EXISTS (SELECT 1 FROM wager_reservation_write_admissions)`;
}

function buildImportBatches(
  snapshot: Snapshot,
  exportedAtMs: number,
  generation: number,
  importAttemptId: string,
): string[] {
  if (!integer(exportedAtMs))
    throw new Error("invalid source export timestamp");
  const guard = importGuard(generation, importAttemptId);
  const assert = `INSERT INTO wager_reservation_write_guards (singleton) SELECT 0 WHERE NOT (${guard});`;
  const statements = [
    `UPDATE wager_reservation_runtime_control SET verified_import_generation = NULL, source_digest = NULL, updated_at_ms = ${exportedAtMs} WHERE singleton = 1 AND ${guard};`,
    `DELETE FROM wager_frozen_operations WHERE ${guard};`,
    `DELETE FROM wager_frozen_balances WHERE ${guard};`,
  ];
  for (const [uid, player] of Object.entries(snapshot)) {
    statements.push(
      `INSERT INTO wager_frozen_balances (player_uid, frozen_json, revision, updated_at_ms) SELECT ${sqlText(uid)}, ${sqlText(JSON.stringify(player.frozen))}, 1, ${exportedAtMs} WHERE ${guard};`,
    );
    for (const [operationId, operation] of Object.entries(player.operations)) {
      statements.push(
        `INSERT INTO wager_frozen_operations (player_uid, operation_id, record_json) SELECT ${sqlText(uid)}, ${sqlText(operationId)}, ${sqlText(JSON.stringify(operation))} WHERE ${guard};`,
      );
    }
  }
  const batches: string[] = [];
  let current = `${assert}\n`;
  for (const statement of statements) {
    if (Buffer.byteLength(`${assert}\n${statement}\n`) > SQL_BATCH_BYTES)
      throw new Error(
        "wager reservation operation exceeds the bounded SQL import size",
      );
    if (Buffer.byteLength(`${current}${statement}\n`) > SQL_BATCH_BYTES) {
      batches.push(current);
      current = `${assert}\n`;
    }
    current += `${statement}\n`;
  }
  batches.push(current);
  return batches;
}

function migrateWagerReservations(
  options: Options,
  dependencies: Dependencies,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  assertSource(options, environment);
  const sourceConcurrency =
    environment.GOOGLE_APPLICATION_CREDENTIALS &&
    options.project === CANONICAL_PROJECT
      ? readSourceConcurrency(environment)
      : null;
  const startedAtMs = dependencies.now();
  if (!integer(startedAtMs)) throw new Error("invalid export timestamp");
  const evidence = options.evidenceFile
    ? parseEvidence(dependencies.readJson(options.evidenceFile), startedAtMs)
    : null;
  const observation =
    options.observationFile && evidence
      ? parseObservation(
          dependencies.readJson(options.observationFile),
          evidence,
        )
      : null;
  let generation = 0;
  let importAttemptId: string | null = null;
  if (options.phase !== "preview") {
    if (!evidence || (options.phase === "final" && !observation))
      throw new Error("missing cutover evidence");
    const inspection = dependencies.inspect();
    assertFrozen(inspection, evidence, observation?.freezeGeneration);
    generation = inspection.control.freezeGeneration;
    if (
      observation &&
      startedAtMs - observation.exportedAtMs < SOURCE_QUIET_INTERVAL_MS
    )
      throw new Error(
        "second source observation must start at least six minutes after the first export finished",
      );
    if (
      options.phase === "final" &&
      startedAtMs - Math.max(...Object.values(evidence.queuesPausedAtMs)) <
        QUEUE_DRAIN_INTERVAL_MS
    )
      throw new Error(
        "all four queues must remain paused for at least fifteen minutes before final import",
      );
    if (options.phase === "final") {
      importAttemptId = randomUUID();
      dependencies.claimImport(generation, importAttemptId, startedAtMs);
    }
  }
  const snapshot = normalizeSnapshot(dependencies.readSource(options.project));
  const exportedAtMs = dependencies.now();
  if (!integer(exportedAtMs) || exportedAtMs < startedAtMs)
    throw new Error("invalid completed export timestamp");
  const summary = summarize(snapshot);
  if (evidence)
    assertFrozen(dependencies.inspect(), evidence, generation, importAttemptId);
  if (observation && summary.digest !== observation.sourceDigest)
    throw new Error(
      "Firebase reservation source changed; investigate legacy writers and start a new observation",
    );
  const files: Record<string, string> = {
    "source.json": `${JSON.stringify(snapshot)}\n`,
    "metadata.json": `${JSON.stringify({ phase: options.phase, exportedAtMs, freezeGeneration: generation, importAttemptId, sourceConcurrency, ...summary, evidence })}\n`,
  };
  let batches: string[] = [];
  if (options.phase === "observe" && evidence) {
    const nextObservation: Observation = {
      schemaVersion: 1,
      project: options.project,
      freezeGeneration: generation,
      exportedAtMs,
      sourceDigest: summary.digest,
      evidence,
      snapshot,
    };
    files["observation.json"] = `${JSON.stringify(nextObservation)}\n`;
  }
  if (options.phase === "final") {
    if (!importAttemptId) throw new Error("missing reservation import claim");
    batches = buildImportBatches(
      snapshot,
      exportedAtMs,
      generation,
      importAttemptId,
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
    JSON.stringify({
      phase: options.phase,
      exportedAtMs,
      sourceConcurrency,
      ...summary,
      artifacts: directory,
    }),
  );
  if (
    options.phase !== "final" ||
    !evidence ||
    !observation ||
    !importAttemptId
  )
    return;
  for (let index = 0; index < batches.length; index++) {
    assertFrozen(dependencies.inspect(), evidence, generation, importAttemptId);
    dependencies.importSql(
      resolve(directory, `import-${String(index).padStart(5, "0")}.sql`),
    );
  }
  const imported = normalizeSnapshot(dependencies.readImportedSnapshot());
  if (digest(imported) !== summary.digest)
    throw new Error(
      "D1 reservation import readback differs from the Firebase source",
    );
  assertFrozen(dependencies.inspect(), evidence, generation, importAttemptId);
  const finalSource = normalizeSnapshot(
    dependencies.readSource(options.project),
  );
  if (digest(finalSource) !== summary.digest)
    throw new Error(
      "Firebase reservations changed during import; activation remains disabled",
    );
  assertFrozen(dependencies.inspect(), evidence, generation, importAttemptId);
  const proof: Proof = {
    importAttemptId,
    freezeGeneration: generation,
    sourceDigest: summary.digest,
    sourceBalanceCount: summary.balances,
    sourceOperationCount: summary.operations,
    sourceFirstExportedAtMs: observation.exportedAtMs,
    sourceExportedAtMs: exportedAtMs,
    queuesPausedAtMs: Math.max(...Object.values(evidence.queuesPausedAtMs)),
    bridgeDeployedAtMs: evidence.bridgeDeployedAtMs,
    bridgeVersionId: evidence.bridgeVersionId,
  };
  dependencies.markVerified(proof);
  const verified = dependencies.inspect();
  assertFrozen(verified, evidence, generation);
  if (
    verified.control.verifiedImportGeneration !== generation ||
    verified.control.sourceDigest !== summary.digest
  )
    throw new Error("reservation import proof could not be verified");
  dependencies.log(
    JSON.stringify({ phase: "final", verified: true, ...summary }),
  );
}

function firebaseDatabaseGetArgs(
  project: string,
  path: string,
  shallow = false,
): string[] {
  return [
    "database:get",
    path,
    "--project",
    project,
    ...(project === CANONICAL_PROJECT
      ? ["--instance", CANONICAL_INSTANCE]
      : []),
    ...(shallow ? ["--shallow"] : []),
  ];
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("reservation source request failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes)
        throw new Error("reservation source response exceeds the size limit");
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid reservation source response");
  }
}

async function sourceAccessToken(
  credentialPath: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let credentials: JsonRecord | null;
  try {
    const info = statSync(credentialPath);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
    credentials = record(JSON.parse(readFileSync(credentialPath, "utf8")));
  } catch {
    throw new Error(
      "explicit Google service account credentials are unreadable",
    );
  }
  if (
    !credentials ||
    credentials.type !== "service_account" ||
    typeof credentials.client_email !== "string" ||
    typeof credentials.private_key !== "string"
  )
    throw new Error(
      "explicit Google credentials must identify a service account",
    );
  try {
    const key = await importPKCS8(credentials.private_key, "RS256");
    const issuedAt = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({
      scope:
        "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(credentials.client_email)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(key);
    const response = await fetcher(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    const token = record(await readBoundedResponse(response, 64 * 1024));
    if (
      typeof token?.access_token !== "string" ||
      !token.access_token ||
      token.token_type !== "Bearer"
    )
      throw new Error();
    return token.access_token;
  } catch {
    throw new Error("reservation source service account authentication failed");
  }
}

function readSourceConcurrency(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = environment.WAGER_RESERVATION_SOURCE_CONCURRENCY;
  if (value === undefined) return SOURCE_READ_CONCURRENCY;
  if (!/^(?:[1-9]|1[0-6])$/.test(value))
    throw new Error(
      "WAGER_RESERVATION_SOURCE_CONCURRENCY must be an integer from 1 through 16",
    );
  return Number(value);
}

async function readSourceAsync(
  get: (path: string, shallow?: boolean) => Promise<unknown>,
  concurrency = SOURCE_READ_CONCURRENCY,
): Promise<Snapshot> {
  if (
    !integer(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_SOURCE_READ_CONCURRENCY
  )
    throw new Error("invalid authenticated source read concurrency");
  const enumerate = async () => {
    const value = await get("/players", true);
    const root = value === null ? {} : record(value);
    if (
      !root ||
      Object.entries(root).some(
        ([uid, value]) => !validIdentifier(uid) || value !== true,
      )
    )
      throw new Error("invalid shallow player UID export");
    return Object.keys(root).sort();
  };
  const uids = await enumerate();
  const snapshot: Snapshot = {};
  let cursor = 0;
  let retainedBytes = 0;
  let failed = false;
  const outcomes = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (!failed && cursor < uids.length) {
        const uid = uids[cursor++];
        try {
          const value = await get(`/players/${uid}/mining`);
          if (value === null) continue;
          const mining = record(value);
          if (!mining) throw new Error("invalid player mining parent");
          if (
            !Object.hasOwn(mining, "frozen") &&
            !Object.hasOwn(mining, "_wagerOps")
          )
            continue;
          const player = {
            frozen: normalizeFrozen(mining.frozen),
            operations: normalizeOperations(mining._wagerOps),
          };
          retainedBytes +=
            Buffer.byteLength(JSON.stringify(player)) +
            Buffer.byteLength(uid) +
            8;
          if (retainedBytes > SNAPSHOT_MAX_BYTES)
            throw new Error("reservation snapshot exceeds the size limit");
          Object.defineProperty(snapshot, uid, {
            value: player,
            enumerable: true,
          });
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (failure) throw failure.reason;
  if (digest(uids) !== digest(await enumerate()))
    throw new Error("player UID enumeration changed during export");
  return normalizeSnapshot(snapshot);
}

async function exportSourceWithCredentials(
  project: string,
  credentialPath: string,
): Promise<Snapshot> {
  if (project !== CANONICAL_PROJECT)
    throw new Error(
      "service account export requires the canonical Firebase project",
    );
  const concurrency = readSourceConcurrency();
  const token = await sourceAccessToken(credentialPath);
  return readSourceAsync(async (path, shallow) => {
    const url = new URL(
      `https://${CANONICAL_INSTANCE}.firebaseio.com${path
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}.json`,
    );
    if (shallow) url.searchParams.set("shallow", "true");
    try {
      return await readBoundedResponse(
        await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(60_000),
          redirect: "error",
        }),
        shallow ? 64 * 1024 * 1024 : SOURCE_MAX_BYTES,
      );
    } catch {
      throw new Error("bounded reservation source read failed");
    }
  }, concurrency);
}

function readRemoteSource(project: string): Snapshot {
  if (
    !process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    project !== CANONICAL_PROJECT
  )
    return readSource(project);
  readSourceConcurrency();
  return normalizeSnapshot(
    JSON.parse(
      runTool(
        process.execPath,
        [
          "--experimental-strip-types",
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          resolve(import.meta.dirname, "migrate-wager-reservations.ts"),
          "--internal-export-source",
          "--project",
          project,
        ],
        SNAPSHOT_MAX_BYTES,
      ),
    ),
  );
}

function readSource(
  project: string,
  get: (path: string, shallow?: boolean) => unknown = (path, shallow) =>
    JSON.parse(
      runTool(
        resolve("node_modules/.bin/firebase"),
        firebaseDatabaseGetArgs(project, path, shallow),
        SOURCE_MAX_BYTES,
      ),
    ),
): Snapshot {
  const enumerate = () => {
    const value = get("/players", true);
    const root = value === null ? {} : record(value);
    if (
      !root ||
      Object.entries(root).some(
        ([uid, value]) => !validIdentifier(uid) || value !== true,
      )
    )
      throw new Error("invalid shallow player UID export");
    return Object.keys(root).sort();
  };
  const uids = enumerate();
  const snapshot: Snapshot = {};
  for (const uid of uids) {
    const value = get(`/players/${uid}/mining`);
    if (value === null) continue;
    const mining = record(value);
    if (!mining) throw new Error("invalid player mining parent");
    if (!Object.hasOwn(mining, "frozen") && !Object.hasOwn(mining, "_wagerOps"))
      continue;
    Object.defineProperty(snapshot, uid, {
      value: {
        frozen: normalizeFrozen(mining.frozen),
        operations: normalizeOperations(mining._wagerOps),
      },
      enumerable: true,
    });
  }
  if (digest(uids) !== digest(enumerate()))
    throw new Error("player UID enumeration changed during export");
  return snapshot;
}

function readImportedSnapshot(
  rows: (query: string) => JsonRecord[] = d1Rows,
): Snapshot {
  const snapshot: Snapshot = {};
  let lastUid: string | null = null;
  while (true) {
    const page = rows(
      `SELECT player_uid, frozen_json FROM wager_frozen_balances ${lastUid === null ? "" : `WHERE player_uid > ${sqlText(lastUid)}`} ORDER BY player_uid LIMIT ${D1_PAGE_SIZE}`,
    );
    for (const row of page) {
      const uid = row.player_uid;
      if (
        !validIdentifier(uid) ||
        Object.hasOwn(snapshot, uid) ||
        typeof row.frozen_json !== "string"
      )
        throw new Error("invalid imported wager balance");
      Object.defineProperty(snapshot, uid, {
        value: {
          frozen: normalizeFrozen(JSON.parse(row.frozen_json)),
          operations: {},
        },
        enumerable: true,
      });
      lastUid = uid;
    }
    if (page.length < D1_PAGE_SIZE) break;
  }
  let cursor: { uid: string; operationId: string } | null = null;
  while (true) {
    const page = rows(
      `SELECT player_uid, operation_id, record_json FROM wager_frozen_operations ${cursor ? `WHERE player_uid > ${sqlText(cursor.uid)} OR (player_uid = ${sqlText(cursor.uid)} AND operation_id > ${sqlText(cursor.operationId)})` : ""} ORDER BY player_uid, operation_id LIMIT ${D1_PAGE_SIZE}`,
    );
    for (const row of page) {
      const uid = row.player_uid;
      const operationId = row.operation_id;
      if (
        !validIdentifier(uid) ||
        !validIdentifier(operationId) ||
        !Object.hasOwn(snapshot, uid) ||
        Object.hasOwn(snapshot[uid].operations, operationId) ||
        typeof row.record_json !== "string"
      )
        throw new Error("invalid imported wager operation");
      const operation = normalizeOperations({
        [operationId]: JSON.parse(row.record_json),
      })[operationId];
      Object.defineProperty(snapshot[uid].operations, operationId, {
        value: operation,
        enumerable: true,
      });
      cursor = { uid, operationId };
    }
    if (page.length < D1_PAGE_SIZE) break;
  }
  return snapshot;
}

function inspect(): Inspection {
  return {
    control: readRemoteControl(),
    canonicalState: readCanonicalState(),
    writeAdmissions: readRemoteAdmissions().length,
    activeGameplayLeases: activeGameplayLeases(Date.now()),
    deployment: readDeployment(),
  };
}

function persistArtifacts(
  files: Readonly<Record<string, string>>,
  phase: Options["phase"],
  nowMs: number,
  rootDirectory = resolve(".cache/wager-reservation-migration"),
): string {
  mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  chmodSync(rootDirectory, 0o700);
  const directory = mkdtempSync(resolve(rootDirectory, `${nowMs}-${phase}-`));
  chmodSync(directory, 0o700);
  for (const [name, value] of Object.entries(files)) {
    if (!/^[a-z0-9.-]+$/.test(name))
      throw new Error("invalid migration artifact name");
    writeFileSync(resolve(directory, name), value, { mode: 0o600, flag: "wx" });
  }
  return directory;
}

function readJson(path: string): unknown {
  const info = statSync(path);
  if (
    !info.isFile() ||
    info.size > 256 * 1024 * 1024 ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "cutover evidence must be a private regular file (mode 0600)",
    );
  return JSON.parse(readFileSync(path, "utf8"));
}

function buildClaimSql(
  generation: number,
  attemptId: string,
  startedAtMs: number,
): string {
  if (!validIdentifier(attemptId) || !integer(startedAtMs))
    throw new Error("invalid import claim");
  return `UPDATE wager_reservation_runtime_control SET verified_import_generation = NULL, source_digest = NULL, import_attempt_id = ${sqlText(attemptId)}, import_started_at_ms = ${startedAtMs}, updated_at_ms = ${startedAtMs} WHERE singleton = 1 AND ${importGuard(generation, null)} RETURNING singleton`;
}

function buildVerificationSql(proof: Proof, nowMs: number): string {
  if (
    !integer(nowMs) ||
    !/^[a-f0-9]{64}$/.test(proof.sourceDigest) ||
    ![
      proof.sourceBalanceCount,
      proof.sourceOperationCount,
      proof.sourceFirstExportedAtMs,
      proof.sourceExportedAtMs,
      proof.queuesPausedAtMs,
      proof.bridgeDeployedAtMs,
    ].every(integer)
  )
    throw new Error("invalid reservation import proof");
  return `UPDATE wager_reservation_runtime_control SET verified_import_generation = freeze_generation, import_attempt_id = NULL, import_started_at_ms = NULL, source_digest = ${sqlText(proof.sourceDigest)}, source_balance_count = ${proof.sourceBalanceCount}, source_operation_count = ${proof.sourceOperationCount}, source_first_exported_at_ms = ${proof.sourceFirstExportedAtMs}, source_exported_at_ms = ${proof.sourceExportedAtMs}, queues_paused_at_ms = ${proof.queuesPausedAtMs}, bridge_deployed_at_ms = ${proof.bridgeDeployedAtMs}, bridge_version_id = ${sqlText(proof.bridgeVersionId)}, updated_at_ms = ${nowMs} WHERE singleton = 1 AND ${importGuard(proof.freezeGeneration, proof.importAttemptId)} RETURNING verified_import_generation`;
}

function markVerified(proof: Proof): void {
  const values = d1Rows(buildVerificationSql(proof, Date.now()));
  if (values[0]?.verified_import_generation !== proof.freezeGeneration)
    throw new Error("reservation import verification conflicted");
}

function execute(argv = process.argv.slice(2)): void {
  migrateWagerReservations(parseArgs(argv), {
    now: Date.now,
    log: console.log,
    readJson,
    readSource: readRemoteSource,
    inspect,
    persistArtifacts,
    importSql: (path) => {
      runTool(
        resolve("node_modules/.bin/wrangler"),
        wranglerArgs([
          "d1",
          "execute",
          "mons-link-profiles",
          "--remote",
          "--file",
          path,
          "--json",
        ]),
      );
    },
    readImportedSnapshot,
    markVerified,
    claimImport: (generation, attemptId, startedAtMs) => {
      const rows = d1Rows(buildClaimSql(generation, attemptId, startedAtMs));
      if (rows.length !== 1)
        throw new Error("reservation import claim conflicted");
    },
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const fail = (error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "wager reservation migration failed",
    );
    process.exitCode = 1;
  };
  if (process.argv[2] === "--internal-export-source") {
    try {
      if (
        process.argv.length !== 5 ||
        process.argv[3] !== "--project" ||
        !process.env.GOOGLE_APPLICATION_CREDENTIALS
      )
        throw new Error("invalid internal source export");
      const options = parseArgs(["--preview", "--project", process.argv[4]]);
      assertSource(options, process.env);
      exportSourceWithCredentials(
        options.project,
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
      )
        .then((snapshot) => {
          process.stdout.write(JSON.stringify(snapshot));
        })
        .catch(fail);
    } catch (error) {
      fail(error);
    }
  } else {
    try {
      execute();
    } catch (error) {
      fail(error);
    }
  }
}

export {
  assertFrozen,
  assertSource,
  buildImportBatches,
  buildClaimSql,
  buildVerificationSql,
  digest,
  execute,
  firebaseDatabaseGetArgs,
  importGuard,
  migrateWagerReservations,
  normalizeFrozen,
  normalizeOperations,
  normalizeSnapshot,
  parseArgs,
  parseEvidence,
  parseObservation,
  persistArtifacts,
  QUEUE_NAMES,
  readImportedSnapshot,
  readBoundedResponse,
  readJson,
  readSource,
  readSourceAsync,
  readSourceConcurrency,
  SQL_BATCH_BYTES,
  summarize,
  type Dependencies,
  type Evidence,
  type Inspection,
  type Observation,
  type Options,
  type Proof,
  type Snapshot,
};
