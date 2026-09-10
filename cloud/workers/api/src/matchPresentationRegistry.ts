import {
  isMatchPresentationSnapshot,
  type MatchPresentationSnapshot,
} from "@mons/shared/match-presentation";
import { parseInviteMatchIndex } from "@mons/shared/rematches";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";

export type MatchPresentationCreation = {
  inviteId: string;
  matchId: string;
  actorUid: string;
  emojiId: number;
  aura: string;
  sourceId: string;
};

export type MatchPresentationRegistration = Pick<
  MatchPresentationCreation,
  "inviteId" | "matchId" | "actorUid" | "sourceId"
> & {
  seedDigest: string;
  provenance: "creation" | "backfill";
};

export type MatchPresentationSeedRegistration = MatchPresentationCreation &
  MatchPresentationRegistration;

export type PrepareMatchPresentations = (
  creations: readonly MatchPresentationCreation[],
) => Promise<MatchPresentationRegistration[]>;

export type RegisteredMatchPresentationSnapshot = MatchPresentationSnapshot & {
  seedDigests: Record<string, string>;
};

export type MatchPresentationControl = {
  phase: "legacy" | "capture" | "durable";
  candidateVersionId: string | null;
  migrationId: string | null;
  captureStartedAtMs: number | null;
  sourceDigest: string | null;
  sourceCount: number | null;
  verificationDigest: string | null;
  verifiedAtMs: number | null;
  activatedAtMs: number | null;
};

type ControlRow = {
  phase: string;
  candidate_version_id: string | null;
  migration_id: string | null;
  capture_started_at_ms: number | null;
  source_digest: string | null;
  source_count: number | null;
  verification_digest: string | null;
  verified_at_ms: number | null;
  activated_at_ms: number | null;
};

type RegistrationRow = {
  invite_id: string;
  match_id: string;
  actor_uid: string;
  seed_digest: string;
  provenance: string;
  source_id: string;
};

const DIGEST = /^[a-f0-9]{64}$/;

export function assertMatchPresentationRegistration(
  row: MatchPresentationRegistration,
): void {
  if (
    !isSafeFirebaseKey(row.inviteId) ||
    !isSafeFirebaseKey(row.matchId) ||
    parseInviteMatchIndex(row.inviteId, row.matchId) === null ||
    !isCanonicalFirebaseUid(row.actorUid) ||
    !DIGEST.test(row.seedDigest) ||
    !["creation", "backfill"].includes(row.provenance) ||
    typeof row.sourceId !== "string" ||
    !row.sourceId.length ||
    row.sourceId.length > 512
  ) {
    throw new TypeError("invalid-match-presentation-registration");
  }
}

export async function matchPresentationSeedDigest(
  seed: Pick<
    MatchPresentationCreation,
    "inviteId" | "matchId" | "actorUid" | "emojiId" | "aura"
  >,
): Promise<string> {
  if (
    !isSafeFirebaseKey(seed.inviteId) ||
    !isSafeFirebaseKey(seed.matchId) ||
    parseInviteMatchIndex(seed.inviteId, seed.matchId) === null ||
    !isCanonicalFirebaseUid(seed.actorUid) ||
    !isMatchPresentationSnapshot({
      matchId: seed.matchId,
      players: {
        [seed.actorUid]: {
          matchId: seed.matchId,
          actorUid: seed.actorUid,
          emojiId: seed.emojiId,
          aura: seed.aura,
          revision: 0,
        },
      },
    })
  ) {
    throw new TypeError("invalid-match-presentation-seed");
  }
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        seed.inviteId,
        seed.matchId,
        seed.actorUid,
        seed.emojiId,
        seed.aura,
      ]),
    ),
  );
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export async function readMatchPresentationControl(
  db: D1Database,
): Promise<MatchPresentationControl> {
  const row = await db
    .withSession("first-primary")
    .prepare("SELECT * FROM match_presentation_control WHERE singleton = 1")
    .first<ControlRow>();
  if (
    !row ||
    !["legacy", "capture", "durable"].includes(row.phase) ||
    (row.phase !== "legacy" &&
      (!row.candidate_version_id ||
        !row.migration_id ||
        !Number.isSafeInteger(row.capture_started_at_ms))) ||
    (row.phase === "durable" &&
      (!row.source_digest ||
        !row.verification_digest ||
        !Number.isSafeInteger(row.source_count) ||
        !Number.isSafeInteger(row.activated_at_ms)))
  )
    throw new Error("match-presentation-control-unavailable");
  return {
    phase: row.phase as MatchPresentationControl["phase"],
    candidateVersionId: row.candidate_version_id,
    migrationId: row.migration_id,
    captureStartedAtMs: row.capture_started_at_ms,
    sourceDigest: row.source_digest,
    sourceCount: row.source_count,
    verificationDigest: row.verification_digest,
    verifiedAtMs: row.verified_at_ms,
    activatedAtMs: row.activated_at_ms,
  };
}

