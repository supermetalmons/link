import {
  GAME_SESSION_MUTATION_LOCK_MS,
  GameSessionMutationLockFailure,
  type GameplayCoordinationStores,
} from "../src/gameplayCoordinationD1.ts";

type LockRow = {
  expiresAtMs: number;
  operationId: string;
  ownerId: string;
};

export type MemoryGameplayCoordinationStores = GameplayCoordinationStores & {
  lockRows: Map<string, LockRow>;
};

export function createMemoryGameplayCoordinationStores(): MemoryGameplayCoordinationStores {
  const lockRows = new Map<string, LockRow>();
  return {
    lockRows,
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
  };
}
