import { isEventPrizeId } from "@mons/shared/event-prizes";

const MAX_EVENT_TRANSACTION_ATTEMPTS = 12;
const EVENT_WRITE_ADMISSION_TTL_MS = 5 * 60 * 1_000;
const EVENT_STATUSES = new Set(["scheduled", "active", "ended", "dismissed"]);
const UTF8_ENCODER = new TextEncoder();

export type EventD1Connection = Pick<D1Database, "batch" | "prepare">;
export type EventStorageMode = "firebase" | "frozen" | "d1";
export type EventPreviousStorageMode = "firebase" | "d1" | null;
export type EventJsonRecord = Record<string, unknown>;
export type EventPrizeAssignmentRecord = {
  assignedAtMs: number;
  eventId: string;
  place: 1 | 2 | 3;
  prizeId: string;
  profileId: string;
} & EventJsonRecord;

export type EventRuntimeControl = {
  cutoverAtMs: number | null;
  freezeGeneration: number;
  previousStorageMode: EventPreviousStorageMode;
  sourceAssignmentCount: number | null;
  sourceDigest: string | null;
  sourceEventCount: number | null;
  sourceExportedAtMs: number | null;
  sourceSelectionCount: number | null;
  storageMode: EventStorageMode;
  updatedAtMs: number;
  verifiedImportGeneration: number | null;
};

export type EventWriteAdmission = {
  admissionId: string;
  expiresAtMs: number;
  storageMode: Exclude<EventStorageMode, "frozen">;
};

export type EventLeaseGuard = {
  eventId: string;
  lockId: string;
  ownerUid: string;
};

export type EventSnapshot = {
  event: EventJsonRecord | null;
  eventId: string;
  prizeSelections: Record<string, string>;
  revision: number;
};

export type ProfileEventPrizeSnapshot = {
  prizes: Record<string, EventPrizeAssignmentRecord>;
  profileId: string;
  revision: number;
};

export type EventTransitionIntent = {
  canonicalUpdates: Record<string, unknown>;
  createdAtMs: number;
  eventId: string;
  expectedRevision: number;
  rtdbEffects: Record<string, unknown>;
  schemaVersion: 1;
  transitionId: string;
  updatedAtMs: number;
};

export type EventOutboxRecord = Record<string, unknown>;

export class EventD1Failure extends Error {
  constructor(message = "event-d1-unavailable", options?: ErrorOptions) {
    super(message, options);
  }
}

export class EventD1Conflict extends EventD1Failure {
  constructor(message = "event-d1-conflict", options?: ErrorOptions) {
    super(message, options);
  }
}

export class EventWritesDisabled extends EventD1Failure {
  constructor() {
    super("event-writes-disabled");
  }
}

type EventRow = {
  event_id: string;
  pending_transition_id: string | null;
  record_json: string;
  revision: number;
  start_at_ms: number;
  status: string;
  updated_at_ms: number;
};

type AssignmentRow = {
  assignment_json: string;
  event_id: string;
  profile_id: string;
};

type RuntimeControlRow = {
  cutover_at_ms: number | null;
  freeze_generation: number;
  previous_storage_mode: string | null;
  source_assignment_count: number | null;
  source_digest: string | null;
  source_event_count: number | null;
  source_exported_at_ms: number | null;
  source_selection_count: number | null;
  storage_mode: string;
  updated_at_ms: number;
  verified_import_generation: number | null;
};

type EventMutationState = {
  current: EventJsonRecord | null;
  next: EventJsonRecord | null;
  pendingTransitionId: string | null;
  revision: number;
  selections: Record<string, string> | null;
  selectionsChanged: boolean;
};

type ProfilePrizeMutationState = {
  prizes: Record<string, EventPrizeAssignmentRecord>;
  revision: number;
};

type PathMutationOptions = {
  admission: EventWriteAdmission;
  allowStoredProfilePrizeAssignment?: boolean;
  eventLease?: EventLeaseGuard;
  expectedEventRevisions?: Readonly<Record<string, number>>;
  expectedPathValues?: Readonly<Record<string, unknown>>;
  expectedProfilePrizeRevisions?: Readonly<Record<string, number>>;
  expectedTelegramStateRevisions?: Readonly<Record<string, number>>;
  now?: () => number;
  transition?: { eventId: string; transitionId: string };
};

type PublicPathMutationOptions = Omit<
  PathMutationOptions,
  "allowStoredProfilePrizeAssignment"
>;

type PathMutationResult = {
  eventRevisions: Record<string, number>;
  profilePrizeRevisions: Record<string, number>;
};

type EventTransactionDecision =
  { commit: false; decision?: string } | { value: unknown; decision?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) || 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      !hasControlCharacter(key) && isJsonValue(entry, depth + 1),
  );
}

function exactKey(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) return "";
  const bytes = UTF8_ENCODER.encode(value).byteLength;
  return bytes > 0 &&
    bytes <= 768 &&
    ![".", "#", "$", "/", "[", "]"].some((character) =>
      value.includes(character),
    ) &&
    !hasControlCharacter(value)
    ? value
    : "";
}

function safeInteger(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new EventD1Failure("invalid-event-integer");
  }
  return value;
}

function nullableInteger(value: unknown, minimum = 0): number | null {
  return value === null || value === undefined
    ? null
    : safeInteger(value, minimum);
}

function cloneJson<T>(value: T): T {
  if (!isJsonValue(value)) throw new EventD1Failure("invalid-event-json");
  return structuredClone(value);
}

function encodeJson(value: unknown): string {
  if (!isJsonValue(value)) throw new EventD1Failure("invalid-event-json");
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new EventD1Failure("invalid-event-json", { cause: error });
  }
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") throw new EventD1Failure();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isJsonValue(parsed)) throw new EventD1Failure();
    return parsed;
  } catch (error) {
    if (error instanceof EventD1Failure) throw error;
    throw new EventD1Failure("invalid-event-json", { cause: error });
  }
}

export function validateEventAggregate(
  eventId: string,
  value: unknown,
): EventJsonRecord {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId || !isRecord(value) || !isJsonValue(value)) {
    throw new EventD1Failure("invalid-event-record");
  }
  if (
    value.eventId !== normalizedEventId ||
    !EVENT_STATUSES.has(String(value.status)) ||
    !Number.isSafeInteger(value.startAtMs) ||
    Number(value.startAtMs) < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    Number(value.updatedAtMs) < 0 ||
    !isRecord(value.participants) ||
    !isRecord(value.rounds)
  ) {
    throw new EventD1Failure("invalid-event-record");
  }
  if (Object.keys(value.participants).length > 32) {
    throw new EventD1Failure("invalid-event-record");
  }
  for (const [profileId, participant] of Object.entries(value.participants)) {
    if (!exactKey(profileId) || !isRecord(participant)) {
      throw new EventD1Failure("invalid-event-record");
    }
  }
  for (const round of Object.values(value.rounds)) {
    if (!isRecord(round)) throw new EventD1Failure("invalid-event-record");
  }
  return cloneJson(value);
}

function parseStoredEventPrizeAssignment(
  profileId: string,
  eventId: string,
  value: unknown,
): EventPrizeAssignmentRecord {
  const normalizedProfileId = exactKey(profileId);
  const normalizedEventId = exactKey(eventId);
  const prizeId = isRecord(value) ? exactKey(value.prizeId) : "";
  if (
    !normalizedProfileId ||
    !normalizedEventId ||
    !prizeId ||
    !isRecord(value) ||
    !isJsonValue(value) ||
    value.profileId !== normalizedProfileId ||
    value.eventId !== normalizedEventId ||
    (value.place !== 1 && value.place !== 2 && value.place !== 3) ||
    !Number.isSafeInteger(value.assignedAtMs) ||
    Number(value.assignedAtMs) < 0
  ) {
    throw new EventD1Failure("invalid-event-prize-assignment");
  }
  return cloneJson(value) as EventPrizeAssignmentRecord;
}

export function validateEventPrizeAssignment(
  profileId: string,
  eventId: string,
  value: unknown,
): EventPrizeAssignmentRecord {
  const assignment = parseStoredEventPrizeAssignment(profileId, eventId, value);
  if (!isEventPrizeId(assignment.eventId, assignment.prizeId)) {
    throw new EventD1Failure("invalid-event-prize-assignment");
  }
  return assignment;
}

function parseStoredPrizeSelection(value: unknown): string {
  const prizeId = exactKey(value);
  if (!prizeId) {
    throw new EventD1Failure("invalid-event-prize-selection");
  }
  return prizeId;
}

function validatePrizeSelection(eventId: string, value: unknown): string {
  const prizeId = parseStoredPrizeSelection(value);
  if (!isEventPrizeId(eventId, prizeId)) {
    throw new EventD1Failure("invalid-event-prize-selection");
  }
  return prizeId;
}