export function buildMatchPresentationRegistrationStatements(
  db: D1Database,
  rows: readonly MatchPresentationRegistration[],
  nowMs: number,
): D1PreparedStatement[] {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new TypeError("invalid-registration-time");
  return rows.flatMap((row) => {
    assertMatchPresentationRegistration(row);
    return [
      db
        .prepare(
          `INSERT INTO match_presentation_registration_guards (singleton)
        SELECT 0 WHERE EXISTS (SELECT 1 FROM match_presentation_registrations
          WHERE actor_uid = ? AND match_id = ? AND (invite_id != ? OR seed_digest != ?))`,
        )
        .bind(row.actorUid, row.matchId, row.inviteId, row.seedDigest),
      db
        .prepare(
          `INSERT OR IGNORE INTO match_presentation_registrations
        (invite_id, match_id, actor_uid, seed_digest, provenance, source_id, registered_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.inviteId,
          row.matchId,
          row.actorUid,
          row.seedDigest,
          row.provenance,
          row.sourceId,
          nowMs,
        ),
    ];
  });
}

export async function listMatchPresentationRegistrations(
  db: D1Database,
  inviteId: string,
  matchId: string,
): Promise<MatchPresentationRegistration[]> {
  if (!isSafeFirebaseKey(inviteId) || !isSafeFirebaseKey(matchId))
    throw new TypeError("invalid-presentation-key");
  const result = await db
    .withSession("first-primary")
    .prepare(
      "SELECT invite_id, match_id, actor_uid, seed_digest, provenance, source_id FROM match_presentation_registrations WHERE invite_id = ? AND match_id = ? ORDER BY actor_uid",
    )
    .bind(inviteId, matchId)
    .all<RegistrationRow>();
  if (!result.success || result.results.length > 2)
    throw new Error("match-presentation-registration-unavailable");
  return result.results.map((row) => {
    const value = {
      inviteId: row.invite_id,
      matchId: row.match_id,
      actorUid: row.actor_uid,
      seedDigest: row.seed_digest,
      provenance: row.provenance as MatchPresentationRegistration["provenance"],
      sourceId: row.source_id,
    };
    assertMatchPresentationRegistration(value);
    return value;
  });
}

export async function prepareCreatedMatchPresentations(
  env: Env,
  creations: readonly MatchPresentationCreation[],
): Promise<MatchPresentationRegistration[]> {
  if (creations.length === 0) return [];
  if (
    (await readMatchPresentationControl(env.PROFILE_GAMES_DB)).phase !==
    "durable"
  )
    throw new Error("match-presentation-authority-not-active");
  const groups = new Map<string, MatchPresentationSeedRegistration[]>();
  for (const creation of creations) {
    const row: MatchPresentationSeedRegistration = {
      ...creation,
      seedDigest: await matchPresentationSeedDigest(creation),
      provenance: "creation",
    };
    assertMatchPresentationRegistration(row);
    const group = groups.get(row.inviteId) || [];
    group.push(row);
    groups.set(row.inviteId, group);
  }
  const registrations: MatchPresentationRegistration[] = [];
  for (const [inviteId, rows] of groups) {
    const result = await env.INVITE_REACTIONS.getByName(
      inviteId,
    ).registerPresentationSeeds(inviteId, rows);
    for (const row of rows) {
      const found = result.find(
        (value) =>
          value.matchId === row.matchId && value.actorUid === row.actorUid,
      );
      if (
        !found ||
        found.seedDigest !== row.seedDigest ||
        found.inviteId !== inviteId
      )
        throw new Error("match-presentation-seed-unacknowledged");
      registrations.push(found);
    }
  }
  return registrations;
}

export function selectRegisteredPresentations(
  matchId: string,
  registrations: readonly MatchPresentationRegistration[],
  snapshot: RegisteredMatchPresentationSnapshot,
): MatchPresentationSnapshot {
  if (
    !isMatchPresentationSnapshot({
      matchId: snapshot.matchId,
      players: snapshot.players,
    }) ||
    snapshot.matchId !== matchId ||
    !snapshot.seedDigests
  )
    throw new Error("match-presentation-unavailable");
  const players = Object.fromEntries(
    registrations.map((row) => {
      if (
        !Object.hasOwn(snapshot.players, row.actorUid) ||
        snapshot.seedDigests[row.actorUid] !== row.seedDigest
      )
        throw new Error("match-presentation-unavailable");
      return [row.actorUid, snapshot.players[row.actorUid]];
    }),
  );
  return { matchId, players };
}

export async function readRegisteredMatchPresentations(
  env: Env,
  inviteId: string,
  matchId: string,
): Promise<MatchPresentationSnapshot> {
  const rows = await listMatchPresentationRegistrations(
    env.PROFILE_GAMES_DB,
    inviteId,
    matchId,
  );
  if (!rows.length) return { matchId, players: {} };
  const snapshot =
    await env.INVITE_REACTIONS.getByName(
      inviteId,
    ).getRegisteredPresentationSnapshot(matchId);
  return selectRegisteredPresentations(matchId, rows, snapshot);
}

export async function freezeRegisteredMatchPresentations(
  env: Env,
  inviteId: string,
  matchId: string,
  actorUids: readonly string[],
): Promise<MatchPresentationSnapshot> {
  if (
    !actorUids.length ||
    actorUids.length > 2 ||
    actorUids.some((uid) => !isCanonicalFirebaseUid(uid))
  )
    throw new TypeError("invalid-presentation-actors");
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  const frozen = await room.getFrozenPresentationSnapshot(matchId);
  if (!isMatchPresentationSnapshot(frozen) || frozen.matchId !== matchId)
    throw new Error("historical-match-presentation-unavailable");
  const missing = actorUids.filter(
    (uid) => !Object.hasOwn(frozen.players, uid),
  );
  if (missing.length) {
    const registrations = await listMatchPresentationRegistrations(
      env.PROFILE_GAMES_DB,
      inviteId,
      matchId,
    );
    const rows = registrations.filter((row) => missing.includes(row.actorUid));
    if (rows.length !== missing.length)
      throw new Error("historical-match-presentation-unavailable");
    selectRegisteredPresentations(
      matchId,
      rows,
      await room.getRegisteredPresentationSnapshot(matchId),
    );
  }
  return room.freezeRegisteredPresentations(matchId, [...actorUids]);
}
