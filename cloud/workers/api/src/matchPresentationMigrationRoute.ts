import type { MatchPresentation } from "@mons/shared/match-presentation";
import { readBoundedText } from "./boundedStreams.ts";
import {
  buildMatchPresentationRegistrationStatements,
  listMatchPresentationRegistrations,
  matchPresentationSeedDigest,
  readMatchPresentationControl,
  readRegisteredMatchPresentations,
  type MatchPresentationControl,
  type MatchPresentationCreation,
  type MatchPresentationRegistration,
  type MatchPresentationSeedRegistration,
} from "./matchPresentationRegistry.ts";
import { verifyMatchPresentationMigrationSignature } from "./matchPresentationMigrationAuth.ts";

export const MATCH_PRESENTATION_MIGRATION_PATH =
  "/internal/match-presentations/migration";
export const MATCH_PRESENTATION_MIGRATION_MAX_BYTES = 256 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type MatchPresentationMigrationRow = Omit<
  MatchPresentationCreation,
  "sourceId"
> & { seedDigest: string };
export type MatchPresentationMigrationRequest = {
  schemaVersion: 1;
  operation: "import" | "readback";
  migrationId: string;
  sourceDigest: string;
  rows: MatchPresentationMigrationRow[];
};
export type MatchPresentationMigrationResult = MatchPresentationRegistration & {
  presentation: MatchPresentation;
};

type MigrationDependencies = {
  now?: () => number;
  readControl?: () => Promise<MatchPresentationControl>;
  execute?: (
    input: MatchPresentationMigrationRequest,
  ) => Promise<MatchPresentationMigrationResult[]>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

export async function parseMatchPresentationMigrationRequest(
  body: string,
): Promise<MatchPresentationMigrationRequest> {
  const input: unknown = JSON.parse(body);
  if (
    !record(input) ||
    !exactFields(input, [
      "schemaVersion",
      "operation",
      "migrationId",
      "sourceDigest",
      "rows",
    ]) ||
    input.schemaVersion !== 1 ||
    !["import", "readback"].includes(String(input.operation)) ||
    typeof input.migrationId !== "string" ||
    !UUID.test(input.migrationId) ||
    typeof input.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sourceDigest) ||
    !Array.isArray(input.rows) ||
    !input.rows.length ||
    input.rows.length > 100
  )
    throw new TypeError("invalid-migration-request");
  const rows: MatchPresentationMigrationRow[] = [];
  const seen = new Set<string>();
  for (const raw of input.rows) {
    if (
      !record(raw) ||
      !exactFields(raw, [
        "inviteId",
        "matchId",
        "actorUid",
        "emojiId",
        "aura",
        "seedDigest",
      ]) ||
      typeof raw.inviteId !== "string" ||
      typeof raw.matchId !== "string" ||
      typeof raw.actorUid !== "string" ||
      typeof raw.emojiId !== "number" ||
      typeof raw.aura !== "string" ||
      typeof raw.seedDigest !== "string"
    )
      throw new TypeError("invalid-migration-row");
    const row: MatchPresentationMigrationRow = {
      inviteId: raw.inviteId,
      matchId: raw.matchId,
      actorUid: raw.actorUid,
      emojiId: raw.emojiId,
      aura: raw.aura,
      seedDigest: raw.seedDigest,
    };
    const key = JSON.stringify([row.actorUid, row.matchId]);
    if (
      seen.has(key) ||
      (await matchPresentationSeedDigest(row)) !== row.seedDigest
    )
      throw new TypeError("invalid-migration-row");
    seen.add(key);
    rows.push(row);
  }
  return {
    schemaVersion: 1,
    operation: input.operation as "import" | "readback",
    migrationId: input.migrationId,
    sourceDigest: input.sourceDigest,
    rows,
  };
}

