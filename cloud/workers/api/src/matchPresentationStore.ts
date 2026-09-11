import {
  isMatchPresentationSnapshot,
  isUpdateMatchPresentationRequest,
  type MatchPresentation,
  type MatchPresentationSnapshot,
  type UpdateMatchPresentationRequest,
} from "@mons/shared/match-presentation";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import {
  assertMatchPresentationRegistration,
  matchPresentationSeedDigest,
  type MatchPresentationRegistration,
  type MatchPresentationSeedRegistration,
  type RegisteredMatchPresentationSnapshot,
} from "./matchPresentationRegistry.ts";

type StoredPresentation = {
  match_id: string;
  actor_uid: string;
  emoji_id: number;
  aura: string;
  revision: number;
  operation_id: string | null;
  operation_json: string | null;
};

type StoredPresentationSeed = {
  invite_id: string;
  match_id: string;
  actor_uid: string;
  seed_digest: string;
  emoji_id: number;
  aura: string;
  provenance: "creation" | "backfill";
  source_id: string;
};

export type MatchPresentationSeeds = Record<
  string,
  { emojiId: number; aura: string }
>;
export type MatchPresentationUpdateResult = {
  status: "updated" | "duplicate" | "conflict";
  presentation: MatchPresentation;
};

function presentationFromRow(row: StoredPresentation): MatchPresentation {
  return {
    matchId: row.match_id,
    actorUid: row.actor_uid,
    emojiId: row.emoji_id,
    aura: row.aura,
    revision: row.revision,
  };
}

