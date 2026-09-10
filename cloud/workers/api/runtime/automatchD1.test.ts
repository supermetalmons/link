import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireAutomatchWriteAdmission,
  assertAutomatchWriteAdmission,
  AUTOMATCH_RECORD_TABLES,
  AUTOMATCH_ROOTS,
  automatchAdmissionGuardStatements,
  createAutomatchD1Store,
  parseAutomatchPath,
  readAutomatchRuntimeControl,
  releaseAutomatchWriteAdmission,
  type AutomatchRoot,
} from "../src/automatchD1.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const nowMs = 1_800_000_000_000;

async function writableStore() {
  const admission = await acquireAutomatchWriteAdmission(db, "test", {
    now: () => nowMs,
  });
  const store = createAutomatchD1Store(db, {
    now: () => nowMs,
    writeGuards: () => automatchAdmissionGuardStatements(db, admission),
  });
  return { admission, store };
}

describe("D1 automatch state", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM game_session_transition_resources"),
      db.prepare("DELETE FROM game_session_transitions"),
      ...[
        ...new Set(
          Object.values(AUTOMATCH_RECORD_TABLES).map(({ table }) => table),
        ),
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
      db.prepare("DELETE FROM automatch_write_admissions"),
      db.prepare("DELETE FROM automatch_runtime_control"),
      db.prepare(
        `INSERT INTO automatch_runtime_control
           (singleton, backend, state, epoch, freeze_generation)
         VALUES (1, 'd1', 'active', 2, 1)`,
      ),
    ]);
  });

  it("maps only the six owned roots and rejects malformed owned keys", () => {
    expect(AUTOMATCH_ROOTS).toHaveLength(6);
    expect(parseAutomatchPath("/automatch/invite/uid/")).toEqual({
      root: "automatch",
      key: "invite",
      nested: ["uid"],
    });
    expect(parseAutomatchPath("profileGameProjectionOutbox/automatch")).toEqual(
      {
        root: "profileGameProjectionOutbox/automatch",
        key: null,
        nested: [],
      },
    );
    expect(
      parseAutomatchPath("profileGameProjectionOutbox/event/id"),
    ).toBeNull();
    expect(parseAutomatchPath("invites/id")).toBeNull();
    expect(() => parseAutomatchPath("automatch/id//uid")).toThrow();
  });

  it("rolls back every root when one expected revision changed", async () => {
    const { store } = await writableStore();
    const first = await store.preparePatch({
      "automatch/invite": { uid: "host" },
      "telegramAutomatches/invite": { lifecycle: "pending", generation: 1 },
      "gameplayMutationReceipts/operation": { kind: "automatch-start" },
    });
    await store.patchRoot({ "automatch/invite": { uid: "new-host" } });
    expect(await store.commit(first)).toBe(false);
    expect(await store.getPath("automatch/invite/uid")).toBe("new-host");
    expect(await store.getPath("telegramAutomatches/invite")).toBeNull();
    expect(
      await store.getPath("gameplayMutationReceipts/operation"),
    ).toBeNull();
  });

  it("preserves deleted revisions so a delete and recreation cannot satisfy an old CAS", async () => {
    const { store } = await writableStore();
    const absent = await store.read("automatch", "invite");
    await store.patchRoot({ "automatch/invite": { uid: "host" } });
    await store.patchRoot({ "automatch/invite": null });
    expect(await store.read("automatch", "invite")).toEqual({
      root: "automatch",
      key: "invite",
      value: null,
      revision: 2,
    });
    expect(await store.list("automatch")).toEqual([]);
    expect(
      await store.commit([{ current: absent, value: { uid: "stale" } }]),
    ).toBe(false);
    await store.patchRoot({ "automatch/invite": { uid: "new-host" } });
    expect((await store.read("automatch", "invite")).revision).toBe(3);
  });

  it("co-locates receipts and orphan expiration markers without coupling component revisions", async () => {
    const { store } = await writableStore();
    const receipt = await store.read("gameplayMutationReceipts", "operation");
    await store.patchRoot({
      "gameplayMutationReceiptExpirations/operation": { completedAtMs: 10 },
    });
    expect(
      await store.commit([
        {
          current: receipt,
          value: { kind: "invite-create", completedAtMs: 10 },
        },
      ]),
    ).toBe(true);
    await store.patchRoot({ "gameplayMutationReceipts/operation": null });
    expect(
      await store.getPath("gameplayMutationReceiptExpirations/operation"),
    ).toEqual({ completedAtMs: 10 });
    expect(
      await store.read("gameplayMutationReceipts", "operation"),
    ).toMatchObject({ value: null, revision: 2 });
    expect(
      await store.read("gameplayMutationReceiptExpirations", "operation"),
    ).toMatchObject({ revision: 1 });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM game_session_mutation_receipts")
        .first("count"),
    ).toBe(1);
  });

  it("commits receipt and expiration mutations in either order in one batch", async () => {
    const { store } = await writableStore();
    for (const roots of [
      ["gameplayMutationReceipts", "gameplayMutationReceiptExpirations"],
      ["gameplayMutationReceiptExpirations", "gameplayMutationReceipts"],
    ]) {
      const key = roots[0];
      await store.patchRoot(
        Object.fromEntries(
          roots.map((root) => [`${root}/${key}`, { completedAtMs: 10 }]),
        ),
      );
      await store.patchRoot(
        Object.fromEntries(roots.map((root) => [`${root}/${key}`, null])),
      );
      for (const root of roots) {
        expect(await store.read(root as AutomatchRoot, key)).toMatchObject({
          value: null,
          revision: 2,
        });
      }
    }
  });

  it("preserves malformed source JSON and Firebase child-value query ordering", async () => {
    const { store } = await writableStore();
    const root = "profileGameProjectionOutbox/automatch";
    const fixtures = {
      nullChild: { lastQueuedAtMs: null, broken: true },
      missingChild: { invalid: "outbox" },
      falseChild: { lastQueuedAtMs: false },
      trueChild: { lastQueuedAtMs: true },
      zeroChild: { lastQueuedAtMs: 0 },
      laterChild: { lastQueuedAtMs: 20 },
      stringChild: { lastQueuedAtMs: "2" },
      objectChild: { lastQueuedAtMs: { unexpected: 1 } },
      malformed: "not-an-outbox",
      array: ["malformed"],
    };
    await store.patchRoot(
      Object.fromEntries(
        Object.entries(fixtures).map(([key, value]) => [
          `${root}/${key}`,
          value,
        ]),
      ),
    );
    expect(await store.getPath(`${root}/malformed`)).toBe("not-an-outbox");
    expect(await store.getPath(`${root}/array`)).toEqual(["malformed"]);
    expect(
      (
        await store.list(root, { orderBy: "lastQueuedAtMs", equalTo: null })
      ).map(({ key }) => key),
    ).toEqual(["array", "malformed", "missingChild", "nullChild"]);
    expect(
      (
        await store.list(root, {
          orderBy: "lastQueuedAtMs",
          startAt: 0,
          endAt: 20,
        })
      ).map(({ key }) => key),
    ).toEqual(["zeroChild", "laterChild"]);
    expect(
      (
        await store.list(root, {
          orderBy: "lastQueuedAtMs",
          endAt: 0,
          limitToFirst: 20,
        })
      ).map(({ key }) => key),
    ).toEqual([
      "array",
      "malformed",
      "missingChild",
      "nullChild",
      "falseChild",
      "trueChild",
      "zeroChild",
    ]);
    expect(
      (await store.list(root, { orderBy: "lastQueuedAtMs", equalTo: "2" })).map(
        ({ key }) => key,
      ),
    ).toEqual(["stringChild"]);
  });

  it("preserves numeric Firebase key ordering and deterministic UID limits", async () => {
    const { store } = await writableStore();
    for (const key of [
      "10",
      "2",
      "02",
      "-1",
      "2147483648",
      "auto-z",
      "auto-a",
    ]) {
      await store.patchRoot({
        [`automatch/${key}`]: { uid: "same", timestamp: key },
      });
    }
    expect(
      (await store.list("automatch", { orderBy: "$key" })).map(
        ({ key }) => key,
      ),
    ).toEqual(["-1", "2", "02", "10", "2147483648", "auto-a", "auto-z"]);
    expect(
      (
        await store.list("automatch", {
          orderBy: "$key",
          startAt: "2",
          endAt: "10",
        })
      ).map(({ key }) => key),
    ).toEqual(["2", "02", "10"]);
    expect(
      (
        await store.list("automatch", {
          orderBy: "uid",
          equalTo: "same",
          limitToFirst: 2,
        })
      ).map(({ key }) => key),
    ).toEqual(["-1", "2"]);
    await expect(
      store.list("automatch", { orderBy: "unsupported" }),
    ).rejects.toThrow();
    await expect(
      store.getPath("automatch", { shallow: true, limitToFirst: 1 }),
    ).rejects.toThrow();
  });

  it("resolves one timestamp and preserves sibling historical descriptors on nested patches", async () => {
    const { store } = await writableStore();
    await store.patchRoot({
      "telegramAutomatches/invite": { generation: 2, lifecycle: "pending" },
      "profileGameProjectionOutbox/automatch/invite": {
        requestId: "old",
        historicalMatches: { first: { finalizedAtMs: 1 } },
      },
    });
    const prepared = await store.preparePatch(
      {
        "telegramAutomatches/invite/generation": { ".sv": { increment: 1 } },
        "telegramAutomatches/invite/updatedAtMs": { ".sv": "timestamp" },
        "profileGameProjectionOutbox/automatch/invite/sourceUpdatedAtMs": {
          ".sv": "timestamp",
        },
        "profileGameProjectionOutbox/automatch/invite/historicalMatches/second":
          { finalizedAtMs: 2 },
      },
      500,
    );
    expect(await store.commit(prepared)).toBe(true);
    expect(await store.getPath("telegramAutomatches/invite")).toEqual({
      generation: 3,
      lifecycle: "pending",
      updatedAtMs: 500,
    });
    expect(
      await store.getPath("profileGameProjectionOutbox/automatch/invite"),
    ).toEqual({
      requestId: "old",
      sourceUpdatedAtMs: 500,
      historicalMatches: {
        first: { finalizedAtMs: 1 },
        second: { finalizedAtMs: 2 },
      },
    });
    await expect(
      store.preparePatch({ "automatch/id": {}, "automatch/id/uid": "host" }),
    ).rejects.toThrow("overlapping");
  });

  it("retries a conflicted transaction and fences stale queue settlement", async () => {
    const { store } = await writableStore();
    const path = "telegramProjectionOutbox/automatch/invite";
    await store.patchRoot({ [path]: { requestId: "first", count: 1 } });
    let releaseFirst: () => void = () => {};
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalPaused: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });
    let guarded = false;
    const admission = await acquireAutomatchWriteAdmission(
      db,
      "concurrency-test",
    );
    const blockingDb = new Proxy(db, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!guarded) {
              guarded = true;
              signalPaused();
              await firstPaused;
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const blocked = createAutomatchD1Store(blockingDb, {
      writeGuards: () => automatchAdmissionGuardStatements(db, admission),
    });
    let calls = 0;
    const pending = blocked.transactPath(path, (current) => {
      calls++;
      const input = current as { count: number; requestId: string };
      return { value: { ...input, count: input.count + 1 } };
    });
    await paused;
    await store.patchRoot({ [path]: { requestId: "second", count: 5 } });
    releaseFirst();
    await expect(pending).resolves.toMatchObject({
      committed: true,
      value: { requestId: "second", count: 6 },
    });
    expect(calls).toBe(2);
    await expect(
      store.transactPath(path, (current) =>
        (current as { requestId: string }).requestId === "first"
          ? { value: null }
          : { commit: false, decision: "stale" },
      ),
    ).resolves.toMatchObject({ committed: false, decision: "stale" });
  });

  it("requires explicit write guards and fails closed without control", async () => {
    const store = createAutomatchD1Store(db);
    await expect(store.commit([])).rejects.toThrow("read-only");
    await db.prepare("DELETE FROM automatch_runtime_control").run();
    await expect(readAutomatchRuntimeControl(db)).rejects.toThrow(
      "control-unavailable",
    );
    await expect(acquireAutomatchWriteAdmission(db, "test")).rejects.toThrow();
  });

  it("durably admits active writes and does not discard unresolved work on freeze", async () => {
    const { store, admission } = await writableStore();
    await db
      .prepare(
        "UPDATE automatch_runtime_control SET state = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
      )
      .run();
    await expect(
      acquireAutomatchWriteAdmission(db, "new-write"),
    ).rejects.toThrow("frozen");
    await expect(
      store.patchRoot({ "automatch/invite": { uid: "host" } }),
    ).rejects.toThrow();
    await expect(
      assertAutomatchWriteAdmission(db, admission, { allowFrozen: true }),
    ).resolves.toBeUndefined();
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM automatch_write_admissions")
        .first("count"),
    ).toBe(1);
    await releaseAutomatchWriteAdmission(db, { ...admission, epoch: 999 });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM automatch_write_admissions")
        .first("count"),
    ).toBe(1);
    await releaseAutomatchWriteAdmission(db, admission);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM automatch_write_admissions")
        .first("count"),
    ).toBe(0);
  });

  it("rejects stale admission epochs and one-way backend rollback", async () => {
    const { admission } = await writableStore();
    await db
      .prepare(
        "UPDATE automatch_runtime_control SET epoch = epoch + 1 WHERE singleton = 1",
      )
      .run();
    await expect(
      assertAutomatchWriteAdmission(db, admission),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE automatch_runtime_control SET backend = 'rtdb' WHERE singleton = 1",
        )
        .run(),
    ).rejects.toThrow("cannot return");
  });

  it("rejects the retired RTDB backend without creating a write admission", async () => {
    await db.batch([
      db.prepare("DELETE FROM automatch_runtime_control"),
      db.prepare(
        `INSERT INTO automatch_runtime_control
           (singleton, backend, state, epoch, freeze_generation)
         VALUES (1, 'rtdb', 'active', 1, 0)`,
      ),
    ]);
    await expect(acquireAutomatchWriteAdmission(db, "test")).rejects.toThrow(
      "automatch-backend-retired",
    );
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM automatch_write_admissions")
        .first("count"),
    ).toBe(0);
    expect(
      await createAutomatchD1Store(db).getPath("automatch/invite"),
    ).toBeNull();
  });

  it("expires only numeric due receipt markers and preserves pending transitions", async () => {
    const { store } = await writableStore();
    await store.patchRoot({
      "gameplayMutationReceipts/due": { kind: "invite-create" },
      "gameplayMutationReceiptExpirations/due": { completedAtMs: 10 },
      "gameplayMutationReceiptExpirations/orphan": { completedAtMs: 11 },
      "gameplayMutationReceiptExpirations/future": { completedAtMs: 30 },
      "gameplayMutationReceiptExpirations/string": { completedAtMs: "10" },
      "gameplayMutationReceiptExpirations/invalid": { malformed: true },
      "gameplayMutationReceipts/reserved": { kind: "automatch-start" },
      "gameplayMutationReceiptExpirations/reserved": { completedAtMs: 1 },
    });
    await db.batch([
      db.prepare(
        `INSERT INTO game_session_transitions
           (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms)
         VALUES ('pending-transition', 'invite', '{}', 'pending', 1, 1)`,
      ),
      db.prepare(
        `INSERT INTO game_session_transition_resources (resource_key, transition_id)
         VALUES ('gameplay-operation:reserved', 'pending-transition')`,
      ),
    ]);
    expect(await store.expireReceipts(20)).toBe(2);
    expect(await store.read("gameplayMutationReceipts", "due")).toMatchObject({
      value: null,
      revision: 2,
    });
    expect(
      await store.read("gameplayMutationReceipts", "orphan"),
    ).toMatchObject({ value: null, revision: 1 });
    expect(
      await store.read("gameplayMutationReceiptExpirations", "orphan"),
    ).toMatchObject({ value: null, revision: 2 });
    for (const key of ["future", "string", "invalid", "reserved"]) {
      expect(
        (await store.read("gameplayMutationReceiptExpirations", key)).value,
      ).not.toBeNull();
    }
    expect(await store.expireReceipts(20)).toBe(0);
  });

  it("expires a thousand receipt pairs in one guarded batch and respects the limit", async () => {
    const admission = await acquireAutomatchWriteAdmission(
      db,
      "expiration-test",
    );
    await db
      .prepare(
        `WITH RECURSIVE records(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM records WHERE n < 1001)
       INSERT INTO game_session_mutation_receipts
         (record_key, payload_json, revision, expiration_json, expiration_revision, updated_at_ms)
       SELECT 'operation-' || n, '{"kind":"automatch-start"}', 1, '{"completedAtMs":10}', 1, 1 FROM records`,
      )
      .run();
    let batches = 0;
    const countingDb = new Proxy(db, {
      get(target, property) {
        if (property === "batch")
          return (statements: D1PreparedStatement[]) => {
            batches++;
            expect(statements).toHaveLength(3);
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = createAutomatchD1Store(countingDb, {
      now: () => nowMs,
      writeGuards: () => automatchAdmissionGuardStatements(db, admission),
    });
    expect(await store.expireReceipts(10)).toBe(1000);
    expect(batches).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM game_session_mutation_receipts WHERE expiration_json IS NOT NULL",
        )
        .first("count"),
    ).toBe(1);
    expect(await store.expireReceipts(10)).toBe(1);
    await db
      .prepare(
        "UPDATE automatch_runtime_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    await expect(store.expireReceipts(10)).rejects.toThrow();
  });

  it("invalidates old active admissions across a freeze generation", async () => {
    const { admission } = await writableStore();
    await db
      .prepare(
        "UPDATE automatch_runtime_control SET freeze_generation = freeze_generation + 1 WHERE singleton = 1",
      )
      .run();
    await expect(
      assertAutomatchWriteAdmission(db, admission),
    ).rejects.toThrow();
  });
});
