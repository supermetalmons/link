import { RETIRED_STATE_BACKEND } from "./stateCompatibility.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { readD1FirstRow } from "./d1Reads.ts";

export type MatchStateControl = {
  backend: typeof RETIRED_STATE_BACKEND | "durable";
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

export type MatchStateRoute = {
  actorUid: string;
  matchId: string;
  kind: "durable" | "legacy";
  inviteId: string | null;
  epoch: number;
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
  if (!isSafeRecordKey(value) || value !== value.trim())
    throw new MatchStateD1Failure("invalid-key");
}

export async function readMatchStateControl(
  db: D1Database,
): Promise<MatchStateControl> {
  let row: ControlRow | null;
  try {
    row = await readD1FirstRow<ControlRow>(
      db
        .withSession("first-primary")
        .prepare("SELECT * FROM match_state_control WHERE singleton = 1"),
    );
  } catch {
    throw new MatchStateD1Failure("control-unavailable");
  }
  return parseMatchStateControl(row);
}

function parseMatchStateControl(
  row: ControlRow | null | undefined,
): MatchStateControl {
  if (
    !row ||
    (row.backend !== RETIRED_STATE_BACKEND && row.backend !== "durable") ||
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

type MatchStateRouteRow = {
  actor_uid: string;
  match_id: string;
  kind: MatchStateRoute["kind"];
  invite_id: string | null;
  epoch: number;
};

function prepareMatchStateRouteRead(
  db: D1DatabaseSession,
  actorUid: string,
  matchId: string,
): D1PreparedStatement {
  safeKey(actorUid);
  safeKey(matchId);
  return db
    .prepare(
      `SELECT actor_uid, match_id, kind, invite_id, epoch
       FROM match_state_routes WHERE actor_uid = ? AND match_id = ?`,
    )
    .bind(actorUid, matchId);
}

function parseMatchStateRoute(
  row: MatchStateRouteRow | null | undefined,
): MatchStateRoute | null {
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

export async function readMatchStateRoutes(
  db: D1Database,
  inputs: readonly { playerId: string; matchId: string }[],
): Promise<Array<MatchStateRoute | null>> {
  if (inputs.length === 0) return [];
  const session = db.withSession("first-primary");
  const results = await session.batch<MatchStateRouteRow>(
    inputs.map((input) =>
      prepareMatchStateRouteRead(session, input.playerId, input.matchId),
    ),
  );
  if (results.length !== inputs.length)
    throw new MatchStateD1Failure("routes-unavailable");
  return results.map((result) => parseMatchStateRoute(result.results[0]));
}

export async function readMatchStateRouteSnapshot(
  db: D1Database,
  inputs: readonly { playerId: string; matchId: string }[],
): Promise<{
  control: MatchStateControl;
  routes: Array<MatchStateRoute | null>;
}> {
  const session = db.withSession("first-primary");
  const statements = [
    session.prepare("SELECT * FROM match_state_control WHERE singleton = 1"),
    ...inputs.map((input) =>
      prepareMatchStateRouteRead(session, input.playerId, input.matchId),
    ),
  ];
  let results: D1Result<ControlRow | MatchStateRouteRow>[];
  try {
    results = await session.batch<ControlRow | MatchStateRouteRow>(statements);
  } catch {
    throw new MatchStateD1Failure("control-unavailable");
  }
  if (!results[0]?.success)
    throw new MatchStateD1Failure("control-unavailable");
  const control = parseMatchStateControl(
    results[0].results?.[0] as ControlRow | undefined,
  );
  if (
    results.length !== inputs.length + 1 ||
    results
      .slice(1)
      .some((result) => !result.success || !Array.isArray(result.results))
  )
    throw new MatchStateD1Failure("routes-unavailable");
  return {
    control,
    routes: results
      .slice(1)
      .map((result) =>
        parseMatchStateRoute(
          result.results[0] as MatchStateRouteRow | undefined,
        ),
      ),
  };
}

export async function readLegacyMatchStates(
  db: D1Database,
  inputs: readonly { playerId: string; matchId: string }[],
  signal?: AbortSignal,
): Promise<unknown[]> {
  signal?.throwIfAborted();
  if (inputs.length === 0) return [];
  for (const input of inputs) {
    safeKey(input.playerId);
    safeKey(input.matchId);
  }
  const session = db.withSession("first-primary");
  const results = await session.batch<{ record_json: string }>(
    inputs.map((input) =>
      session
        .prepare(
          "SELECT record_json FROM match_state_legacy_records WHERE actor_uid = ? AND match_id = ?",
        )
        .bind(input.playerId, input.matchId),
    ),
  );
  signal?.throwIfAborted();
  if (results.length !== inputs.length)
    throw new MatchStateD1Failure("legacy-record-unavailable");
  const missing: { playerId: string; matchId: string }[] = [];
  const values = results.map((result, index): unknown => {
    const row = result.results[0];
    if (row) return JSON.parse(row.record_json);
    missing.push(inputs[index]);
    return null;
  });
  if (missing.length > 0) {
    const routes = await readMatchStateRoutes(db, missing);
    signal?.throwIfAborted();
    if (routes.some((route) => route?.kind === "legacy"))
      throw new MatchStateD1Failure("legacy-record-unavailable");
  }
  return values;
}