export class MatchPresentationStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly dependencies: { pinInvite: (inviteId: string) => void },
  ) {
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_presentations (match_id TEXT NOT NULL, actor_uid TEXT NOT NULL, emoji_id INTEGER NOT NULL, aura TEXT NOT NULL, revision INTEGER NOT NULL, operation_id TEXT, operation_json TEXT, PRIMARY KEY(match_id, actor_uid))",
    );
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS frozen_match_presentations (match_id TEXT NOT NULL, actor_uid TEXT NOT NULL, emoji_id INTEGER NOT NULL, aura TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(match_id, actor_uid))",
    );
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_presentation_seeds (match_id TEXT NOT NULL, actor_uid TEXT NOT NULL, invite_id TEXT NOT NULL, seed_digest TEXT NOT NULL, emoji_id INTEGER NOT NULL, aura TEXT NOT NULL, provenance TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(match_id, actor_uid))",
    );
  }

  readPresentations(
    matchId: string,
    frozen = false,
  ): MatchPresentationSnapshot {
    const rows = this.storage.sql
      .exec<StoredPresentation>(
        frozen
          ? "SELECT match_id, actor_uid, emoji_id, aura, revision FROM frozen_match_presentations WHERE match_id = ? ORDER BY actor_uid"
          : "SELECT * FROM match_presentations WHERE match_id = ? ORDER BY actor_uid",
        matchId,
      )
      .toArray();
    return {
      matchId,
      players: Object.fromEntries(
        rows.map((row) => [row.actor_uid, presentationFromRow(row)]),
      ),
    };
  }

  private initializePresentations(
    matchId: string,
    seeds: MatchPresentationSeeds,
  ): MatchPresentationSnapshot {
    const normalized: MatchPresentationSnapshot = {
      matchId,
      players: Object.fromEntries(
        Object.entries(seeds).map(([actorUid, seed]) => [
          actorUid,
          {
            matchId,
            actorUid,
            emojiId: seed.emojiId,
            aura: seed.aura,
            revision: 0,
          },
        ]),
      ),
    };
    if (
      !isMatchPresentationSnapshot(normalized) ||
      Object.keys(seeds).some((uid) => !isCanonicalLoginUid(uid))
    ) {
      throw new TypeError("invalid-presentation-seeds");
    }
    const current = this.readPresentations(matchId);
    if (
      new Set([...Object.keys(current.players), ...Object.keys(seeds)]).size > 2
    ) {
      throw new TypeError("presentation-participant-limit");
    }
    for (const [actorUid, seed] of Object.entries(seeds)) {
      if (
        !Object.hasOwn(current.players, actorUid) &&
        this.storage.sql
          .exec(
            "SELECT 1 FROM match_presentation_seeds WHERE match_id = ? AND actor_uid = ?",
            matchId,
            actorUid,
          )
          .toArray().length
      ) {
        throw new Error("match-presentation-unavailable");
      }
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO match_presentations (match_id, actor_uid, emoji_id, aura, revision) VALUES (?, ?, ?, ?, 0)",
        matchId,
        actorUid,
        seed.emojiId,
        seed.aura,
      );
    }
    return this.readPresentations(matchId);
  }

  ensurePresentations(
    matchId: string,
    seeds: MatchPresentationSeeds,
  ): MatchPresentationSnapshot {
    return this.storage.transactionSync(() =>
      this.initializePresentations(matchId, seeds),
    );
  }

  getPresentationSnapshot(matchId: string): MatchPresentationSnapshot {
    return this.readPresentations(matchId);
  }

  private readCanonicalPresentationPlayers(
    matchId: string,
    actorUids: readonly string[],
  ): MatchPresentationSnapshot {
    const snapshot = this.registeredPresentationSnapshot(matchId);
    const players = Object.fromEntries(
      actorUids.map((actorUid) => {
        if (!Object.hasOwn(snapshot.players, actorUid))
          throw new Error("match-presentation-unavailable");
        return [actorUid, snapshot.players[actorUid]];
      }),
    );
    return { matchId, players };
  }

  registeredPresentationSnapshot(
    matchId: string,
  ): RegisteredMatchPresentationSnapshot {
    if (!isSafeRecordKey(matchId))
      throw new TypeError("invalid-presentation-match");
    const seeds = this.storage.sql
      .exec<StoredPresentationSeed>(
        "SELECT * FROM match_presentation_seeds WHERE match_id = ? ORDER BY actor_uid",
        matchId,
      )
      .toArray();
    const current = this.readPresentations(matchId);
    const players = Object.fromEntries(
      seeds.map((seed) => {
        if (!Object.hasOwn(current.players, seed.actor_uid))
          throw new Error("match-presentation-unavailable");
        return [seed.actor_uid, current.players[seed.actor_uid]];
      }),
    );
    const seedDigests = Object.fromEntries(
      seeds.map((seed) => [seed.actor_uid, seed.seed_digest]),
    );
    const snapshot = { matchId, players, seedDigests };
    if (!isMatchPresentationSnapshot({ matchId, players }))
      throw new Error("match-presentation-unavailable");
    return snapshot;
  }

  async registerPresentationSeeds(
    inviteId: string,
    seeds: MatchPresentationSeedRegistration[],
  ): Promise<MatchPresentationRegistration[]> {
    if (!seeds.length || seeds.length > 100)
      throw new TypeError("invalid-presentation-seed-batch");
    for (const seed of seeds) {
      assertMatchPresentationRegistration(seed);
      if (
        seed.inviteId !== inviteId ||
        (await matchPresentationSeedDigest(seed)) !== seed.seedDigest
      )
        throw new TypeError("invalid-presentation-seed-digest");
    }
    return this.storage.transactionSync(() => {
      this.dependencies.pinInvite(inviteId);
      return seeds.map((seed) => {
        const existing = this.storage.sql
          .exec<StoredPresentationSeed>(
            "SELECT * FROM match_presentation_seeds WHERE match_id = ? AND actor_uid = ?",
            seed.matchId,
            seed.actorUid,
          )
          .toArray()[0];
        if (
          existing &&
          (existing.invite_id !== inviteId ||
            existing.seed_digest !== seed.seedDigest ||
            existing.emoji_id !== seed.emojiId ||
            existing.aura !== seed.aura)
        ) {
          throw new Error("match-presentation-seed-conflict");
        }
        if (
          existing &&
          !Object.hasOwn(
            this.readPresentations(seed.matchId).players,
            seed.actorUid,
          )
        ) {
          throw new Error("match-presentation-unavailable");
        }
        this.initializePresentations(seed.matchId, {
          [seed.actorUid]: { emojiId: seed.emojiId, aura: seed.aura },
        });
        this.storage.sql.exec(
          "INSERT OR IGNORE INTO match_presentation_seeds (match_id, actor_uid, invite_id, seed_digest, emoji_id, aura, provenance, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          seed.matchId,
          seed.actorUid,
          inviteId,
          seed.seedDigest,
          seed.emojiId,
          seed.aura,
          seed.provenance,
          seed.sourceId,
        );
        const snapshot = this.registeredPresentationSnapshot(seed.matchId);
        if (snapshot.seedDigests[seed.actorUid] !== seed.seedDigest)
          throw new Error("match-presentation-seed-unacknowledged");
        return {
          inviteId,
          matchId: seed.matchId,
          actorUid: seed.actorUid,
          seedDigest: seed.seedDigest,
          provenance: existing?.provenance || seed.provenance,
          sourceId: existing?.source_id || seed.sourceId,
        };
      });
    });
  }

  getRegisteredPresentationSnapshot(
    matchId: string,
  ): RegisteredMatchPresentationSnapshot {
    return this.registeredPresentationSnapshot(matchId);
  }

  getFrozenPresentationSnapshot(matchId: string): MatchPresentationSnapshot {
    if (!isSafeRecordKey(matchId))
      throw new TypeError("invalid-presentation-match");
    return this.readPresentations(matchId, true);
  }

  freezeRegisteredPresentations(
    matchId: string,
    actorUids: string[],
  ): MatchPresentationSnapshot {
    if (
      !actorUids.length ||
      actorUids.length > 2 ||
      actorUids.some((uid) => !isCanonicalLoginUid(uid))
    )
      throw new TypeError("invalid-presentation-actors");
    return this.storage.transactionSync(() => {
      const frozen = this.readPresentations(matchId, true);
      const missing = actorUids.filter(
        (uid) => !Object.hasOwn(frozen.players, uid),
      );
      if (missing.length) {
        const snapshot = this.readCanonicalPresentationPlayers(
          matchId,
          missing,
        );
        for (const actorUid of missing) {
          const value = snapshot.players[actorUid];
          this.storage.sql.exec(
            "INSERT OR IGNORE INTO frozen_match_presentations (match_id, actor_uid, emoji_id, aura, revision) VALUES (?, ?, ?, ?, ?)",
            matchId,
            actorUid,
            value.emojiId,
            value.aura,
            value.revision,
          );
        }
      }
      return this.readPresentations(matchId, true);
    });
  }

  freezePresentations(
    matchId: string,
    seeds: MatchPresentationSeeds,
  ): MatchPresentationSnapshot {
    return this.storage.transactionSync(() => {
      const current = this.initializePresentations(matchId, seeds);
      for (const actorUid of Object.keys(seeds)) {
        const presentation = current.players[actorUid];
        this.storage.sql.exec(
          "INSERT OR IGNORE INTO frozen_match_presentations (match_id, actor_uid, emoji_id, aura, revision) VALUES (?, ?, ?, ?, ?)",
          matchId,
          actorUid,
          presentation.emojiId,
          presentation.aura,
          presentation.revision,
        );
      }
      return this.readPresentations(matchId, true);
    });
  }

  updatePresentation(
    actorUid: string,
    matchId: string,
    request: UpdateMatchPresentationRequest,
  ): MatchPresentationUpdateResult {
    if (
      !isCanonicalLoginUid(actorUid) ||
      !isUpdateMatchPresentationRequest(request)
    ) {
      throw new TypeError("invalid-presentation-update");
    }
    const operationJson = JSON.stringify({
      operationId: request.operationId,
      expectedRevision: request.expectedRevision,
      emojiId: request.emojiId,
      aura: request.aura,
    });
    const result = this.storage.transactionSync(
      (): MatchPresentationUpdateResult => {
        const [row] = this.storage.sql
          .exec<StoredPresentation>(
            "SELECT * FROM match_presentations WHERE match_id = ? AND actor_uid = ?",
            matchId,
            actorUid,
          )
          .toArray();
        if (!row) throw new TypeError("presentation-not-initialized");
        const current = presentationFromRow(row);
        if (row.operation_id === request.operationId) {
          return {
            status:
              row.operation_json === operationJson ? "duplicate" : "conflict",
            presentation: current,
          };
        }
        if (
          row.revision !== request.expectedRevision ||
          row.revision === Number.MAX_SAFE_INTEGER
        ) {
          return { status: "conflict", presentation: current };
        }
        const presentation = {
          ...current,
          emojiId: request.emojiId,
          aura: request.aura,
          revision: current.revision + 1,
        };
        this.storage.sql.exec(
          "UPDATE match_presentations SET emoji_id = ?, aura = ?, revision = ?, operation_id = ?, operation_json = ? WHERE match_id = ? AND actor_uid = ?",
          presentation.emojiId,
          presentation.aura,
          presentation.revision,
          request.operationId,
          operationJson,
          matchId,
          actorUid,
        );
        return { status: "updated", presentation };
      },
    );
    return result;
  }
}
