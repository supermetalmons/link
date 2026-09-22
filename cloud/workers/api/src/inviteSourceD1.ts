import { RETIRED_STATE_BACKEND } from "./stateCompatibility.ts";
import {
  evaluateStateValueMarker,
  STATE_VALUE_FIELD,
} from "./stateCompatibility.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { classifyD1Failure } from "./d1Failure.ts";

const RETIRED_FIELDS = new Set([
  "reactions",
  "wagers",
  "matchesWagerResolutions",
]);

export type InviteSourceControl = {
  backend: typeof RETIRED_STATE_BACKEND | "d1";
  state: "active" | "frozen";
  epoch: number;
  freezeGeneration: number;
  candidateVersionId: string | null;
  sourceDigest: string | null;
  importDigest: string | null;
  verifiedAtMs: number | null;
  activatedAtMs: number | null;
  metadata: unknown;
};

export type InviteSourceAdmission = Pick<
  InviteSourceControl,
  "backend" | "epoch" | "freezeGeneration"
> & { admissionId: string; kind: string; createdAtMs: number };

export type InviteSourceSnapshot = {
  inviteId: string;
  value: Record<string, unknown> | null;
  revision: number;
};

export type InviteSourceChange = {
  inviteId: string;
  value: Record<string, unknown>;
  operationIds?: Record<string, string>;
};

export type InviteSourceMutation = {
  current: InviteSourceSnapshot;
  value: Record<string, unknown>;
};

type ControlRow = {
  backend: string;
  state: string;
  epoch: number;
  freeze_generation: number;
  candidate_version_id: string | null;
  source_digest: string | null;
  import_digest: string | null;
  verified_at_ms: number | null;
  activated_at_ms: number | null;
  metadata_json: string | null;
};

export class InviteSourceFailure extends Error {
  constructor(message = "invite-source-unavailable", options?: ErrorOptions) {
    super(message, options);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function requireId(value: string): void {
  if (!isSafeRecordKey(value)) throw new TypeError("invalid-invite-source-key");
}

export function isEventOwnedInviteSource(value: unknown): boolean {
  return (
    record(value) &&
    (value.eventOwned === true ||
      (typeof value.eventId === "string" && value.eventId.trim().length > 0))
  );
}

export function normalizeInviteSource(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new TypeError("invalid-invite-source-json");
  const active = new Set<object>();
  const copy = (entry: unknown, depth: number): unknown => {
    if (depth > 64) throw new TypeError("invalid-invite-source-json");
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    )
      return entry;
    if (!entry || typeof entry !== "object" || active.has(entry))
      throw new TypeError("invalid-invite-source-json");
    const prototype = Object.getPrototypeOf(entry);
    if (
      !Array.isArray(entry) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      throw new TypeError("invalid-invite-source-json");
    active.add(entry);
    const result = Array.isArray(entry)
      ? entry.map((child) => copy(child, depth + 1))
      : Object.fromEntries(
          Object.entries(entry).map(([key, child]) => {
            requireId(key);
            return [key, copy(child, depth + 1)];
          }),
        );
    active.delete(entry);
    return result;
  };
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !RETIRED_FIELDS.has(key))
      .map(([key, child]) => {
        requireId(key);
        return [key, copy(child, 1)];
      }),
  );
}

export function prepareInviteSourceControlRead(
  db: Pick<D1Database, "prepare">,
): D1PreparedStatement {
  return db.prepare("SELECT * FROM invite_source_control WHERE singleton = 1");
}

export function parseInviteSourceControlRow(
  value: unknown,
): InviteSourceControl {
  const row = value as ControlRow | null | undefined;
  if (
    !row ||
    (row.backend !== RETIRED_STATE_BACKEND && row.backend !== "d1") ||
    (row.state !== "active" && row.state !== "frozen") ||
    !integer(row.epoch) ||
    !integer(row.freeze_generation) ||
    (row.backend === RETIRED_STATE_BACKEND && row.epoch !== 0) ||
    (row.backend === "d1" &&
      (row.epoch < 1 ||
        !integer(row.verified_at_ms) ||
        Number(row.verified_at_ms) <= 0 ||
        !integer(row.activated_at_ms) ||
        Number(row.activated_at_ms) < Number(row.verified_at_ms)))
  ) {
    throw new InviteSourceFailure("invite-source-control-unavailable");
  }
  let metadata: unknown = null;
  if (row.metadata_json !== null) {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch (error) {
      throw new InviteSourceFailure("invite-source-control-unavailable", {
        cause: error,
      });
    }
  }
  return {
    backend: row.backend,
    state: row.state,
    epoch: row.epoch,
    freezeGeneration: row.freeze_generation,
    candidateVersionId: row.candidate_version_id,
    sourceDigest: row.source_digest,
    importDigest: row.import_digest,
    verifiedAtMs: row.verified_at_ms,
    activatedAtMs: row.activated_at_ms,
    metadata,
  };
}

