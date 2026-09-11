import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  createWranglerRunner,
  digest,
  privateDirectory,
  readPrivateJson,
  resolveCloudflareToken,
  writePrivateImmutable,
  type SqlRunner,
} from "./operator/runtime.ts";
import {
  assertSameMatchStateSource,
  buildMatchStateBundle,
  buildMatchStateManifest,
  matchClaimPath,
  matchRecordPath,
  matchStateSourceFile,
  validateMatchStateManifest,
  type MatchStateInventory,
  type MatchStateManifest,
} from "./match-state-manifest.ts";
import { createMatchStateProvider } from "./match-state-provider.ts";
import { mapMatchStateBounded } from "./match-state-concurrency.ts";
import type { MatchStateMigrationRequest } from "../cloud/workers/api/src/matchStateMigration.ts";
import type { MatchStateImportSnapshot } from "../cloud/workers/api/src/matchStateTypes.ts";

const DATABASE = "mons-link-profile-games";
const EVENTS = "mons-link-events";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type JsonRecord = Record<string, unknown>;
type Operation =
  | "status"
  | "preflight"
  | "drain"
  | "freeze"
  | "export"
  | "import"
  | "verify"
  | "activate"
  | "resume"
  | "inspect-admissions"
  | "reconcile-admission";
export type MatchStateArguments = {
  operation: Operation;
  directory?: string;
  candidateVersionId?: string;
  firebaseCredentials?: string;
  secretFile?: string;
  fenceEvidence?: string;
  evidence?: string;
};
type OperatorIdentity = {
  schemaVersion: 1;
  importId: string;
  ownerToken: string;
  candidateVersionId: string;
};
type Control = JsonRecord & {
  backend: "rtdb" | "durable";
  state: "active" | "draining" | "frozen";
  epoch: number;
  freeze_generation: number;
  import_id: string | null;
  candidate_version_id: string | null;
  source_digest: string | null;
  verified_digest: string | null;
};
export type MatchStateOperatorDependencies = {
  run: SqlRunner;
  now(): number;
  deployment(): Promise<string>;
  inventory(): Promise<MatchStateInventory>;
  readSource?(path: string): Promise<unknown>;
  migrate(input: MatchStateMigrationRequest): Promise<MatchStateImportSnapshot>;
  log(value: JsonRecord): void;
};

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("match-state-invalid-record");
  return value as JsonRecord;
}

export function parseMatchStateArgs(argv: string[]): MatchStateArguments {
  const operations: Operation[] = [
    "status",
    "preflight",
    "drain",
    "freeze",
    "export",
    "import",
    "verify",
    "activate",
    "resume",
    "inspect-admissions",
    "reconcile-admission",
  ];
  const operation = argv[0]?.slice(2) as Operation;
  if (!argv[0]?.startsWith("--") || !operations.includes(operation))
    throw new Error(
      "choose --status, --preflight, --drain, --freeze, --export, --import, --verify, --activate, --resume, --inspect-admissions or --reconcile-admission",
    );
  const args: MatchStateArguments = { operation };
  const names = new Map<string, keyof Omit<MatchStateArguments, "operation">>([
    ["--directory", "directory"],
    ["--candidate-version-id", "candidateVersionId"],
    ["--firebase-credentials", "firebaseCredentials"],
    ["--secret-file", "secretFile"],
    ["--fence-evidence", "fenceEvidence"],
    ["--evidence", "evidence"],
  ]);
  for (let i = 1; i < argv.length; i += 2) {
    const name = names.get(argv[i]);
    if (!name || !argv[i + 1] || args[name] !== undefined)
      throw new Error("invalid or duplicate match-state argument");
    args[name] = argv[i + 1];
  }
  if (operation === "status") {
    if (argv.length !== 1)
      throw new Error("--status accepts no other arguments");
    return args;
  }
  if (!args.directory || !isAbsolute(args.directory))
    throw new Error(
      "match-state operation requires --directory with an absolute protected path",
    );
  for (const path of [
    args.firebaseCredentials,
    args.secretFile,
    args.fenceEvidence,
    args.evidence,
  ]) {
    if (path && !isAbsolute(path))
      throw new Error(
        "match-state credential and evidence paths must be absolute",
      );
  }
  if (
    operation === "preflight" &&
    (!args.candidateVersionId || !UUID.test(args.candidateVersionId))
  )
    throw new Error(
      "--preflight requires an exact --candidate-version-id UUID",
    );
  if (operation !== "preflight" && args.candidateVersionId !== undefined)
    throw new Error(
      "candidate version is locked by the protected preflight identity",
    );
  if (operation === "export" && !args.fenceEvidence)
    throw new Error("--export requires --fence-evidence");
  if (["import", "verify", "activate"].includes(operation) && !args.secretFile)
    throw new Error("match-state room operations require --secret-file");
  if (operation === "reconcile-admission" && !args.evidence)
    throw new Error("--reconcile-admission requires --evidence");
  return args;
}

