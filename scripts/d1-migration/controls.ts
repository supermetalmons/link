import type { D1Binding } from "../operator/configuration.ts";
import type { MigrationManifest } from "./state.ts";

type Scalar = string | number | null;
type ControlRow = Record<string, Scalar>;
type Operation = "freeze" | "resume";

export type ControlQuery = (
  databaseId: string,
  sql: string,
  params?: Scalar[],
) => Promise<Record<string, unknown>[]>;

export type DomainControlDependencies = {
  manifest: MigrationManifest;
  query: ControlQuery;
  persist: () => Promise<void>;
  activeVersionId?: string;
  now?: () => number;
  beforeControl?: (control: {
    binding: D1Binding;
    table: string;
    operation: "freeze" | "resume";
  }) => Promise<void>;
};

export type ControlTransitionRecord = {
  databaseId: string;
  before: ControlRow;
  after: ControlRow;
  changed: boolean;
  status:
    "intent" | "applied" | "preserved" | "uncertain" | "blocked" | "conflict";
  attempts: number;
  recordedAtMs: number;
  confirmedAtMs?: number;
  activeVersionId?: string;
};

export type DomainControlJournal = {
  version: 1;
  runId: string;
  controls: Record<string, Partial<Record<Operation, ControlTransitionRecord>>>;
  frozenAtMs?: number;
  resumedAtMs?: number;
};

export type DomainControlResult = {
  changed: string[];
  preserved: string[];
};

type ControlSpec = {
  binding: D1Binding;
  table: string;
  kind:
    | "profile"
    | "wager"
    | "automatch"
    | "event"
    | "telegram"
    | "withdrawal"
    | "invite"
    | "match";
};

const SPECS: readonly ControlSpec[] = [
  {
    binding: "EVENT_PRIZE_WITHDRAWALS_DB",
    table: "event_prize_withdrawal_runtime_control",
    kind: "withdrawal",
  },
  {
    binding: "PROFILE_DB",
    table: "profile_canonical_control",
    kind: "profile",
  },
  {
    binding: "PROFILE_DB",
    table: "wager_reservation_runtime_control",
    kind: "wager",
  },
  {
    binding: "PROFILE_GAMES_DB",
    table: "automatch_runtime_control",
    kind: "automatch",
  },
  { binding: "EVENT_DB", table: "event_runtime_control", kind: "event" },
  {
    binding: "TELEGRAM_DB",
    table: "telegram_runtime_control",
    kind: "telegram",
  },
  {
    binding: "PROFILE_GAMES_DB",
    table: "invite_source_control",
    kind: "invite",
  },
  { binding: "PROFILE_GAMES_DB", table: "match_state_control", kind: "match" },
];

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const BINDINGS: readonly D1Binding[] = [
  "PROFILE_DB",
  "PROFILE_GAMES_DB",
  "AUTH_STATE_DB",
  "EVENT_DB",
  "TELEGRAM_DB",
  "EVENT_PRIZE_WITHDRAWALS_DB",
];

function fail(message: string): never {
  throw new Error(`D1 migration controls: ${message}`);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid manifest record");
  return value as Record<string, unknown>;
}

function key(spec: ControlSpec): string {
  return `${spec.binding}.${spec.table}`;
}

function identifier(name: string): string {
  if (!name || name.includes("\0")) fail("invalid column name");
  return `"${name.replaceAll('"', '""')}"`;
}

function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    fail("invalid control integer");
  return value;
}

function row(value: unknown): ControlRow {
  const result: ControlRow = {};
  for (const [name, scalar] of Object.entries(object(value)).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    identifier(name);
    if (
      scalar !== null &&
      typeof scalar !== "string" &&
      !(typeof scalar === "number" && Number.isSafeInteger(scalar))
    )
      fail("control snapshot contains an unsupported value");
    result[name] = scalar as Scalar;
  }
  if (result.singleton !== 1) fail("control singleton is missing");
  return result;
}

function same(left: ControlRow, right: ControlRow): boolean {
  return JSON.stringify(row(left)) === JSON.stringify(row(right));
}

function baseline(manifest: MigrationManifest, spec: ControlSpec): ControlRow {
  const rows = manifest.controls[key(spec)];
  if (!Array.isArray(rows) || rows.length !== 1)
    fail(`missing baseline for ${key(spec)}`);
  return row(rows[0]);
}

