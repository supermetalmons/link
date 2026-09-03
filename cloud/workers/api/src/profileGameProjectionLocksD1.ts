export const PROFILE_GAME_PROJECTION_LOCK_MS = 15 * 60 * 1_000;
export const PROFILE_GAME_PROJECTION_LOCK_SWEEP_LIMIT = 1_000;
const RELEASE_ATTEMPTS = 3;

export type ProfileGameProjectionLock = {
  scope: "invite" | "profile-link";
  resourceId: string;
  requestId?: string;
};

export type ProfileGameProjectionLockStore = {
  acquire: (
    lock: ProfileGameProjectionLock,
    ownerId: string,
    nowMs: number,
  ) => Promise<void>;
  release: (lock: ProfileGameProjectionLock, ownerId: string) => Promise<void>;
  deleteExpired: (nowMs: number) => Promise<number>;
};

export class ProfileGameProjectionLockFailure extends Error {
  readonly scope: ProfileGameProjectionLock["scope"] | "cleanup";

  constructor(
    operation: "acquire" | "busy" | "cleanup" | "release",
    scope: ProfileGameProjectionLockFailure["scope"],
    cause?: unknown,
  ) {
    super(
      `profile-game-projection-lock-${operation}${operation === "busy" ? "" : "-failed"}`,
      { cause },
    );
    this.scope = scope;
  }
}

function assertTimestamp(nowMs: number): void {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(nowMs + PROFILE_GAME_PROJECTION_LOCK_MS)
  ) {
    throw new TypeError("invalid-projection-lock-timestamp");
  }
}

export function createProfileGameProjectionLockStore(
  db: Pick<D1Database, "prepare">,
): ProfileGameProjectionLockStore {
  return {
    async acquire(lock, ownerId, nowMs) {
      try {
        assertTimestamp(nowMs);
        const result = await db
          .prepare(
            `INSERT INTO profile_game_projection_locks
               (scope, resource_id, owner_id, request_id, expires_at_ms)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (scope, resource_id) DO UPDATE SET
               owner_id = excluded.owner_id,
               request_id = excluded.request_id,
               expires_at_ms = excluded.expires_at_ms
             WHERE profile_game_projection_locks.expires_at_ms <= ?`,
          )
          .bind(
            lock.scope,
            lock.resourceId,
            ownerId,
            lock.requestId ?? null,
            nowMs + PROFILE_GAME_PROJECTION_LOCK_MS,
            nowMs,
          )
          .run();
        if (result.meta.changes === 0) {
          throw new ProfileGameProjectionLockFailure("busy", lock.scope);
        }
        if (result.meta.changes !== 1) {
          throw new Error("unexpected-projection-lock-write-count");
        }
      } catch (error) {
        if (error instanceof ProfileGameProjectionLockFailure) throw error;
        throw new ProfileGameProjectionLockFailure(
          "acquire",
          lock.scope,
          error,
        );
      }
    },

    async release(lock, ownerId) {
      for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
        try {
          await db
            .prepare(
              `DELETE FROM profile_game_projection_locks
               WHERE scope = ? AND resource_id = ? AND owner_id = ?`,
            )
            .bind(lock.scope, lock.resourceId, ownerId)
            .run();
          return;
        } catch (error) {
          if (attempt === RELEASE_ATTEMPTS - 1) {
            throw new ProfileGameProjectionLockFailure(
              "release",
              lock.scope,
              error,
            );
          }
        }
      }
    },

    async deleteExpired(nowMs) {
      try {
        assertTimestamp(nowMs);
        const result = await db
          .prepare(
            `DELETE FROM profile_game_projection_locks
             WHERE (scope, resource_id) IN (
               SELECT scope, resource_id FROM profile_game_projection_locks
               WHERE expires_at_ms <= ?
               ORDER BY expires_at_ms, scope, resource_id
               LIMIT ?
             )`,
          )
          .bind(nowMs, PROFILE_GAME_PROJECTION_LOCK_SWEEP_LIMIT)
          .run();
        return result.meta.changes;
      } catch (error) {
        throw new ProfileGameProjectionLockFailure("cleanup", "cleanup", error);
      }
    },
  };
}