async function control(deps: MatchStateOperatorDependencies): Promise<Control> {
  const row = record(
    (
      await deps.run(
        "SELECT * FROM match_state_control WHERE singleton = 1",
        DATABASE,
      )
    )[0],
  ) as Control;
  if (
    !["rtdb", "durable"].includes(row.backend) ||
    !["active", "draining", "frozen"].includes(row.state) ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 1 ||
    !Number.isSafeInteger(row.freeze_generation)
  )
    throw new Error("match-state-control-unavailable");
  return row;
}

async function counts(
  deps: MatchStateOperatorDependencies,
): Promise<JsonRecord> {
  const gameplay = record(
    (
      await deps.run(
        `SELECT
    (SELECT COUNT(*) FROM match_state_write_admissions) AS admissions,
    (SELECT COUNT(*) FROM game_session_transitions WHERE status = 'pending') AS session_intents,
    (SELECT COUNT(*) FROM game_session_transition_resources) AS session_resources,
    (SELECT COUNT(*) FROM invite_source_write_admissions) AS invite_admissions,
    (SELECT COUNT(*) FROM automatch_write_admissions) AS automatch_admissions,
    (SELECT COUNT(*) FROM game_session_mutation_locks WHERE expires_at_ms > ?) AS session_leases,
    (SELECT COUNT(*) FROM match_state_routes) AS routes,
    (SELECT COUNT(*) FROM match_state_import_receipts) AS bundles`,
        DATABASE,
        [deps.now()],
      )
    )[0],
  );
  const event = record(
    (
      await deps.run(
        `SELECT
    (SELECT COUNT(*) FROM event_write_admissions) AS event_admissions,
    (SELECT COUNT(*) FROM event_transition_intents WHERE status = 'pending') AS event_intents,
    (SELECT COUNT(*) FROM event_leases WHERE expires_at_ms > ?) AS event_leases`,
        EVENTS,
        [deps.now()],
      )
    )[0],
  );
  return { ...gameplay, ...event };
}

function assertDrained(value: JsonRecord): void {
  for (const name of [
    "admissions",
    "session_intents",
    "session_resources",
    "invite_admissions",
    "automatch_admissions",
    "session_leases",
    "event_admissions",
    "event_intents",
    "event_leases",
  ]) {
    if (value[name] !== 0) throw new Error(`match-state-unresolved-${name}`);
  }
}

function identity(directory: string): OperatorIdentity {
  const value = record(
    readPrivateJson(resolve(directory, "operator.json")),
  ) as OperatorIdentity;
  if (
    value.schemaVersion !== 1 ||
    !UUID.test(value.importId) ||
    !UUID.test(value.ownerToken) ||
    !UUID.test(value.candidateVersionId)
  )
    throw new Error("invalid-match-state-operator-identity");
  return value;
}

async function assertCandidate(
  deps: MatchStateOperatorDependencies,
  owner: OperatorIdentity,
): Promise<void> {
  if ((await deps.deployment()) !== owner.candidateVersionId)
    throw new Error("match-state-candidate-is-not-serving-all-traffic");
}

async function acquireLock(
  deps: MatchStateOperatorDependencies,
  owner: OperatorIdentity,
  phase: string,
): Promise<void> {
  await deps.run(
    `INSERT OR IGNORE INTO match_state_operator_lock (singleton, owner_token, import_id, phase, created_at_ms)
    SELECT 1, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM match_state_control WHERE singleton = 1 AND backend = 'rtdb')`,
    DATABASE,
    [owner.ownerToken, owner.importId, phase, deps.now()],
  );
  await assertLock(deps, owner);
  await deps.run(
    "UPDATE match_state_operator_lock SET phase = ? WHERE singleton = 1 AND owner_token = ? AND import_id = ?",
    DATABASE,
    [phase, owner.ownerToken, owner.importId],
  );
}

async function assertLock(
  deps: MatchStateOperatorDependencies,
  owner: OperatorIdentity,
): Promise<void> {
  const lock = (
    await deps.run(
      "SELECT owner_token, import_id FROM match_state_operator_lock WHERE singleton = 1",
      DATABASE,
    )
  )[0];
  if (
    !lock ||
    lock.owner_token !== owner.ownerToken ||
    lock.import_id !== owner.importId
  )
    throw new Error("match-state-operator-lock-owned-by-another-operation");
}

function ownerGuard(): string {
  return "EXISTS (SELECT 1 FROM match_state_operator_lock WHERE singleton = 1 AND owner_token = ? AND import_id = ?)";
}

function frozenGuard(): string {
  return `EXISTS (SELECT 1 FROM match_state_control WHERE singleton = 1 AND backend = 'rtdb' AND state = 'frozen'
    AND import_id = ? AND source_digest = ? AND epoch + 1 = ?) AND ${ownerGuard()}`;
}

function frozenBindings(
  owner: OperatorIdentity,
  manifest: MatchStateManifest,
): Array<string | number> {
  return [
    owner.importId,
    manifest.sourceDigest,
    manifest.epoch,
    owner.ownerToken,
    owner.importId,
  ];
}