function parseEventRow(row: EventRow): EventMutationState {
  const event = validateEventAggregate(
    row.event_id,
    decodeJson(row.record_json),
  );
  if (
    event.status !== row.status ||
    event.startAtMs !== row.start_at_ms ||
    event.updatedAtMs !== row.updated_at_ms
  ) {
    throw new EventD1Failure("event-row-mismatch");
  }
  return {
    current: event,
    next: cloneJson(event),
    pendingTransitionId: row.pending_transition_id,
    revision: safeInteger(row.revision, 1),
    selections: null,
    selectionsChanged: false,
  };
}

async function readEventState(
  db: EventD1Connection,
  eventId: string,
): Promise<EventMutationState> {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId) throw new EventD1Failure("invalid-event-id");
  const row = await db
    .prepare(
      `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
              pending_transition_id, record_json
       FROM event_records WHERE event_id = ?`,
    )
    .bind(normalizedEventId)
    .first<EventRow>();
  return row
    ? parseEventRow(row)
    : {
        current: null,
        next: null,
        pendingTransitionId: null,
        revision: 0,
        selections: null,
        selectionsChanged: false,
      };
}

async function readSelections(
  db: EventD1Connection,
  eventId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .prepare(
      `SELECT profile_id, prize_id FROM event_prize_selections
       WHERE event_id = ? ORDER BY profile_id`,
    )
    .bind(eventId)
    .all<{ prize_id: string; profile_id: string }>();
  return selectionsFromRows(eventId, rows.results);
}

function selectionsFromRows(
  eventId: string,
  rows: Array<{ prize_id: string; profile_id: string }>,
): Record<string, string> {
  const selections: Record<string, string> = {};
  for (const row of rows) {
    const profileId = exactKey(row.profile_id);
    if (!profileId) throw new EventD1Failure();
    selections[profileId] = parseStoredPrizeSelection(row.prize_id);
  }
  return selections;
}

export async function readEventSnapshot(
  db: EventD1Connection,
  eventId: string,
): Promise<EventSnapshot> {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId) throw new EventD1Failure("invalid-event-id");
  const results = await db.batch([
    db
      .prepare(
        `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
                pending_transition_id, record_json
         FROM event_records WHERE event_id = ?`,
      )
      .bind(normalizedEventId),
    db
      .prepare(
        `SELECT profile_id, prize_id FROM event_prize_selections
         WHERE event_id = ? ORDER BY profile_id`,
      )
      .bind(normalizedEventId),
  ]);
  const row = results[0].results[0] as EventRow | undefined;
  if (!row) {
    return {
      event: null,
      eventId: normalizedEventId,
      prizeSelections: {},
      revision: 0,
    };
  }
  const state = parseEventRow(row);
  return {
    event: state.current!,
    eventId: normalizedEventId,
    prizeSelections: selectionsFromRows(
      normalizedEventId,
      results[1].results as Array<{ prize_id: string; profile_id: string }>,
    ),
    revision: state.revision,
  };
}

export async function listEventAggregates(
  db: EventD1Connection,
  input: {
    limit?: number;
    status?: "scheduled" | "active" | "ended" | "dismissed";
  } = {},
): Promise<Record<string, EventJsonRecord>> {
  const limit = Math.min(safeInteger(input.limit ?? 1_000, 1), 1_000);
  const rows = input.status
    ? await db
        .prepare(
          `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
                  pending_transition_id, record_json
           FROM event_records WHERE status = ?
           ORDER BY start_at_ms, event_id LIMIT ?`,
        )
        .bind(input.status, limit)
        .all<EventRow>()
    : await db
        .prepare(
          `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
                  pending_transition_id, record_json
           FROM event_records ORDER BY updated_at_ms, event_id LIMIT ?`,
        )
        .bind(limit)
        .all<EventRow>();
  return Object.fromEntries(
    rows.results.map((row) => [row.event_id, parseEventRow(row).current!]),
  );
}

export async function readProfileEventPrizes(
  db: EventD1Connection,
  profileId: string,
): Promise<ProfileEventPrizeSnapshot> {
  const normalizedProfileId = exactKey(profileId);
  if (!normalizedProfileId) throw new EventD1Failure("invalid-profile-id");
  const results = await db.batch([
    db
      .prepare(
        `SELECT profile_id, event_id, assignment_json
         FROM profile_event_prizes
         WHERE profile_id = ? ORDER BY event_id`,
      )
      .bind(normalizedProfileId),
    db
      .prepare(
        `SELECT revision FROM profile_event_prize_revisions
         WHERE profile_id = ?`,
      )
      .bind(normalizedProfileId),
  ]);
  const prizes: Record<string, EventPrizeAssignmentRecord> = {};
  for (const row of results[0].results as AssignmentRow[]) {
    prizes[row.event_id] = parseStoredEventPrizeAssignment(
      normalizedProfileId,
      row.event_id,
      decodeJson(row.assignment_json),
    );
  }
  const revisionRow = results[1].results[0] as { revision: number } | undefined;
  return {
    prizes,
    profileId: normalizedProfileId,
    revision: revisionRow ? safeInteger(revisionRow.revision, 1) : 0,
  };
}

function parseRuntimeControl(
  row: RuntimeControlRow | null,
): EventRuntimeControl {
  if (!row) throw new EventD1Failure("event-runtime-control-unavailable");
  const storageMode = row.storage_mode;
  const previousStorageMode = row.previous_storage_mode;
  if (
    (storageMode !== "firebase" &&
      storageMode !== "frozen" &&
      storageMode !== "d1") ||
    (previousStorageMode !== null &&
      previousStorageMode !== "firebase" &&
      previousStorageMode !== "d1") ||
    (storageMode === "frozen"
      ? previousStorageMode === null
      : previousStorageMode !== null)
  ) {
    throw new EventD1Failure("invalid-event-runtime-control");
  }
  if (row.source_digest !== null && !/^[a-f0-9]{64}$/.test(row.source_digest)) {
    throw new EventD1Failure("invalid-event-runtime-control");
  }
  return {
    cutoverAtMs: nullableInteger(row.cutover_at_ms, 1),
    freezeGeneration: safeInteger(row.freeze_generation),
    previousStorageMode,
    sourceAssignmentCount: nullableInteger(row.source_assignment_count),
    sourceDigest: row.source_digest,
    sourceEventCount: nullableInteger(row.source_event_count),
    sourceExportedAtMs: nullableInteger(row.source_exported_at_ms, 1),
    sourceSelectionCount: nullableInteger(row.source_selection_count),
    storageMode,
    updatedAtMs: safeInteger(row.updated_at_ms),
    verifiedImportGeneration: nullableInteger(
      row.verified_import_generation,
      1,
    ),
  };
}

export async function readEventRuntimeControl(
  db: EventD1Connection,
): Promise<EventRuntimeControl> {
  const row = await db
    .prepare("SELECT * FROM event_runtime_control WHERE singleton = 1")
    .first<RuntimeControlRow>();
  return parseRuntimeControl(row);
}

export async function assertEventWritesAllowed(
  db: EventD1Connection,
): Promise<void> {
  if ((await readEventRuntimeControl(db)).storageMode === "frozen") {
    throw new EventWritesDisabled();
  }
}

export async function acquireEventWriteAdmission(
  db: EventD1Connection,
  input: {
    admissionId?: string;
    nowMs?: number;
    ttlMs?: number;
  } = {},
): Promise<EventWriteAdmission> {
  const admissionId = exactKey(
    input.admissionId || `ewa_${crypto.randomUUID()}`,
  );
  const nowMs = safeInteger(input.nowMs ?? Date.now());
  const ttlMs = safeInteger(input.ttlMs ?? EVENT_WRITE_ADMISSION_TTL_MS, 1);
  if (!admissionId || nowMs + ttlMs > Number.MAX_SAFE_INTEGER) {
    throw new EventD1Failure("invalid-event-write-admission");
  }
  const result = await db
    .prepare(
      `INSERT INTO event_write_admissions (
         admission_id, admitted_storage_mode, created_at_ms, expires_at_ms
       )
       SELECT ?, storage_mode, ?, ?
       FROM event_runtime_control
       WHERE singleton = 1 AND storage_mode IN ('firebase', 'd1')
       RETURNING admitted_storage_mode`,
    )
    .bind(admissionId, nowMs, nowMs + ttlMs)
    .all<{ admitted_storage_mode: string }>();
  const storageMode = result.results[0]?.admitted_storage_mode;
  if (storageMode !== "firebase" && storageMode !== "d1") {
    throw new EventWritesDisabled();
  }
  return { admissionId, expiresAtMs: nowMs + ttlMs, storageMode };
}

export async function releaseEventWriteAdmission(
  db: EventD1Connection,
  admission: Pick<EventWriteAdmission, "admissionId">,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM event_write_admissions WHERE admission_id = ?")
    .bind(exactKey(admission.admissionId))
    .run();
  return result.meta.changes === 1;
}