function validateControl(spec: ControlSpec, value: ControlRow): void {
  if (spec.kind === "profile") {
    if (value.state !== "active" && value.state !== "frozen")
      fail("invalid profile state");
    return;
  }
  if (spec.kind === "invite" || spec.kind === "match") {
    if (value.backend !== (spec.kind === "invite" ? "d1" : "durable"))
      fail("legacy control authority cannot be migrated");
    if (!["active", "frozen", "draining"].includes(String(value.state)))
      fail("invalid retained control state");
    integer(value.epoch, 1);
    integer(value.freeze_generation);
    return;
  }
  if (spec.kind === "automatch") {
    if (
      value.backend !== "d1" ||
      (value.state !== "active" && value.state !== "frozen")
    )
      fail("automatch requires canonical D1 authority");
    integer(value.epoch, 1);
    integer(value.freeze_generation);
    integer(value.activated_at_ms, 1);
    for (const name of ["staged_at_ms", "imported_at_ms"])
      if (value[name] !== null) integer(value[name]);
    if (
      typeof value.candidate_version_id !== "string" ||
      !UUID.test(value.candidate_version_id) ||
      typeof value.source_digest !== "string" ||
      !value.source_digest ||
      value.source_digest !== value.import_digest
    )
      fail("automatch activation evidence is unverified");
    let metadata: Record<string, unknown>;
    try {
      metadata = object(JSON.parse(String(value.metadata_json)));
    } catch {
      fail("automatch activation metadata is unreadable");
    }
    integer(metadata.verifiedAtMs);
    if (
      typeof metadata.activationCandidateVersionId !== "string" ||
      !UUID.test(metadata.activationCandidateVersionId)
    )
      fail("automatch activation candidate is invalid");
    return;
  }
  if (value.storage_mode !== "d1" && value.storage_mode !== "frozen")
    fail("invalid finalized storage mode");
  integer(
    value.updated_at_ms,
    spec.kind === "telegram" || spec.kind === "withdrawal" ? 1 : 0,
  );
  if (spec.kind === "wager" || spec.kind === "event")
    integer(value.freeze_generation);
  if (
    spec.kind === "withdrawal" &&
    value.previous_storage_mode !==
      (value.storage_mode === "frozen" ? "d1" : null)
  )
    fail("withdrawal storage transition metadata is invalid");
}

function identities(
  manifest: MigrationManifest,
  operation: Operation,
): Map<D1Binding, string> {
  const configured = manifest.configuration.d1_databases;
  if (
    !Array.isArray(configured) ||
    configured.length !== BINDINGS.length ||
    manifest.databases.length !== BINDINGS.length
  )
    fail("captured six-database source configuration is missing");
  const sourceIds = new Set<string>();
  const destinationIds = new Set<string>();
  const bindings = new Set<string>();
  const result = new Map<D1Binding, string>();
  for (const database of manifest.databases) {
    if (
      !BINDINGS.includes(database.binding) ||
      !UUID.test(database.sourceId) ||
      sourceIds.has(database.sourceId.toLowerCase()) ||
      bindings.has(database.binding)
    )
      fail("ambiguous manifest source identity");
    bindings.add(database.binding);
    sourceIds.add(database.sourceId.toLowerCase());
    const matching = configured
      .map(object)
      .filter((entry) => entry.binding === database.binding);
    if (
      matching.length !== 1 ||
      matching[0].database_id !== database.sourceId ||
      matching[0].database_name !== database.sourceName
    )
      fail("source identity differs from captured configuration");
    if (database.destinationId) {
      if (
        !UUID.test(database.destinationId) ||
        destinationIds.has(database.destinationId.toLowerCase())
      )
        fail("ambiguous manifest destination identity");
      destinationIds.add(database.destinationId.toLowerCase());
    }
    const id =
      operation === "freeze" ? database.sourceId : database.destinationId;
    if (!id) fail("destination has not been assigned");
    result.set(database.binding, id);
  }
  if ([...sourceIds].some((id) => destinationIds.has(id)))
    fail("destination overlaps a source database");
  for (const spec of SPECS)
    if (!result.has(spec.binding)) fail("required binding is missing");
  return result;
}