function assertFenceEvidence(
  value: unknown,
  owner: OperatorIdentity,
  current: Control,
  nowMs: number,
): JsonRecord {
  const proof = record(value);
  if (
    proof.schemaVersion !== 1 ||
    proof.kind !== "match-state-source-fence" ||
    proof.candidateVersionId !== owner.candidateVersionId ||
    proof.importId !== owner.importId ||
    proof.freezeGeneration !== current.freeze_generation ||
    proof.databaseUrl !== "https://mons-link-default-rtdb.firebaseio.com" ||
    !Number.isSafeInteger(proof.checkedAtMs) ||
    Number(proof.checkedAtMs) < 0 ||
    !Number.isSafeInteger(current.frozen_at_ms) ||
    Number(proof.checkedAtMs) < Number(current.frozen_at_ms) ||
    Number(proof.checkedAtMs) > nowMs ||
    proof.workflowInstancesFenced !== true ||
    !Array.isArray(proof.principals) ||
    !proof.principals.length
  )
    throw new Error("match-state-source-fence-evidence-required");
  const principals = new Set<string>();
  for (const raw of proof.principals) {
    const row = record(raw);
    if (
      typeof row.principal !== "string" ||
      !row.principal.endsWith(".iam.gserviceaccount.com") ||
      principals.has(row.principal) ||
      ![401, 403].includes(Number(row.beforeTokenWriteStatus)) ||
      ![401, 403].includes(Number(row.freshTokenWriteStatus)) ||
      row.readStatus !== 200
    )
      throw new Error("match-state-source-fence-probe-unconfirmed");
    principals.add(row.principal);
  }
  return proof;
}

function readManifest(
  directory: string,
  owner: OperatorIdentity,
): MatchStateManifest {
  const manifest = validateMatchStateManifest(
    readPrivateJson(resolve(directory, "manifest.json")),
  );
  if (
    manifest.importId !== owner.importId ||
    manifest.candidateVersionId !== owner.candidateVersionId
  )
    throw new Error("match-state-manifest-operator-conflict");
  return manifest;
}

function readSource(directory: string, path: string): unknown {
  const value = record(
    readPrivateJson(resolve(directory, matchStateSourceFile(path))),
  );
  if (value.path !== path || !Object.hasOwn(value, "value"))
    throw new Error("match-state-source-artifact-conflict");
  return value.value;
}

async function verifySource(
  deps: MatchStateOperatorDependencies,
  manifest: MatchStateManifest,
): Promise<void> {
  const current = buildMatchStateManifest(await deps.inventory(), {
    importId: manifest.importId,
    epoch: manifest.epoch,
    candidateVersionId: manifest.candidateVersionId,
    freezeGeneration: manifest.freezeGeneration,
  });
  assertSameMatchStateSource(manifest, current);
}

async function importLegacy(
  deps: MatchStateOperatorDependencies,
  directory: string,
  owner: OperatorIdentity,
  manifest: MatchStateManifest,
): Promise<void> {
  for (const row of manifest.records.filter(
    (value) => value.inviteId === null,
  )) {
    const value = readSource(directory, matchRecordPath(row));
    if (digest(value) !== row.digest || row.disposition === null)
      throw new Error("match-state-legacy-source-conflict");
    await deps.run(
      `INSERT OR IGNORE INTO match_state_legacy_records
      (actor_uid, match_id, record_json, source_digest, import_id, disposition)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${frozenGuard()}`,
      DATABASE,
      [
        row.actorUid,
        row.matchId,
        canonicalJson(value),
        row.digest,
        owner.importId,
        row.disposition,
        ...frozenBindings(owner, manifest),
      ],
    );
    await deps.run(
      `INSERT OR IGNORE INTO match_state_routes (actor_uid, match_id, kind, invite_id, epoch)
      SELECT ?, ?, 'legacy', NULL, ? WHERE ${frozenGuard()}
        AND EXISTS (SELECT 1 FROM match_state_legacy_records WHERE actor_uid = ? AND match_id = ? AND source_digest = ? AND import_id = ?)`,
      DATABASE,
      [
        row.actorUid,
        row.matchId,
        manifest.epoch,
        ...frozenBindings(owner, manifest),
        row.actorUid,
        row.matchId,
        row.digest,
        owner.importId,
      ],
    );
  }
  for (const row of manifest.claims.filter(
    (value) => value.inviteId === null,
  )) {
    const value = readSource(directory, matchClaimPath(row));
    if (digest(value) !== row.digest || !row.disposition)
      throw new Error("match-state-legacy-claim-source-conflict");
    await deps.run(
      `INSERT OR IGNORE INTO match_state_legacy_claims
      (match_id, record_json, source_digest, import_id, disposition)
      SELECT ?, ?, ?, ?, ? WHERE ${frozenGuard()}`,
      DATABASE,
      [
        row.matchId,
        canonicalJson(value),
        row.digest,
        owner.importId,
        row.disposition,
        ...frozenBindings(owner, manifest),
      ],
    );
  }
}

