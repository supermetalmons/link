import { readBoundedText } from "./boundedStreams.ts";
import {
  buildMatchStateRouteStatements,
  readMatchStateControl,
  type MatchStateControl,
} from "./matchStateD1.ts";
import {
  MATCH_STATE_MIGRATION_MAX_BYTES,
  matchStateCanonicalJson,
  parseMatchStateMigrationRequest,
  type MatchStateMigrationRequest,
} from "./matchStateMigration.ts";
import { verifyMatchStateMigrationSignature } from "./matchStateMigrationAuth.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "./matchStateRpc.ts";
import type { MatchStateImportSnapshot } from "./matchStateTypes.ts";

type Dependencies = {
  now?: () => number;
  readControl?: () => Promise<MatchStateControl>;
  execute?: (
    input: MatchStateMigrationRequest,
  ) => Promise<MatchStateImportSnapshot>;
};

function migrationGuards(
  db: D1Database,
  input: MatchStateMigrationRequest,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO match_state_guards (singleton) SELECT 0 WHERE NOT EXISTS (
      SELECT 1 FROM match_state_control AS control JOIN match_state_operator_lock AS lock ON lock.singleton = control.singleton
      WHERE control.singleton = 1 AND control.backend = 'rtdb' AND control.state = 'frozen'
        AND control.import_id = ? AND control.source_digest = ? AND control.epoch + 1 = ?
        AND lock.import_id = control.import_id AND lock.owner_token = ?
        AND NOT EXISTS (SELECT 1 FROM match_state_write_admissions))`,
      )
      .bind(
        input.bundle.importId,
        input.sourceDigest,
        input.bundle.epoch,
        input.ownerToken,
      ),
  ];
}

async function executeMigration(
  env: Env,
  input: MatchStateMigrationRequest,
): Promise<MatchStateImportSnapshot> {
  const db = env.PROFILE_GAMES_DB;
  await db.batch(migrationGuards(db, input));
  const { bundle } = input;
  const room = getMatchStateRpc(env, bundle.inviteId);
  const target = {
    inviteId: bundle.inviteId,
    importId: bundle.importId,
    epoch: bundle.epoch,
  };
  if (input.operation === "import") {
    const result = unwrapMatchStateRpc(await room.importMatchState(bundle));
    if (matchStateCanonicalJson(result) !== matchStateCanonicalJson(bundle))
      throw new Error("match-state-import-readback-conflict");
    await db.batch([
      ...migrationGuards(db, input),
      ...buildMatchStateRouteStatements(
        db,
        bundle.records.map((row) => ({
          actorUid: row.playerId,
          matchId: row.matchId,
          kind: "durable" as const,
          inviteId: bundle.inviteId,
          epoch: bundle.epoch,
        })),
      ),
      db
        .prepare(
          `INSERT OR IGNORE INTO match_state_import_receipts
        (import_id, invite_id, epoch, digest, record_count, claim_count, phase)
        VALUES (?, ?, ?, ?, ?, ?, 'staged')`,
        )
        .bind(
          bundle.importId,
          bundle.inviteId,
          bundle.epoch,
          bundle.digest,
          bundle.recordCount,
          bundle.claimCount,
        ),
    ]);
  }
  const snapshot = unwrapMatchStateRpc(
    await room.inspectMatchStateImport(target),
  );
  if (matchStateCanonicalJson(snapshot) !== matchStateCanonicalJson(bundle))
    throw new Error("match-state-import-readback-conflict");
  if (input.operation === "activate") {
    const receipt = await db
      .prepare(
        `SELECT phase FROM match_state_import_receipts
      WHERE import_id = ? AND invite_id = ? AND epoch = ? AND digest = ?`,
      )
      .bind(bundle.importId, bundle.inviteId, bundle.epoch, bundle.digest)
      .first<{ phase: string }>();
    if (!receipt || !["verified", "active"].includes(receipt.phase))
      throw new Error("match-state-import-not-verified");
    const active = unwrapMatchStateRpc(
      await room.activateMatchState({
        ...target,
        digest: bundle.digest,
        recordCount: bundle.recordCount,
        claimCount: bundle.claimCount,
      }),
    );
    if (
      active.status !== "active" ||
      active.epoch !== bundle.epoch ||
      active.importId !== bundle.importId ||
      active.digest !== bundle.digest
    )
      throw new Error("match-state-activation-unconfirmed");
  }
  if (input.operation !== "import") {
    const result = await db.batch([
      ...migrationGuards(db, input),
      db
        .prepare(
          `UPDATE match_state_import_receipts SET phase = ?
        WHERE import_id = ? AND invite_id = ? AND epoch = ? AND digest = ?
          AND record_count = ? AND claim_count = ?`,
        )
        .bind(
          input.operation === "activate" ? "active" : "verified",
          bundle.importId,
          bundle.inviteId,
          bundle.epoch,
          bundle.digest,
          bundle.recordCount,
          bundle.claimCount,
        ),
    ]);
    if (result[1].meta.changes !== 1)
      throw new Error("match-state-receipt-unconfirmed");
  }
  return bundle;
}

function response(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleMatchStateMigrationRoute(
  request: Request,
  env: Env,
  dependencies: Dependencies = {},
): Promise<Response> {
  if (request.method !== "POST")
    return response(405, { ok: false, error: "method-not-allowed" });
  const secret = env.MATCH_STATE_MIGRATION_SECRET?.trim() || "";
  if (!secret) return response(404, { ok: false, error: "not-found" });
  let body: string;
  try {
    if (!request.body) throw new Error("missing-body");
    body = await readBoundedText(
      request.body,
      MATCH_STATE_MIGRATION_MAX_BYTES,
      () => new Error("body-too-large"),
    );
  } catch {
    return response(400, { ok: false, error: "invalid-request" });
  }
  if (
    !(await verifyMatchStateMigrationSignature(
      body,
      secret,
      request.headers.get("X-Mons-Match-State-Timestamp") || "",
      request.headers.get("X-Mons-Match-State-Signature") || "",
      (dependencies.now || Date.now)(),
    ))
  )
    return response(401, { ok: false, error: "unauthenticated" });
  let input: MatchStateMigrationRequest;
  try {
    input = await parseMatchStateMigrationRequest(body);
  } catch {
    return response(400, { ok: false, error: "invalid-request" });
  }
  try {
    const control = await (
      dependencies.readControl ||
      (() => readMatchStateControl(env.PROFILE_GAMES_DB))
    )();
    if (control.backend === "durable")
      return response(410, { ok: false, error: "migration-retired" });
    if (
      control.state !== "frozen" ||
      control.importId !== input.bundle.importId ||
      control.sourceDigest !== input.sourceDigest ||
      control.epoch + 1 !== input.bundle.epoch
    )
      return response(409, { ok: false, error: "migration-control-conflict" });
    const bundle = await (
      dependencies.execute || ((value) => executeMigration(env, value))
    )(input);
    return response(200, { ok: true, bundle });
  } catch {
    return response(503, { ok: false, error: "migration-unavailable" });
  }
}
