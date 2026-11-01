export const GAME_SESSION_MUTATION_LOCK_MS = 60_000;
export const GAME_SESSION_MUTATION_LOCK_SWEEP_LIMIT = 1_000;
export const GAME_SESSION_MUTATION_LOCK_RELEASE_ATTEMPTS = 3;
const CURRENT_SESSION_WRITER_SQL = `game_session_mutation_locks.writer_generation = 2
  AND (game_session_mutation_locks.writer_owner_id IS game_session_mutation_locks.owner_id
    OR EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = 'd1'))`;

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

export type GameplayCoordinationStores = {
  mutationLocks: GameSessionMutationLockStore;
};

function assertTimestamp(value: number, message: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(message);
  }
}

function assertKey(value: unknown, message: string): asserts value is string {
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

function assertLeaseTimestamp(nowMs: number): void {
  assertTimestamp(nowMs, "invalid-game-session-mutation-lock-timestamp");
  if (!Number.isSafeInteger(nowMs + GAME_SESSION_MUTATION_LOCK_MS)) {
    throw new TypeError("invalid-game-session-mutation-lock-timestamp");
  }
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
               (lock_id, owner_id, operation_id, expires_at_ms, writer_generation, writer_owner_id)
             VALUES (?, ?, ?, ?, 2, ?)
             ON CONFLICT (lock_id) DO UPDATE SET
               owner_id = excluded.owner_id,
               operation_id = excluded.operation_id,
               expires_at_ms = excluded.expires_at_ms,
               writer_generation = 2,
               writer_owner_id = excluded.writer_owner_id
             WHERE game_session_mutation_locks.expires_at_ms <= ?
               AND ((${CURRENT_SESSION_WRITER_SQL})
                 OR (SELECT enabled FROM game_session_legacy_fence WHERE singleton = 1) = 0)`,
          )
          .bind(
            lock.lockId,
            ownerId,
            lock.operationId,
            nowMs + GAME_SESSION_MUTATION_LOCK_MS,
            ownerId,
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
               AND (${CURRENT_SESSION_WRITER_SQL})
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
               WHERE expires_at_ms <= ? AND (${CURRENT_SESSION_WRITER_SQL})
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
