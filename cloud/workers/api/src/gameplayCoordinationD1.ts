import { parseStrictMatchTimer } from "@mons/shared/timers";

export const GAME_SESSION_MUTATION_LOCK_MS = 60_000;
export const GAME_SESSION_MUTATION_LOCK_SWEEP_LIMIT = 1_000;
export const GAME_SESSION_MUTATION_LOCK_RELEASE_ATTEMPTS = 3;
export const MATCH_TIMER_START_SWEEP_LIMIT = 100;

export type GameSessionMutationLock = {
  lockId: string;
  operationId: string;
};

export type GameSessionMutationLockFailureOperation =
  "acquire" | "busy" | "cleanup" | "lost" | "refresh" | "release";

export type GameSessionMutationLockStore = {
  acquire: (
    lock: GameSessionMutationLock,
    ownerId: string,
    nowMs: number,
  ) => Promise<void>;
  refresh: (
    lock: GameSessionMutationLock,
    ownerId: string,
    nowMs: number,
  ) => Promise<void>;
  release: (lock: GameSessionMutationLock, ownerId: string) => Promise<void>;
  deleteExpired: (nowMs: number) => Promise<number>;
};

export class GameSessionMutationLockFailure extends Error {
  readonly operation: GameSessionMutationLockFailureOperation;

  constructor(
    operation: GameSessionMutationLockFailureOperation,
    cause?: unknown,
  ) {
    super(
      operation === "busy" || operation === "lost"
        ? `game-session-mutation-lock-${operation}`
        : `game-session-mutation-lock-${operation}-failed`,
      { cause },
    );
    this.operation = operation;
  }
}

export type MatchTimerStartCandidate = {
  timer: string;
  turnNumber: number;
};

export type MatchTimerStartMarker = MatchTimerStartCandidate & {
  updatedAtMs: number;
};

export type MatchTimerStartReconciliationItem = MatchTimerStartMarker & {
  matchId: string;
  opponentId: string | null;
  playerId: string;
};

export type MatchTimerStartStoreFailureOperation =
  | "delete"
  | "delete-if-unchanged"
  | "delete-pair"
  | "get-or-advance"
  | "list"
  | "opponent-backfill"
  | "touch-if-unchanged";

export type MatchTimerStartStore = {
  getOrAdvance: (
    playerId: string,
    opponentId: string,
    matchId: string,
    candidate: MatchTimerStartCandidate,
    updatedAtMs: number,
  ) => Promise<MatchTimerStartMarker>;
  backfillOpponentIfUnchanged: (
    marker: MatchTimerStartReconciliationItem,
    opponentId: string,
  ) => Promise<boolean>;
  delete: (playerId: string, matchId: string) => Promise<void>;
  deleteIfUnchanged: (
    marker: MatchTimerStartReconciliationItem,
  ) => Promise<boolean>;
  deletePair: (
    playerId: string,
    opponentId: string,
    matchId: string,
  ) => Promise<void>;
  listOldest: (limit?: number) => Promise<MatchTimerStartReconciliationItem[]>;
  touchIfUnchanged: (
    marker: MatchTimerStartReconciliationItem,
    updatedAtMs: number,
  ) => Promise<boolean>;
};

export class MatchTimerStartStoreFailure extends Error {
  readonly operation: MatchTimerStartStoreFailureOperation;

  constructor(
    operation: MatchTimerStartStoreFailureOperation,
    cause?: unknown,
  ) {
    super(`match-timer-start-${operation}-failed`, { cause });
    this.operation = operation;
  }
}

export type GameplayCoordinationStores = {
  mutationLocks: GameSessionMutationLockStore;
  timerStarts: MatchTimerStartStore;
};

type MatchTimerStartRow = {
  opponent_id: string | null;
  timer: string;
  turn_number: number;
  updated_at_ms: number;
};

type MatchTimerStartListRow = MatchTimerStartRow & {
  match_id: string;
  player_id: string;
};

function assertTimestamp(value: number, message: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(message);
  }
}

function assertKey(value: string, message: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("/")) {
    throw new TypeError(message);
  }
}

function assertNonempty(value: string, message: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(message);
  }
}

function assertGameSessionMutationLock(
  lock: GameSessionMutationLock,
  ownerId: string,
): void {
  assertKey(lock.lockId, "invalid-game-session-mutation-lock-id");
  assertNonempty(
    lock.operationId,
    "invalid-game-session-mutation-lock-operation-id",
  );
  assertNonempty(ownerId, "invalid-game-session-mutation-lock-owner-id");
}

function assertMatchTimerStartKeys(playerId: string, matchId: string): void {
  assertKey(playerId, "invalid-match-timer-start-player-id");
  assertKey(matchId, "invalid-match-timer-start-match-id");
}

