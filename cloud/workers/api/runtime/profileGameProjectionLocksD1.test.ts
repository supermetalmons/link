import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  createProfileGameProjectionLockStore,
  PROFILE_GAME_PROJECTION_LOCK_MS,
  PROFILE_GAME_PROJECTION_LOCK_SWEEP_LIMIT,
  type ProfileGameProjectionLock,
} from "../src/profileGameProjectionLocksD1.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const invite: ProfileGameProjectionLock = {
  scope: "invite",
  resourceId: "invite-1",
  requestId: "request-1",
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

function row(lock = invite) {
  return db
    .prepare(
      "SELECT owner_id, request_id, expires_at_ms FROM profile_game_projection_locks WHERE scope = ? AND resource_id = ?",
    )
    .bind(lock.scope, lock.resourceId)
    .first();
}

describe("D1 profile game projection locks", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.prepare("DELETE FROM profile_game_projection_locks").run();
  });

  it("allows exactly one concurrent owner and rejects same-owner re-entry", async () => {
    const stores = Array.from({ length: 8 }, () =>
      createProfileGameProjectionLockStore(db),
    );
    const outcomes = await Promise.allSettled(
      stores.map((store, index) =>
        store.acquire(invite, `owner-${index}`, 100),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const winner = outcomes.findIndex(
      (outcome) => outcome.status === "fulfilled",
    );
    expect(await row()).toEqual({
      owner_id: `owner-${winner}`,
      request_id: "request-1",
      expires_at_ms: 100 + PROFILE_GAME_PROJECTION_LOCK_MS,
    });
    await expect(
      stores[winner].acquire(invite, `owner-${winner}`, 101),
    ).rejects.toMatchObject({
      message: "profile-game-projection-lock-busy",
      scope: "invite",
    });
  });

  it("separates resource IDs and lock scopes", async () => {
    const store = createProfileGameProjectionLockStore(db);
    const keys: ProfileGameProjectionLock[] = [
      invite,
      { scope: "invite", resourceId: "invite-2" },
      { scope: "profile-link", resourceId: invite.resourceId },
    ];
    await Promise.all(keys.map((key) => store.acquire(key, "owner", 100)));
    for (const key of keys)
      expect(await row(key)).toMatchObject({ owner_id: "owner" });
    expect(await row(keys[1])).toMatchObject({ request_id: null });
  });

  it("takes over only at expiry and protects the successor from stale release", async () => {
    const store = createProfileGameProjectionLockStore(db);
    await store.acquire(invite, "old-owner", 100);
    await expect(
      store.acquire(invite, "new-owner", 99 + PROFILE_GAME_PROJECTION_LOCK_MS),
    ).rejects.toThrow("lock-busy");
    await store.acquire(
      { ...invite, requestId: "new-request" },
      "new-owner",
      100 + PROFILE_GAME_PROJECTION_LOCK_MS,
    );
    await store.release(invite, "old-owner");
    expect(await row()).toMatchObject({
      owner_id: "new-owner",
      request_id: "new-request",
    });
    await store.release(invite, "new-owner");
    expect(await row()).toBeNull();
    await expect(store.release(invite, "new-owner")).resolves.toBeUndefined();
  });

  it("retries a failed release and safely handles an ambiguous successful delete", async () => {
    const base = createProfileGameProjectionLockStore(db);
    for (const afterCommit of [false, true]) {
      await base.acquire(invite, "owner", 100);
      let attempts = 0;
      const store = createProfileGameProjectionLockStore(
        interceptRuns(async (_query, run) => {
          attempts++;
          if (attempts === 1) {
            if (afterCommit) await run();
            throw new Error("transient-release");
          }
          return run();
        }),
      );
      await store.release(invite, "owner");
      expect(attempts).toBe(2);
      expect(await row()).toBeNull();
    }
  });

  it("fails after three release attempts without deleting the lease", async () => {
    await createProfileGameProjectionLockStore(db).acquire(
      invite,
      "owner",
      100,
    );
    let attempts = 0;
    const store = createProfileGameProjectionLockStore(
      interceptRuns(async () => {
        attempts++;
        throw new Error("offline");
      }),
    );
    await expect(store.release(invite, "owner")).rejects.toMatchObject({
      message: "profile-game-projection-lock-release-failed",
      scope: "invite",
    });
    expect(attempts).toBe(3);
    expect(await row()).toMatchObject({ owner_id: "owner" });
  });

  it("fails closed on acquisition errors, including lost responses after a write", async () => {
    const store = createProfileGameProjectionLockStore(
      interceptRuns(async (_query, run) => {
        await run();
        throw new Error("lost-response");
      }),
    );
    await expect(store.acquire(invite, "owner", 100)).rejects.toMatchObject({
      message: "profile-game-projection-lock-acquire-failed",
      scope: "invite",
    });
    await expect(
      createProfileGameProjectionLockStore(db).acquire(
        invite,
        "contender",
        101,
      ),
    ).rejects.toThrow("lock-busy");
  });

  it("removes at most 1000 expired rows and preserves active leases", async () => {
    await db
      .prepare(
        `WITH RECURSIVE numbers(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?
       )
       INSERT INTO profile_game_projection_locks
         (scope, resource_id, owner_id, expires_at_ms)
       SELECT 'invite', 'expired-' || n, 'owner', 100 FROM numbers`,
      )
      .bind(PROFILE_GAME_PROJECTION_LOCK_SWEEP_LIMIT + 1)
      .run();
    const store = createProfileGameProjectionLockStore(db);
    await store.acquire(invite, "active-owner", 100);
    expect(await store.deleteExpired(100)).toBe(1_000);
    expect(await row()).toMatchObject({ owner_id: "active-owner" });
    expect(await store.deleteExpired(100)).toBe(1);
    expect(await store.deleteExpired(100)).toBe(0);
  });

  it("rejects invalid lease values and reports cleanup failures", async () => {
    const store = createProfileGameProjectionLockStore(db);
    for (const nowMs of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      await expect(store.acquire(invite, "owner", nowMs)).rejects.toThrow(
        "lock-acquire-failed",
      );
    }
    await expect(
      store.acquire({ ...invite, resourceId: "bad/path" }, "owner", 100),
    ).rejects.toThrow("lock-acquire-failed");
    await expect(store.acquire(invite, "", 100)).rejects.toThrow(
      "lock-acquire-failed",
    );
    expect(await row()).toBeNull();
    const unavailable = createProfileGameProjectionLockStore(
      interceptRuns(async () => {
        throw new Error("offline");
      }),
    );
    await expect(unavailable.deleteExpired(100)).rejects.toMatchObject({
      message: "profile-game-projection-lock-cleanup-failed",
      scope: "cleanup",
    });
  });
});