function journal(manifest: MigrationManifest): DomainControlJournal {
  if (manifest.records.domainControls === undefined) {
    const value: DomainControlJournal = {
      version: 1,
      runId: manifest.runId,
      controls: {},
    };
    manifest.records.domainControls = value;
    return value;
  }
  const value = object(manifest.records.domainControls);
  if (value.version !== 1 || value.runId !== manifest.runId)
    fail("control journal belongs to another run");
  object(value.controls);
  if (value.frozenAtMs !== undefined) integer(value.frozenAtMs, 1);
  if (value.resumedAtMs !== undefined) integer(value.resumedAtMs, 1);
  return value as DomainControlJournal;
}

function timestamp(input: DomainControlDependencies): number {
  return integer((input.now || Date.now)(), 1);
}

function isFrozen(spec: ControlSpec, value: ControlRow): boolean {
  return (
    (spec.kind === "profile" || spec.kind === "automatch"
      ? value.state
      : value.storage_mode) === "frozen"
  );
}

function nextRow(
  spec: ControlSpec,
  before: ControlRow,
  operation: Operation,
  input: DomainControlDependencies,
): ControlRow {
  const after = { ...before };
  if (spec.kind === "invite" || spec.kind === "match") return after;
  if (spec.kind === "profile") {
    after.state = operation === "freeze" ? "frozen" : "active";
    return after;
  }
  if (spec.kind === "automatch") {
    after.state = operation === "freeze" ? "frozen" : "active";
    if (operation === "freeze")
      after.freeze_generation = integer(before.freeze_generation) + 1;
    else {
      if (!input.activeVersionId || !UUID.test(input.activeVersionId))
        fail("automatch resume requires the verified active Version ID");
      after.candidate_version_id = input.activeVersionId;
    }
  } else {
    after.storage_mode = operation === "freeze" ? "frozen" : "d1";
    after.updated_at_ms = timestamp(input);
    if (
      (spec.kind === "event" || spec.kind === "wager") &&
      operation === "freeze"
    )
      after.freeze_generation = integer(before.freeze_generation) + 1;
    if (spec.kind === "withdrawal")
      after.previous_storage_mode = operation === "freeze" ? "d1" : null;
  }
  validateControl(spec, after);
  return row(after);
}

async function readControl(
  input: DomainControlDependencies,
  spec: ControlSpec,
  id: string,
): Promise<ControlRow> {
  const rows = await input.query(id, `SELECT * FROM ${identifier(spec.table)}`);
  if (rows.length !== 1) fail(`control is missing or ambiguous: ${key(spec)}`);
  const current = row(rows[0]);
  validateControl(spec, current);
  return current;
}

function guards(spec: ControlSpec, operation: Operation): string[] {
  switch (spec.kind) {
    case "wager":
      return [
        "EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen')",
        ...(operation === "resume"
          ? ["NOT EXISTS (SELECT 1 FROM wager_reservation_write_admissions)"]
          : []),
      ];
    case "event":
      return ["NOT EXISTS (SELECT 1 FROM event_write_admissions)"];
    case "automatch":
      return [
        "EXISTS (SELECT 1 FROM game_session_legacy_fence WHERE singleton = 1 AND enabled = 1)",
        "NOT EXISTS (SELECT 1 FROM game_session_mutation_locks WHERE writer_generation != 2)",
        "NOT EXISTS (SELECT 1 FROM game_session_legacy_releases WHERE reconciled_at_ms IS NULL)",
        ...(operation === "resume"
          ? ["NOT EXISTS (SELECT 1 FROM automatch_write_admissions)"]
          : []),
      ];
    default:
      return [];
  }
}

async function prerequisites(
  input: DomainControlDependencies,
  spec: ControlSpec,
  id: string,
  ids: Map<D1Binding, string>,
  operation: Operation,
): Promise<void> {
  const predicates = guards(spec, operation);
  if (predicates.length) {
    const result = await input.query(
      id,
      `SELECT CASE WHEN ${predicates.join(" AND ")} THEN 'ok' ELSE 'blocked' END AS result`,
    );
    if (result.length !== 1 || result[0].result !== "ok")
      fail(`admission or writer guards block ${operation} of ${key(spec)}`);
  }
  if (spec.kind === "wager" && operation === "resume") {
    const result = await input.query(
      ids.get("PROFILE_GAMES_DB")!,
      "SELECT CAST(COUNT(*) AS TEXT) AS count FROM game_session_mutation_locks WHERE expires_at_ms > ?",
      [timestamp(input)],
    );
    if (result.length !== 1 || result[0].count !== "0")
      fail("gameplay mutation leases are not drained");
  }
}

