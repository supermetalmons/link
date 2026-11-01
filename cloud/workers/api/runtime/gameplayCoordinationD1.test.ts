import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGameSessionMutationLockStore,
  GAME_SESSION_MUTATION_LOCK_MS,
  GAME_SESSION_MUTATION_LOCK_RELEASE_ATTEMPTS,
  GAME_SESSION_MUTATION_LOCK_SWEEP_LIMIT,
  GameSessionMutationLockFailure,
  type GameSessionMutationLock,
} from "../src/gameplayCoordinationD1.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const lock: GameSessionMutationLock = {
  lockId: "invite-1",
  operationId: "operation-1",
};

function interceptRuns(
  intercept: (query: string, run: () => Promise<D1Result>) => Promise<D1Result>,
): Pick<D1Database, "prepare"> {
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        if (property === "run") {
          return () => intercept(query, () => target.run());
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return { prepare: (query) => wrap(db.prepare(query), query) };
}

async function readLock(lockId = lock.lockId) {
  return db
    .prepare(
      `SELECT owner_id, operation_id, expires_at_ms
       FROM game_session_mutation_locks
       WHERE lock_id = ?`,
    )
    .bind(lockId)
    .first();
}

describe("D1 gameplay coordination", () => {
  beforeAll(async () => {
    await applyCanonicalTestMigrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare(
        "UPDATE game_session_legacy_fence SET enabled = 0 WHERE singleton = 1",
      ),
      db.prepare("DELETE FROM game_session_mutation_locks"),
      db.prepare("DELETE FROM game_session_legacy_releases"),
      db.prepare("DELETE FROM automatch_runtime_control"),
      db.prepare(
        "INSERT INTO automatch_runtime_control (singleton, backend, state, epoch, freeze_generation) VALUES (1, 'rtdb', 'active', 1, 0)",
      ),
    ]);
  });

  it("enforces slash-free mutation-lock keys at the schema boundary", async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO game_session_mutation_locks
        (lock_id, owner_id, operation_id, expires_at_ms) VALUES (?, ?, ?, ?)`,
        )
        .bind("bad/lock", "owner", "operation", 100)
        .run(),
    ).rejects.toThrow();
  });

  describe("game-session mutation locks", () => {
    it("preserves evidence when legacy SQL takes over a stamped lease", async () => {
      const store = createGameSessionMutationLockStore(db);
      await store.acquire(lock, "modern-owner", 100);
      const takeoverTime = 100 + GAME_SESSION_MUTATION_LOCK_MS;
      await db
        .prepare(
          `INSERT INTO game_session_mutation_locks
        (lock_id, owner_id, operation_id, expires_at_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT (lock_id) DO UPDATE SET owner_id = excluded.owner_id,
          operation_id = excluded.operation_id, expires_at_ms = excluded.expires_at_ms
        WHERE game_session_mutation_locks.expires_at_ms <= ?`,
        )
        .bind(
          lock.lockId,
          "legacy-owner",
          lock.operationId,
          takeoverTime + GAME_SESSION_MUTATION_LOCK_MS,
          takeoverTime,
        )
        .run();
      expect(
        await db
          .prepare(
            "SELECT owner_id, writer_owner_id, writer_generation FROM game_session_mutation_locks WHERE lock_id = ?",
          )
          .bind(lock.lockId)
          .first(),
      ).toEqual({
        owner_id: "legacy-owner",
        writer_owner_id: "modern-owner",
        writer_generation: 2,
      });
      await db
        .prepare(
          "UPDATE game_session_legacy_fence SET enabled = 1 WHERE singleton = 1",
        )
        .run();
      await expect(
        db
          .prepare(
            "UPDATE game_session_mutation_locks SET expires_at_ms = ? WHERE lock_id = ? AND owner_id = ? AND operation_id = ? AND expires_at_ms > ?",
          )
          .bind(
            takeoverTime + GAME_SESSION_MUTATION_LOCK_MS + 1,
            lock.lockId,
            "legacy-owner",
            lock.operationId,
            takeoverTime + 1,
          )
          .run(),
      ).rejects.toThrow("legacy-game-session-writer-disabled");
      const expiredAt = takeoverTime + GAME_SESSION_MUTATION_LOCK_MS;
      await expect(
        store.acquire(lock, "next-owner", expiredAt),
      ).rejects.toMatchObject({ operation: "busy" });
      expect(await store.deleteExpired(expiredAt)).toBe(0);
      await db
        .prepare(
          "DELETE FROM game_session_mutation_locks WHERE lock_id = ? AND owner_id = ? AND operation_id = ?",
        )
        .bind(lock.lockId, "legacy-owner", lock.operationId)
        .run();
      expect(
        await db
          .prepare(
            "SELECT owner_id FROM game_session_legacy_releases WHERE lock_id = ?",
          )
          .bind(lock.lockId)
          .first("owner_id"),
      ).toBe("legacy-owner");
      await store.acquire(lock, "next-owner", expiredAt);
      await store.refresh(lock, "next-owner", expiredAt + 1);
      expect(
        await db
          .prepare(
            "SELECT writer_owner_id FROM game_session_mutation_locks WHERE lock_id = ?",
          )
          .bind(lock.lockId)
          .first("writer_owner_id"),
      ).toBe("next-owner");
    });

    it("keeps unstamped generation-two leases compatible after D1 activation", async () => {
      await db
        .prepare(
          "UPDATE automatch_runtime_control SET backend = 'd1' WHERE singleton = 1",
        )
        .run();
      await db
        .prepare(
          "UPDATE game_session_legacy_fence SET enabled = 1 WHERE singleton = 1",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO game_session_mutation_locks (lock_id, owner_id, operation_id, expires_at_ms, writer_generation) VALUES (?, ?, ?, ?, 2)",
        )
        .bind(lock.lockId, "previous-worker", lock.operationId, 1000)
        .run();
      await db
        .prepare(
          "UPDATE game_session_mutation_locks SET expires_at_ms = 2000 WHERE lock_id = ? AND owner_id = ? AND writer_generation = 2",
        )
        .bind(lock.lockId, "previous-worker")
        .run();
      const store = createGameSessionMutationLockStore(db);
      await store.refresh(lock, "previous-worker", 1000);
      await store.acquire(
        lock,
        "updated-worker",
        1000 + GAME_SESSION_MUTATION_LOCK_MS,
      );
      expect(
        await db
          .prepare(
            "SELECT owner_id, writer_owner_id FROM game_session_mutation_locks WHERE lock_id = ?",
          )
          .bind(lock.lockId)
          .first(),
      ).toEqual({
        owner_id: "updated-worker",
        writer_owner_id: "updated-worker",
      });
      expect(
        await store.deleteExpired(1000 + 2 * GAME_SESSION_MUTATION_LOCK_MS),
      ).toBe(1);
      expect(
        await db
          .prepare("SELECT count(*) AS n FROM game_session_legacy_releases")
          .first("n"),
      ).toBe(0);
    });

    it("allows one concurrent owner and reports the other contenders as busy", async () => {
      const stores = Array.from({ length: 8 }, () =>
        createGameSessionMutationLockStore(db),
      );
      const outcomes = await Promise.allSettled(
        stores.map((store, index) =>
          store.acquire(lock, `owner-${index}`, 1_000),
        ),
      );
      const winners = outcomes
        .map((outcome, index) => ({ index, outcome }))
        .filter(({ outcome }) => outcome.status === "fulfilled");
      expect(winners).toHaveLength(1);
      expect(await readLock()).toEqual({
        owner_id: `owner-${winners[0]!.index}`,
        operation_id: lock.operationId,
        expires_at_ms: 1_000 + GAME_SESSION_MUTATION_LOCK_MS,
      });
      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") continue;
        expect(outcome.reason).toBeInstanceOf(GameSessionMutationLockFailure);
        expect(outcome.reason).toMatchObject({ operation: "busy" });
      }
    });

    it("permits takeover exactly at expiry and fences stale owners and operations", async () => {
      const store = createGameSessionMutationLockStore(db);
      await store.acquire(lock, "old-owner", 100);
      await expect(
        store.acquire(
          { ...lock, operationId: "operation-2" },
          "new-owner",
          100 + GAME_SESSION_MUTATION_LOCK_MS - 1,
        ),
      ).rejects.toMatchObject({ operation: "busy" });
      await store.acquire(
        { ...lock, operationId: "operation-2" },
        "new-owner",
        100 + GAME_SESSION_MUTATION_LOCK_MS,
      );
      await expect(
        store.refresh(lock, "old-owner", 100 + GAME_SESSION_MUTATION_LOCK_MS),
      ).rejects.toMatchObject({ operation: "lost" });
      await store.release(lock, "old-owner");
      expect(await readLock()).toMatchObject({
        owner_id: "new-owner",
        operation_id: "operation-2",
      });
      await store.release({ ...lock, operationId: "operation-2" }, "new-owner");
      expect(await readLock()).toBeNull();
    });

    it("refreshes only an exactly fenced lease", async () => {
      const store = createGameSessionMutationLockStore(db);
      await store.acquire(lock, "owner", 100);
      await expect(
        store.refresh({ ...lock, operationId: "wrong" }, "owner", 200),
      ).rejects.toMatchObject({ operation: "lost" });
      await expect(
        store.refresh(lock, "wrong-owner", 200),
      ).rejects.toMatchObject({ operation: "lost" });
      await store.refresh(lock, "owner", 200);
      expect(await readLock()).toEqual({
        owner_id: "owner",
        operation_id: lock.operationId,
        expires_at_ms: 200 + GAME_SESSION_MUTATION_LOCK_MS,
      });
    });

    it("rejects refresh exactly at lease expiry", async () => {
      const store = createGameSessionMutationLockStore(db);
      await store.acquire(lock, "owner", 100);
      await expect(
        store.refresh(lock, "owner", 100 + GAME_SESSION_MUTATION_LOCK_MS),
      ).rejects.toMatchObject({ operation: "lost" });
      expect(await readLock()).toEqual({
        owner_id: "owner",
        operation_id: lock.operationId,
        expires_at_ms: 100 + GAME_SESSION_MUTATION_LOCK_MS,
      });
    });

    it("retries releases and tolerates an ambiguous successful delete", async () => {
      const base = createGameSessionMutationLockStore(db);
      for (const afterCommit of [false, true]) {
        await base.acquire(lock, "owner", 100);
        let attempts = 0;
        const store = createGameSessionMutationLockStore(
          interceptRuns(async (query, run) => {
            expect(query).toContain("DELETE FROM game_session_mutation_locks");
            attempts++;
            if (attempts === 1) {
              if (afterCommit) await run();
              throw new Error("transient-release");
            }
            return run();
          }),
        );
        await store.release(lock, "owner");
        expect(attempts).toBe(2);
        expect(await readLock()).toBeNull();
      }
    });

    it("fails a release after three attempts", async () => {
      await createGameSessionMutationLockStore(db).acquire(lock, "owner", 100);
      let attempts = 0;
      const store = createGameSessionMutationLockStore(
        interceptRuns(async () => {
          attempts++;
          throw new Error("offline");
        }),
      );
      await expect(store.release(lock, "owner")).rejects.toMatchObject({
        operation: "release",
      });
      expect(attempts).toBe(GAME_SESSION_MUTATION_LOCK_RELEASE_ATTEMPTS);
      expect(await readLock()).not.toBeNull();
    });

    it("removes no more than 1000 expired rows and preserves active leases", async () => {
      await db
        .prepare(
          `WITH RECURSIVE numbers(n) AS (
             SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?
           )
           INSERT INTO game_session_mutation_locks
             (lock_id, owner_id, operation_id, expires_at_ms, writer_generation, writer_owner_id)
           SELECT 'expired-' || n, 'owner', 'operation', 100, 2, 'owner' FROM numbers`,
        )
        .bind(GAME_SESSION_MUTATION_LOCK_SWEEP_LIMIT + 1)
        .run();
      const store = createGameSessionMutationLockStore(db);
      await store.acquire(lock, "active-owner", 100);
      expect(await store.deleteExpired(100)).toBe(1_000);
      expect(await readLock()).not.toBeNull();
      expect(await store.deleteExpired(100)).toBe(1);
      expect(await store.deleteExpired(100)).toBe(0);
    });

    it("wraps invalid values and storage failures with identifiable operations", async () => {
      const store = createGameSessionMutationLockStore(db);
      for (const nowMs of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
        await expect(store.acquire(lock, "owner", nowMs)).rejects.toMatchObject(
          { operation: "acquire" },
        );
      }
      await expect(
        store.acquire({ ...lock, lockId: "" }, "owner", 100),
      ).rejects.toMatchObject({ operation: "acquire" });
      await expect(
        store.acquire({ ...lock, lockId: "bad/path" }, "owner", 100),
      ).rejects.toMatchObject({ operation: "acquire" });
      const unavailable = createGameSessionMutationLockStore(
        interceptRuns(async () => {
          throw new Error("offline");
        }),
      );
      await expect(unavailable.deleteExpired(100)).rejects.toMatchObject({
        operation: "cleanup",
      });
    });
  });
});