function assertLeaseTimestamp(nowMs: number): void {
  assertTimestamp(nowMs, "invalid-game-session-mutation-lock-timestamp");
  if (!Number.isSafeInteger(nowMs + GAME_SESSION_MUTATION_LOCK_MS)) {
    throw new TypeError("invalid-game-session-mutation-lock-timestamp");
  }
}

function decodeMatchTimerStartMarker(
  value: MatchTimerStartRow | undefined,
): (MatchTimerStartMarker & { opponentId: string | null }) | null {
  if (
    !value ||
    typeof value.timer !== "string" ||
    !Number.isSafeInteger(value.turn_number) ||
    value.turn_number < 0 ||
    !Number.isSafeInteger(value.updated_at_ms) ||
    value.updated_at_ms < 0 ||
    !(value.opponent_id === null || typeof value.opponent_id === "string")
  ) {
    return null;
  }
  const parsed = parseStrictMatchTimer(value.timer);
  if (!parsed || parsed.turnNumber !== value.turn_number) return null;
  return {
    opponentId: value.opponent_id,
    timer: value.timer,
    turnNumber: value.turn_number,
    updatedAtMs: value.updated_at_ms,
  };
}

export function createGameSessionMutationLockStore(
  db: Pick<D1Database, "prepare">,
): GameSessionMutationLockStore {
  return {
    async acquire(lock, ownerId, nowMs) {
      try {
        assertGameSessionMutationLock(lock, ownerId);
        assertLeaseTimestamp(nowMs);
        const result = await db
          .prepare(
            `INSERT INTO game_session_mutation_locks
               (lock_id, owner_id, operation_id, expires_at_ms)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (lock_id) DO UPDATE SET
               owner_id = excluded.owner_id,
               operation_id = excluded.operation_id,
               expires_at_ms = excluded.expires_at_ms
             WHERE game_session_mutation_locks.expires_at_ms <= ?`,
          )
          .bind(
            lock.lockId,
            ownerId,
            lock.operationId,
            nowMs + GAME_SESSION_MUTATION_LOCK_MS,
            nowMs,
          )
          .run();
        if (result.meta.changes === 0) {
          throw new GameSessionMutationLockFailure("busy");
        }
        if (result.meta.changes !== 1) {
          throw new Error("unexpected-game-session-mutation-lock-write-count");
        }
      } catch (error) {
        if (error instanceof GameSessionMutationLockFailure) throw error;
        throw new GameSessionMutationLockFailure("acquire", error);
      }
    },

    async refresh(lock, ownerId, nowMs) {
      try {
        assertGameSessionMutationLock(lock, ownerId);
        assertLeaseTimestamp(nowMs);
        const result = await db
          .prepare(
            `UPDATE game_session_mutation_locks
             SET expires_at_ms = ?
             WHERE lock_id = ?
               AND owner_id = ?
               AND operation_id = ?
               AND expires_at_ms > ?`,
          )
          .bind(
            nowMs + GAME_SESSION_MUTATION_LOCK_MS,
            lock.lockId,
            ownerId,
            lock.operationId,
            nowMs,
          )
          .run();
        if (result.meta.changes === 0) {
          throw new GameSessionMutationLockFailure("lost");
        }
        if (result.meta.changes !== 1) {
          throw new Error("unexpected-game-session-mutation-lock-write-count");
        }
      } catch (error) {
        if (error instanceof GameSessionMutationLockFailure) throw error;
        throw new GameSessionMutationLockFailure("refresh", error);
      }
    },

    async release(lock, ownerId) {
      try {
        assertGameSessionMutationLock(lock, ownerId);
      } catch (error) {
        throw new GameSessionMutationLockFailure("release", error);
      }
      for (
        let attempt = 0;
        attempt < GAME_SESSION_MUTATION_LOCK_RELEASE_ATTEMPTS;
        attempt++
      ) {
        try {
          await db
            .prepare(
              `DELETE FROM game_session_mutation_locks
               WHERE lock_id = ? AND owner_id = ? AND operation_id = ?`,
            )
            .bind(lock.lockId, ownerId, lock.operationId)
            .run();
          return;
        } catch (error) {
          if (attempt === GAME_SESSION_MUTATION_LOCK_RELEASE_ATTEMPTS - 1) {
            throw new GameSessionMutationLockFailure("release", error);
          }
        }
      }
    },

    async deleteExpired(nowMs) {
      try {
        assertTimestamp(
          nowMs,
          "invalid-game-session-mutation-lock-cleanup-timestamp",
        );
        const result = await db
          .prepare(
            `DELETE FROM game_session_mutation_locks
             WHERE lock_id IN (
               SELECT lock_id FROM game_session_mutation_locks
               WHERE expires_at_ms <= ?
               ORDER BY expires_at_ms, lock_id
               LIMIT ?
             )`,
          )
          .bind(nowMs, GAME_SESSION_MUTATION_LOCK_SWEEP_LIMIT)
          .run();
        return result.meta.changes;
      } catch (error) {
        throw new GameSessionMutationLockFailure("cleanup", error);
      }
    },
  };
}

