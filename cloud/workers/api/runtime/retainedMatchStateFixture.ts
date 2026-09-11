import type { MatchStateRecord } from "../src/matchStateTypes.ts";

export function seedRetainedMatchState(
  storage: DurableObjectStorage,
  input: {
    inviteId: string;
    epoch: number;
    importId: string;
    records: {
      matchId: string;
      playerId: string;
      value: MatchStateRecord;
    }[];
    claims?: { matchId: string; value: MatchStateRecord }[];
  },
): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      "INSERT INTO match_state_source(singleton, invite_id, active_epoch, staged_epoch, import_id, digest) VALUES (1, ?, ?, ?, ?, ?)",
      input.inviteId,
      input.epoch,
      input.epoch,
      input.importId,
      "a".repeat(64),
    );
    for (const record of input.records) {
      const json = JSON.stringify(record.value);
      storage.sql.exec(
        "INSERT INTO match_state_records(match_id, player_id, value_json) VALUES (?, ?, ?)",
        record.matchId,
        record.playerId,
        json,
      );
      storage.sql.exec(
        "INSERT INTO match_state_staged_records(import_id, match_id, player_id, value_json) VALUES (?, ?, ?, ?)",
        input.importId,
        record.matchId,
        record.playerId,
        json,
      );
    }
    for (const claim of input.claims || []) {
      const json = JSON.stringify(claim.value);
      storage.sql.exec(
        "INSERT INTO match_state_claims(match_id, value_json) VALUES (?, ?)",
        claim.matchId,
        json,
      );
      storage.sql.exec(
        "INSERT INTO match_state_staged_claims(import_id, match_id, value_json) VALUES (?, ?, ?)",
        input.importId,
        claim.matchId,
        json,
      );
    }
  });
}