function sameControlIdentity(
  left: Pick<EventRuntimeControl, "storageMode" | "previousStorageMode">,
  right: Pick<EventRuntimeControl, "storageMode" | "previousStorageMode">,
): boolean {
  return (
    left.storageMode === right.storageMode &&
    left.previousStorageMode === right.previousStorageMode
  );
}

export async function transitionEventStorageMode(
  db: EventD1Connection,
  input: {
    expected: Pick<EventRuntimeControl, "storageMode" | "previousStorageMode">;
    next: Pick<EventRuntimeControl, "storageMode" | "previousStorageMode">;
    cutoverAtMs?: number | null;
    nowMs: number;
  },
): Promise<EventRuntimeControl> {
  safeInteger(input.nowMs, 1);
  const changed = await db
    .prepare(
      `UPDATE event_runtime_control
       SET storage_mode = ?, previous_storage_mode = ?,
           cutover_at_ms = COALESCE(?, cutover_at_ms),
           freeze_generation = CASE
             WHEN storage_mode != 'frozen' AND ? = 'frozen'
             THEN freeze_generation + 1
             ELSE freeze_generation
           END,
           verified_import_generation = CASE
             WHEN storage_mode != 'frozen' AND ? = 'frozen' THEN NULL
             WHEN storage_mode = 'frozen' AND previous_storage_mode = 'firebase'
                  AND ? = 'firebase' THEN NULL
             ELSE verified_import_generation
           END,
           updated_at_ms = ?
       WHERE singleton = 1 AND storage_mode = ?
         AND previous_storage_mode IS ?`,
    )
    .bind(
      input.next.storageMode,
      input.next.previousStorageMode,
      input.cutoverAtMs ?? null,
      input.next.storageMode,
      input.next.storageMode,
      input.next.storageMode,
      input.nowMs,
      input.expected.storageMode,
      input.expected.previousStorageMode,
    )
    .run();
  if (changed.meta.changes !== 1) throw new EventD1Conflict();
  const control = await readEventRuntimeControl(db);
  if (!sameControlIdentity(control, input.next)) throw new EventD1Conflict();
  return control;
}

export async function writeEventImportMetadata(
  db: EventD1Connection,
  input: {
    expectedStorageMode: EventStorageMode;
    sourceAssignmentCount: number;
    sourceDigest: string;
    sourceEventCount: number;
    sourceExportedAtMs: number;
    sourceSelectionCount: number;
    nowMs: number;
  },
): Promise<EventRuntimeControl> {
  if (!/^[a-f0-9]{64}$/.test(input.sourceDigest)) {
    throw new EventD1Failure("invalid-event-source-digest");
  }
  safeInteger(input.sourceAssignmentCount);
  safeInteger(input.sourceEventCount);
  safeInteger(input.sourceExportedAtMs, 1);
  safeInteger(input.sourceSelectionCount);
  safeInteger(input.nowMs, 1);
  const updated = await db
    .prepare(
      `UPDATE event_runtime_control
       SET source_digest = ?, source_event_count = ?,
           source_selection_count = ?, source_assignment_count = ?,
           source_exported_at_ms = ?, verified_import_generation = NULL,
           updated_at_ms = ?
       WHERE singleton = 1 AND storage_mode = ?`,
    )
    .bind(
      input.sourceDigest,
      input.sourceEventCount,
      input.sourceSelectionCount,
      input.sourceAssignmentCount,
      input.sourceExportedAtMs,
      input.nowMs,
      input.expectedStorageMode,
    )
    .run();
  if (updated.meta.changes !== 1) throw new EventD1Conflict();
  return readEventRuntimeControl(db);
}

export async function markEventImportVerified(
  db: EventD1Connection,
  input: {
    expectedFreezeGeneration: number;
    sourceDigest: string;
    nowMs: number;
  },
): Promise<EventRuntimeControl> {
  const freezeGeneration = safeInteger(input.expectedFreezeGeneration, 1);
  const nowMs = safeInteger(input.nowMs, 1);
  if (!/^[a-f0-9]{64}$/.test(input.sourceDigest)) {
    throw new EventD1Failure("invalid-event-source-digest");
  }
  const updated = await db
    .prepare(
      `UPDATE event_runtime_control
       SET verified_import_generation = freeze_generation, updated_at_ms = ?
       WHERE singleton = 1
         AND storage_mode = 'frozen'
         AND previous_storage_mode = 'firebase'
         AND freeze_generation = ?
         AND source_digest = ?
         AND NOT EXISTS (
           SELECT 1 FROM event_write_admissions
         )`,
    )
    .bind(nowMs, freezeGeneration, input.sourceDigest)
    .run();
  if (updated.meta.changes !== 1) throw new EventD1Conflict();
  return readEventRuntimeControl(db);
}

function guardStatement(
  db: EventD1Connection,
  failurePredicate: string,
  values: unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO event_transaction_guards (singleton)
       SELECT 0 WHERE ${failurePredicate}`,
    )
    .bind(...values);
}

function eventWriteAdmissionGuard(
  db: EventD1Connection,
  admission: EventWriteAdmission,
): D1PreparedStatement {
  return guardStatement(
    db,
    `NOT EXISTS (
       SELECT 1
       FROM event_write_admissions AS admission
       JOIN event_runtime_control AS control ON control.singleton = 1
       WHERE admission.admission_id = ?
         AND admission.admitted_storage_mode = 'd1'
         AND control.storage_mode = 'd1'
     )`,
    [admission.admissionId],
  );
}

function eventLeaseGuard(
  db: EventD1Connection,
  lease: EventLeaseGuard,
): D1PreparedStatement {
  const eventId = exactKey(lease.eventId);
  const lockId = exactKey(lease.lockId);
  const ownerUid = exactKey(lease.ownerUid);
  if (!eventId || !lockId || !ownerUid) {
    throw new EventD1Failure("invalid-event-lease-guard");
  }
  return guardStatement(
    db,
    `NOT EXISTS (
       SELECT 1 FROM event_leases
       WHERE event_id = ? AND lease_id = ? AND owner_uid = ?
         AND expires_at_ms > CAST(
           (julianday('now') - 2440587.5) * 86400000 AS INTEGER
         )
     )`,
    [eventId, lockId, ownerUid],
  );
}

function isConstraintFailure(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : "";
  return /constraint|event_transaction_guards|event transition|event pending|foreign key/i.test(
    message,
  );
}

function splitPath(path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !part))
    throw new EventD1Failure("invalid-event-path");
  return parts;
}

function getNested(root: unknown, parts: readonly string[]): unknown {
  let current = root;
  for (const part of parts) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return null;
    current = current[part];
  }
  return cloneJson(current);
}

function setNested(
  root: Record<string, unknown>,
  parts: readonly string[],
  value: unknown,
): void {
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const existing = current[part];
    if (!isRecord(existing)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  const key = parts.at(-1);
  if (!key) throw new EventD1Failure("invalid-event-path");
  if (value === null) delete current[key];
  else current[key] = cloneJson(value);
}

async function getEventMutationState(
  db: EventD1Connection,
  states: Map<string, EventMutationState>,
  eventId: string,
): Promise<EventMutationState> {
  let state = states.get(eventId);
  if (!state) {
    state = await readEventState(db, eventId);
    states.set(eventId, state);
  }
  return state;
}

async function ensureSelections(
  db: EventD1Connection,
  eventId: string,
  state: EventMutationState,
): Promise<Record<string, string>> {
  state.selections ??= await readSelections(db, eventId);
  return state.selections;
}

async function readProfilePrizeMutationState(
  db: EventD1Connection,
  profileId: string,
): Promise<ProfilePrizeMutationState> {
  const snapshot = await readProfileEventPrizes(db, profileId);
  return { prizes: snapshot.prizes, revision: snapshot.revision };
}

function eventRevisionGuard(
  db: EventD1Connection,
  eventId: string,
  expectedRevision: number,
): D1PreparedStatement {
  return expectedRevision === 0
    ? guardStatement(
        db,
        "EXISTS (SELECT 1 FROM event_records WHERE event_id = ?)",
        [eventId],
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM event_records WHERE event_id = ? AND revision = ?
         )`,
        [eventId, expectedRevision],
      );
}

