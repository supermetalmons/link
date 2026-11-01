import { formatMatchTimer } from "@mons/shared/timers";
import { AuthApiFailure } from "./authErrors.ts";
import { isCanonicalLoginUid } from "./recordKeys.ts";
import type {
  MatchTimerStartCandidate,
  MatchTimerStartMarker,
} from "./matchTimerRecords.ts";

type StoredTimer = {
  opponent_id: string;
  deadline_at_ms: number;
  turn_number: number;
  updated_at_ms: number;
};

function invalid(): never {
  throw new AuthApiFailure(503, "unavailable", "match-timer-storage-invalid");
}

export class LocalMatchTimerStore {
  constructor(private readonly sql: SqlStorage) {}

  mode(matchId: string): "local" | null {
    return this.readMode(matchId);
  }

  private readMode(matchId: string): "local" | null {
    const [cohort] = this.sql
      .exec<{ mode: string; schema_version: number }>(
        "SELECT mode, schema_version FROM match_state_timer_cohorts_canonical WHERE match_id = ?",
        matchId,
      )
      .toArray();
    if (cohort && (cohort.schema_version !== 1 || cohort.mode !== "local"))
      invalid();
    if (
      cohort?.mode !== "local" &&
      this.sql
        .exec(
          "SELECT 1 FROM match_state_timer_starts_canonical WHERE match_id = ? LIMIT 1",
          matchId,
        )
        .toArray().length
    )
      invalid();
    return cohort ? "local" : null;
  }

  initializeFresh(matchId: string): void {
    if (this.mode(matchId) !== null) return;
    const prior = this.sql
      .exec<{ present: number }>(
        "SELECT EXISTS(SELECT 1 FROM match_state_records_canonical WHERE match_id = ?) OR EXISTS(SELECT 1 FROM match_state_revisions_canonical WHERE match_id = ?) OR EXISTS(SELECT 1 FROM match_state_claims_canonical WHERE match_id = ?) AS present",
        matchId,
        matchId,
        matchId,
      )
      .one().present;
    if (prior) invalid();
    this.sql.exec(
      "INSERT INTO match_state_timer_cohorts_canonical(match_id, mode, schema_version) VALUES (?, 'local', 1)",
      matchId,
    );
  }

  getOrAdvance(
    matchId: string,
    playerId: string,
    opponentId: string,
    candidate: MatchTimerStartCandidate,
    updatedAtMs: number,
  ): MatchTimerStartMarker {
    if (this.mode(matchId) !== "local") invalid();
    const [row] = this.sql
      .exec<StoredTimer>(
        "SELECT opponent_id, deadline_at_ms, turn_number, updated_at_ms FROM match_state_timer_starts_canonical WHERE match_id = ? AND player_id = ?",
        matchId,
        playerId,
      )
      .toArray();
    if (row) {
      if (
        !isCanonicalLoginUid(row.opponent_id) ||
        row.opponent_id === playerId ||
        !Number.isSafeInteger(row.turn_number) ||
        row.turn_number < 0 ||
        !Number.isSafeInteger(row.deadline_at_ms) ||
        row.deadline_at_ms <= 0 ||
        !Number.isSafeInteger(row.updated_at_ms) ||
        row.updated_at_ms < 0
      )
        invalid();
      if (row.turn_number >= candidate.turnNumber) {
        if (
          row.turn_number === candidate.turnNumber &&
          row.opponent_id !== opponentId
        )
          invalid();
        return {
          timer: formatMatchTimer(row.turn_number, row.deadline_at_ms),
          turnNumber: row.turn_number,
          updatedAtMs: row.updated_at_ms,
        };
      }
    }
    this.sql.exec(
      "INSERT INTO match_state_timer_starts_canonical(match_id, player_id, opponent_id, deadline_at_ms, turn_number, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(match_id, player_id) DO UPDATE SET opponent_id = excluded.opponent_id, deadline_at_ms = excluded.deadline_at_ms, turn_number = excluded.turn_number, updated_at_ms = excluded.updated_at_ms",
      matchId,
      playerId,
      opponentId,
      candidate.timer.deadlineAtMs,
      candidate.turnNumber,
      updatedAtMs,
    );
    return { ...candidate, updatedAtMs };
  }
}