async function verifyLegacy(
  deps: MatchStateOperatorDependencies,
  directory: string,
  owner: OperatorIdentity,
  manifest: MatchStateManifest,
): Promise<void> {
  const routePages = await mapMatchStateBounded(
    Array.from(
      { length: Math.ceil(manifest.records.length / 500) },
      (_, index) => index * 500,
    ),
    8,
    (offset) =>
      deps.run(
        "SELECT actor_uid, match_id, kind, invite_id, epoch FROM match_state_routes ORDER BY actor_uid, match_id LIMIT 500 OFFSET ?",
        DATABASE,
        [offset],
      ),
  );
  const routes = new Map<string, JsonRecord>();
  for (const actual of routePages.flat()) {
    const key = JSON.stringify([actual.actor_uid, actual.match_id]);
    if (routes.has(key))
      throw new Error("match-state-route-readback-duplicate");
    routes.set(key, actual);
  }
  for (const row of manifest.records) {
    const actual = routes.get(JSON.stringify([row.actorUid, row.matchId]));
    if (
      !actual ||
      actual.invite_id !== row.inviteId ||
      actual.kind !== (row.inviteId === null ? "legacy" : "durable") ||
      actual.epoch !== manifest.epoch
    )
      throw new Error("match-state-route-readback-conflict");
    if (row.inviteId === null) {
      const stored = (
        await deps.run(
          "SELECT record_json, source_digest, import_id, disposition FROM match_state_legacy_records WHERE actor_uid = ? AND match_id = ?",
          DATABASE,
          [row.actorUid, row.matchId],
        )
      )[0];
      if (
        !stored ||
        stored.record_json !==
          canonicalJson(readSource(directory, matchRecordPath(row))) ||
        stored.source_digest !== row.digest ||
        stored.import_id !== owner.importId ||
        stored.disposition !== row.disposition
      )
        throw new Error("match-state-legacy-readback-conflict");
    }
  }
  for (const row of manifest.claims.filter(
    (value) => value.inviteId === null,
  )) {
    const stored = (
      await deps.run(
        "SELECT record_json, source_digest, import_id FROM match_state_legacy_claims WHERE match_id = ?",
        DATABASE,
        [row.matchId],
      )
    )[0];
    if (
      !stored ||
      stored.record_json !==
        canonicalJson(readSource(directory, matchClaimPath(row))) ||
      stored.source_digest !== row.digest ||
      stored.import_id !== owner.importId
    )
      throw new Error("match-state-legacy-claim-readback-conflict");
  }
}

async function assertCoverage(
  deps: MatchStateOperatorDependencies,
  manifest: MatchStateManifest,
  phase: "verified" | "active",
): Promise<void> {
  const actual = record(
    (
      await deps.run(
        `SELECT
    (SELECT COUNT(*) FROM match_state_routes) AS routes,
    (SELECT COUNT(*) FROM match_state_legacy_records) AS legacy_records,
    (SELECT COUNT(*) FROM match_state_legacy_claims) AS legacy_claims,
    (SELECT COUNT(*) FROM match_state_import_receipts WHERE import_id = ? AND phase IN (${phase === "active" ? "'active'" : "'verified','active'"})) AS bundles,
    (SELECT COALESCE(SUM(record_count),0) FROM match_state_import_receipts WHERE import_id = ?) AS room_records,
    (SELECT COALESCE(SUM(claim_count),0) FROM match_state_import_receipts WHERE import_id = ?) AS room_claims`,
        DATABASE,
        [manifest.importId, manifest.importId, manifest.importId],
      )
    )[0],
  );
  if (
    actual.routes !== manifest.records.length ||
    actual.bundles !== manifest.invites.length ||
    actual.legacy_records !==
      manifest.records.filter((row) => row.inviteId === null).length ||
    actual.legacy_claims !==
      manifest.claims.filter((row) => row.inviteId === null).length ||
    Number(actual.room_records) + Number(actual.legacy_records) !==
      manifest.records.length ||
    Number(actual.room_claims) + Number(actual.legacy_claims) !==
      manifest.claims.length
  )
    throw new Error("match-state-import-coverage-incomplete");
}

async function migrateRooms(
  deps: MatchStateOperatorDependencies,
  directory: string,
  owner: OperatorIdentity,
  manifest: MatchStateManifest,
  operation: MatchStateMigrationRequest["operation"],
): Promise<void> {
  await mapMatchStateBounded(manifest.invites, 8, async ({ inviteId }) => {
    const bundle = buildMatchStateBundle(manifest, inviteId, (path) =>
      readSource(directory, path),
    );
    const result = await deps.migrate({
      schemaVersion: 1,
      operation,
      sourceDigest: manifest.sourceDigest,
      ownerToken: owner.ownerToken,
      bundle,
    });
    if (canonicalJson(result) !== canonicalJson(bundle))
      throw new Error("match-state-room-readback-conflict");
    writePrivateImmutable(
      resolve(directory, `${operation}-${digest(inviteId)}.json`),
      result,
    );
  });
}

