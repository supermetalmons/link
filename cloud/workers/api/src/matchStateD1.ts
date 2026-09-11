import { isSafeFirebaseKey } from "./firebaseKeys.ts";

export type MatchStateControl = {
  backend: "rtdb" | "durable";
  state: "active" | "draining" | "frozen";
  epoch: number;
  freezeGeneration: number;
  candidateVersionId: string | null;
  importId: string | null;
  sourceDigest: string | null;
  sourceRecordCount: number | null;
  sourceClaimCount: number | null;
  sourceBundleCount: number | null;
  fenceDigest: string | null;
  verifiedDigest: string | null;
  verifiedAtMs: number | null;
  activatedAtMs: number | null;
};

export type MatchStateAdmission = {
  admissionId: string;
  backend: MatchStateControl["backend"];
  epoch: number;
  freezeGeneration: number;
  kind: string;
  resources: string[];
  transitionId: string | null;
  createdAtMs: number;
};

export type MatchStateAdmissionInput = {
  kind: string;
  resources: readonly string[];
  transitionId?: string | null;
  admissionId?: string;
  nowMs?: number;
};

export type MatchStateRoute = {
  actorUid: string;
  matchId: string;
  kind: "durable" | "legacy";
  inviteId: string | null;
  epoch: number;
};

export type LegacyMatchStateRecord = {
  actorUid: string;
  matchId: string;
  value: unknown;
  sourceDigest: string;
  importId: string;
  disposition:
    "missing-invite" | "ambiguous-invite" | "nonparticipant" | "malformed";
};

type ControlRow = {
  backend: string;
  state: string;
  epoch: number;
  freeze_generation: number;
  candidate_version_id: string | null;
  import_id: string | null;
  source_digest: string | null;
  source_record_count: number | null;
  source_claim_count: number | null;
  source_bundle_count: number | null;
  fence_digest: string | null;
  verified_digest: string | null;
  verified_at_ms: number | null;
  activated_at_ms: number | null;
};

export class MatchStateD1Failure extends Error {
  readonly status = 503;
  readonly code = "unavailable";