export function createMatchTimerStartStore(
  db: Pick<D1Database, "batch" | "prepare">,
): MatchTimerStartStore {
  return {
    async getOrAdvance(playerId, opponentId, matchId, candidate, updatedAtMs) {
      try {
        assertMatchTimerStartKeys(playerId, matchId);
        assertKey(opponentId, "invalid-match-timer-start-opponent-id");
        assertTimestamp(updatedAtMs, "invalid-match-timer-start-timestamp");
        const parsedTimer = parseStrictMatchTimer(candidate.timer);
        if (
          !Number.isSafeInteger(candidate.turnNumber) ||
          candidate.turnNumber < 0 ||
          !parsedTimer ||
          parsedTimer.turnNumber !== candidate.turnNumber
        ) {
          throw new TypeError("invalid-match-timer-start-candidate");
        }
        const [writeResult, , readResult] = await db.batch<MatchTimerStartRow>([
          db
            .prepare(
              `INSERT INTO match_timer_starts
                 (player_id, match_id, opponent_id, timer, turn_number, updated_at_ms)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (player_id, match_id) DO UPDATE SET
                 opponent_id = excluded.opponent_id,
                 timer = excluded.timer,
                 turn_number = excluded.turn_number,
                 updated_at_ms = excluded.updated_at_ms
               WHERE match_timer_starts.turn_number < excluded.turn_number`,
            )
            .bind(
              playerId,
              matchId,
              opponentId,
              candidate.timer,
              candidate.turnNumber,
              updatedAtMs,
            ),
          db
            .prepare(
              `UPDATE match_timer_starts
               SET opponent_id = ?
               WHERE player_id = ?
                 AND match_id = ?
                 AND opponent_id IS NULL
                 AND turn_number = ?`,
            )
            .bind(opponentId, playerId, matchId, candidate.turnNumber),
          db
            .prepare(
              `SELECT opponent_id, timer, turn_number, updated_at_ms
               FROM match_timer_starts
               WHERE player_id = ? AND match_id = ?`,
            )
            .bind(playerId, matchId),
        ]);
        const marker = decodeMatchTimerStartMarker(readResult?.results[0]);
        if (!marker) throw new Error("invalid-match-timer-start-readback");
        if (writeResult.meta.changes !== 0 && writeResult.meta.changes !== 1) {
          throw new Error("unexpected-match-timer-start-write-count");
        }
        if (
          marker.turnNumber === candidate.turnNumber &&
          marker.opponentId !== opponentId
        ) {
          throw new Error("match-timer-start-opponent-mismatch");
        }
        return {
          timer: marker.timer,
          turnNumber: marker.turnNumber,
          updatedAtMs: marker.updatedAtMs,
        };
      } catch (error) {
        if (error instanceof MatchTimerStartStoreFailure) throw error;
        throw new MatchTimerStartStoreFailure("get-or-advance", error);
      }
    },

    async backfillOpponentIfUnchanged(marker, opponentId) {
      try {
        assertMatchTimerStartKeys(marker.playerId, marker.matchId);
        if (marker.opponentId !== null) {
          throw new TypeError("match-timer-start-opponent-already-set");
        }
        assertKey(opponentId, "invalid-match-timer-start-opponent-id");
        assertTimestamp(
          marker.updatedAtMs,
          "invalid-match-timer-start-timestamp",
        );
        const parsedTimer = parseStrictMatchTimer(marker.timer);
        if (!parsedTimer || parsedTimer.turnNumber !== marker.turnNumber) {
          throw new TypeError("invalid-match-timer-start-marker");
        }
        const result = await db
          .prepare(
            `UPDATE match_timer_starts
             SET opponent_id = ?
             WHERE player_id = ?
               AND match_id = ?
               AND opponent_id IS NULL
               AND timer = ?
               AND turn_number = ?
               AND updated_at_ms = ?`,
          )
          .bind(
            opponentId,
            marker.playerId,
            marker.matchId,
            marker.timer,
            marker.turnNumber,
            marker.updatedAtMs,
          )
          .run();
        return result.meta.changes === 1;
      } catch (error) {
        if (error instanceof MatchTimerStartStoreFailure) throw error;
        throw new MatchTimerStartStoreFailure("opponent-backfill", error);
      }
    },

    async delete(playerId, matchId) {
      try {
        assertMatchTimerStartKeys(playerId, matchId);
        await db
          .prepare(
            `DELETE FROM match_timer_starts
             WHERE player_id = ? AND match_id = ?`,
          )
          .bind(playerId, matchId)
          .run();
      } catch (error) {
        throw new MatchTimerStartStoreFailure("delete", error);
      }
    },

    async deleteIfUnchanged(marker) {
      try {
        assertMatchTimerStartKeys(marker.playerId, marker.matchId);
        if (marker.opponentId !== null) {
          assertKey(marker.opponentId, "invalid-match-timer-start-opponent-id");
        }
        assertTimestamp(
          marker.updatedAtMs,
          "invalid-match-timer-start-timestamp",
        );
        const parsedTimer = parseStrictMatchTimer(marker.timer);
        if (!parsedTimer || parsedTimer.turnNumber !== marker.turnNumber) {
          throw new TypeError("invalid-match-timer-start-marker");
        }
        const result = await db
          .prepare(
            `DELETE FROM match_timer_starts
             WHERE player_id = ?
               AND match_id = ?
               AND opponent_id IS ?
               AND timer = ?
               AND turn_number = ?
               AND updated_at_ms = ?`,
          )
          .bind(
            marker.playerId,
            marker.matchId,
            marker.opponentId,
            marker.timer,
            marker.turnNumber,
            marker.updatedAtMs,
          )
          .run();
        return result.meta.changes === 1;
      } catch (error) {
        if (error instanceof MatchTimerStartStoreFailure) throw error;
        throw new MatchTimerStartStoreFailure("delete-if-unchanged", error);
      }
    },

    async deletePair(playerId, opponentId, matchId) {
      try {
        assertMatchTimerStartKeys(playerId, matchId);
        assertKey(opponentId, "invalid-match-timer-start-opponent-id");
        await db
          .prepare(
            `DELETE FROM match_timer_starts
             WHERE match_id = ? AND player_id IN (?, ?)`,
          )
          .bind(matchId, playerId, opponentId)
          .run();
      } catch (error) {
        throw new MatchTimerStartStoreFailure("delete-pair", error);
      }
    },

    async listOldest(limit = MATCH_TIMER_START_SWEEP_LIMIT) {
      try {
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > MATCH_TIMER_START_SWEEP_LIMIT
        ) {
          throw new TypeError("invalid-match-timer-start-list-limit");
        }
        const result = await db
          .prepare(
            `SELECT player_id, match_id, opponent_id, timer, turn_number, updated_at_ms
             FROM match_timer_starts
             ORDER BY updated_at_ms, player_id, match_id
             LIMIT ?`,
          )
          .bind(limit)
          .all<MatchTimerStartListRow>();
        return result.results.map((row) => {
          assertMatchTimerStartKeys(row.player_id, row.match_id);
          if (row.opponent_id !== null) {
            assertKey(row.opponent_id, "invalid-match-timer-start-opponent-id");
          }
          const marker = decodeMatchTimerStartMarker(row);
          if (!marker) throw new Error("invalid-match-timer-start-readback");
          return {
            ...marker,
            matchId: row.match_id,
            playerId: row.player_id,
          };
        });
      } catch (error) {
        if (error instanceof MatchTimerStartStoreFailure) throw error;
        throw new MatchTimerStartStoreFailure("list", error);
      }
    },

    async touchIfUnchanged(marker, updatedAtMs) {
      try {
        assertMatchTimerStartKeys(marker.playerId, marker.matchId);
        if (marker.opponentId !== null) {
          assertKey(marker.opponentId, "invalid-match-timer-start-opponent-id");
        }
        assertTimestamp(
          marker.updatedAtMs,
          "invalid-match-timer-start-timestamp",
        );
        assertTimestamp(updatedAtMs, "invalid-match-timer-start-timestamp");
        const parsedTimer = parseStrictMatchTimer(marker.timer);
        if (!parsedTimer || parsedTimer.turnNumber !== marker.turnNumber) {
          throw new TypeError("invalid-match-timer-start-marker");
        }
        const result = await db
          .prepare(
            `UPDATE match_timer_starts
             SET updated_at_ms = ?
             WHERE player_id = ?
               AND match_id = ?
               AND opponent_id IS ?
               AND timer = ?
               AND turn_number = ?
               AND updated_at_ms = ?`,
          )
          .bind(
            updatedAtMs,
            marker.playerId,
            marker.matchId,
            marker.opponentId,
            marker.timer,
            marker.turnNumber,
            marker.updatedAtMs,
          )
          .run();
        return result.meta.changes === 1;
      } catch (error) {
        if (error instanceof MatchTimerStartStoreFailure) throw error;
        throw new MatchTimerStartStoreFailure("touch-if-unchanged", error);
      }
    },
  };
}

export function createGameplayCoordinationStores(
  db: Pick<D1Database, "batch" | "prepare">,
): GameplayCoordinationStores {
  return {
    mutationLocks: createGameSessionMutationLockStore(db),
    timerStarts: createMatchTimerStartStore(db),
  };
}
