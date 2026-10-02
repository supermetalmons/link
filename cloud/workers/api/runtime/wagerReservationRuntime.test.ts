import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEmptyMaterials } from "@mons/shared/mining";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { createWagerReservationRuntime } from "../src/wagerReservationRuntime.ts";
import { reserveFrozenMaterialsOnce } from "../src/wagerReservationOperations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_DB;
const materials = (dust = 0) => ({ ...createEmptyMaterials(), dust });

function observeBalanceReads(
  intercept: (read: () => Promise<unknown>) => Promise<unknown> = (read) =>
    read(),
) {
  const sessions: Parameters<D1Database["withSession"]>[0][] = [];
  const queries: string[] = [];
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        if (property === "first")
          return async (...args: unknown[]) => {
            queries.push(query);
            return intercept(() => Reflect.apply(target.first, target, args));
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => wrap(target.prepare(query), query);
      if (property === "withSession")
        return (...args: Parameters<D1Database["withSession"]>) => {
          sessions.push(args[0]);
          const session = target.withSession(...args);
          return new Proxy(session, {
            get(current, key) {
              if (key === "prepare")
                return (query: string) => wrap(current.prepare(query), query);
              const value = Reflect.get(current, key, current);
              return typeof value === "function" ? value.bind(current) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = createWagerReservationRuntime(
    { ...env, PROFILE_DB: database },
    {} as GameplayRepository,
  );
  return { runtime, sessions, queries };
}

async function seedBalance(playerUid: string, dust: number, revision: number) {
  await db
    .prepare(
      `INSERT INTO wager_frozen_balances
       (player_uid, frozen_json, revision, updated_at_ms) VALUES (?, ?, ?, 0)`,
    )
    .bind(playerUid, JSON.stringify(materials(dust)), revision)
    .run();
}

async function freezeReservations() {
  await db.batch([
    db.prepare(
      "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
    ),
    db.prepare(
      "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
    ),
  ]);
}

function versionedRequest() {
  return new Request("https://api.mons.link/wagers/proposals/send", {
    headers: { "X-Mons-Wager-Storage-Version": "1" },
  });
}

describe("D1 wager reservation runtime", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM wager_frozen_operations"),
      db.prepare("DELETE FROM wager_frozen_balances"),
      db.prepare("DELETE FROM wager_reservation_write_admissions"),
      db.prepare(
        "UPDATE wager_reservation_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
      ),
    ]);
  });

  it("uses D1 exclusively, releases successful admissions, and permits frozen reads", async () => {
    let sourceAccesses = 0;
    let frozenWork = 0;
    const unexpectedSource = async () => {
      sourceAccesses++;
      throw new Error("unexpected-source-reservation-access");
    };
    const repository = {
      readInviteMetadata: unexpectedSource,
      wagers: { readWager: unexpectedSource },
    } as unknown as GameplayRepository;
    const runtime = createWagerReservationRuntime(env, repository, {
      now: () => 2_000_000,
    });
    await expect(
      runtime.assertClientVersion(
        new Request("https://api.mons.link/wagers/proposals/send"),
      ),
    ).rejects.toThrow("Reload this page");
    await expect(
      runtime.assertClientVersion(versionedRequest()),
    ).resolves.toBeUndefined();
    expect(
      await runtime.run("send", (admitted) =>
        reserveFrozenMaterialsOnce(
          admitted,
          "host",
          "reservation",
          "dust",
          3,
          { ...createEmptyMaterials(), dust: 10 },
          () => 2_000_000,
          new AbortController().signal,
        ),
      ),
    ).toBe(3);
    expect(await runtime.readBalance("host")).toEqual({
      frozen: { ...createEmptyMaterials(), dust: 3 },
      revision: 1,
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM wager_reservation_write_admissions",
        )
        .first("count"),
    ).toBe(0);
    await freezeReservations();
    expect((await runtime.readBalance("host")).frozen.dust).toBe(3);
    await expect(
      runtime.run("send", async () => {
        frozenWork++;
      }),
    ).rejects.toThrow("wager-reservation-writes-disabled");
    expect(frozenWork).toBe(0);
    expect(sourceAccesses).toBe(0);
  });

  it("fails unavailable D1 control closed without querying gameplay storage", async () => {
    let sourceAccesses = 0;
    const repository = {
      readInviteMetadata: async () => {
        sourceAccesses++;
        return null;
      },
    } as unknown as GameplayRepository;
    const brokenDb = new Proxy(db, {
      get(target, property) {
        if (property === "prepare" || property === "withSession")
          return () => {
            throw new Error("control-unavailable");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtime = createWagerReservationRuntime(
      { ...env, PROFILE_DB: brokenDb },
      repository,
    );
    await expect(runtime.readBalance("host")).rejects.toThrow(
      "wager-reservation-unavailable",
    );
    await expect(
      runtime.run("send", async () => {
        throw new Error("unexpected-work");
      }),
    ).rejects.toThrow("wager-reservation-unavailable");
    expect(sourceAccesses).toBe(0);
  });

  it.each(["d1", "frozen"])(
    "reads populated and absent balances in one primary snapshot while %s",
    async (mode) => {
      await seedBalance("host", 3, 7);
      await seedBalance("other", 9, 8);
      if (mode === "frozen") await freezeReservations();
      const observed = observeBalanceReads();
      expect(await observed.runtime.readBalance("host")).toEqual({
        frozen: materials(3),
        revision: 7,
      });
      expect(await observed.runtime.readBalance("other")).toEqual({
        frozen: materials(9),
        revision: 8,
      });
      expect(await observed.runtime.readBalance("absent")).toEqual({
        frozen: materials(),
        revision: 0,
      });
      expect(observed.sessions).toEqual(Array(3).fill("first-primary"));
      expect(observed.queries).toHaveLength(3);
      expect(
        observed.queries.every(
          (query) =>
            query.includes("wager_reservation_runtime_control") &&
            query.includes("wager_frozen_balances"),
        ),
      ).toBe(true);
    },
  );

  it("rejects absent and malformed controls without returning a zero balance", async () => {
    const absent = {
      storage_mode: "d1",
      freeze_generation: 2,
      balance_player_uid: null,
      frozen_json: null,
      revision: null,
    };
    for (const row of [
      null,
      {},
      { ...absent, storage_mode: "firebase" },
      { ...absent, storage_mode: undefined },
      { ...absent, freeze_generation: undefined },
      { ...absent, freeze_generation: -1 },
      { ...absent, freeze_generation: 1.5 },
      { ...absent, freeze_generation: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const observed = observeBalanceReads(async () => row);
      await expect(observed.runtime.readBalance("host")).rejects.toMatchObject({
        status: 503,
        code: "unavailable",
        message: "wager-reservation-unavailable",
      });
      expect(observed.queries).toHaveLength(1);
    }
  });

  it("rejects incomplete and corrupt balance rows without treating them as absent", async () => {
    const balance = {
      storage_mode: "d1",
      freeze_generation: 2,
      balance_player_uid: "host",
      frozen_json: JSON.stringify(materials(3)),
      revision: 7,
    };
    for (const row of [
      { storage_mode: "d1", freeze_generation: 2 },
      { ...balance, balance_player_uid: null },
      { ...balance, balance_player_uid: "other" },
      { ...balance, frozen_json: null },
      { ...balance, frozen_json: "invalid-json" },
      { ...balance, frozen_json: "{}" },
      { ...balance, frozen_json: JSON.stringify(materials(-1)) },
      { ...balance, frozen_json: JSON.stringify(materials(1.5)) },
      { ...balance, revision: null },
      { ...balance, revision: 0 },
      { ...balance, revision: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const observed = observeBalanceReads(async () => row);
      await expect(observed.runtime.readBalance("host")).rejects.toThrow();
      expect(observed.queries).toHaveLength(1);
    }
  });

  it("fails closed when the primary snapshot query rejects", async () => {
    const observed = observeBalanceReads(async () => {
      throw new Error("d1-query-unavailable");
    });
    await expect(observed.runtime.readBalance("host")).rejects.toMatchObject({
      status: 503,
      code: "unavailable",
      message: "wager-reservation-unavailable",
    });
    expect(observed.queries).toHaveLength(1);
  });

  it("rejects invalid actors before opening a primary session", async () => {
    const observed = observeBalanceReads();
    await expect(observed.runtime.readBalance("bad/key")).rejects.toThrow(
      "invalid-wager-frozen-key",
    );
    expect(observed.sessions).toEqual([]);
    expect(observed.queries).toEqual([]);
  });

  it.each(["before", "after"])(
    "keeps a coherent balance when freezing %s the SQL snapshot",
    async (timing) => {
      await seedBalance("host", 3, 7);
      let changed = false;
      const freezeAndUpdate = async () => {
        await freezeReservations();
        await db
          .prepare(
            "UPDATE wager_frozen_balances SET frozen_json = ?, revision = 8 WHERE player_uid = 'host'",
          )
          .bind(JSON.stringify(materials(9)))
          .run();
      };
      const observed = observeBalanceReads(async (read) => {
        if (changed) return read();
        changed = true;
        if (timing === "before") await freezeAndUpdate();
        const snapshot = await read();
        if (timing === "after") await freezeAndUpdate();
        return snapshot;
      });
      expect(await observed.runtime.readBalance("host")).toEqual({
        frozen: materials(timing === "before" ? 9 : 3),
        revision: timing === "before" ? 8 : 7,
      });
      expect(observed.queries).toHaveLength(1);
      expect(await observed.runtime.readBalance("host")).toEqual({
        frozen: materials(9),
        revision: 8,
      });
      expect(observed.queries).toHaveLength(2);
      expect(observed.sessions).toEqual(["first-primary", "first-primary"]);
    },
  );
});