export async function readInviteSourceControl(
  db: D1Database,
): Promise<InviteSourceControl> {
  const row = await prepareInviteSourceControlRead(
    db.withSession("first-primary"),
  ).first<ControlRow>();
  return parseInviteSourceControlRow(row);
}

export function inviteSourceControlGuardStatements(
  db: D1Database,
  control: Pick<InviteSourceControl, "backend" | "epoch" | "freezeGeneration">,
  requireActive = true,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO invite_source_guards (singleton)
    SELECT 0 WHERE NOT EXISTS (
      SELECT 1 FROM invite_source_control WHERE singleton = 1
        AND backend = ? AND epoch = ? AND freeze_generation = ?
        ${requireActive ? "AND state = 'active'" : ""}
    )`,
      )
      .bind(control.backend, control.epoch, control.freezeGeneration),
  ];
}

export async function acquireInviteSourceAdmission(
  db: D1Database,
  kind: string,
  { now = Date.now }: { now?: () => number } = {},
): Promise<InviteSourceAdmission> {
  const control = await readInviteSourceControl(db);
  if (control.state !== "active")
    throw new InviteSourceFailure("invite-source-writes-frozen");
  const createdAtMs = now();
  if (!kind || !integer(createdAtMs))
    throw new TypeError("invalid-invite-source-admission");
  const admissionId = crypto.randomUUID();
  const admission: InviteSourceAdmission = {
    admissionId,
    backend: control.backend,
    epoch: control.epoch,
    freezeGeneration: control.freezeGeneration,
    kind,
    createdAtMs,
  };
  const insert = db
    .prepare(
      `INSERT INTO invite_source_write_admissions
    (admission_id, backend, epoch, freeze_generation, kind, created_at_ms)
    SELECT ?, backend, epoch, freeze_generation, ?, ? FROM invite_source_control
    WHERE singleton = 1 AND state = 'active' AND backend = ? AND epoch = ? AND freeze_generation = ?
    ON CONFLICT(admission_id) DO NOTHING
    RETURNING admission_id`,
    )
    .bind(
      admissionId,
      kind,
      createdAtMs,
      control.backend,
      control.epoch,
      control.freezeGeneration,
    );
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let insertFailed = false;
    try {
      const inserted = await insert.first<{ admission_id: string }>();
      if (inserted?.admission_id === admissionId) return admission;
    } catch (error) {
      failure = error;
      insertFailed = true;
    }
    let absent = false;
    try {
      const existing = await db
        .withSession("first-primary")
        .prepare(
          `SELECT admission_id FROM invite_source_write_admissions
          WHERE admission_id = ? AND backend = ? AND epoch = ? AND freeze_generation = ?
            AND kind = ? AND created_at_ms = ?`,
        )
        .bind(
          admissionId,
          control.backend,
          control.epoch,
          control.freezeGeneration,
          kind,
          createdAtMs,
        )
        .first<{ admission_id: string }>();
      if (existing?.admission_id === admissionId) return admission;
      absent = true;
    } catch (error) {
      failure = error;
    }
    if (!insertFailed && absent)
      throw new InviteSourceFailure("invite-source-writes-frozen");
  }
  console.error(
    JSON.stringify({
      event: "invite_source_admission_acquire_unconfirmed",
      ...admission,
    }),
  );
  throw new InviteSourceFailure("invite-source-admission-unconfirmed", {
    cause: failure,
  });
}

export async function releaseInviteSourceAdmission(
  db: D1Database,
  admission: InviteSourceAdmission,
): Promise<void> {
  const statement = db
    .prepare(
      `DELETE FROM invite_source_write_admissions
    WHERE admission_id = ? AND backend = ? AND epoch = ? AND freeze_generation = ?
      AND kind = ? AND created_at_ms = ?`,
    )
    .bind(
      admission.admissionId,
      admission.backend,
      admission.epoch,
      admission.freezeGeneration,
      admission.kind,
      admission.createdAtMs,
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await statement.run();
      return;
    } catch (error) {
      if (attempt === 2) {
        console.error(
          JSON.stringify({
            event: "invite_source_admission_release_failed",
            ...admission,
          }),
        );
        throw error;
      }
    }
  }
}

export function inviteSourceAdmissionGuardStatements(
  db: D1Database,
  admission: InviteSourceAdmission,
): D1PreparedStatement[] {
  return [
    ...inviteSourceControlGuardStatements(db, admission),
    db
      .prepare(
        `INSERT INTO invite_source_guards (singleton)
      SELECT 0 WHERE NOT EXISTS (
        SELECT 1 FROM invite_source_write_admissions WHERE admission_id = ?
          AND backend = ? AND epoch = ? AND freeze_generation = ? AND kind = ? AND created_at_ms = ?
      )`,
      )
      .bind(
        admission.admissionId,
        admission.backend,
        admission.epoch,
        admission.freezeGeneration,
        admission.kind,
        admission.createdAtMs,
      ),
  ];
}

function getNested(value: unknown, parts: readonly string[]): unknown {
  let current = value;
  for (const key of parts) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key))
      return null;
    current = Reflect.get(current, key);
  }
  return current ?? null;
}

function setNested(
  target: Record<string, unknown>,
  parts: readonly string[],
  value: unknown,
): void {
  let current = target;
  for (const key of parts.slice(0, -1)) {
    const existing = Object.hasOwn(current, key) ? current[key] : null;
    const nested = record(existing) ? { ...existing } : {};
    Object.defineProperty(current, key, {
      value: nested,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    current = nested;
  }
  const key = parts.at(-1)!;
  if (value === null) delete current[key];
  else
    Object.defineProperty(current, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
}

function resolveValue(
  value: unknown,
  current: unknown,
  nowMs: number,
): unknown {
  if (Array.isArray(value))
    return value.map((child, index) =>
      resolveValue(
        child,
        Array.isArray(current) ? current[index] : null,
        nowMs,
      ),
    );
  if (!record(value)) return value;
  if (Object.hasOwn(value, STATE_VALUE_FIELD)) {
    if (Object.keys(value).length !== 1)
      throw new TypeError("invalid-invite-source-server-value");
    const result = evaluateStateValueMarker(
      value[STATE_VALUE_FIELD],
      current,
      nowMs,
    );
    if (result.ok) return result.value;
    throw new TypeError("invalid-invite-source-server-value");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      resolveValue(
        child,
        record(current) && Object.hasOwn(current, key) ? current[key] : null,
        nowMs,
      ),
    ]),
  );
}

export function isInviteSourceRevisionConflict(error: unknown): boolean {
  return classifyD1Failure(error) === "invite-source-conflict";
}

export function prepareInviteSourceSnapshotRead(
  db: Pick<D1Database, "prepare">,
  inviteId: string,
): D1PreparedStatement {
  requireId(inviteId);
  return db
    .prepare(
      "SELECT source_json, revision FROM invite_sources WHERE invite_id = ?",
    )
    .bind(inviteId);
}

export async function readInviteSourceSnapshot(
  db: D1Database,
  inviteId: string,
  signal?: AbortSignal,
): Promise<InviteSourceSnapshot> {
  const row = await prepareInviteSourceSnapshotRead(
    db.withSession("first-primary"),
    inviteId,
  ).first<{ source_json: string; revision: number }>();
  signal?.throwIfAborted();
  return decodeInviteSourceSnapshot(inviteId, row);
}

export function decodeInviteSourceSnapshot(
  inviteId: string,
  row: unknown,
): InviteSourceSnapshot {
  if (!row) return { inviteId, value: null, revision: 0 };
  if (
    !record(row) ||
    typeof row.source_json !== "string" ||
    !integer(row.revision) ||
    row.revision < 1
  )
    throw new InviteSourceFailure("invite-source-corrupt");
  try {
    const decoded: unknown = JSON.parse(row.source_json);
    if (
      !record(decoded) ||
      Object.keys(decoded).some((key) => RETIRED_FIELDS.has(key))
    )
      throw new TypeError("invalid-invite-source-json");
    return {
      inviteId,
      value: normalizeInviteSource(decoded),
      revision: row.revision,
    };
  } catch (error) {
    throw new InviteSourceFailure("invite-source-corrupt", { cause: error });
  }
}

export function createInviteSourceD1Store(
  db: D1Database,
  {
    now = Date.now,
    writeGuards = () => [],
  }: {
    now?: () => number;
    writeGuards?: () => readonly D1PreparedStatement[];
  } = {},
) {
  const read = async (
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<InviteSourceSnapshot> => {
    requireId(inviteId);
    signal?.throwIfAborted();
    const control = await readInviteSourceControl(db);
    if (control.backend !== "d1")
      throw new InviteSourceFailure("invite-source-not-activated");
    return readInviteSourceSnapshot(db, inviteId, signal);
  };

  async function readMutationSnapshots(
    inviteIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<InviteSourceSnapshot[]> {
    if (!inviteIds.length) return [];
    signal?.throwIfAborted();
    const session = db.withSession("first-primary");
    const [controlRows, ...snapshots] = await session.batch([
      prepareInviteSourceControlRead(session),
      ...inviteIds.map((inviteId) =>
        session
          .prepare(
            "SELECT source_json, revision FROM invite_sources WHERE invite_id = ?",
          )
          .bind(inviteId),
      ),
    ]);
    signal?.throwIfAborted();
    const control = parseInviteSourceControlRow(controlRows.results[0]);
    if (control.backend !== "d1")
      throw new InviteSourceFailure("invite-source-not-activated");
    return inviteIds.map((inviteId, index) =>
      decodeInviteSourceSnapshot(inviteId, snapshots[index].results[0]),
    );
  }

  const buildRevisionGuardStatements = (
    mutations: readonly InviteSourceMutation[],
  ): D1PreparedStatement[] =>
    mutations.map(({ current }) => {
      requireId(current.inviteId);
      if (
        !integer(current.revision) ||
        (current.value === null) !== (current.revision === 0)
      )
        throw new TypeError("invalid-invite-source-revision");
      return db
        .prepare(
          `INSERT INTO invite_source_revision_guards (singleton)
        SELECT 0 WHERE COALESCE((SELECT revision FROM invite_sources WHERE invite_id = ?), 0) != ?`,
        )
        .bind(current.inviteId, current.revision);
    });

  const buildCommitStatements = (
    mutations: readonly InviteSourceMutation[],
    nowMs = now(),
  ): D1PreparedStatement[] => {
    if (!integer(nowMs)) throw new TypeError("invalid-invite-source-timestamp");
    return [
      ...writeGuards(),
      ...buildRevisionGuardStatements(mutations),
      ...mutations.map(({ current, value }) => {
        const normalized = normalizeInviteSource(value);
        if (
          Object.keys(value).some((key) => RETIRED_FIELDS.has(key)) ||
          !Number.isSafeInteger(current.revision + 1)
        )
          throw new TypeError("invalid-invite-source-mutation");
        return db
          .prepare(
            `INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms)
        VALUES (?, ?, ?, ?) ON CONFLICT (invite_id) DO UPDATE SET
          source_json = excluded.source_json, revision = excluded.revision, updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(
            current.inviteId,
            JSON.stringify(normalized),
            current.revision + 1,
            nowMs,
          );
      }),
    ];
  };

  return {
    read,
    buildRevisionGuardStatements,
    buildCommitStatements,
    async prepareChanges(
      changes: readonly InviteSourceChange[],
      nowMs = now(),
      signal?: AbortSignal,
    ): Promise<InviteSourceMutation[]> {
      if (!integer(nowMs))
        throw new TypeError("invalid-invite-source-timestamp");
      const grouped = new Map<string, InviteSourceChange[]>();
      for (const change of changes) {
        requireId(change.inviteId);
        if (!record(change.value))
          throw new TypeError("invite-source-deletion-unsupported");
        if (
          Object.keys(change.value).some(
            (field) =>
              RETIRED_FIELDS.has(field) || field === "sessionTransition",
          )
        )
          throw new TypeError("reserved-invite-source-field");
        const group = grouped.get(change.inviteId) || [];
        group.push(change);
        grouped.set(change.inviteId, group);
      }
      const groups = [...grouped.values()];
      const snapshots = await readMutationSnapshots(
        [...grouped.keys()],
        signal,
      );
      return snapshots.map((current, index) => {
        const next = structuredClone(current.value || {});
        for (const change of groups[index]) {
          for (const [key, value] of Object.entries(change.value)) {
            requireId(key);
            setNested(
              next,
              [key],
              resolveValue(value, getNested(next, [key]), nowMs),
            );
          }
          for (const [loginUid, operationId] of Object.entries(
            change.operationIds || {},
          )) {
            requireId(loginUid);
            setNested(next, ["automatchOperationIds", loginUid], operationId);
          }
        }
        return { current, value: normalizeInviteSource(next) };
      });
    },
  };
}