async function executeMigrationBatch(
  env: Env,
  input: MatchPresentationMigrationRequest,
): Promise<MatchPresentationMigrationResult[]> {
  if (input.operation === "import") {
    const groups = new Map<string, MatchPresentationSeedRegistration[]>();
    for (const row of input.rows) {
      const group = groups.get(row.inviteId) || [];
      group.push({
        ...row,
        provenance: "backfill",
        sourceId: `backfill:${input.migrationId}:${row.seedDigest}`,
      });
      groups.set(row.inviteId, group);
    }
    const registrations: MatchPresentationRegistration[] = [];
    for (const [inviteId, seeds] of groups) {
      const result = await env.INVITE_REACTIONS.getByName(
        inviteId,
      ).registerPresentationSeeds(inviteId, seeds);
      for (const row of seeds) {
        const acknowledged = result.find(
          (value) =>
            value.matchId === row.matchId && value.actorUid === row.actorUid,
        );
        if (
          !acknowledged ||
          acknowledged.inviteId !== inviteId ||
          acknowledged.seedDigest !== row.seedDigest
        )
          throw new Error("migration-seed-unacknowledged");
        registrations.push(acknowledged);
      }
    }
    await env.PROFILE_GAMES_DB.batch([
      env.PROFILE_GAMES_DB.prepare(
        `INSERT INTO match_presentation_registration_guards (singleton)
        SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM match_presentation_control
          WHERE singleton = 1 AND phase = 'capture' AND migration_id = ? AND source_digest = ?)`,
      ).bind(input.migrationId, input.sourceDigest),
      ...buildMatchPresentationRegistrationStatements(
        env.PROFILE_GAMES_DB,
        registrations,
        Date.now(),
      ),
    ]);
  }
  const results: MatchPresentationMigrationResult[] = [];
  const matches = new Map<string, MatchPresentationMigrationRow[]>();
  for (const row of input.rows) {
    const key = JSON.stringify([row.inviteId, row.matchId]);
    const group = matches.get(key) || [];
    group.push(row);
    matches.set(key, group);
  }
  for (const rows of matches.values()) {
    const { inviteId, matchId } = rows[0];
    const registrations = await listMatchPresentationRegistrations(
      env.PROFILE_GAMES_DB,
      inviteId,
      matchId,
    );
    const snapshot = await readRegisteredMatchPresentations(
      env,
      inviteId,
      matchId,
    );
    for (const row of rows) {
      const registered = registrations.find(
        (value) => value.actorUid === row.actorUid,
      );
      if (
        !registered ||
        registered.seedDigest !== row.seedDigest ||
        !Object.hasOwn(snapshot.players, row.actorUid)
      )
        throw new Error("migration-readback-mismatch");
      results.push({
        ...registered,
        presentation: snapshot.players[row.actorUid],
      });
    }
  }
  return results;
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

export async function handleMatchPresentationMigrationRoute(
  request: Request,
  env: Env,
  dependencies: MigrationDependencies = {},
): Promise<Response> {
  if (request.method !== "POST")
    return response(405, { ok: false, error: "method-not-allowed" });
  const secret = env.MATCH_PRESENTATION_MIGRATION_SECRET?.trim() || "";
  if (!secret) return response(404, { ok: false, error: "not-found" });
  let body: string;
  try {
    if (!request.body) throw new TypeError("missing-migration-body");
    body = await readBoundedText(
      request.body,
      MATCH_PRESENTATION_MIGRATION_MAX_BYTES,
      () => new Error("migration-body-too-large"),
    );
  } catch {
    return response(400, { ok: false, error: "invalid-request" });
  }
  const timestamp = request.headers.get("X-Mons-Migration-Timestamp") || "";
  const signature = request.headers.get("X-Mons-Migration-Signature") || "";
  if (
    !(await verifyMatchPresentationMigrationSignature(
      body,
      secret,
      timestamp,
      signature,
      (dependencies.now || Date.now)(),
    ))
  )
    return response(401, { ok: false, error: "unauthenticated" });
  let input: MatchPresentationMigrationRequest;
  try {
    input = await parseMatchPresentationMigrationRequest(body);
  } catch {
    return response(400, { ok: false, error: "invalid-request" });
  }
  try {
    const control = await (
      dependencies.readControl ||
      (() => readMatchPresentationControl(env.PROFILE_GAMES_DB))
    )();
    if (control.phase === "durable")
      return response(410, { ok: false, error: "migration-retired" });
    if (
      control.phase !== "capture" ||
      control.migrationId !== input.migrationId ||
      control.sourceDigest !== input.sourceDigest
    )
      return response(409, { ok: false, error: "migration-control-conflict" });
    const rows = await (
      dependencies.execute || ((value) => executeMigrationBatch(env, value))
    )(input);
    return response(200, { ok: true, rows });
  } catch {
    return response(503, { ok: false, error: "migration-unavailable" });
  }
}
