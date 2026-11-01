import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { isAura, type Aura } from "@mons/shared/appearance";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { REACTION_SOCKET_PROTOCOL } from "@mons/shared/reactions";
import { buildMatchPresentationRegistrationStatements } from "../src/matchPresentationRegistry.ts";
import type { MatchPresentationSnapshot } from "@mons/shared/match-presentation";
import { runInCanonicalMatchRoom as runInDurableObject } from "./canonicalMatchTestFixture.ts";
import type { InviteReactions } from "../src/inviteReactions.ts";
import { matchPresentationSeedDigest } from "../src/matchPresentationRegistry.ts";

type Seeds = Record<string, { emojiId: number; aura: string }>;
type Room = DurableObjectStub<InviteReactions>;
function fixtureAura(value: string): Aura {
  const aura = value === "" ? "none" : value;
  if (!isAura(aura)) throw new TypeError("invalid fixture aura");
  return aura;
}

export function readStoredPresentationsFromStorage(
  storage: DurableObjectStorage,
  matchId: string,
  frozen = false,
): MatchPresentationSnapshot {
  const table = frozen
    ? "frozen_match_presentations_canonical"
    : "match_presentations_canonical";
  const rows = storage.sql
    .exec<{
      actor_uid: string;
      emoji_id: number;
      aura: Aura;
      revision: number;
    }>(
      `SELECT actor_uid, emoji_id, aura, revision FROM ${table} WHERE match_id = ? ORDER BY actor_uid`,
      matchId,
    )
    .toArray();
  return {
    matchId,
    players: Object.fromEntries(
      rows.map((row) => [
        row.actor_uid,
        {
          matchId,
          actorUid: row.actor_uid,
          emojiId: row.emoji_id,
          aura: row.aura,
          revision: row.revision,
        },
      ]),
    ),
  };
}

export function readStoredPresentations(room: Room, matchId: string) {
  return runInDurableObject(room, (_instance, state) =>
    readStoredPresentationsFromStorage(state.storage, matchId),
  );
}

export async function registerTestPresentations(
  room: Pick<
    InviteReactions,
    "registerPresentationSeeds" | "getRegisteredPresentationSnapshot"
  >,
  inviteId: string,
  matchId: string,
  seeds: Seeds,
) {
  await room.registerPresentationSeeds(
    inviteId,
    await Promise.all(
      Object.entries(seeds).map(async ([actorUid, appearance]) => {
        const seed = {
          inviteId,
          matchId,
          actorUid,
          ...appearance,
          aura: fixtureAura(appearance.aura),
        };
        return {
          ...seed,
          seedDigest: await matchPresentationSeedDigest(seed),
          provenance: "creation" as const,
          sourceId: "test-creation",
        };
      }),
    ),
  );
  const { seedDigests: _proof, ...snapshot } =
    await room.getRegisteredPresentationSnapshot(matchId);
  return snapshot;
}

export function seedHistoricalPresentations(
  room: Room,
  matchId: string,
  seeds: Seeds,
) {
  return runInDurableObject(room, (_instance, state) => {
    for (const [actorUid, appearance] of Object.entries(seeds))
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO match_presentations_canonical (match_id, actor_uid, emoji_id, aura, revision) VALUES (?, ?, ?, ?, 0)",
        matchId,
        actorUid,
        appearance.emojiId,
        fixtureAura(appearance.aura),
      );
    return readStoredPresentationsFromStorage(state.storage, matchId);
  });
}

export async function freezeHistoricalPresentations(
  room: Room,
  matchId: string,
  seeds: Seeds,
) {
  await seedHistoricalPresentations(room, matchId, seeds);
  return runInDurableObject(room, (_instance, state) => {
    for (const actorUid of Object.keys(seeds))
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO frozen_match_presentations_canonical (match_id, actor_uid, emoji_id, aura, revision) SELECT match_id, actor_uid, emoji_id, aura, revision FROM match_presentations_canonical WHERE match_id = ? AND actor_uid = ?",
        matchId,
        actorUid,
      );
    return readStoredPresentationsFromStorage(state.storage, matchId, true);
  });
}

export async function reactionSocketTestHeaders(
  room: Room,
  inviteId: string,
  matchId = inviteId,
): Promise<Record<string, string>> {
  await applyCanonicalTestMigrations(
    env.PROFILE_GAMES_DB,
    (env as Env & { TEST_D1_MIGRATIONS: D1Migration[] }).TEST_D1_MIGRATIONS,
  );
  const existing = await runInDurableObject(room, (_instance, state) =>
    state.storage.sql
      .exec<{
        actor_uid: string;
        seed_digest: string;
        emoji_id: number;
        aura: string;
        provenance: "creation" | "backfill";
        source_id: string;
      }>(
        "SELECT actor_uid, seed_digest, emoji_id, aura, provenance, source_id FROM match_presentation_seeds_canonical WHERE match_id = ? ORDER BY actor_uid",
        matchId,
      )
      .toArray(),
  );
  if (!existing.length) {
    const current = await readStoredPresentations(room, matchId);
    const seeds = Object.keys(current.players).length
      ? Object.fromEntries(
          Object.entries(current.players).map(([actorUid, value]) => [
            actorUid,
            { emojiId: value.emojiId, aura: value.aura },
          ]),
        )
      : {
          "host-login": { emojiId: 1, aura: "none" },
          "guest-login": { emojiId: 2, aura: "none" },
        };
    await registerTestPresentations(room, inviteId, matchId, seeds);
  }
  const snapshot = await room.getRegisteredPresentationSnapshot(matchId);
  const rows = Object.entries(snapshot.seedDigests).map(
    ([actorUid, seedDigest]) => ({
      inviteId,
      matchId,
      actorUid,
      seedDigest,
      provenance: "creation" as const,
      sourceId: "test-creation",
    }),
  );
  await env.PROFILE_GAMES_DB.batch(
    buildMatchPresentationRegistrationStatements(env.PROFILE_GAMES_DB, rows, 1),
  );
  return {
    "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL,
    "X-Mons-Presentation-Match": encodeURIComponent(matchId),
    "X-Mons-Presentation-Canonical": "1",
    "X-Mons-Presentation-Actors": encodeURIComponent(
      JSON.stringify(rows.map((row) => row.actorUid)),
    ),
  };
}
