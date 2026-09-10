import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  createWranglerRunner,
  resolveCloudflareToken,
  digest,
  privateDirectory,
  readPrivateJson,
  writePrivateImmutable,
  type SqlRunner,
} from "./operator/runtime.ts";

const require = createRequire(import.meta.url);

const { normalizeInviteSource } =
  require("../cloud/workers/api/src/inviteSourceD1.ts") as {
    normalizeInviteSource(value: unknown): Record<string, unknown>;
  };

const DATABASE = "mons-link-profile-games";

const EVENT_DATABASE = "mons-link-events";

const VERSION = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

const HASH = /^[a-f0-9]{64}$/;

const MAX_SOURCE_BYTES = 900_000;

type JsonRecord = Record<string, unknown>;

type Operation = "status" | "inspect-admission" | "reconcile-admission";

type Arguments = {
  operation: Operation;
  directory?: string;
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

type SourceRow = { inviteId: string; source: JsonRecord };

type StoredRow = SourceRow & { revision: number; updatedAtMs: number };

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
  readRows(inviteIds: string[]): Promise<StoredRow[]>;
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
    throw new Error("stored metadata contains retired invite fields");
  if (Buffer.byteLength(canonicalJson(source)) > MAX_SOURCE_BYTES)
    throw new Error("invite metadata exceeds the bounded D1 record size");
  return { inviteId, source };
}

function parseArgs(argv: string[]): Arguments {
  if (argv.length === 1 && argv[0] === "--status")
    return { operation: "status" };
  if (
    argv.length === 4 &&
    argv[0] === "--inspect-admission" &&
    VERSION.test(argv[1]) &&
    argv[2] === "--directory" &&
    isAbsolute(argv[3])
  )
    return {
      operation: "inspect-admission",
      admissionId: argv[1],
      directory: argv[3],
    };
  if (
    argv.length === 3 &&
    argv[0] === "--reconcile-admission" &&
    argv[1] === "--evidence" &&
    isAbsolute(argv[2])
  )
    return { operation: "reconcile-admission", evidence: argv[2] };
  throw new Error(
    "choose --status, --inspect-admission <UUID> --directory <absolute-path>, or --reconcile-admission --evidence <absolute-path>; initial invite migration commands are retired",
  );
}

function parseAdmission(value: unknown): Admission {
  const row = record(value);
  if (
    typeof row.admissionId !== "string" ||
    !VERSION.test(row.admissionId) ||
    row.backend !== "d1" ||
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
  if (
    [
      status.counts.sessionIntents,
      status.counts.sessionResources,
      status.counts.sessionLocks,
      status.counts.eventIntents,
      status.counts.eventLeases,
    ].some((value) => value !== 0)
  )
    throw new Error("invite-source work is not drained");
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
        (await dependencies.readRows([source.inviteId]))[0]?.source ?? null;
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

async function manageInviteSource(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  if (args.operation === "inspect-admission")
    return inspectAdmission(args, dependencies);
  if (args.operation === "reconcile-admission")
    return reconcileAdmission(args.evidence!, dependencies);
  if (args.operation !== "status")
    throw new Error("initial invite migration commands are retired");
  dependencies.log({
    operation: "status",
    ...(await dependencies.status()),
    admissions: await dependencies.listAdmissions(),
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
      throw new Error("invalid invite-source writer gate");
    return {
      state: state as Gate["state"],
      freezeGeneration: row.freeze_generation,
    };
  };
  if (
    invite.backend !== "d1" ||
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

function createSqlDependencies(run: SqlRunner, now = Date.now): Dependencies {
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
  return {
    now,
    log: (value) => console.log(JSON.stringify(value)),
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
  };
}

function createProductionDependencies({
  apiToken = resolveCloudflareToken(),
  fetcher = fetch,
}: { apiToken?: string; fetcher?: typeof fetch } = {}): Dependencies {
  return createSqlDependencies(createWranglerRunner({ apiToken, fetcher }));
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  await manageInviteSource(args, createProductionDependencies());
}

export {
  parseArgs,
  sourceRow,
  parseStatus,
  createSqlDependencies,
  createProductionDependencies,
  manageInviteSource,
  execute,
  type Arguments,
  type Dependencies,
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
        : "invite-source operation failed; inspect status",
    );
    process.exitCode = 1;
  });
