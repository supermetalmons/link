import { isAura, isEmojiId, type Aura } from "@mons/shared/appearance";
import {
  isMatchPresentationSnapshot,
  isMatchPresentation,
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
  schema_version: number;
  match_id: string;
  actor_uid: string;
  emoji_id: number;
  aura: string;
  revision: number;
  operation_id: string | null;
  operation_json: string | null;
};

type StoredPresentationSeed = {
  schema_version: number;
  invite_id: string;
  match_id: string;
  actor_uid: string;
  seed_digest: string;
  emoji_id: number;
  aura: string;
  provenance: "creation" | "backfill";
  source_id: string;
};

type MatchPresentationSeeds = Record<string, { emojiId: number; aura: Aura }>;
export type MatchPresentationUpdateResult = {
  status: "updated" | "duplicate" | "conflict";
  presentation: MatchPresentation;
};

type FrozenPresentation = Omit<
  StoredPresentation,
  "operation_id" | "operation_json"
>;

function presentationFromRow(
  row: StoredPresentation | FrozenPresentation,
): MatchPresentation {
  const value = {
    matchId: row.match_id,
    actorUid: row.actor_uid,
    emojiId: row.emoji_id,
    aura: row.aura,
    revision: row.revision,
  };
  if (row.schema_version !== 1 || !isMatchPresentation(value))
    throw new TypeError("invalid-stored-presentation");
  if ("operation_id" in row) {
    if ((row.operation_id === null) !== (row.operation_json === null))
      throw new TypeError("invalid-stored-presentation-operation");
    if (row.operation_json !== null) {
      const operation: unknown = JSON.parse(row.operation_json);
      if (
        !isUpdateMatchPresentationRequest(operation) ||
        operation.operationId !== row.operation_id ||
        operation.emojiId !== value.emojiId ||
        operation.aura !== value.aura ||
        operation.expectedRevision + 1 !== value.revision
      )
        throw new TypeError("invalid-stored-presentation-operation");
    }
  }
  return value;
}

function assertStoredPresentationSeed(row: StoredPresentationSeed): void {
  if (row.schema_version !== 1 || !isEmojiId(row.emoji_id) || !isAura(row.aura))
    throw new TypeError("invalid-stored-presentation-seed");
  assertMatchPresentationRegistration({
    inviteId: row.invite_id,
    matchId: row.match_id,
    actorUid: row.actor_uid,
    seedDigest: row.seed_digest,
    provenance: row.provenance,
    sourceId: row.source_id,
  });
}

export class MatchPresentationStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly dependencies: { pinInvite: (inviteId: string) => void },
  ) {}

  readPresentations(
    matchId: string,
    frozen = false,
  ): MatchPresentationSnapshot {
    const rows = this.storage.sql
      .exec<StoredPresentation>(
        frozen
          ? "SELECT match_id, actor_uid, emoji_id, aura, revision, schema_version FROM frozen_match_presentations_canonical WHERE match_id = ? ORDER BY actor_uid"
          : "SELECT * FROM match_presentations_canonical WHERE match_id = ? ORDER BY actor_uid",
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
            "SELECT 1 FROM match_presentation_seeds_canonical WHERE match_id = ? AND actor_uid = ?",
            matchId,
            actorUid,
          )
          .toArray().length
      ) {
        throw new Error("match-presentation-unavailable");
      }
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO match_presentations_canonical (match_id, actor_uid, emoji_id, aura, revision) VALUES (?, ?, ?, ?, 0)",
        matchId,
        actorUid,
        seed.emojiId,
        seed.aura,
      );
    }
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
        return [actorUid, snapshot.players[actorUid]!];
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
        "SELECT * FROM match_presentation_seeds_canonical WHERE match_id = ? ORDER BY actor_uid",
        matchId,
      )
      .toArray();
    const current = this.readPresentations(matchId);
    const players = Object.fromEntries(
      seeds.map((seed) => {
        assertStoredPresentationSeed(seed);
        if (!Object.hasOwn(current.players, seed.actor_uid))
          throw new Error("match-presentation-unavailable");
        return [seed.actor_uid, current.players[seed.actor_uid]!];
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
            "SELECT * FROM match_presentation_seeds_canonical WHERE match_id = ? AND actor_uid = ?",
            seed.matchId,
            seed.actorUid,
          )
          .toArray()[0];
        if (existing) assertStoredPresentationSeed(existing);
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
          "INSERT OR IGNORE INTO match_presentation_seeds_canonical (match_id, actor_uid, invite_id, seed_digest, emoji_id, aura, provenance, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
          const value = snapshot.players[actorUid]!;
          this.storage.sql.exec(
            "INSERT OR IGNORE INTO frozen_match_presentations_canonical (match_id, actor_uid, emoji_id, aura, revision) VALUES (?, ?, ?, ?, ?)",
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
            "SELECT * FROM match_presentations_canonical WHERE match_id = ? AND actor_uid = ?",
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
          "UPDATE match_presentations_canonical SET emoji_id = ?, aura = ?, revision = ?, operation_id = ?, operation_json = ? WHERE match_id = ? AND actor_uid = ?",
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