async function reconcileAdmission(
  deps: MatchStateOperatorDependencies,
  args: MatchStateArguments,
  directory: string,
  owner: OperatorIdentity,
): Promise<void> {
  const proof = record(readPrivateJson(args.evidence!));
  const admission = record(proof.admission);
  if (
    proof.schemaVersion !== 1 ||
    proof.importId !== owner.importId ||
    proof.admissionDigest !== digest(admission) ||
    typeof admission.admission_id !== "string" ||
    !UUID.test(admission.admission_id) ||
    proof.requestFinished !== true ||
    !Number.isSafeInteger(proof.requestFinishedAtMs) ||
    Number(proof.requestFinishedAtMs) < Number(admission.created_at_ms) ||
    Number(proof.requestFinishedAtMs) > deps.now() ||
    proof.sourceWritesFenced !== true ||
    !Array.isArray(proof.sources)
  )
    throw new Error(
      "match-state-admission-requires-finished-request-and-source-evidence",
    );
  const expected = (
    await deps.run(
      "SELECT * FROM match_state_write_admissions WHERE admission_id = ?",
      DATABASE,
      [admission.admission_id],
    )
  )[0];
  if (!expected) {
    const receipt = (
      await deps.run(
        "SELECT evidence_digest FROM match_state_reconciliation_receipts WHERE admission_id = ?",
        DATABASE,
        [admission.admission_id],
      )
    )[0];
    if (receipt?.evidence_digest === digest(proof)) return;
    throw new Error(
      "match-state-missing-admission-without-reconciliation-proof",
    );
  }
  if (canonicalJson(expected) !== canonicalJson(admission))
    throw new Error("match-state-admission-changed");
  const resources: unknown = JSON.parse(String(admission.resources_json));
  if (
    !Array.isArray(resources) ||
    resources.some((resource) => typeof resource !== "string")
  )
    throw new Error("match-state-invalid-admission-resource-scope");
  const sourceProofs = proof.sources.map(record);
  const uniqueSources = new Set(sourceProofs.map((source) => source.resource));
  if (
    uniqueSources.size !== sourceProofs.length ||
    resources.some((resource) => !uniqueSources.has(resource)) ||
    sourceProofs.length !== resources.length ||
    sourceProofs.some(
      (source) =>
        typeof source.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(source.digest),
    )
  )
    throw new Error("match-state-admission-source-evidence-incomplete");
  if ((await control(deps)).state === "active")
    throw new Error("match-state-admission-reconciliation-needs-drain");
  for (const source of sourceProofs) {
    if (
      typeof source.resource !== "string" ||
      !/^(players\/[^/]+\/matches\/[^/]+(?:\/[^/]+)?|matchTimerClaims\/[^/]+)$/.test(
        source.resource,
      ) ||
      !deps.readSource ||
      admission.backend !== "rtdb"
    )
      throw new Error(
        "match-state-admission-needs-current-authority-resource-inspection",
      );
    if (digest(await deps.readSource(source.resource)) !== source.digest)
      throw new Error("match-state-admission-source-changed");
  }
  writePrivateImmutable(
    resolve(directory, `reconcile-${digest(proof)}.json`),
    proof,
  );
  await deps.run(
    `INSERT OR IGNORE INTO match_state_reconciliation_receipts (admission_id, admission_digest, evidence_digest, reconciled_at_ms)
    SELECT ?, ?, ?, ? WHERE ${ownerGuard()}`,
    DATABASE,
    [
      admission.admission_id,
      digest(admission),
      digest(proof),
      deps.now(),
      owner.ownerToken,
      owner.importId,
    ],
  );
  const tupleKeys = [
    "admission_id",
    "backend",
    "epoch",
    "freeze_generation",
    "kind",
    "resources_json",
    "transition_id",
    "phase",
    "created_at_ms",
  ];
  await deps.run(
    `DELETE FROM match_state_write_admissions WHERE ${tupleKeys.map((field) => `${field} IS ?`).join(" AND ")}
    AND ${ownerGuard()} AND EXISTS (SELECT 1 FROM match_state_reconciliation_receipts WHERE admission_id = ? AND evidence_digest = ?)`,
    DATABASE,
    [
      ...tupleKeys.map((field) => admission[field] as string | number | null),
      owner.ownerToken,
      owner.importId,
      admission.admission_id,
      digest(proof),
    ],
  );
  if (
    (
      await deps.run(
        "SELECT admission_id FROM match_state_write_admissions WHERE admission_id = ?",
        DATABASE,
        [admission.admission_id],
      )
    ).length
  )
    throw new Error("match-state-admission-reconciliation-unconfirmed");
}

