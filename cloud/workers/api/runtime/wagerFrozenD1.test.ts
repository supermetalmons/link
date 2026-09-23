import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEmptyMaterials } from "@mons/shared/mining";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { createWagerFrozenD1Store } from "../src/wagerFrozenD1.ts";
import { classifyD1Failure } from "../src/d1Failure.ts";
import { observeD1FailureDatabase } from "./d1FailureTestUtils.ts";
import {
  consumeWagerReservationOperation,
  operationFingerprint,
  readFrozenOperationForUid,
  reserveAcceptedMaterialsOnce,
  reserveFrozenMaterialsOnce,
} from "../src/wagerReservationOperations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_DB;
const materials = (dust = 0) => ({ ...createEmptyMaterials(), dust });
const signal = () => new AbortController().signal;
const store = () =>
  createWagerFrozenD1Store(db, { writeGuards: () => [], now: () => 100 });
const repository = (value = store()) =>
  ({ wagerFrozen: value }) as GameplayRepository;
const reserve = (
  repo: GameplayRepository,
  operationId: string,
  count = 3,
  uid = "host",
) =>
  reserveFrozenMaterialsOnce(
    repo,
    uid,
    operationId,
    "dust",
    count,
    materials(10),
    () => 100,
    signal(),
  );

function withBatch(
  intercept: (statements: D1PreparedStatement[]) => Promise<D1Result[]>,
): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") return intercept;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("D1 wager frozen reservations", () => {
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
    ]);
  });

  it("enforces complete, safe frozen counts at the schema boundary", async () => {
    for (const frozen of [
      {},
      { dust: 1 },
      { ...materials(), extra: 1 },
      materials(-1),
      materials(1.5),
      materials(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      await expect(
        db
          .prepare(
            "INSERT INTO wager_frozen_balances (player_uid, frozen_json, revision, updated_at_ms) VALUES (?, ?, 1, 0)",
          )
          .bind("invalid", JSON.stringify(frozen))
          .run(),
      ).rejects.toThrow();
    }
    expect(await store().readBalance("invalid")).toEqual({
      frozen: materials(),
      revision: 0,
    });
  });

  it("preserves UID isolation, replay fences, and permanent settlement tombstones", async () => {
    const repo = repository();
    expect(await repo.wagerFrozen!.readBalance("host")).toEqual({
      frozen: materials(),
      revision: 0,
    });
    expect(await reserve(repo, "send")).toBe(3);
    expect(await reserve(repo, "send")).toBe(3);
    expect(await readFrozenOperationForUid(repo, "host", "send")).toMatchObject(
      { appliedAtMs: 101, count: 3 },
    );
    expect(await repo.wagerFrozen!.readBalance("host")).toEqual({
      frozen: materials(3),
      revision: 2,
    });
    expect(await reserve(repo, "send", 2, "other-login")).toBe(2);
    expect(
      await consumeWagerReservationOperation(repo, "host", "send", true),
    ).toBe("released");
    expect(await reserve(repo, "send")).toBe(0);
    expect(await repo.wagerFrozen!.readBalance("host")).toEqual({
      frozen: materials(),
      revision: 3,
    });
    expect((await repo.wagerFrozen!.read("host", "send")).operation).toEqual({
      status: "consumed",
    });
    expect(await repo.wagerFrozen!.readBalance("other-login")).toEqual({
      frozen: materials(2),
      revision: 1,
    });
  });

  it("retries simultaneous reservations without overspending the shared UID balance", async () => {
    const counts = await Promise.all([
      reserve(repository(), "match-one", 8),
      reserve(repository(), "match-two", 8),
    ]);
    expect(counts.sort((a, b) => a - b)).toEqual([2, 8]);
    expect(await store().readBalance("host")).toEqual({
      frozen: materials(10),
      revision: 2,
    });
  });

  it("retains the balance revision when ordinary cleanup removes the last operation", async () => {
    const repo = repository();
    await reserve(repo, "send");
    expect(await consumeWagerReservationOperation(repo, "host", "send")).toBe(
      "released",
    );
    expect(await repo.wagerFrozen!.readBalance("host")).toEqual({
      frozen: materials(),
      revision: 2,
    });
    expect((await repo.wagerFrozen!.read("host", "send")).operation).toEqual({
      status: "absent",
    });
    await reserve(repo, "send");
    expect(await repo.wagerFrozen!.readBalance("host")).toEqual({
      frozen: materials(3),
      revision: 3,
    });
  });

  it("reconciles committed reservations and releases after their responses are lost", async () => {
    let loseNextResponse = true;
    const connection = withBatch(async (statements) => {
      const result = await db.batch(statements);
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error("lost-d1-response");
      }
      return result;
    });
    const repo = repository(
      createWagerFrozenD1Store(connection, { writeGuards: () => [] }),
    );
    expect(await reserve(repo, "send")).toBe(3);
    loseNextResponse = true;
    expect(await reserve(repo, "send")).toBe(3);
    loseNextResponse = true;
    expect(
      await consumeWagerReservationOperation(repo, "host", "send", true),
    ).toBe("released");
    expect(await store().readBalance("host")).toEqual({
      frozen: materials(),
      revision: 3,
    });
  });

  it("rejects a delayed cleanup batch after a reservation replay advances its revision", async () => {
    const live = repository();
    await reserve(live, "send");
    let pending: D1PreparedStatement[] | undefined;
    const connection = withBatch(async (statements) => {
      pending = statements;
      throw new Error("ambiguous-cleanup");
    });
    const stale = repository(
      createWagerFrozenD1Store(connection, { writeGuards: () => [] }),
    );
    await expect(
      consumeWagerReservationOperation(stale, "host", "send"),
    ).rejects.toThrow("ambiguous-cleanup");
    await reserve(live, "send");
    expect(pending).toBeDefined();
    const observed = observeD1FailureDatabase(db);
    await expect(observed.database.batch(pending!)).rejects.toThrow(
      "wager_frozen_revision_guard",
    );
    expect(observed.errors).toHaveLength(1);
    expect(classifyD1Failure(observed.errors[0])).toBe("wager-frozen-conflict");
    expect(await store().readBalance("host")).toEqual({
      frozen: materials(3),
      revision: 2,
    });
  });

  it.each([
    ["profile_transaction_guards", "guard"],
    ["wager_state_revision_guards", "wager-state-conflict"],
  ])(
    "rolls the balance back without retrying %s failures",
    async (table, kind) => {
      const connection = withBatch((statements) =>
        db.batch([
          ...statements,
          db.prepare(`INSERT INTO ${table} (singleton) VALUES (0)`),
        ]),
      );
      const observed = observeD1FailureDatabase(connection);
      const repo = repository(
        createWagerFrozenD1Store(observed.database, { writeGuards: () => [] }),
      );
      await expect(reserve(repo, "send")).rejects.toThrow(
        "wager-operation-unavailable",
      );
      expect(observed.batches).toHaveLength(1);
      expect(observed.errors).toHaveLength(1);
      expect(classifyD1Failure(observed.errors[0])).toBe(kind);
      expect(await store().readBalance("host")).toEqual({
        frozen: materials(),
        revision: 0,
      });
      expect((await store().read("host", "send")).operation).toEqual({
        status: "absent",
      });
    },
  );

  it("executes admission guards at the write boundary and honors aborted work", async () => {
    let open = true;
    const guarded = createWagerFrozenD1Store(db, {
      writeGuards: () => [
        db
          .prepare(
            "INSERT INTO profile_transaction_guards (singleton) SELECT 0 WHERE ? = 0",
          )
          .bind(open ? 1 : 0),
      ],
    });
    const current = await guarded.read("host", "send");
    open = false;
    await expect(
      guarded.transact("host", "send", () => ({
        value: { ...current, operation: { status: "consumed" } },
      })),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort(new Error("expired-admission"));
    await expect(
      guarded.transact(
        "host",
        "send",
        () => ({ value: current }),
        controller.signal,
      ),
    ).rejects.toThrow("expired-admission");
    expect(await store().readBalance("host")).toEqual({
      frozen: materials(),
      revision: 0,
    });
  });

  it("stops after 25 frozen conflicts and refreshes its clock and guards each attempt", async () => {
    const connection = withBatch((statements) =>
      db.batch([
        ...statements,
        db
          .prepare(
            "INSERT INTO wager_frozen_balances (player_uid, frozen_json, revision, updated_at_ms) VALUES ('conflict', ?, 0, 0)",
          )
          .bind(JSON.stringify(materials())),
      ]),
    );
    const observed = observeD1FailureDatabase(connection);
    let guards = 0;
    let clock = 100;
    let decisions = 0;
    const bounded = createWagerFrozenD1Store(observed.database, {
      writeGuards: () => {
        guards++;
        return [];
      },
      now: () => clock++,
    });
    await expect(
      bounded.transact("host", "send", (current) => {
        decisions++;
        return { value: { ...current, frozen: materials(3) } };
      }),
    ).rejects.toThrow("wager-operation-unavailable");
    expect(observed.batches).toHaveLength(25);
    expect(observed.sessions).toHaveLength(25);
    expect(observed.errors.map(classifyD1Failure)).toEqual(
      Array(25).fill("wager-frozen-conflict"),
    );
    expect({ guards, clock, decisions }).toEqual({
      guards: 25,
      clock: 125,
      decisions: 25,
    });
    expect(await store().readBalance("host")).toEqual({
      frozen: materials(),
      revision: 0,
    });
  });

  it("honors cancellation after a decision without writing, but retains a confirmed commit", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled-before-write");
    const observed = observeD1FailureDatabase(db);
    const cancelled = createWagerFrozenD1Store(observed.database, {
      writeGuards: () => [],
    });
    await expect(
      cancelled.transact(
        "host",
        "send",
        (current) => {
          controller.abort(reason);
          return { value: { ...current, frozen: materials(3) } };
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(observed.batches).toHaveLength(0);
    const committedController = new AbortController();
    const committed = createWagerFrozenD1Store(
      withBatch(async (statements) => {
        const result = await db.batch(statements);
        committedController.abort(reason);
        return result;
      }),
      { writeGuards: () => [] },
    );
    await expect(
      committed.transact(
        "host",
        "send",
        (current) => ({
          value: { ...current, frozen: materials(3) },
          decision: "reserved",
        }),
        committedController.signal,
      ),
    ).resolves.toEqual({
      committed: true,
      decision: "reserved",
      value: { frozen: materials(3), operation: { status: "absent" } },
    });
    expect(await store().readBalance("host")).toEqual({
      frozen: materials(3),
      revision: 1,
    });
  });

  it("preserves no-op accepts and refuses malformed or conflicting active records", async () => {
    const repo = repository();
    await reserve(repo, "send");
    const accepted = await reserveAcceptedMaterialsOnce(
      repo,
      "host",
      "accept",
      "dust",
      3,
      { material: "dust", count: 3 },
      materials(10),
      () => 100,
      signal(),
    );
    expect(accepted).toEqual({ acceptedCount: 3, appliedDelta: {} });
    expect(
      await consumeWagerReservationOperation(repo, "host", "accept", true),
    ).toBe("released");
    expect(await store().readBalance("host")).toEqual({
      frozen: materials(3),
      revision: 3,
    });
    await expect(reserve(repo, "send", 4)).rejects.toThrow(
      "wager-operation-conflict",
    );
    await db
      .prepare(
        "UPDATE wager_frozen_operations SET record_json = ? WHERE player_uid = ? AND operation_id = ?",
      )
      .bind(
        JSON.stringify({
          appliedAtMs: 100,
          count: 3,
          fingerprint: operationFingerprint("send-reserve", "dust", 3),
          deltas: {},
        }),
        "host",
        "send",
      )
      .run();
    await expect(
      consumeWagerReservationOperation(repo, "host", "send", true),
    ).rejects.toThrow("wager-operation-unavailable");
    expect(await store().readBalance("host")).toEqual({
      frozen: materials(3),
      revision: 3,
    });
  });

  it("tombstones an absent reservation and rejects missing production store admission", async () => {
    const repo = repository();
    expect(
      await consumeWagerReservationOperation(repo, "host", "absent", true),
    ).toBe("released");
    expect(await reserve(repo, "absent")).toBe(0);
    await expect(
      reserve({} as GameplayRepository, "missing-store"),
    ).rejects.toThrow("wager-operation-unavailable");
  });
});