function updateSql(
  spec: ControlSpec,
  before: ControlRow,
  after: ControlRow,
  operation: Operation,
): { sql: string; params: Scalar[] } {
  const changes = Object.entries(after).filter(
    ([name, value]) => value !== before[name],
  );
  if (!changes.length) fail("empty control transition");
  const params: Scalar[] = changes.map(([, value]) => value);
  const predicates = Object.entries(before).map(([name, value]) => {
    params.push(
      value === null ? "null" : typeof value === "number" ? "integer" : "text",
      value,
    );
    return `(typeof(${identifier(name)}) = ? AND ${identifier(name)} IS ?)`;
  });
  predicates.push(...guards(spec, operation));
  return {
    sql: `UPDATE ${identifier(spec.table)} SET ${changes.map(([name]) => `${identifier(name)} = ?`).join(", ")} WHERE ${predicates.join(" AND ")} RETURNING singleton`,
    params,
  };
}

function validateTransition(
  record: ControlTransitionRecord,
  spec: ControlSpec,
  before: ControlRow,
  id: string,
  operation: Operation,
  input: DomainControlDependencies,
  preserve: boolean,
): void {
  if (record.databaseId !== id || !same(record.before, before))
    fail("control journal identity or baseline changed");
  validateControl(spec, row(record.after));
  integer(record.attempts);
  integer(record.recordedAtMs, 1);
  if (
    ![
      "intent",
      "applied",
      "preserved",
      "uncertain",
      "blocked",
      "conflict",
    ].includes(record.status)
  )
    fail("unknown control transition status");
  if (
    operation === "resume" &&
    spec.kind === "automatch" &&
    record.changed &&
    record.after.candidate_version_id !== input.activeVersionId
  )
    fail("active automatch Version ID changed during resume");
  if (record.changed === same(record.before, record.after))
    fail("inconsistent control change journal");
  if (record.changed !== !preserve)
    fail("control change ownership differs from the baseline");
  const expectedAfter = preserve
    ? before
    : nextRow(spec, before, operation, {
        ...input,
        now: () => integer(record.after.updated_at_ms, 1),
      });
  if (!same(record.after, expectedAfter))
    fail("control journal changes an unauthorized field or generation");
}

async function transition(
  input: DomainControlDependencies,
  spec: ControlSpec,
  ids: Map<D1Binding, string>,
  state: DomainControlJournal,
  operation: Operation,
): Promise<ControlTransitionRecord> {
  const name = key(spec);
  const id = ids.get(spec.binding)!;
  const original = baseline(input.manifest, spec);
  validateControl(spec, original);
  const entry = (state.controls[name] ||= {});
  object(entry);
  const frozen = entry.freeze;
  if (
    operation === "resume" &&
    (!frozen || !["applied", "preserved"].includes(frozen.status))
  )
    fail(`freeze is unconfirmed for ${name}`);
  if (operation === "resume") {
    const sourceId = input.manifest.databases.find(
      (database) => database.binding === spec.binding,
    )!.sourceId;
    validateTransition(
      frozen!,
      spec,
      original,
      sourceId,
      "freeze",
      input,
      spec.kind === "invite" ||
        spec.kind === "match" ||
        isFrozen(spec, original),
    );
  }
  const before = operation === "freeze" ? original : row(frozen!.after);
  const preserve =
    spec.kind === "invite" ||
    spec.kind === "match" ||
    (operation === "freeze" ? isFrozen(spec, original) : !frozen!.changed);
  let record = entry[operation];
  if (record)
    validateTransition(record, spec, before, id, operation, input, preserve);
  const current = await readControl(input, spec, id);
  if (record?.status === "conflict")
    fail(`recorded control conflict requires review: ${name}`);
  if (record && same(current, record.after)) {
    if (record.changed && record.status === "blocked") {
      record.status = "conflict";
      await input.persist();
      fail(`control changed after a known rejected CAS: ${name}`);
    }
    record.status = record.changed ? "applied" : "preserved";
    record.confirmedAtMs ||= timestamp(input);
    await input.persist();
    return record;
  }
  if (!same(current, before))
    fail(`control changed outside this migration: ${name}`);
  if (record?.status === "applied" || record?.status === "preserved")
    fail("confirmed control transition was undone");
  if (!record) {
    const after = preserve ? before : nextRow(spec, before, operation, input);
    record = {
      databaseId: id,
      before,
      after,
      changed: !preserve,
      status: preserve ? "preserved" : "intent",
      attempts: 0,
      recordedAtMs: timestamp(input),
      ...(input.activeVersionId
        ? { activeVersionId: input.activeVersionId }
        : {}),
    };
    entry[operation] = record;
  }
  if (preserve) {
    record.confirmedAtMs = timestamp(input);
    await input.persist();
    return record;
  }
  await prerequisites(input, spec, id, ids, operation);
  const command = updateSql(spec, record.before, record.after, operation);
  record.status = "intent";
  record.attempts++;
  await input.persist();
  let result: Record<string, unknown>[];
  try {
    result = await input.query(id, command.sql, command.params);
  } catch (error) {
    record.status = "uncertain";
    await input.persist();
    throw error;
  }
  const applied = result.length === 1 && result[0].singleton === 1;
  if (!applied) {
    record.status = "blocked";
    await input.persist();
  }
  const observed = await readControl(input, spec, id);
  if (!applied) {
    record.status = same(observed, record.before) ? "blocked" : "conflict";
    await input.persist();
    fail(`control CAS did not apply: ${name}`);
  }
  if (!same(observed, record.after)) {
    record.status = "conflict";
    await input.persist();
    fail(`control changed after the acknowledged write: ${name}`);
  }
  record.status = "applied";
  record.confirmedAtMs = timestamp(input);
  await input.persist();
  return record;
}