export async function manageMatchState(
  args: MatchStateArguments,
  deps: MatchStateOperatorDependencies,
): Promise<void> {
  const before = await control(deps);
  if (args.operation === "status") {
    deps.log({
      operation: "status",
      control: before,
      counts: await counts(deps),
      operatorLock:
        (
          await deps.run(
            "SELECT import_id, phase, created_at_ms FROM match_state_operator_lock WHERE singleton = 1",
            DATABASE,
          )
        )[0] ?? null,
    });
    return;
  }
  if (
    before.backend === "durable" &&
    before.state === "active" &&
    args.operation !== "inspect-admissions"
  )
    throw new Error(
      "match-state-migration-complete; mutating phases are retired; use --status or --inspect-admissions",
    );
  const directory = privateDirectory(args.directory!);
  if (args.operation === "preflight") {
    const path = resolve(directory, "operator.json");
    const owner: OperatorIdentity = existsSync(path)
      ? identity(directory)
      : {
          schemaVersion: 1,
          importId: randomUUID(),
          ownerToken: randomUUID(),
          candidateVersionId: args.candidateVersionId!,
        };
    if (owner.candidateVersionId !== args.candidateVersionId)
      throw new Error("match-state-preflight-candidate-conflict");
    if (before.backend !== "rtdb")
      throw new Error("match-state-migration-already-active");
    writePrivateImmutable(path, owner);
    const result = {
      operation: "preflight",
      candidateVersionId: owner.candidateVersionId,
      deployedVersionId: await deps.deployment(),
      control: before,
      counts: await counts(deps),
    };
    if (!existsSync(resolve(directory, "preflight.json")))
      writePrivateImmutable(resolve(directory, "preflight.json"), result);
    deps.log({
      operation: "preflight",
      importId: owner.importId,
      candidateVersionId: owner.candidateVersionId,
    });
    return;
  }
  const owner = identity(directory);
  if (args.operation === "inspect-admissions") {
    if (before.backend === "durable" && before.import_id !== owner.importId)
      throw new Error("match-state-inspection-import-conflict");
    const rows = await deps.run(
      "SELECT * FROM match_state_write_admissions ORDER BY admission_id",
      DATABASE,
    );
    writePrivateImmutable(
      resolve(directory, `admissions-${digest(rows)}.json`),
      { schemaVersion: 1, importId: owner.importId, admissions: rows },
    );
    deps.log({ operation: args.operation, admissions: rows.length });
    return;
  }
  await assertCandidate(deps, owner);
  if (
    args.operation === "activate" &&
    before.backend === "durable" &&
    before.import_id === owner.importId
  ) {
    const manifest = readManifest(directory, owner);
    if (
      before.epoch !== manifest.epoch ||
      before.source_digest !== manifest.sourceDigest ||
      before.verified_digest !== manifest.sourceDigest
    )
      throw new Error("match-state-existing-activation-conflict");
    writePrivateImmutable(resolve(directory, "activated.json"), {
      importId: owner.importId,
      sourceDigest: manifest.sourceDigest,
      epoch: manifest.epoch,
    });
    deps.log({
      operation: "activate",
      backend: "durable",
      state: before.state,
      epoch: before.epoch,
    });
    return;
  }
  await acquireLock(deps, owner, args.operation);
  if (args.operation === "reconcile-admission") {
    await reconcileAdmission(deps, args, directory, owner);
    deps.log({ operation: args.operation, reconciled: true });
    return;
  }
  if (args.operation === "drain") {
    if (before.backend !== "rtdb" || before.state === "frozen")
      throw new Error("match-state-drain-control-conflict");
    await deps.run(
      `UPDATE match_state_control SET state = 'draining', import_id = ?, candidate_version_id = ?, updated_at_ms = ?
      WHERE singleton = 1 AND backend = 'rtdb' AND state IN ('active','draining') AND epoch = ? AND freeze_generation = ?
        AND (import_id IS NULL OR import_id = ?) AND ${ownerGuard()}`,
      DATABASE,
      [
        owner.importId,
        owner.candidateVersionId,
        deps.now(),
        before.epoch,
        before.freeze_generation,
        owner.importId,
        owner.ownerToken,
        owner.importId,
      ],
    );
    const current = await control(deps);
    if (current.state !== "draining" || current.import_id !== owner.importId)
      throw new Error("match-state-drain-unconfirmed");
    const pending = [
      ...(await deps.run(
        "SELECT transition_id FROM game_session_transitions WHERE status = 'pending' ORDER BY transition_id",
        DATABASE,
      )),
      ...(await deps.run(
        "SELECT transition_id FROM event_transition_intents WHERE status = 'pending' ORDER BY transition_id",
        EVENTS,
      )),
    ];
    for (const row of pending)
      await deps.run(
        `INSERT OR IGNORE INTO match_state_recovery_ids (transition_id, freeze_generation)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM match_state_control WHERE singleton = 1 AND state = 'draining' AND freeze_generation = ?) AND ${ownerGuard()}`,
        DATABASE,
        [
          String(row.transition_id),
          current.freeze_generation,
          current.freeze_generation,
          owner.ownerToken,
          owner.importId,
        ],
      );
    deps.log({
      operation: "drain",
      counts: await counts(deps),
      allowedRecoveryTransitions: pending.length,
    });
    return;
  }
  if (args.operation === "freeze") {
    assertDrained(await counts(deps));
    const event = (
      await deps.run(
        "SELECT storage_mode FROM event_runtime_control WHERE singleton = 1",
        EVENTS,
      )
    )[0];
    if (event?.storage_mode !== "frozen")
      throw new Error("match-state-freeze-requires-event-writes-frozen");
    if (before.state === "draining")
      await deps.run(
        `UPDATE match_state_control SET state = 'frozen', freeze_generation = freeze_generation + 1, frozen_at_ms = ?, updated_at_ms = ?
      WHERE singleton = 1 AND backend = 'rtdb' AND state = 'draining' AND epoch = ? AND freeze_generation = ? AND import_id = ?
        AND NOT EXISTS (SELECT 1 FROM match_state_write_admissions) AND ${ownerGuard()}`,
        DATABASE,
        [
          deps.now(),
          deps.now(),
          before.epoch,
          before.freeze_generation,
          owner.importId,
          owner.ownerToken,
          owner.importId,
        ],
      );
    const current = await control(deps);
    if (
      current.backend !== "rtdb" ||
      current.state !== "frozen" ||
      current.import_id !== owner.importId
    )
      throw new Error("match-state-freeze-unconfirmed");
    writePrivateImmutable(resolve(directory, "frozen.json"), {
      importId: owner.importId,
      epoch: current.epoch,
      freezeGeneration: current.freeze_generation,
      frozenAtMs: current.frozen_at_ms,
    });
    deps.log({
      operation: "freeze",
      freezeGeneration: current.freeze_generation,
    });
    return;
  }
  if (args.operation === "resume") {
    if (
      before.backend !== "durable" ||
      before.state !== "frozen" ||
      before.import_id !== owner.importId
    )
      throw new Error("match-state-resume-requires-verified-durable-authority");
    assertDrained(await counts(deps));
    await assertCandidate(deps, owner);
    await deps.run(
      `UPDATE match_state_control SET state = 'active', updated_at_ms = ? WHERE singleton = 1
      AND backend = 'durable' AND state = 'frozen' AND import_id = ? AND candidate_version_id = ? AND ${ownerGuard()}`,
      DATABASE,
      [
        deps.now(),
        owner.importId,
        owner.candidateVersionId,
        owner.ownerToken,
        owner.importId,
      ],
    );
    const current = await control(deps);
    if (current.state !== "active")
      throw new Error("match-state-resume-unconfirmed");
    writePrivateImmutable(resolve(directory, "resumed.json"), {
      importId: owner.importId,
      epoch: current.epoch,
      sourceDigest: current.source_digest,
    });
    await deps.run(
      "DELETE FROM match_state_operator_lock WHERE singleton = 1 AND owner_token = ? AND import_id = ?",
      DATABASE,
      [owner.ownerToken, owner.importId],
    );
    deps.log({
      operation: "resume",
      backend: "durable",
      state: "active",
      epoch: current.epoch,
    });
    return;
  }
  if (
    before.backend !== "rtdb" ||
    before.state !== "frozen" ||
    before.import_id !== owner.importId
  )
    throw new Error("match-state-import-needs-frozen-source-authority");
  assertDrained(await counts(deps));
  if (args.operation === "export") {
    const fence = assertFenceEvidence(
      readPrivateJson(args.fenceEvidence!),
      owner,
      before,
      deps.now(),
    );
    writePrivateImmutable(resolve(directory, "source-fence.json"), fence);
    const inventory = await deps.inventory();
    const manifest = buildMatchStateManifest(inventory, {
      importId: owner.importId,
      epoch: before.epoch + 1,
      candidateVersionId: owner.candidateVersionId,
      freezeGeneration: before.freeze_generation,
    });
    for (const row of inventory.records)
      writePrivateImmutable(
        resolve(directory, matchStateSourceFile(matchRecordPath(row))),
        { path: matchRecordPath(row), value: row.value },
      );
    for (const row of inventory.claims)
      writePrivateImmutable(
        resolve(directory, matchStateSourceFile(matchClaimPath(row))),
        { path: matchClaimPath(row), value: row.value },
      );
    writePrivateImmutable(resolve(directory, "cross-checks.json"), {
      invites: inventory.invites,
      discovery: inventory.discovery,
      crossChecks: inventory.crossChecks,
    });
    writePrivateImmutable(resolve(directory, "manifest.json"), manifest);
    await verifySource(deps, manifest);
    await deps.run(
      `UPDATE match_state_control SET source_digest = ?, source_record_count = ?, source_claim_count = ?, source_bundle_count = ?, fence_digest = ?, updated_at_ms = ?
      WHERE singleton = 1 AND backend = 'rtdb' AND state = 'frozen' AND import_id = ? AND freeze_generation = ?
        AND (source_digest IS NULL OR source_digest = ?) AND ${ownerGuard()}`,
      DATABASE,
      [
        manifest.sourceDigest,
        manifest.records.length,
        manifest.claims.length,
        manifest.invites.length,
        digest(fence),
        deps.now(),
        owner.importId,
        before.freeze_generation,
        manifest.sourceDigest,
        owner.ownerToken,
        owner.importId,
      ],
    );
    if ((await control(deps)).source_digest !== manifest.sourceDigest)
      throw new Error("match-state-export-registration-unconfirmed");
    deps.log({
      operation: "export",
      sourceDigest: manifest.sourceDigest,
      records: manifest.records.length,
      claims: manifest.claims.length,
      rooms: manifest.invites.length,
    });
    return;
  }
  const manifest = readManifest(directory, owner);
  if (
    before.source_digest !== manifest.sourceDigest ||
    before.epoch + 1 !== manifest.epoch ||
    before.freeze_generation !== manifest.freezeGeneration
  )
    throw new Error("match-state-manifest-control-conflict");
  const fence = assertFenceEvidence(
    readPrivateJson(resolve(directory, "source-fence.json")),
    owner,
    before,
    deps.now(),
  );
  if (before.fence_digest !== digest(fence))
    throw new Error("match-state-fence-evidence-conflict");
  if (args.operation === "import") {
    await migrateRooms(deps, directory, owner, manifest, "import");
    await importLegacy(deps, directory, owner, manifest);
    deps.log({
      operation: "import",
      rooms: manifest.invites.length,
      records: manifest.records.length,
    });
    return;
  }
  await verifySource(deps, manifest);
  await verifyLegacy(deps, directory, owner, manifest);
  if (args.operation === "verify") {
    await migrateRooms(deps, directory, owner, manifest, "readback");
    await assertCoverage(deps, manifest, "verified");
    writePrivateImmutable(resolve(directory, "verified.json"), {
      importId: owner.importId,
      sourceDigest: manifest.sourceDigest,
      epoch: manifest.epoch,
    });
    await deps.run(
      `UPDATE match_state_control SET verified_digest = ?, verified_at_ms = ?, updated_at_ms = ?
      WHERE singleton = 1 AND ${frozenGuard()}`,
      DATABASE,
      [
        manifest.sourceDigest,
        deps.now(),
        deps.now(),
        ...frozenBindings(owner, manifest),
      ],
    );
    if ((await control(deps)).verified_digest !== manifest.sourceDigest)
      throw new Error("match-state-verification-unconfirmed");
    deps.log({
      operation: "verify",
      sourceDigest: manifest.sourceDigest,
      verified: true,
    });
    return;
  }
  if (
    args.operation !== "activate" ||
    before.verified_digest !== manifest.sourceDigest
  )
    throw new Error("match-state-activation-needs-complete-verification");
  await migrateRooms(deps, directory, owner, manifest, "activate");
  await assertCoverage(deps, manifest, "active");
  await verifySource(deps, manifest);
  assertDrained(await counts(deps));
  await assertCandidate(deps, owner);
  await deps.run(
    `UPDATE match_state_control SET backend = 'durable', epoch = epoch + 1, activated_at_ms = ?, updated_at_ms = ?
    WHERE singleton = 1 AND ${frozenGuard()} AND verified_digest = source_digest
      AND NOT EXISTS (SELECT 1 FROM match_state_write_admissions)
      AND (SELECT COUNT(*) FROM match_state_import_receipts WHERE import_id = ? AND phase = 'active') = source_bundle_count
      AND (SELECT COUNT(*) FROM match_state_routes) = source_record_count`,
    DATABASE,
    [
      deps.now(),
      deps.now(),
      ...frozenBindings(owner, manifest),
      owner.importId,
    ],
  );
  const current = await control(deps);
  if (current.backend !== "durable" || current.epoch !== manifest.epoch)
    throw new Error("match-state-activation-unconfirmed");
  writePrivateImmutable(resolve(directory, "activated.json"), {
    importId: owner.importId,
    sourceDigest: manifest.sourceDigest,
    epoch: manifest.epoch,
  });
  deps.log({
    operation: "activate",
    backend: "durable",
    state: "frozen",
    epoch: current.epoch,
  });
}

export async function executeMatchState(
  argv = process.argv.slice(2),
): Promise<void> {
  const args = parseMatchStateArgs(argv);
  const run = createWranglerRunner({ apiToken: resolveCloudflareToken() });
  const provider = createMatchStateProvider({
    run,
    firebaseCredentials: args.firebaseCredentials,
    secretFile: args.secretFile,
  });
  await manageMatchState(args, {
    run,
    ...provider,
    now: Date.now,
    log: (value) => console.log(JSON.stringify(value)),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  executeMatchState().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "match-state-operation-failed; inspect status before retrying",
    );
    process.exitCode = 1;
  });