function profileRevisionGuard(
  db: EventD1Connection,
  profileId: string,
  expectedRevision: number,
): D1PreparedStatement {
  return expectedRevision === 0
    ? guardStatement(
        db,
        `EXISTS (
           SELECT 1 FROM profile_event_prize_revisions WHERE profile_id = ?
         )`,
        [profileId],
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM profile_event_prize_revisions
           WHERE profile_id = ? AND revision = ?
         )`,
        [profileId, expectedRevision],
      );
}

function recordJsonGuard(
  db: EventD1Connection,
  table:
    | "event_progress_outboxes"
    | "event_profile_game_projection_outboxes"
    | "event_telegram_projection_outboxes",
  recordId: string,
  expected: unknown,
  status?: "dead" | "pending",
): D1PreparedStatement {
  const keyColumn =
    table === "event_progress_outboxes" ? "outbox_id" : "event_id";
  const statusPredicate = status ? " AND status = ?" : "";
  const keyValues = status ? [recordId, status] : [recordId];
  return expected === null
    ? guardStatement(
        db,
        `EXISTS (
           SELECT 1 FROM ${table}
           WHERE ${keyColumn} = ?${statusPredicate}
         )`,
        keyValues,
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM ${table}
           WHERE ${keyColumn} = ?${statusPredicate} AND record_json = ?
         )`,
        [...keyValues, encodeJson(expected)],
      );
}