  constructor(reason = "unavailable") {
    super(`match-state-${reason}`);
  }
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function safeKey(value: string): void {
  if (!isSafeFirebaseKey(value) || value !== value.trim())
    throw new MatchStateD1Failure("invalid-key");
}

export async function readMatchStateControl(
  db: D1Database,
): Promise<MatchStateControl> {
  let row: ControlRow | null;
  try {
    row = await db
      .withSession("first-primary")
      .prepare("SELECT * FROM match_state_control WHERE singleton = 1")
      .first<ControlRow>();
  } catch {
    throw new MatchStateD1Failure("control-unavailable");
  }
  if (
    !row ||
    (row.backend !== "rtdb" && row.backend !== "durable") ||
    !["active", "draining", "frozen"].includes(row.state) ||
    !safeInteger(row.epoch, 1) ||
    !safeInteger(row.freeze_generation)
  )
    throw new MatchStateD1Failure("control-unavailable");
  return {
    backend: row.backend,
    state: row.state as MatchStateControl["state"],
    epoch: row.epoch,
    freezeGeneration: row.freeze_generation,
    candidateVersionId: row.candidate_version_id,
    importId: row.import_id,
    sourceDigest: row.source_digest,
    sourceRecordCount: row.source_record_count,
    sourceClaimCount: row.source_claim_count,
    sourceBundleCount: row.source_bundle_count,
    fenceDigest: row.fence_digest,
    verifiedDigest: row.verified_digest,
    verifiedAtMs: row.verified_at_ms,
    activatedAtMs: row.activated_at_ms,
  };
}

export async function acquireMatchStateAdmission(
  db: D1Database,
  input: MatchStateAdmissionInput,
): Promise<MatchStateAdmission> {
  const resources = [...new Set(input.resources)].sort();
  const admissionId = input.admissionId || crypto.randomUUID();
  const createdAtMs = input.nowMs ?? Date.now();
  const transitionId = input.transitionId ?? null;
  safeKey(admissionId);
  if (transitionId !== null) safeKey(transitionId);
  if (
    !input.kind ||
    input.kind.length > 120 ||
    !safeInteger(createdAtMs) ||
    resources.length > 256 ||
    resources.some((key) => !key || key.length > 1024) ||
    JSON.stringify(resources).length > 32 * 1024
  )
    throw new MatchStateD1Failure("invalid-admission");
  let row: {
    backend: MatchStateControl["backend"];
    epoch: number;
    freeze_generation: number;
  } | null;
  try {
    row = await db
      .prepare(
        `INSERT INTO match_state_write_admissions
          (admission_id, backend, epoch, freeze_generation, kind, resources_json, transition_id, created_at_ms)
         SELECT ?, backend, epoch, freeze_generation, ?, ?, ?, ?
         FROM match_state_control AS control WHERE singleton = 1 AND
           (state = 'active' OR (state = 'draining' AND EXISTS (
             SELECT 1 FROM match_state_recovery_ids WHERE transition_id = ?
               AND freeze_generation = control.freeze_generation)))
         RETURNING backend, epoch, freeze_generation`,
      )
      .bind(
        admissionId,
        input.kind,
        JSON.stringify(resources),
        transitionId,
        createdAtMs,
        transitionId,
      )
      .first();
  } catch {
    throw new MatchStateD1Failure("admission-unconfirmed");
  }
  if (!row) throw new MatchStateD1Failure("writes-disabled");
  return {
    admissionId,
    backend: row.backend,
    epoch: row.epoch,
    freezeGeneration: row.freeze_generation,
    kind: input.kind,
    resources,
    transitionId,
    createdAtMs,
  };
}

export function matchStateAdmissionGuardStatements(
  db: D1Database,
  admission: MatchStateAdmission,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO match_state_guards (singleton)
         SELECT 0 WHERE NOT EXISTS (
           SELECT 1 FROM match_state_write_admissions AS admission
           JOIN match_state_control AS control ON control.singleton = 1
           WHERE admission.admission_id = ? AND admission.backend = ?
             AND admission.epoch = ? AND admission.freeze_generation = ?
             AND admission.kind = ? AND admission.resources_json = ?
             AND admission.transition_id IS ? AND admission.created_at_ms = ?
             AND admission.phase = 'admitted'
             AND control.backend = admission.backend AND control.epoch = admission.epoch
             AND control.freeze_generation = admission.freeze_generation
             AND control.state IN ('active', 'draining'))`,
      )
      .bind(
        admission.admissionId,
        admission.backend,
        admission.epoch,
        admission.freezeGeneration,
        admission.kind,
        JSON.stringify(admission.resources),
        admission.transitionId,
        admission.createdAtMs,
      ),
  ];
}

export async function assertMatchStateAdmission(
  db: D1Database,
  admission: MatchStateAdmission,
): Promise<void> {
  try {
    await db.batch(matchStateAdmissionGuardStatements(db, admission));
  } catch {
    throw new MatchStateD1Failure("admission-lost");
  }
}

export async function extendMatchStateAdmissionResources(
  db: D1Database,
  admission: MatchStateAdmission,
  resources: readonly string[],
): Promise<void> {
  const next = [...new Set([...admission.resources, ...resources])].sort();
  if (
    next.length > 256 ||
    next.some((key) => !key || key.length > 1024) ||
    JSON.stringify(next).length > 32 * 1024
  )
    throw new MatchStateD1Failure("invalid-admission-resources");
  const previous = JSON.stringify(admission.resources);
  const encoded = JSON.stringify(next);
  if (previous === encoded) {
    await assertMatchStateAdmission(db, admission);
    return;
  }
  try {
    const results = await db.batch([
      ...matchStateAdmissionGuardStatements(db, admission),
      db
        .prepare(
          `UPDATE match_state_write_admissions SET resources_json = ?
        WHERE admission_id = ? AND resources_json = ? AND phase = 'admitted'`,
        )
        .bind(encoded, admission.admissionId, previous),
    ]);
    if (results[1].meta.changes !== 1)
      throw new MatchStateD1Failure("admission-resources-unconfirmed");
  } catch {
    const current = await db
      .withSession("first-primary")
      .prepare(
        `SELECT resources_json FROM match_state_write_admissions
      WHERE admission_id = ? AND backend = ? AND epoch = ? AND freeze_generation = ?
        AND kind = ? AND transition_id IS ? AND created_at_ms = ? AND phase = 'admitted'`,
      )
      .bind(
        admission.admissionId,
        admission.backend,
        admission.epoch,
        admission.freezeGeneration,
        admission.kind,
        admission.transitionId,
        admission.createdAtMs,
      )
      .first<{ resources_json: string }>();
    if (current?.resources_json !== encoded)
      throw new MatchStateD1Failure("admission-resources-unconfirmed");
  }
  admission.resources = next;
  await assertMatchStateAdmission(db, admission);
}

export async function completeMatchStateAdmission(
  db: D1Database,
  admission: MatchStateAdmission,
): Promise<void> {
  const result = await db
    .prepare(
      `DELETE FROM match_state_write_admissions WHERE admission_id = ?
       AND backend = ? AND epoch = ? AND freeze_generation = ?
       AND kind = ? AND resources_json = ? AND transition_id IS ?
       AND created_at_ms = ? AND phase = 'admitted'`,
    )
    .bind(
      admission.admissionId,
      admission.backend,
      admission.epoch,
      admission.freezeGeneration,
      admission.kind,
      JSON.stringify(admission.resources),
      admission.transitionId,
      admission.createdAtMs,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new MatchStateD1Failure("admission-release-unconfirmed");
}

export async function markMatchStateAdmissionUncertain(
  db: D1Database,
  admission: MatchStateAdmission,
): Promise<void> {
  await db
    .prepare(
      `UPDATE match_state_write_admissions SET phase = 'uncertain'
       WHERE admission_id = ? AND backend = ? AND epoch = ?
         AND freeze_generation = ? AND created_at_ms = ?`,
    )
    .bind(
      admission.admissionId,
      admission.backend,
      admission.epoch,
      admission.freezeGeneration,
      admission.createdAtMs,
    )
    .run();
}

export function buildMatchStateRouteStatements(
  db: D1Database,
  routes: readonly MatchStateRoute[],
): D1PreparedStatement[] {
  return routes.map((route) => {
    safeKey(route.actorUid);
    safeKey(route.matchId);
    if (route.inviteId !== null) safeKey(route.inviteId);
    if (
      !safeInteger(route.epoch, 1) ||
      !["durable", "legacy"].includes(route.kind) ||
      (route.kind === "durable") !== (route.inviteId !== null)
    )
      throw new MatchStateD1Failure("invalid-route");
    return db
      .prepare(
        `INSERT OR IGNORE INTO match_state_routes
         (actor_uid, match_id, kind, invite_id, epoch) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        route.actorUid,
        route.matchId,
        route.kind,
        route.inviteId,
        route.epoch,
      );
  });
}

