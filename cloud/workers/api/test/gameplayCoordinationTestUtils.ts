import {
  GAME_SESSION_MUTATION_LOCK_MS,
  GameSessionMutationLockFailure,
  type GameplayCoordinationStores,
  MatchTimerStartStoreFailure,
  type MatchTimerStartMarker,
} from "../src/gameplayCoordinationD1.ts";

type LockRow = {
  expiresAtMs: number;
  operationId: string;
  ownerId: string;
};

export type MemoryGameplayCoordinationStores = GameplayCoordinationStores & {
  lockRows: Map<string, LockRow>;
  timerRows: Map<string, MatchTimerStartMarker>;
};

export function createMemoryGameplayCoordinationStores(): MemoryGameplayCoordinationStores {
  const lockRows = new Map<string, LockRow>();
  const timerRows = new Map<string, MatchTimerStartMarker>();
  const timerOpponents = new Map<string, string>();
  return {
    lockRows,
    timerRows,
    mutationLocks: {
      async acquire(lock, ownerId, nowMs) {
        const current = lockRows.get(lock.lockId);
        if (current && current.expiresAtMs > nowMs) {
          throw new GameSessionMutationLockFailure("busy");
        }
        lockRows.set(lock.lockId, {
          expiresAtMs: nowMs + GAME_SESSION_MUTATION_LOCK_MS,
          operationId: lock.operationId,
          ownerId,
        });
      },
      async refresh(lock, ownerId, nowMs) {
        const current = lockRows.get(lock.lockId);
        if (
          !current ||
          current.ownerId !== ownerId ||
          current.operationId !== lock.operationId ||
          current.expiresAtMs <= nowMs
        ) {
          throw new GameSessionMutationLockFailure("lost");
        }
        current.expiresAtMs = nowMs + GAME_SESSION_MUTATION_LOCK_MS;
      },
      async release(lock, ownerId) {
        const current = lockRows.get(lock.lockId);
        if (
          current?.ownerId === ownerId &&
          current.operationId === lock.operationId
        ) {
          lockRows.delete(lock.lockId);
        }
      },
      async deleteExpired(nowMs) {
        let deleted = 0;
        for (const [lockId, row] of lockRows) {
          if (deleted === 1_000) break;
          if (row.expiresAtMs <= nowMs) {
            lockRows.delete(lockId);
            deleted++;
          }
        }
        return deleted;
      },
    },
    timerStarts: {
      async getOrAdvance(
        playerId,
        opponentId,
        matchId,
        candidate,
        updatedAtMs,
      ) {
        const key = `${playerId}/${matchId}`;
        const current = timerRows.get(key);
        if (!current || current.turnNumber < candidate.turnNumber) {
          const marker = { ...candidate, updatedAtMs };
          timerRows.set(key, marker);
          timerOpponents.set(key, opponentId);
          return marker;
        }
        const currentOpponent = timerOpponents.get(key);
        if (
          current.turnNumber === candidate.turnNumber &&
          currentOpponent &&
          currentOpponent !== opponentId
        ) {
          throw new MatchTimerStartStoreFailure("get-or-advance");
        }
        if (current.turnNumber === candidate.turnNumber && !currentOpponent) {
          timerOpponents.set(key, opponentId);
        }
        return current;
      },
      async backfillOpponentIfUnchanged(marker, opponentId) {
        const key = `${marker.playerId}/${marker.matchId}`;
        const current = timerRows.get(key);
        if (
          !current ||
          timerOpponents.has(key) ||
          current.timer !== marker.timer ||
          current.turnNumber !== marker.turnNumber ||
          current.updatedAtMs !== marker.updatedAtMs
        ) {
          return false;
        }
        timerOpponents.set(key, opponentId);
        return true;
      },
      async delete(playerId, matchId) {
        const key = `${playerId}/${matchId}`;
        timerRows.delete(key);
        timerOpponents.delete(key);
      },
      async deleteIfUnchanged(marker) {
        const key = `${marker.playerId}/${marker.matchId}`;
        const current = timerRows.get(key);
        if (
          !current ||
          timerOpponents.get(key) !== (marker.opponentId || undefined) ||
          current.timer !== marker.timer ||
          current.turnNumber !== marker.turnNumber ||
          current.updatedAtMs !== marker.updatedAtMs
        ) {
          return false;
        }
        timerRows.delete(key);
        timerOpponents.delete(key);
        return true;
      },
      async deletePair(playerId, opponentId, matchId) {
        for (const key of [
          `${playerId}/${matchId}`,
          `${opponentId}/${matchId}`,
        ]) {
          timerRows.delete(key);
          timerOpponents.delete(key);
        }
      },
      async listOldest(limit = 100) {
        return [...timerRows.entries()]
          .map(([key, marker]) => {
            const separator = key.indexOf("/");
            return {
              ...marker,
              playerId: key.slice(0, separator),
              matchId: key.slice(separator + 1),
              opponentId: timerOpponents.get(key) || null,
            };
          })
          .sort(
            (left, right) =>
              left.updatedAtMs - right.updatedAtMs ||
              left.playerId.localeCompare(right.playerId) ||
              left.matchId.localeCompare(right.matchId),
          )
          .slice(0, limit);
      },
      async touchIfUnchanged(marker, updatedAtMs) {
        const key = `${marker.playerId}/${marker.matchId}`;
        const current = timerRows.get(key);
        if (
          !current ||
          timerOpponents.get(key) !== (marker.opponentId || undefined) ||
          current.timer !== marker.timer ||
          current.turnNumber !== marker.turnNumber ||
          current.updatedAtMs !== marker.updatedAtMs
        ) {
          return false;
        }
        timerRows.set(key, { ...current, updatedAtMs });
        return true;
      },
    },
  };
}