function telegramStateRevisionGuard(
  db: EventD1Connection,
  eventId: string,
  expectedRevision: number,
): D1PreparedStatement {
  return expectedRevision === 0
    ? guardStatement(
        db,
        "EXISTS (SELECT 1 FROM event_telegram_projection_state WHERE event_id = ?)",
        [eventId],
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM event_telegram_projection_state
           WHERE event_id = ? AND revision = ?
         )`,
        [eventId, expectedRevision],
      );
}

function eventRecordStatement(
  db: EventD1Connection,
  eventId: string,
  state: EventMutationState,
  pendingTransitionId: string | null,
): D1PreparedStatement {
  if (!state.next) {
    return db
      .prepare("DELETE FROM event_records WHERE event_id = ?")
      .bind(eventId);
  }
  const event = validateEventAggregate(eventId, state.next);
  return db
    .prepare(
      `INSERT INTO event_records (
         event_id, status, start_at_ms, updated_at_ms, revision,
         pending_transition_id, record_json
       ) VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET
         status = excluded.status,
         start_at_ms = excluded.start_at_ms,
         updated_at_ms = excluded.updated_at_ms,
         revision = event_records.revision + 1,
         pending_transition_id = excluded.pending_transition_id,
         record_json = excluded.record_json`,
    )
    .bind(
      eventId,
      event.status,
      event.startAtMs,
      event.updatedAtMs,
      pendingTransitionId,
      encodeJson(event),
    );
}

async function patchEventOwnedPathsInternal(
  db: EventD1Connection,
  updates: Readonly<Record<string, unknown>>,
  options: PathMutationOptions,
): Promise<PathMutationResult> {
  const now = options.now || Date.now;
  const nowMs = safeInteger(now());
  const eventStates = new Map<string, EventMutationState>();
  const profileStates = new Map<string, ProfilePrizeMutationState>();
  const progressUpdates = new Map<string, unknown>();
  const progressDeadUpdates = new Map<string, unknown>();
  const profileProjectionUpdates = new Map<string, unknown>();
  const telegramProjectionUpdates = new Map<string, unknown>();
  const telegramStateUpdates = new Map<
    string,
    { generation?: unknown; state?: unknown }
  >();

  for (const [path, value] of Object.entries(updates)) {
    const parts = splitPath(path);
    if (parts[0] === "events" && parts.length >= 2) {
      const eventId = exactKey(parts[1]);
      if (!eventId) throw new EventD1Failure("invalid-event-path");
      const state = await getEventMutationState(db, eventStates, eventId);
      if (parts.length === 2) {
        if (value === null) {
          throw new EventD1Failure("event-deletion-unsupported");
        }
        state.next = validateEventAggregate(eventId, value);
      } else {
        if (!state.next) throw new EventD1Conflict("event-not-found");
        setNested(state.next, parts.slice(2), value);
      }
      continue;
    }
    if (parts[0] === "eventPrizeSelections" && parts.length >= 2) {
      const eventId = exactKey(parts[1]);
      if (!eventId) throw new EventD1Failure("invalid-event-path");
      const state = await getEventMutationState(db, eventStates, eventId);
      if (!state.next) throw new EventD1Conflict("event-not-found");
      const selections = await ensureSelections(db, eventId, state);
      if (parts.length === 2) {
        const replacement = value === null ? {} : value;
        if (!isRecord(replacement)) {
          throw new EventD1Failure("invalid-event-prize-selections");
        }
        state.selections = Object.fromEntries(
          Object.entries(replacement).map(([profileId, prizeId]) => {
            const normalizedProfileId = exactKey(profileId);
            if (!normalizedProfileId) {
              throw new EventD1Failure("invalid-event-prize-selection");
            }
            return [
              normalizedProfileId,
              validatePrizeSelection(eventId, prizeId),
            ];
          }),
        );
      } else if (parts.length === 3) {
        const profileId = exactKey(parts[2]);
        if (!profileId) throw new EventD1Failure("invalid-event-path");
        if (value === null) delete selections[profileId];
        else selections[profileId] = validatePrizeSelection(eventId, value);
      } else {
        throw new EventD1Failure("invalid-event-path");
      }
      state.selectionsChanged = true;
      continue;
    }
    if (parts[0] === "profileEventPrizes" && parts.length >= 2) {
      const profileId = exactKey(parts[1]);
      if (!profileId) throw new EventD1Failure("invalid-event-path");
      let state = profileStates.get(profileId);
      if (!state) {
        state = await readProfilePrizeMutationState(db, profileId);
        profileStates.set(profileId, state);
      }
      if (parts.length === 2) {
        const replacement = value === null ? {} : value;
        if (!isRecord(replacement)) {
          throw new EventD1Failure("invalid-profile-event-prizes");
        }
        state.prizes = Object.fromEntries(
          Object.entries(replacement).map(([eventId, assignment]) => [
            eventId,
            validateEventPrizeAssignment(profileId, eventId, assignment),
          ]),
        );
      } else if (parts.length === 3) {
        const eventId = exactKey(parts[2]);
        if (!eventId) throw new EventD1Failure("invalid-event-path");
        if (value === null) delete state.prizes[eventId];
        else {
          state.prizes[eventId] = options.allowStoredProfilePrizeAssignment
            ? parseStoredEventPrizeAssignment(profileId, eventId, value)
            : validateEventPrizeAssignment(profileId, eventId, value);
        }
      } else {
        throw new EventD1Failure("invalid-event-path");
      }
      continue;
    }
    if (parts[0] === "eventProgressOutbox" && parts.length >= 2) {
      const outboxId = exactKey(parts[1]);
      if (!outboxId) throw new EventD1Failure("invalid-event-path");
      if (parts.length === 2) {
        progressUpdates.set(outboxId, value);
      } else {
        const current = await readEventProgressOutbox(db, outboxId);
        if (!current) throw new EventD1Conflict("event-progress-not-found");
        const next = cloneJson(current);
        setNested(next, parts.slice(2), value);
        progressUpdates.set(outboxId, next);
      }
      continue;
    }
    if (parts[0] === "eventProgressOutboxDead" && parts.length === 2) {
      const outboxId = exactKey(parts[1]);
      if (!outboxId) throw new EventD1Failure("invalid-event-path");
      progressDeadUpdates.set(outboxId, value);
      continue;
    }
    if (
      parts[0] === "profileGameProjectionOutbox" &&
      parts[1] === "event" &&
      parts.length >= 3
    ) {
      const eventId = exactKey(parts[2]);
      if (!eventId) throw new EventD1Failure("invalid-event-path");
      if (parts.length === 3) {
        profileProjectionUpdates.set(eventId, value);
      } else {
        const stored = profileProjectionUpdates.has(eventId)
          ? profileProjectionUpdates.get(eventId)
          : await readEventProfileGameProjectionOutbox(db, eventId);
        const next = isRecord(stored) ? cloneJson(stored) : {};
        setNested(next, parts.slice(3), value);
        profileProjectionUpdates.set(eventId, next);
      }
      continue;
    }
    if (
      parts[0] === "telegramProjectionOutbox" &&
      parts[1] === "event" &&
      parts.length === 3
    ) {
      const eventId = exactKey(parts[2]);
      if (!eventId) throw new EventD1Failure("invalid-event-path");
      telegramProjectionUpdates.set(eventId, value);
      continue;
    }
    if (
      (parts[0] === "eventTelegramProjectionGenerations" ||
        parts[0] === "eventTelegramProjections") &&
      parts.length === 2
    ) {
      const eventId = exactKey(parts[1]);
      if (!eventId) throw new EventD1Failure("invalid-event-path");
      const update = telegramStateUpdates.get(eventId) || {};
      if (parts[0] === "eventTelegramProjectionGenerations") {
        update.generation = value;
      } else {
        update.state = value;
      }
      telegramStateUpdates.set(eventId, update);
      continue;
    }
    throw new EventD1Failure("unsupported-event-path");
  }

  if (options.transition) {
    const transitionEventId = exactKey(options.transition.eventId);
    const transitionId = exactKey(options.transition.transitionId);
    if (!transitionEventId || !transitionId) {
      throw new EventD1Failure("invalid-event-transition");
    }
    const state = await getEventMutationState(
      db,
      eventStates,
      transitionEventId,
    );
    if (state.pendingTransitionId !== transitionId) {
      throw new EventD1Conflict("event-transition-not-owned");
    }
  }

  const guards: D1PreparedStatement[] = [];
  const mutations: D1PreparedStatement[] = [];
  const eventRevisions: Record<string, number> = {};
  const profilePrizeRevisions: Record<string, number> = {};

  if (options.admission.storageMode !== "d1") {
    throw new EventD1Conflict("event-write-admission-mode-mismatch");
  }
  guards.push(eventWriteAdmissionGuard(db, options.admission));
  if (options.eventLease) {
    guards.push(eventLeaseGuard(db, options.eventLease));
  }

  for (const [eventId, state] of eventStates) {
    if (
      state.pendingTransitionId &&
      (options.transition?.eventId !== eventId ||
        options.transition.transitionId !== state.pendingTransitionId)
    ) {
      throw new EventD1Conflict("event-transition-pending");
    }
    const expected =
      options.expectedEventRevisions?.[eventId] ?? state.revision;
    if (expected !== state.revision) throw new EventD1Conflict();
    guards.push(eventRevisionGuard(db, eventId, expected));
    const transitionApplies = options.transition?.eventId === eventId;
    if (transitionApplies) {
      guards.push(
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM event_transition_intents
             WHERE transition_id = ? AND event_id = ?
               AND expected_revision = ? AND status = 'pending'
           )`,
          [options.transition!.transitionId, eventId, expected],
        ),
      );
    }
    mutations.push(
      eventRecordStatement(
        db,
        eventId,
        state,
        transitionApplies ? null : state.pendingTransitionId,
      ),
    );
    if (state.selectionsChanged) {
      mutations.push(
        db
          .prepare("DELETE FROM event_prize_selections WHERE event_id = ?")
          .bind(eventId),
      );
      for (const [profileId, prizeId] of Object.entries(
        state.selections || {},
      )) {
        mutations.push(
          db
            .prepare(
              `INSERT INTO event_prize_selections (
                 event_id, profile_id, prize_id, updated_at_ms
               ) VALUES (?, ?, ?, ?)`,
            )
            .bind(eventId, profileId, prizeId, nowMs),
        );
      }
    }
    eventRevisions[eventId] = state.revision + 1;
  }

  for (const [profileId, state] of profileStates) {
    const expected =
      options.expectedProfilePrizeRevisions?.[profileId] ?? state.revision;
    if (expected !== state.revision) throw new EventD1Conflict();
    guards.push(profileRevisionGuard(db, profileId, expected));
    mutations.push(
      db
        .prepare("DELETE FROM profile_event_prizes WHERE profile_id = ?")
        .bind(profileId),
    );
    for (const [eventId, assignment] of Object.entries(state.prizes)) {
      mutations.push(
        db
          .prepare(
            `INSERT INTO profile_event_prizes (
               profile_id, event_id, assignment_json, updated_at_ms
             ) VALUES (?, ?, ?, ?)`,
          )
          .bind(profileId, eventId, encodeJson(assignment), nowMs),
      );
    }
    mutations.push(
      db
        .prepare(
          `INSERT INTO profile_event_prize_revisions (
             profile_id, revision, updated_at_ms
           ) VALUES (?, 1, ?)
           ON CONFLICT (profile_id) DO UPDATE SET
             revision = profile_event_prize_revisions.revision + 1,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(profileId, nowMs),
    );
    profilePrizeRevisions[profileId] = state.revision + 1;
  }

  for (const [outboxId, raw] of progressUpdates) {
    const path = `eventProgressOutbox/${outboxId}`;
    if (Object.hasOwn(options.expectedPathValues || {}, path)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_progress_outboxes",
          outboxId,
          options.expectedPathValues![path],
          "pending",
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            `DELETE FROM event_progress_outboxes
             WHERE outbox_id = ? AND status = 'pending'`,
          )
          .bind(outboxId),
      );
      continue;
    }
    const record = validateEventProgressOutbox(outboxId, raw);
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_progress_outboxes (
             outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
             record_json
           ) VALUES (?, ?, 'pending', ?, ?, ?)
           ON CONFLICT (status, outbox_id) DO UPDATE SET
             event_id = excluded.event_id,
             status = 'pending',
             run_at_ms = excluded.run_at_ms,
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          outboxId,
          record.eventId,
          record.runAtMs,
          record.lastQueuedAtMs,
          encodeJson(record),
        ),
    );
  }

  for (const [outboxId, raw] of progressDeadUpdates) {
    const path = `eventProgressOutboxDead/${outboxId}`;
    if (Object.hasOwn(options.expectedPathValues || {}, path)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_progress_outboxes",
          outboxId,
          options.expectedPathValues![path],
          "dead",
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'dead'",
          )
          .bind(outboxId),
      );
      continue;
    }
    if (!isRecord(raw) || !isJsonValue(raw)) {
      throw new EventD1Failure("invalid-event-progress-dead-letter");
    }
    const original = isRecord(raw.originalRecord) ? raw.originalRecord : null;
    const eventId = original ? exactKey(original.eventId) : "";
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_progress_outboxes (
             outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
             record_json
           ) VALUES (?, (
             SELECT event_id FROM event_records WHERE event_id = ?
           ), 'dead', NULL, ?, ?)
           ON CONFLICT (status, outbox_id) DO UPDATE SET
             event_id = excluded.event_id,
             status = 'dead',
             run_at_ms = NULL,
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          outboxId,
          eventId || null,
          safeInteger(raw.deadAtMs),
          encodeJson(raw),
        ),
    );
  }

  for (const [eventId, raw] of profileProjectionUpdates) {
    const path = `profileGameProjectionOutbox/event/${eventId}`;
    if (Object.hasOwn(options.expectedPathValues || {}, path)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_profile_game_projection_outboxes",
          eventId,
          options.expectedPathValues![path],
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_profile_game_projection_outboxes WHERE event_id = ?",
          )
          .bind(eventId),
      );
      continue;
    }
    const record = validateProjectionOutbox("profile-game", eventId, raw);
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_profile_game_projection_outboxes (
             event_id, request_id, status, last_queued_at_ms, record_json
           ) VALUES (?, ?, 'pending', ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             request_id = excluded.request_id,
             status = 'pending',
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          eventId,
          record.requestId,
          record.lastQueuedAtMs,
          encodeJson(record.raw),
        ),
    );
  }

  for (const [eventId, raw] of telegramProjectionUpdates) {
    const path = `telegramProjectionOutbox/event/${eventId}`;
    if (Object.hasOwn(options.expectedPathValues || {}, path)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_telegram_projection_outboxes",
          eventId,
          options.expectedPathValues![path],
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_telegram_projection_outboxes WHERE event_id = ?",
          )
          .bind(eventId),
      );
      continue;
    }
    const record = validateProjectionOutbox("telegram", eventId, raw);
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_telegram_projection_outboxes (
             event_id, request_id, status, first_queued_at_ms, updated_at_ms,
             record_json
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             request_id = excluded.request_id,
             status = excluded.status,
             first_queued_at_ms = excluded.first_queued_at_ms,
             updated_at_ms = excluded.updated_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          eventId,
          record.requestId,
          record.status,
          record.firstQueuedAtMs,
          record.updatedAtMs,
          encodeJson(record.raw),
        ),
    );
  }

  for (const [eventId, update] of telegramStateUpdates) {
    const current = await readEventTelegramProjectionState(db, eventId);
    const currentRevision = current?.revision || 0;
    const expectedRevision =
      options.expectedTelegramStateRevisions?.[eventId] ?? currentRevision;
    if (expectedRevision !== currentRevision) throw new EventD1Conflict();
    guards.push(telegramStateRevisionGuard(db, eventId, expectedRevision));
    let generation = current?.generation || 0;
    let state = current?.state || {};
    if (update.generation !== undefined) {
      const increment = isRecord(update.generation)
        ? isRecord(update.generation[".sv"])
          ? update.generation[".sv"].increment
          : undefined
        : undefined;
      generation =
        increment === undefined
          ? safeInteger(update.generation)
          : generation + safeInteger(increment);
    }
    if (update.state !== undefined) {
      if (update.state === null) {
        mutations.push(
          db
            .prepare(
              "DELETE FROM event_telegram_projection_state WHERE event_id = ?",
            )
            .bind(eventId),
        );
        continue;
      }
      if (!isRecord(update.state) || !isJsonValue(update.state)) {
        throw new EventD1Failure("invalid-event-telegram-projection-state");
      }
      state = cloneJson(update.state);
    }
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_telegram_projection_state (
             event_id, generation, revision, state_json, updated_at_ms
           ) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             generation = excluded.generation,
             revision = event_telegram_projection_state.revision + 1,
             state_json = excluded.state_json,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(eventId, generation, encodeJson(state), nowMs),
    );
  }

  if (options.transition) {
    mutations.push(
      db
        .prepare(
          `DELETE FROM event_transition_intents
           WHERE transition_id = ? AND event_id = ? AND status = 'pending'`,
        )
        .bind(options.transition.transitionId, options.transition.eventId),
    );
  }
  if (mutations.length === 0) return { eventRevisions, profilePrizeRevisions };
  try {
    await db.batch([...guards, ...mutations]);
  } catch (error) {
    if (isConstraintFailure(error)) {
      throw new EventD1Conflict("event-d1-conflict", { cause: error });
    }
    throw error;
  }
  return { eventRevisions, profilePrizeRevisions };
}

export function patchEventOwnedPaths(
  db: EventD1Connection,
  updates: Readonly<Record<string, unknown>>,
  options: PublicPathMutationOptions,
): Promise<PathMutationResult> {
  return patchEventOwnedPathsInternal(db, updates, options);
}

export async function readEventOwnedPath(
  db: EventD1Connection,
  path: string,
): Promise<unknown> {
  const parts = splitPath(path);
  if (parts[0] === "events" && parts.length >= 2) {
    const snapshot = await readEventSnapshot(db, parts[1]);
    return parts.length === 2
      ? snapshot.event
      : getNested(snapshot.event, parts.slice(2));
  }
  if (parts[0] === "eventPrizeSelections" && parts.length >= 2) {
    const snapshot = await readEventSnapshot(db, parts[1]);
    return parts.length === 2
      ? snapshot.prizeSelections
      : getNested(snapshot.prizeSelections, parts.slice(2));
  }
  if (parts[0] === "profileEventPrizes" && parts.length >= 2) {
    const snapshot = await readProfileEventPrizes(db, parts[1]);
    return parts.length === 2
      ? snapshot.prizes
      : getNested(snapshot.prizes, parts.slice(2));
  }
  if (parts[0] === "eventProgressOutbox" && parts.length >= 2) {
    const record = await readEventProgressOutbox(db, parts[1]);
    return parts.length === 2 ? record : getNested(record, parts.slice(2));
  }
  if (parts[0] === "eventProgressOutboxDead" && parts.length === 2) {
    const row = await db
      .prepare(
        `SELECT record_json FROM event_progress_outboxes
         WHERE outbox_id = ? AND status = 'dead'`,
      )
      .bind(parts[1])
      .first<{ record_json: string }>();
    return row ? decodeJson(row.record_json) : null;
  }
  if (
    parts[0] === "profileGameProjectionOutbox" &&
    parts[1] === "event" &&
    parts.length === 3
  ) {
    return readEventProfileGameProjectionOutbox(db, parts[2]);
  }
  if (
    parts[0] === "telegramProjectionOutbox" &&
    parts[1] === "event" &&
    parts.length === 3
  ) {
    return readEventTelegramProjectionOutbox(db, parts[2]);
  }
  if (parts[0] === "eventTelegramProjectionGenerations" && parts.length === 2) {
    return (
      (await readEventTelegramProjectionState(db, parts[1]))?.generation || 0
    );
  }
  if (parts[0] === "eventTelegramProjections" && parts.length === 2) {
    return (
      (await readEventTelegramProjectionState(db, parts[1]))?.state || null
    );
  }
  if (parts[0] === "eventLocks" && parts.length === 2) {
    const row = await db
      .prepare(
        `SELECT lease_id, owner_uid, acquired_at_ms, refreshed_at_ms,
                expires_at_ms FROM event_leases WHERE event_id = ?`,
      )
      .bind(parts[1])
      .first<{
        acquired_at_ms: number;
        expires_at_ms: number;
        lease_id: string;
        owner_uid: string;
        refreshed_at_ms: number;
      }>();
    return row
      ? {
          lockId: row.lease_id,
          ownerUid: row.owner_uid,
          acquiredAtMs: row.acquired_at_ms,
          refreshedAtMs: row.refreshed_at_ms,
          expiresAtMs: row.expires_at_ms,
        }
      : null;
  }
  if (parts[0] === "eventSyncThrottles" && parts.length === 2) {
    const row = await db
      .prepare(
        `SELECT owner_uid, token, started_at_ms
         FROM event_sync_throttles WHERE event_id = ?`,
      )
      .bind(parts[1])
      .first<{ owner_uid: string; started_at_ms: number; token: string }>();
    return row
      ? {
          ownerUid: row.owner_uid,
          token: row.token,
          startedAtMs: row.started_at_ms,
        }
      : null;
  }
  throw new EventD1Failure("unsupported-event-path");
}

async function transactEventOwnedPathInternal(
  db: EventD1Connection,
  path: string,
  updater: (current: unknown) => EventTransactionDecision,
  options: {
    admission: EventWriteAdmission;
    allowStoredProfilePrizeAssignment?: boolean;
    eventLease?: EventLeaseGuard;
    now?: () => number;
    signal?: AbortSignal;
  },
): Promise<{ committed: boolean; decision?: string; value: unknown }> {
  for (
    let attempt = 0;
    attempt < MAX_EVENT_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    options.signal?.throwIfAborted();
    const parts = splitPath(path);
    let expectedEventRevisions: Record<string, number> | undefined;
    let expectedPathValues: Record<string, unknown> | undefined;
    let expectedProfilePrizeRevisions: Record<string, number> | undefined;
    let expectedTelegramStateRevisions: Record<string, number> | undefined;
    let current: unknown;
    if (
      (parts[0] === "events" || parts[0] === "eventPrizeSelections") &&
      parts[1]
    ) {
      const snapshot = await readEventSnapshot(db, parts[1]);
      expectedEventRevisions = { [parts[1]]: snapshot.revision };
      current =
        parts[0] === "events"
          ? parts.length === 2
            ? snapshot.event
            : getNested(snapshot.event, parts.slice(2))
          : parts.length === 2
            ? snapshot.prizeSelections
            : getNested(snapshot.prizeSelections, parts.slice(2));
    } else if (parts[0] === "profileEventPrizes" && parts[1]) {
      const snapshot = await readProfileEventPrizes(db, parts[1]);
      expectedProfilePrizeRevisions = { [parts[1]]: snapshot.revision };
      current =
        parts.length === 2
          ? snapshot.prizes
          : getNested(snapshot.prizes, parts.slice(2));
    } else if (
      ((parts[0] === "profileGameProjectionOutbox" && parts[1] === "event") ||
        (parts[0] === "telegramProjectionOutbox" && parts[1] === "event")) &&
      parts.length === 3
    ) {
      current = await readEventOwnedPath(db, path);
      expectedPathValues = { [path]: current };
    } else if (
      (parts[0] === "eventTelegramProjections" ||
        parts[0] === "eventTelegramProjectionGenerations") &&
      parts.length === 2
    ) {
      const snapshot = await readEventTelegramProjectionState(db, parts[1]);
      current =
        parts[0] === "eventTelegramProjections"
          ? snapshot?.state || null
          : snapshot?.generation || 0;
      expectedTelegramStateRevisions = {
        [parts[1]]: snapshot?.revision || 0,
      };
    } else if (
      (parts[0] === "eventProgressOutbox" ||
        parts[0] === "eventProgressOutboxDead") &&
      parts.length === 2
    ) {
      current = await readEventOwnedPath(db, path);
      expectedPathValues = { [path]: current };
    } else {
      current = await readEventOwnedPath(db, path);
    }
    options.signal?.throwIfAborted();
    const decision = updater(current);
    options.signal?.throwIfAborted();
    if ("commit" in decision) {
      return {
        committed: false,
        decision: decision.decision,
        value: current,
      };
    }
    try {
      await patchEventOwnedPathsInternal(
        db,
        { [path]: decision.value },
        {
          expectedEventRevisions,
          expectedPathValues,
          expectedProfilePrizeRevisions,
          expectedTelegramStateRevisions,
          admission: options.admission,
          allowStoredProfilePrizeAssignment:
            options.allowStoredProfilePrizeAssignment,
          eventLease: options.eventLease,
          now: options.now,
        },
      );
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    } catch (error) {
      if (error instanceof EventD1Conflict) {
        options.signal?.throwIfAborted();
        continue;
      }
      throw error;
    }
  }
  throw new EventD1Conflict();
}

export function transactEventOwnedPath(
  db: EventD1Connection,
  path: string,
  updater: (current: unknown) => EventTransactionDecision,
  options: {
    admission: EventWriteAdmission;
    eventLease?: EventLeaseGuard;
    now?: () => number;
    signal?: AbortSignal;
  },
): Promise<{ committed: boolean; decision?: string; value: unknown }> {
  return transactEventOwnedPathInternal(db, path, updater, options);
}

export function transactStoredProfileEventPrizePath(
  db: EventD1Connection,
  path: string,
  updater: (current: unknown) => EventTransactionDecision,
  options: {
    admission: EventWriteAdmission;
    eventLease: EventLeaseGuard;
    now?: () => number;
    signal?: AbortSignal;
  },
): Promise<{ committed: boolean; decision?: string; value: unknown }> {
  const parts = splitPath(path);
  if (
    parts.length !== 3 ||
    parts[0] !== "profileEventPrizes" ||
    !exactKey(parts[1]) ||
    !exactKey(parts[2]) ||
    parts[2] !== options.eventLease.eventId
  ) {
    throw new EventD1Failure("invalid-stored-profile-event-prize-path");
  }
  return transactEventOwnedPathInternal(db, path, updater, {
    ...options,
    allowStoredProfilePrizeAssignment: true,
  });
}

export async function transactEventCoordinationPath(
  db: EventD1Connection,
  path: string,
  updater: (current: unknown) => EventTransactionDecision,
  options: { admission: EventWriteAdmission },
): Promise<{ committed: boolean; decision?: string; value: unknown }> {
  if (options.admission.storageMode !== "d1") {
    throw new EventD1Conflict("event-write-admission-mode-mismatch");
  }
  const runMutation = async (
    statement: D1PreparedStatement,
  ): Promise<D1Result> => {
    try {
      const results = await db.batch([
        eventWriteAdmissionGuard(db, options.admission),
        statement,
      ]);
      return results[1];
    } catch (error) {
      if (isConstraintFailure(error)) {
        throw new EventD1Conflict("event-d1-conflict", { cause: error });
      }
      throw error;
    }
  };
  const parts = splitPath(path);
  if (
    parts.length !== 2 ||
    (parts[0] !== "eventLocks" && parts[0] !== "eventSyncThrottles")
  ) {
    throw new EventD1Failure("unsupported-event-coordination-path");
  }
  const eventId = exactKey(parts[1]);
  if (!eventId) throw new EventD1Failure("invalid-event-path");
  for (
    let attempt = 0;
    attempt < MAX_EVENT_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    const current = await readEventOwnedPath(db, path);
    const decision = updater(current);
    if ("commit" in decision) {
      return {
        committed: false,
        decision: decision.decision,
        value: current,
      };
    }
    if (parts[0] === "eventLocks") {
      const currentRecord = isRecord(current) ? current : null;
      if (decision.value === null) {
        if (!currentRecord) {
          return { committed: true, decision: decision.decision, value: null };
        }
        const result = await runMutation(
          db
            .prepare(
              `DELETE FROM event_leases
             WHERE event_id = ? AND lease_id = ? AND owner_uid = ?
               AND expires_at_ms = ?`,
            )
            .bind(
              eventId,
              currentRecord.lockId,
              currentRecord.ownerUid,
              currentRecord.expiresAtMs,
            ),
        );
        if (result.meta.changes === 1) {
          return { committed: true, decision: decision.decision, value: null };
        }
        continue;
      }
      const next = isRecord(decision.value) ? decision.value : null;
      const lockId = next ? exactKey(next.lockId) : "";
      const ownerUid = next ? exactKey(next.ownerUid) : "";
      if (!next || !lockId || !ownerUid) {
        throw new EventD1Failure("invalid-event-lease");
      }
      const acquiredAtMs = safeInteger(next.acquiredAtMs);
      const refreshedAtMs = safeInteger(next.refreshedAtMs);
      const expiresAtMs = safeInteger(next.expiresAtMs, refreshedAtMs + 1);
      const statement = currentRecord
        ? db
            .prepare(
              `UPDATE event_leases SET
                 lease_id = ?, owner_uid = ?, acquired_at_ms = ?,
                 refreshed_at_ms = ?, expires_at_ms = ?
               WHERE event_id = ? AND lease_id = ? AND owner_uid = ?
                 AND expires_at_ms = ?`,
            )
            .bind(
              lockId,
              ownerUid,
              acquiredAtMs,
              refreshedAtMs,
              expiresAtMs,
              eventId,
              currentRecord.lockId,
              currentRecord.ownerUid,
              currentRecord.expiresAtMs,
            )
        : db
            .prepare(
              `INSERT INTO event_leases (
                 event_id, lease_id, owner_uid, acquired_at_ms,
                 refreshed_at_ms, expires_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (event_id) DO NOTHING`,
            )
            .bind(
              eventId,
              lockId,
              ownerUid,
              acquiredAtMs,
              refreshedAtMs,
              expiresAtMs,
            );
      const result = await runMutation(statement);
      if (result.meta.changes === 1) {
        return {
          committed: true,
          decision: decision.decision,
          value: cloneJson(next),
        };
      }
      continue;
    }
    const currentRecord = isRecord(current) ? current : null;
    if (decision.value === null) {
      const result = currentRecord
        ? await runMutation(
            db
              .prepare(
                `DELETE FROM event_sync_throttles
               WHERE event_id = ? AND token = ? AND started_at_ms = ?`,
              )
              .bind(eventId, currentRecord.token, currentRecord.startedAtMs),
          )
        : null;
      if (!result || result.meta.changes === 1) {
        return { committed: true, decision: decision.decision, value: null };
      }
      continue;
    }
    const next = isRecord(decision.value) ? decision.value : null;
    const ownerUid = next ? exactKey(next.ownerUid) : "";
    const token = next ? exactKey(next.token) : "";
    if (!next || !ownerUid || !token) {
      throw new EventD1Failure("invalid-event-sync-throttle");
    }
    const startedAtMs = safeInteger(next.startedAtMs);
    const statement = currentRecord
      ? db
          .prepare(
            `UPDATE event_sync_throttles
             SET owner_uid = ?, token = ?, started_at_ms = ?
             WHERE event_id = ? AND token = ? AND started_at_ms = ?`,
          )
          .bind(
            ownerUid,
            token,
            startedAtMs,
            eventId,
            currentRecord.token,
            currentRecord.startedAtMs,
          )
      : db
          .prepare(
            `INSERT INTO event_sync_throttles (
               event_id, owner_uid, token, started_at_ms
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (event_id) DO NOTHING`,
          )
          .bind(eventId, ownerUid, token, startedAtMs);
    const result = await runMutation(statement);
    if (result.meta.changes === 1) {
      return {
        committed: true,
        decision: decision.decision,
        value: cloneJson(next),
      };
    }
  }
  throw new EventD1Conflict();
}

function validateTransitionIntent(
  value: EventTransitionIntent,
): EventTransitionIntent {
  if (
    value.schemaVersion !== 1 ||
    !exactKey(value.transitionId) ||
    !exactKey(value.eventId) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 1 ||
    !isRecord(value.rtdbEffects) ||
    !isRecord(value.canonicalUpdates) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs ||
    !isJsonValue(value)
  ) {
    throw new EventD1Failure("invalid-event-transition");
  }
  return cloneJson(value);
}

export async function createEventTransitionIntent(
  db: EventD1Connection,
  rawIntent: EventTransitionIntent,
  options: { admission: EventWriteAdmission },
): Promise<void> {
  const intent = validateTransitionIntent(rawIntent);
  const encoded = encodeJson(intent);
  if (options.admission.storageMode !== "d1") {
    throw new EventD1Conflict("event-write-admission-mode-mismatch");
  }
  try {
    await db.batch([
      eventWriteAdmissionGuard(db, options.admission),
      eventRevisionGuard(db, intent.eventId, intent.expectedRevision),
      guardStatement(
        db,
        `EXISTS (
           SELECT 1 FROM event_records
           WHERE event_id = ? AND pending_transition_id IS NOT NULL
             AND pending_transition_id != ?
         )`,
        [intent.eventId, intent.transitionId],
      ),
      db
        .prepare(
          `INSERT INTO event_transition_intents (
             transition_id, event_id, expected_revision, status, intent_json,
             attempts, last_error, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 'pending', ?, 0, NULL, ?, ?)
           ON CONFLICT (transition_id) DO NOTHING`,
        )
        .bind(
          intent.transitionId,
          intent.eventId,
          intent.expectedRevision,
          encoded,
          intent.createdAtMs,
          intent.updatedAtMs,
        ),
      guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM event_transition_intents
           WHERE transition_id = ? AND event_id = ?
             AND expected_revision = ? AND status = 'pending'
             AND intent_json = ?
         )`,
        [intent.transitionId, intent.eventId, intent.expectedRevision, encoded],
      ),
      db
        .prepare(
          `UPDATE event_records SET pending_transition_id = ?
           WHERE event_id = ? AND revision = ?`,
        )
        .bind(intent.transitionId, intent.eventId, intent.expectedRevision),
    ]);
  } catch (error) {
    if (isConstraintFailure(error)) {
      throw new EventD1Conflict("event-transition-conflict", { cause: error });
    }
    throw error;
  }
}