export async function registerMatchStateRoutes(
  db: D1Database,
  routes: readonly MatchStateRoute[],
  epoch: number,
): Promise<void> {
  if (
    !safeInteger(epoch, 1) ||
    routes.some((route) => route.kind !== "durable" || route.epoch !== epoch)
  )
    throw new MatchStateD1Failure("route-authority-conflict");
  await db.batch([
    db
      .prepare(
        `INSERT INTO match_state_guards (singleton)
      SELECT 0 WHERE NOT EXISTS (
        SELECT 1 FROM match_state_control
        WHERE singleton = 1 AND backend = 'durable' AND state = 'active' AND epoch = ?
      )`,
      )
      .bind(epoch),
    ...buildMatchStateRouteStatements(db, routes),
  ]);
}

export async function readMatchStateRoute(
  db: D1Database,
  actorUid: string,
  matchId: string,
): Promise<MatchStateRoute | null> {
  safeKey(actorUid);
  safeKey(matchId);
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT actor_uid, match_id, kind, invite_id, epoch
       FROM match_state_routes WHERE actor_uid = ? AND match_id = ?`,
    )
    .bind(actorUid, matchId)
    .first<{
      actor_uid: string;
      match_id: string;
      kind: MatchStateRoute["kind"];
      invite_id: string | null;
      epoch: number;
    }>();
  return row
    ? {
        actorUid: row.actor_uid,
        matchId: row.match_id,
        kind: row.kind,
        inviteId: row.invite_id,
        epoch: row.epoch,
      }
    : null;
}

export async function readLegacyMatchState(
  db: D1Database,
  actorUid: string,
  matchId: string,
): Promise<unknown | null> {
  safeKey(actorUid);
  safeKey(matchId);
  const row = await db
    .withSession("first-primary")
    .prepare(
      "SELECT record_json FROM match_state_legacy_records WHERE actor_uid = ? AND match_id = ?",
    )
    .bind(actorUid, matchId)
    .first<{ record_json: string }>();
  if (row) return JSON.parse(row.record_json);
  if ((await readMatchStateRoute(db, actorUid, matchId))?.kind === "legacy")
    throw new MatchStateD1Failure("legacy-record-unavailable");
  return null;
}
