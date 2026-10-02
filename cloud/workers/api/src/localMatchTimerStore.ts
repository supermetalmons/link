import { parseStrictMatchTimer } from "@mons/shared/timers";
import { AuthApiFailure } from "./authErrors.ts";
import { isCanonicalLoginUid } from "./recordKeys.ts";
import type {
  MatchTimerStartCandidate,
  MatchTimerStartMarker,
} from "./gameplayCoordinationD1.ts";

export type MatchTimerStorageMode = "d1" | "local";

export function parseNewMatchTimerStorage(
  value: unknown,
): MatchTimerStorageMode {
  if (value === undefined || value === "d1") return "d1";
  if (value === "local") return "local";
  throw new TypeError("invalid-new-match-timer-storage");
}

type StoredTimer = {
  opponent_id: string;
  timer: string;
  turn_number: number;
  updated_at_ms: number;
};

function invalid(): never {
  throw new AuthApiFailure(503, "unavailable", "match-timer-storage-invalid");
}

export class LocalMatchTimerStore {
  constructor(private readonly sql: SqlStorage) {}

  mode(matchId: string): MatchTimerStorageMode | null {
    const [cohort] = this.sql
      .exec<{ mode: string; schema_version: number }>(
        "SELECT mode, schema_version FROM match_state_timer_cohorts WHERE match_id = ?",
        matchId,
      )
      .toArray();
    if (
      cohort &&
      (cohort.schema_version !== 1 ||
        (cohort.mode !== "d1" && cohort.mode !== "local"))
    )
      invalid();
    if (
      cohort?.mode !== "local" &&
      this.sql
        .exec(
          "SELECT 1 FROM match_state_timer_starts WHERE match_id = ? LIMIT 1",
          matchId,
        )
        .toArray().length
    )
      invalid();
    return (cohort?.mode as MatchTimerStorageMode | undefined) ?? null;
  }

  initializeFresh(matchId: string, mode: MatchTimerStorageMode): void {
    if (this.mode(matchId) !== null) return;
    const prior = this.sql
      .exec<{ present: number }>(
        "SELECT EXISTS(SELECT 1 FROM match_state_records WHERE match_id = ?) OR EXISTS(SELECT 1 FROM match_state_revisions WHERE match_id = ?) OR EXISTS(SELECT 1 FROM match_state_claims WHERE match_id = ?) AS present",
        matchId,
        matchId,
        matchId,
      )
      .one().present;
    if (prior) return;
    this.sql.exec(
      "INSERT INTO match_state_timer_cohorts(match_id, mode, schema_version) VALUES (?, ?, 1)",
      matchId,
      mode,
    );
  }

  getOrAdvance(
    matchId: string,
    playerId: string,
    opponentId: string,
    candidate: MatchTimerStartCandidate,
    updatedAtMs: number,
  ): MatchTimerStartMarker {
    const [row] = this.sql
      .exec<StoredTimer>(
        "SELECT opponent_id, timer, turn_number, updated_at_ms FROM match_state_timer_starts WHERE match_id = ? AND player_id = ?",
        matchId,
        playerId,
      )
      .toArray();
    if (row) {
      const parsed = parseStrictMatchTimer(row.timer);
      if (
        !isCanonicalLoginUid(row.opponent_id) ||
        row.opponent_id === playerId ||
        !Number.isSafeInteger(row.turn_number) ||
        row.turn_number < 0 ||
        parsed?.turnNumber !== row.turn_number ||
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
          timer: row.timer,
          turnNumber: row.turn_number,
          updatedAtMs: row.updated_at_ms,
        };
      }
    }
    this.sql.exec(
      "INSERT INTO match_state_timer_starts(match_id, player_id, opponent_id, timer, turn_number, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(match_id, player_id) DO UPDATE SET opponent_id = excluded.opponent_id, timer = excluded.timer, turn_number = excluded.turn_number, updated_at_ms = excluded.updated_at_ms",
      matchId,
      playerId,
      opponentId,
      candidate.timer,
      candidate.turnNumber,
      updatedAtMs,
    );
    return { ...candidate, updatedAtMs };
  }
}
