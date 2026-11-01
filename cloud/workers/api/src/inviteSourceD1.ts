import { isRematchSeries, type RematchSeries } from "@mons/shared/rematches";
import {
  readInviteDocument,
  type InviteDocument,
  type InviteFieldChanges,
} from "@mons/shared/invite-records";
import { RETIRED_STATE_BACKEND } from "./stateCompatibility.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { classifyD1Failure } from "./d1Failure.ts";
import { runD1AdmissionAcquire, runD1AdmissionRelease } from "./d1Admission.ts";

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
};

export type InviteSourceAdmission = Pick<
  InviteSourceControl,
  "backend" | "epoch" | "freezeGeneration"
> & { admissionId: string; kind: string; createdAtMs: number };

export type InviteSourceSnapshot = {
  inviteId: string;
  value: InviteDocument | null;
  revision: number;
};

export type InviteSourceChange = {
  inviteId: string;
  value: InviteDocument;
  operationIds?: Record<string, string>;
};

export type InviteSourcePersistenceChange = Omit<
  InviteSourceChange,
  "value"
> & {
  value:
    | InviteDocument
    | InviteFieldChanges
    | { hostRematches: RematchSeries }
    | { guestRematches: RematchSeries };
};
export type InviteSourceMutation = {
  current: InviteSourceSnapshot;
  value: InviteDocument;
};
export type RetainedInviteMutationBatch = readonly InviteSourceMutation[];

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

export function normalizeInviteSource(value: unknown): InviteDocument {
  const invite = readInviteDocument(value);
  if (!invite) throw new TypeError("invalid-invite-source-json");
  return structuredClone(invite);
}

export function prepareInviteSourceControlRead(
  db: Pick<D1Database, "prepare">,
): D1PreparedStatement {
  return db.prepare(
    "SELECT backend, state, epoch, freeze_generation, candidate_version_id, source_digest, import_digest, verified_at_ms, activated_at_ms FROM invite_source_control WHERE singleton = 1",
  );
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
  {
    now = Date.now,
    expectedControl,
  }: { now?: () => number; expectedControl?: InviteSourceControl } = {},
): Promise<InviteSourceAdmission> {
  const control = {
    ...(expectedControl ?? (await readInviteSourceControl(db))),
  };
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
  return runD1AdmissionAcquire({
    write: () => insert.first<{ admission_id: string }>(),
    written: (inserted) =>
      inserted?.admission_id === admissionId ? admission : null,
    readback: () =>
      db
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
        .first<{ admission_id: string }>(),
    confirmed(existing, writeFailed) {
      if (existing?.admission_id === admissionId) return admission;
      if (!writeFailed)
        throw new InviteSourceFailure("invite-source-writes-frozen");
      return null;
    },
    unconfirmed(cause) {
      console.error(
        JSON.stringify({
          event: "invite_source_admission_acquire_unconfirmed",
          ...admission,
        }),
      );
      return new InviteSourceFailure("invite-source-admission-unconfirmed", {
        cause,
      });
    },
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
  try {
    await runD1AdmissionRelease(() => statement.run());
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "invite_source_admission_release_failed",
        ...admission,
      }),
    );
    throw error;
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
      "SELECT source_json, revision FROM invite_sources_canonical WHERE invite_id = ?",
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
            "SELECT source_json, revision FROM invite_sources_canonical WHERE invite_id = ?",
          )
          .bind(inviteId),
      ),
    ]);
    signal?.throwIfAborted();
    const control = parseInviteSourceControlRow(controlRows!.results[0]);
    if (control.backend !== "d1")
      throw new InviteSourceFailure("invite-source-not-activated");
    return inviteIds.map((inviteId, index) =>
      decodeInviteSourceSnapshot(inviteId, snapshots[index]!.results[0]),
    );
  }

  const revisionGuards = (
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
        SELECT 0 WHERE COALESCE((SELECT revision FROM invite_sources_canonical WHERE invite_id = ?), 0) != ?`,
        )
        .bind(current.inviteId, current.revision);
    });

  const commitStatements = (
    mutations: readonly InviteSourceMutation[],
    nowMs = now(),
  ): D1PreparedStatement[] => {
    if (!integer(nowMs)) throw new TypeError("invalid-invite-source-timestamp");
    return [
      ...writeGuards(),
      ...revisionGuards(mutations),
      ...mutations.map(({ current, value }) => {
        const normalized = normalizeInviteSource(value);
        if (!Number.isSafeInteger(current.revision + 1))
          throw new TypeError("invalid-invite-source-mutation");
        return db
          .prepare(
            `INSERT INTO invite_sources_canonical (invite_id, source_json, revision, updated_at_ms)
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
    buildRevisionGuardStatements(mutations: readonly InviteSourceMutation[]) {
      return revisionGuards(mutations);
    },
    buildCommitStatements(
      mutations: readonly InviteSourceMutation[],
      nowMs = now(),
    ) {
      return commitStatements(mutations, nowMs);
    },
    buildRetainedRevisionGuardStatements(
      mutations: RetainedInviteMutationBatch,
    ) {
      return revisionGuards(mutations);
    },
    buildRetainedCommitStatements(
      mutations: RetainedInviteMutationBatch,
      nowMs: number,
    ) {
      return commitStatements(mutations, nowMs);
    },
    async prepareChanges(
      changes: readonly InviteSourcePersistenceChange[],
      nowMs = now(),
      signal?: AbortSignal,
    ): Promise<InviteSourceMutation[]> {
      if (!integer(nowMs))
        throw new TypeError("invalid-invite-source-timestamp");
      const grouped = new Map<string, InviteSourcePersistenceChange[]>();
      for (const change of changes) {
        requireId(change.inviteId);
        const value = change.value;
        if (!record(value))
          throw new TypeError("invite-source-deletion-unsupported");
        const complete = readInviteDocument(value);
        if (!complete) {
          const allowed = new Set([
            "guestId",
            "hostId",
            "hostColor",
            "password",
            "automatchStateHint",
            "automatchCanceledAt",
            "telegramDeliveryVersion",
            "hostRematches",
            "guestRematches",
          ]);
          if (Object.keys(value).some((field) => !allowed.has(field)))
            throw new TypeError("reserved-invite-source-field");
          if (
            ("hostRematches" in value &&
              !isRematchSeries(value.hostRematches)) ||
            ("guestRematches" in value &&
              !isRematchSeries(value.guestRematches))
          )
            throw new TypeError("invalid-invite-rematches");
        }
        const group = grouped.get(change.inviteId) ?? [];
        group.push(change);
        grouped.set(change.inviteId, group);
      }
      const groups = [...grouped.values()];
      const snapshots = await readMutationSnapshots(
        [...grouped.keys()],
        signal,
      );
      return snapshots.map((current, index) => {
        let next = current.value;
        for (const change of groups[index]!) {
          const complete = readInviteDocument(change.value);
          const operationIds = {
            ...next?.automatchOperationIds,
            ...complete?.automatchOperationIds,
            ...change.operationIds,
          };
          const candidate = {
            ...next,
            ...change.value,
            automatchOperationIds: operationIds,
            ...(next
              ? {
                  sessionTransition: next.sessionTransition,
                  automatchMessage: next.automatchMessage,
                }
              : {}),
          };
          next = normalizeInviteSource(candidate);
        }
        if (!next) throw new TypeError("invite-source-creation-required");
        return { current, value: next };
      });
    },
  };
}