async function runControls(
  input: DomainControlDependencies,
  operation: Operation,
): Promise<DomainControlResult> {
  const ids = identities(input.manifest, operation);
  if (input.activeVersionId !== undefined && !UUID.test(input.activeVersionId))
    fail("invalid active Version ID");
  for (const spec of SPECS)
    validateControl(spec, baseline(input.manifest, spec));
  const state = journal(input.manifest);
  if (operation === "resume" && state.frozenAtMs === undefined)
    fail("the complete source freeze has not been recorded");
  if (operation === "resume") {
    for (const spec of SPECS) {
      const frozen = state.controls[key(spec)]?.freeze;
      if (!frozen || !["applied", "preserved"].includes(frozen.status))
        fail(`freeze is unconfirmed for ${key(spec)}`);
      const original = baseline(input.manifest, spec);
      const sourceId = input.manifest.databases.find(
        (database) => database.binding === spec.binding,
      )!.sourceId;
      validateTransition(
        frozen,
        spec,
        original,
        sourceId,
        "freeze",
        input,
        spec.kind === "invite" ||
          spec.kind === "match" ||
          isFrozen(spec, original),
      );
      if (
        spec.kind === "automatch" &&
        frozen.changed &&
        (!input.activeVersionId || !UUID.test(input.activeVersionId))
      )
        fail("automatch resume requires the verified active Version ID");
    }
  }
  const preserved = SPECS.filter(
    (spec) => spec.kind === "invite" || spec.kind === "match",
  );
  const mutable = SPECS.filter(
    (spec) => spec.kind !== "invite" && spec.kind !== "match",
  );
  const ordered =
    operation === "freeze"
      ? [...preserved, ...mutable]
      : [
          ...preserved,
          ...mutable.filter((spec) => spec.kind !== "profile").reverse(),
          ...mutable.filter((spec) => spec.kind === "profile"),
        ];
  const result: DomainControlResult = { changed: [], preserved: [] };
  for (const spec of ordered) {
    await input.beforeControl?.({
      binding: spec.binding,
      table: spec.table,
      operation,
    });
    const record = await transition(input, spec, ids, state, operation);
    (record.changed ? result.changed : result.preserved).push(key(spec));
  }
  if (operation === "freeze") state.frozenAtMs ||= timestamp(input);
  else state.resumedAtMs ||= timestamp(input);
  await input.persist();
  return result;
}

export function freezeDomainControls(
  input: DomainControlDependencies,
): Promise<DomainControlResult> {
  return runControls(input, "freeze");
}

export function resumeDomainControls(
  input: DomainControlDependencies,
): Promise<DomainControlResult> {
  return runControls(input, "resume");
}
