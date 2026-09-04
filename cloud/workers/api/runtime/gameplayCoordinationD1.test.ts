import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGameSessionMutationLockStore,
  createGameplayCoordinationStores,
  createMatchTimerStartStore,
  GAME_SESSION_MUTATION_LOCK_MS,
  GAME_SESSION_MUTATION_LOCK_RELEASE_ATTEMPTS,
  GAME_SESSION_MUTATION_LOCK_SWEEP_LIMIT,
  GameSessionMutationLockFailure,
  MatchTimerStartStoreFailure,
  type GameSessionMutationLock,
  type MatchTimerStartCandidate,
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

async function readTimer(playerId: string, matchId: string) {
  return db
    .prepare(
      `SELECT timer, turn_number, updated_at_ms
       FROM match_timer_starts
       WHERE player_id = ? AND match_id = ?`,
    )
    .bind(playerId, matchId)
    .first();
}

async function readTimerOpponent(playerId: string, matchId: string) {
  return db
    .prepare(
      `SELECT opponent_id
       FROM match_timer_starts
       WHERE player_id = ? AND match_id = ?`,
    )
    .bind(playerId, matchId)
    .first("opponent_id");
}

describe("D1 gameplay coordination", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM game_session_mutation_locks"),
      db.prepare("DELETE FROM match_timer_starts"),
    ]);
  });

  it("enforces slash-free coordination keys at the schema boundary", async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO game_session_mutation_locks
             (lock_id, owner_id, operation_id, expires_at_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .bind("bad/lock", "owner", "operation", 100)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT INTO match_timer_starts
             (player_id, match_id, timer, turn_number, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind("bad/player", "match-1", "1;1000", 1, 100)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT INTO match_timer_starts
             (player_id, match_id, timer, turn_number, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind("player-1", "bad/match", "1;1000", 1, 100)
        .run(),
    ).rejects.toThrow();
  });

  describe("game-session mutation locks", () => {
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
        owner_id: `owner-${winners[0].index}`,
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
             (lock_id, owner_id, operation_id, expires_at_ms)
           SELECT 'expired-' || n, 'owner', 'operation', 100 FROM numbers`,
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

  describe("match-timer starts", () => {
    it("converges concurrent same-turn callers on the first exact marker", async () => {
      const candidates = Array.from({ length: 8 }, (_, index) => ({
        timer: `3;${10_000 + index}`,
        turnNumber: 3,
      }));
      const stores = candidates.map(
        () => createGameplayCoordinationStores(db).timerStarts,
      );
      const results = await Promise.all(
        stores.map((store, index) =>
          store.getOrAdvance(
            "player-1",
            "player-2",
            "match-1",
            candidates[index],
            1_000 + index,
          ),
        ),
      );
      expect(new Set(results.map(({ timer }) => timer))).toHaveLength(1);
      expect(
        new Set(results.map(({ updatedAtMs }) => updatedAtMs)),
      ).toHaveLength(1);
      expect(await readTimer("player-1", "match-1")).toEqual({
        timer: results[0].timer,
        turn_number: 3,
        updated_at_ms: results[0].updatedAtMs,
      });
    });

    it("advances newer turns while returning the stored marker to same or older turns", async () => {
      const store = createMatchTimerStartStore(db);
      const first = await store.getOrAdvance(
        "player-1",
        "player-2",
        "match-1",
        { timer: "2;2000", turnNumber: 2 },
        1_000,
      );
      expect(
        await store.getOrAdvance(
          "player-1",
          "player-2",
          "match-1",
          { timer: "2;9999", turnNumber: 2 },
          1_100,
        ),
      ).toEqual(first);
      const advanced = await store.getOrAdvance(
        "player-1",
        "player-3",
        "match-1",
        { timer: "3;3000", turnNumber: 3 },
        1_200,
      );
      expect(advanced).toEqual({
        timer: "3;3000",
        turnNumber: 3,
        updatedAtMs: 1_200,
      });
      expect(await readTimerOpponent("player-1", "match-1")).toBe("player-3");
      expect(
        await store.getOrAdvance(
          "player-1",
          "player-3",
          "match-1",
          { timer: "1;1000", turnNumber: 1 },
          1_300,
        ),
      ).toEqual(advanced);
    });

    it("fills a legacy opponent without changing the first same-turn deadline", async () => {
      await db
        .prepare(
          `INSERT INTO match_timer_starts
             (player_id, match_id, timer, turn_number, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind("player-1", "match-1", "2;2000", 2, 100)
        .run();
      await expect(
        createMatchTimerStartStore(db).getOrAdvance(
          "player-1",
          "player-2",
          "match-1",
          { timer: "2;9999", turnNumber: 2 },
          200,
        ),
      ).resolves.toEqual({
        timer: "2;2000",
        turnNumber: 2,
        updatedAtMs: 100,
      });
      expect(await readTimerOpponent("player-1", "match-1")).toBe("player-2");
      await expect(
        createMatchTimerStartStore(db).getOrAdvance(
          "player-1",
          "player-3",
          "match-1",
          { timer: "2;2000", turnNumber: 2 },
          300,
        ),
      ).rejects.toMatchObject({ operation: "get-or-advance" });
    });

    it("lists oldest markers and fences reconciliation writes exactly", async () => {
      const store = createMatchTimerStartStore(db);
      for (const [playerId, updatedAtMs] of [
        ["player-3", 300],
        ["player-1", 100],
        ["player-2", 200],
      ] as const) {
        await store.getOrAdvance(
          playerId,
          "opponent",
          "match-1",
          { timer: "1;1000", turnNumber: 1 },
          updatedAtMs,
        );
      }
      const oldest = await store.listOldest(2);
      expect(oldest.map(({ playerId }) => playerId)).toEqual([
        "player-1",
        "player-2",
      ]);
      expect(await store.touchIfUnchanged(oldest[0], 400)).toBe(true);
      expect(await store.touchIfUnchanged(oldest[0], 500)).toBe(false);
      expect(await store.deleteIfUnchanged(oldest[0])).toBe(false);
      const refreshed = (await store.listOldest()).find(
        ({ playerId }) => playerId === "player-1",
      );
      expect(refreshed?.updatedAtMs).toBe(400);
      expect(await store.deleteIfUnchanged(refreshed!)).toBe(true);
      expect(await readTimer("player-1", "match-1")).toBeNull();
      await expect(store.listOldest(101)).rejects.toMatchObject({
        operation: "list",
      });
    });

    it("backfills legacy opponents only through an exact marker fence", async () => {
      await db
        .prepare(
          `INSERT INTO match_timer_starts
             (player_id, match_id, timer, turn_number, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind("player-1", "match-1", "2;2000", 2, 100)
        .run();
      const store = createMatchTimerStartStore(db);
      const marker = (await store.listOldest())[0];
      expect(await store.touchIfUnchanged(marker, 200)).toBe(true);
      expect(await store.backfillOpponentIfUnchanged(marker, "player-2")).toBe(
        false,
      );
      const current = (await store.listOldest())[0];
      expect(await store.backfillOpponentIfUnchanged(current, "player-2")).toBe(
        true,
      );
      expect(await readTimerOpponent("player-1", "match-1")).toBe("player-2");
      expect(await store.backfillOpponentIfUnchanged(current, "player-3")).toBe(
        false,
      );
    });

    it("preserves the exact candidate across an ambiguous batch response", async () => {
      let attempts = 0;
      const store = createMatchTimerStartStore({
        prepare: (query) => db.prepare(query),
        async batch<T = unknown>(statements: D1PreparedStatement[]) {
          attempts++;
          const results = await db.batch<T>(statements);
          if (attempts === 1) throw new Error("lost-response");
          return results;
        },
      });
      const candidate: MatchTimerStartCandidate = {
        timer: "4;5000",
        turnNumber: 4,
      };
      await expect(
        store.getOrAdvance("player-1", "player-2", "match-1", candidate, 1_000),
      ).rejects.toMatchObject({ operation: "get-or-advance" });
      await expect(
        store.getOrAdvance("player-1", "player-2", "match-1", candidate, 1_000),
      ).resolves.toEqual({ ...candidate, updatedAtMs: 1_000 });
      expect(attempts).toBe(2);
    });

    it("deletes one marker or a participant pair idempotently", async () => {
      const store = createMatchTimerStartStore(db);
      for (const [playerId, matchId] of [
        ["player-1", "match-1"],
        ["player-2", "match-1"],
        ["player-3", "match-1"],
        ["player-1", "match-2"],
      ]) {
        await store.getOrAdvance(
          playerId,
          "opponent",
          matchId,
          { timer: "1;1000", turnNumber: 1 },
          100,
        );
      }
      await store.delete("player-3", "match-1");
      await store.delete("player-3", "match-1");
      await store.deletePair("player-1", "player-2", "match-1");
      await store.deletePair("player-1", "player-2", "match-1");
      expect(await readTimer("player-1", "match-1")).toBeNull();
      expect(await readTimer("player-2", "match-1")).toBeNull();
      expect(await readTimer("player-3", "match-1")).toBeNull();
      expect(await readTimer("player-1", "match-2")).not.toBeNull();
    });

    it("rejects unsafe keys, malformed timers, and timer-turn mismatches", async () => {
      const store = createMatchTimerStartStore(db);
      for (const [playerId, matchId, candidate] of [
        ["bad/player", "match-1", { timer: "1;1000", turnNumber: 1 }],
        ["player-1", "bad/match", { timer: "1;1000", turnNumber: 1 }],
        ["player-1", "match-1", { timer: "1:1000", turnNumber: 1 }],
        ["player-1", "match-1", { timer: "2;1000", turnNumber: 1 }],
      ] as const) {
        await expect(
          store.getOrAdvance(playerId, "opponent", matchId, candidate, 100),
        ).rejects.toMatchObject({ operation: "get-or-advance" });
      }
      expect(await readTimer("player-1", "match-1")).toBeNull();
      await db
        .prepare(
          `INSERT INTO match_timer_starts
             (player_id, match_id, timer, turn_number, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind("player-1", "match-1", "malformed", 1, 100)
        .run();
      await expect(
        store.getOrAdvance(
          "player-1",
          "player-2",
          "match-1",
          { timer: "1;1000", turnNumber: 1 },
          100,
        ),
      ).rejects.toMatchObject({ operation: "get-or-advance" });
    });

    it("uses one batch and identifies read, single-delete, and pair-delete failures", async () => {
      let batches = 0;
      const store = createMatchTimerStartStore({
        prepare: (query) => db.prepare(query),
        async batch<T = unknown>(statements: D1PreparedStatement[]) {
          batches++;
          return db.batch<T>(statements);
        },
      });
      await store.getOrAdvance(
        "player-1",
        "player-2",
        "match-1",
        { timer: "1;1000", turnNumber: 1 },
        100,
      );
      expect(batches).toBe(1);

      const unavailableStatements = interceptRuns(async () => {
        throw new Error("offline");
      });
      const unavailable = createMatchTimerStartStore({
        prepare: unavailableStatements.prepare,
        async batch() {
          throw new Error("offline");
        },
      });
      await expect(
        unavailable.getOrAdvance(
          "player-1",
          "player-2",
          "match-1",
          { timer: "1;1000", turnNumber: 1 },
          100,
        ),
      ).rejects.toBeInstanceOf(MatchTimerStartStoreFailure);
      await expect(
        unavailable.delete("player-1", "match-1"),
      ).rejects.toMatchObject({ operation: "delete" });
      await expect(
        unavailable.deletePair("player-1", "player-2", "match-1"),
      ).rejects.toMatchObject({ operation: "delete-pair" });
    });
  });
});