function parseTransitionRow(row: {
  intent_json: string;
}): EventTransitionIntent {
  return validateTransitionIntent(
    decodeJson(row.intent_json) as EventTransitionIntent,
  );
}

export async function readEventTransitionIntent(
  db: EventD1Connection,
  transitionId: string,
): Promise<EventTransitionIntent | null> {
  const row = await db
    .prepare(
      `SELECT intent_json FROM event_transition_intents
       WHERE transition_id = ? AND status = 'pending'`,
    )
    .bind(exactKey(transitionId))
    .first<{ intent_json: string }>();
  return row ? parseTransitionRow(row) : null;
}

export async function listPendingEventTransitionIntents(
  db: EventD1Connection,
  limit = 100,
): Promise<Array<EventTransitionIntent & { attempts: number }>> {
  safeInteger(limit, 1);
  const rows = await db
    .prepare(
      `SELECT intent_json, attempts FROM event_transition_intents
       WHERE status = 'pending'
       ORDER BY updated_at_ms, transition_id LIMIT ?`,
    )
    .bind(Math.min(limit, 100))
    .all<{ attempts: number; intent_json: string }>();
  return rows.results.map((row) => ({
    ...parseTransitionRow(row),
    attempts: safeInteger(row.attempts),
  }));
}

export async function recordEventTransitionAttempt(
  db: EventD1Connection,
  input: { error?: string | null; nowMs: number; transitionId: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE event_transition_intents
       SET attempts = attempts + 1, last_error = ?, updated_at_ms = ?
       WHERE transition_id = ? AND status = 'pending'`,
    )
    .bind(
      input.error?.slice(0, 1024) || null,
      safeInteger(input.nowMs),
      exactKey(input.transitionId),
    )
    .run();
  return result.meta.changes === 1;
}

function validateEventProgressOutbox(
  outboxId: string,
  value: unknown,
): EventOutboxRecord & {
  eventId: string;
  lastQueuedAtMs: number;
  runAtMs: number | null;
} {
  if (!exactKey(outboxId) || !isRecord(value) || !isJsonValue(value)) {
    throw new EventD1Failure("invalid-event-progress-outbox");
  }
  const eventId = exactKey(value.eventId);
  const runAtMs = nullableInteger(value.runAtMs);
  const lastQueuedAtMs = safeInteger(value.lastQueuedAtMs);
  if (!eventId || value.schemaVersion !== 1) {
    throw new EventD1Failure("invalid-event-progress-outbox");
  }
  return { ...cloneJson(value), eventId, runAtMs, lastQueuedAtMs };
}

export async function readEventProgressOutbox(
  db: EventD1Connection,
  outboxId: string,
): Promise<EventOutboxRecord | null> {
  const row = await db
    .prepare(
      `SELECT record_json FROM event_progress_outboxes
       WHERE outbox_id = ? AND status = 'pending'`,
    )
    .bind(exactKey(outboxId))
    .first<{ record_json: string }>();
  return row ? (decodeJson(row.record_json) as EventOutboxRecord) : null;
}

export async function listDueEventProgressOutboxes(
  db: EventD1Connection,
  beforeMs: number,
  limit = 100,
): Promise<Array<{ outboxId: string; record: EventOutboxRecord }>> {
  const rows = await db
    .prepare(
      `SELECT outbox_id, record_json FROM event_progress_outboxes
       WHERE status = 'pending' AND last_queued_at_ms <= ?
       ORDER BY last_queued_at_ms, outbox_id LIMIT ?`,
    )
    .bind(safeInteger(beforeMs), Math.min(safeInteger(limit, 1), 100))
    .all<{ outbox_id: string; record_json: string }>();
  return rows.results.map((row) => ({
    outboxId: row.outbox_id,
    record: decodeJson(row.record_json) as EventOutboxRecord,
  }));
}

function validateProjectionOutbox(
  kind: "profile-game" | "telegram",
  eventId: string,
  value: unknown,
): EventOutboxRecord & {
  raw: EventOutboxRecord;
  status: "dead" | "pending";
  firstQueuedAtMs?: number;
  lastQueuedAtMs?: number;
  requestId: string;
  updatedAtMs?: number;
} {
  if (!exactKey(eventId) || !isRecord(value) || !isJsonValue(value)) {
    throw new EventD1Failure("invalid-event-projection-outbox");
  }
  const raw = cloneJson(value);
  if (kind === "telegram" && value.status === "dead") {
    const deadAtMs = safeInteger(value.deadAtMs);
    return {
      raw,
      status: "dead",
      requestId: exactKey(value.requestId) || eventId,
      firstQueuedAtMs: deadAtMs,
      updatedAtMs: deadAtMs,
    };
  }
  const requestId = exactKey(value.requestId);
  if (!requestId || value.schemaVersion !== 1 || value.status !== "pending") {
    throw new EventD1Failure("invalid-event-projection-outbox");
  }
  if (kind === "profile-game") {
    return {
      raw,
      status: "pending",
      requestId,
      lastQueuedAtMs: safeInteger(value.lastQueuedAtMs),
    };
  }
  const updatedAtMs = safeInteger(value.updatedAtMs);
  return {
    raw,
    status: "pending",
    requestId,
    firstQueuedAtMs: safeInteger(value.firstQueuedAtMs ?? updatedAtMs),
    updatedAtMs,
  };
}

export async function readEventProfileGameProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
): Promise<EventOutboxRecord | null> {
  return readProjectionOutbox(
    db,
    "event_profile_game_projection_outboxes",
    eventId,
  );
}

export async function readEventTelegramProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
): Promise<EventOutboxRecord | null> {
  return readProjectionOutbox(
    db,
    "event_telegram_projection_outboxes",
    eventId,
  );
}

async function readProjectionOutbox(
  db: EventD1Connection,
  table:
    | "event_profile_game_projection_outboxes"
    | "event_telegram_projection_outboxes",
  eventId: string,
): Promise<EventOutboxRecord | null> {
  const row = await db
    .prepare(
      `SELECT record_json FROM ${table}
       WHERE event_id = ? AND status = 'pending'`,
    )
    .bind(exactKey(eventId))
    .first<{ record_json: string }>();
  return row ? (decodeJson(row.record_json) as EventOutboxRecord) : null;
}

export async function listDueEventProfileGameProjectionOutboxes(
  db: EventD1Connection,
  beforeMs: number,
  limit = 100,
): Promise<Array<{ eventId: string; record: EventOutboxRecord }>> {
  return listProjectionOutboxes(
    db,
    "event_profile_game_projection_outboxes",
    "last_queued_at_ms",
    beforeMs,
    limit,
  );
}

export async function listDueEventTelegramProjectionOutboxes(
  db: EventD1Connection,
  beforeMs: number,
  limit = 100,
): Promise<Array<{ eventId: string; record: EventOutboxRecord }>> {
  return listProjectionOutboxes(
    db,
    "event_telegram_projection_outboxes",
    "updated_at_ms",
    beforeMs,
    limit,
  );
}

async function listProjectionOutboxes(
  db: EventD1Connection,
  table:
    | "event_profile_game_projection_outboxes"
    | "event_telegram_projection_outboxes",
  timestampColumn: "last_queued_at_ms" | "updated_at_ms",
  beforeMs: number,
  limit: number,
): Promise<Array<{ eventId: string; record: EventOutboxRecord }>> {
  const rows = await db
    .prepare(
      `SELECT event_id, record_json FROM ${table}
       WHERE status = 'pending' AND ${timestampColumn} <= ?
       ORDER BY ${timestampColumn}, event_id LIMIT ?`,
    )
    .bind(safeInteger(beforeMs), Math.min(safeInteger(limit, 1), 100))
    .all<{ event_id: string; record_json: string }>();
  return rows.results.map((row) => ({
    eventId: row.event_id,
    record: decodeJson(row.record_json) as EventOutboxRecord,
  }));
}

export async function readEventTelegramProjectionState(
  db: EventD1Connection,
  eventId: string,
): Promise<{
  generation: number;
  revision: number;
  state: EventJsonRecord;
} | null> {
  const row = await db
    .prepare(
      `SELECT generation, revision, state_json
       FROM event_telegram_projection_state WHERE event_id = ?`,
    )
    .bind(exactKey(eventId))
    .first<{ generation: number; revision: number; state_json: string }>();
  if (!row) return null;
  const state = decodeJson(row.state_json);
  if (!isRecord(state)) throw new EventD1Failure();
  return {
    generation: safeInteger(row.generation),
    revision: safeInteger(row.revision, 1),
    state,
  };
}
