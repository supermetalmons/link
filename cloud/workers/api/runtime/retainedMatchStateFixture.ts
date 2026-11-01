import { matchDocumentFixture } from "../test/matchRecordFixture.ts";
import { timerClaimFixture } from "../test/matchClaimFixture.ts";

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid retained match fixture");
  return Object.fromEntries(Object.entries(value));
}

export function seedRetainedMatchState(
  storage: DurableObjectStorage,
  input: {
    inviteId: string;
    epoch: number;
    importId: string;
    records: {
      matchId: string;
      playerId: string;
      value: unknown;
    }[];
    claims?: { matchId: string; value: unknown }[];
  },
): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_staged_records (import_id TEXT NOT NULL, match_id TEXT NOT NULL, player_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(import_id, match_id, player_id))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_staged_claims (import_id TEXT NOT NULL, match_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(import_id, match_id))",
    );
    storage.sql.exec(
      "INSERT INTO match_state_source_canonical(singleton, invite_id, active_epoch, staged_epoch, import_id, digest) VALUES (1, ?, ?, ?, ?, ?)",
      input.inviteId,
      input.epoch,
      input.epoch,
      input.importId,
      "a".repeat(64),
    );
    for (const record of input.records) {
      const json = JSON.stringify(matchDocumentFixture(fields(record.value)));
      storage.sql.exec(
        "INSERT INTO match_state_records_canonical(match_id, player_id, value_json) VALUES (?, ?, ?)",
        record.matchId,
        record.playerId,
        json,
      );
      storage.sql.exec(
        "INSERT OR IGNORE INTO match_state_timer_cohorts_canonical(match_id, mode, schema_version) VALUES (?, 'local', 1)",
        record.matchId,
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
      const json = JSON.stringify(
        timerClaimFixture({ inviteId: input.inviteId, ...fields(claim.value) }),
      );
      storage.sql.exec(
        "INSERT INTO match_state_claims_canonical(match_id, value_json) VALUES (?, ?)",
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
