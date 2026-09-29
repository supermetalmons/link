import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireAutomatchWriteAdmission,
  automatchAdmissionGuardStatements,
  createAutomatchD1Store,
} from "../src/automatchD1.ts";
import { createAutomatchPersistence } from "../src/automatchPersistence.ts";
import { matchTestPort } from "../test/gameSessionTestPorts.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const profileTable = "game_session_projection_outbox";
const telegramTable = "automatch_telegram_projection_outbox";
const nowMs = 1_800_000_000_000;

function profileOutbox(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: "pending",
    requestId: "request-one",
    sourceUpdatedAtMs: 50,
    lastQueuedAtMs: 100,
    reason: "automatch-queue",
    ...extra,
  };
}

function telegramOutbox(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: "pending",
    requestId: "request-one",
    updatedAtMs: 100,
    ...extra,
  };
}

function historical(retryNotBeforeMs?: number) {
  return {
    finalizedAtMs: 10,
    hostPlayerId: "host",
    guestPlayerId: "guest",
    source: "transition",
    ...(retryNotBeforeMs === undefined ? {} : { retryNotBeforeMs }),
  };
}

async function seed(
  table: string,
  value: unknown,
  revision = 1,
  updatedAtMs = nowMs,
) {
  await db
    .prepare(
      `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
       VALUES ('invite', ?, ?, ?)
       ON CONFLICT(record_key) DO UPDATE SET payload_json = excluded.payload_json,
         revision = excluded.revision, updated_at_ms = excluded.updated_at_ms`,
    )
    .bind(value === null ? null : JSON.stringify(value), revision, updatedAtMs)
    .run();
}

async function stored(table: string) {
  const row = await db
    .prepare(
      `SELECT payload_json, revision, updated_at_ms FROM ${table} WHERE record_key = 'invite'`,
    )
    .first<{
      payload_json: string | null;
      revision: number;
      updated_at_ms: number;
    }>();
  return (
    row && {
      ...row,
      value: row.payload_json === null ? null : JSON.parse(row.payload_json),
    }
  );
}

function observeDatabase(beforeWrite?: () => Promise<void>) {
  const reads: string[] = [];
  const writes: string[] = [];
  let writeBatches = 0;
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          writes.push(query);
          return target.prepare(query);
        };
      if (property === "withSession")
        return (constraint?: D1SessionConstraint | D1SessionBookmark) => {
          const session = target.withSession(constraint);
          return new Proxy(session, {
            get(sessionTarget, sessionProperty) {
              if (sessionProperty === "prepare")
                return (query: string) => {
                  reads.push(query);
                  return sessionTarget.prepare(query);
                };
              const value = Reflect.get(
                sessionTarget,
                sessionProperty,
                sessionTarget,
              );
              return typeof value === "function"
                ? value.bind(sessionTarget)
                : value;
            },
          });
        };
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          writeBatches++;
          await beforeWrite?.();
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, reads, writes, batches: () => writeBatches };
}

async function writableStore(database = db, now = () => nowMs) {
  const admission = await acquireAutomatchWriteAdmission(db, "outbox-test", {
    now,
  });
  return createAutomatchD1Store(database, {
    now,
    writeGuards: () => automatchAdmissionGuardStatements(db, admission),
  });
}

describe("native automatch projection outboxes", () => {
  beforeAll(() => applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS));
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM game_session_transition_resources"),
      db.prepare("DELETE FROM game_session_transitions"),
      db.prepare(`DELETE FROM ${profileTable}`),
      db.prepare(`DELETE FROM ${telegramTable}`),
      db.prepare("DELETE FROM automatch_write_admissions"),
      db.prepare("DELETE FROM invite_source_write_admissions"),
      db.prepare("DELETE FROM automatch_runtime_control"),
      db.prepare(
        `INSERT INTO automatch_runtime_control
           (singleton, backend, state, epoch, freeze_generation)
         VALUES (1, 'd1', 'active', 2, 1)`,
      ),
      db.prepare(
        `UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1,
         freeze_generation = 0, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1`,
      ),
    ]);
  });

  it("claims both outboxes with one read and field updates, preserving unknown fields and monotonic timestamps", async () => {
    const unknown = { nested: [1, { retained: true }], note: "future-schema" };
    await seed(profileTable, profileOutbox({ unknown }), 7, nowMs + 100);
    await seed(telegramTable, telegramOutbox({ unknown }), 9, nowMs + 100);
    const observed = observeDatabase();
    const store = await writableStore(observed.database);
    expect(
      await store.claimAutomatchProfileOutbox(
        "invite",
        "request-one",
        100,
        200,
      ),
    ).toBe(true);
    expect(
      await store.claimAutomatchTelegramOutbox(
        "invite",
        "request-one",
        100,
        200,
      ),
    ).toBe(true);
    expect(observed.reads).toHaveLength(2);
    expect(observed.batches()).toBe(2);
    const updates = observed.writes.filter((query) =>
      query.startsWith("UPDATE"),
    );
    expect(updates).toHaveLength(2);
    for (const query of updates) {
      expect(query).toContain("json_set(payload_json,");
      expect(query).toContain("revision = revision + 1");
      expect(query).toContain("updated_at_ms = MAX(updated_at_ms, ?)");
      expect(query).toContain("AND revision = ?");
      expect(query).not.toContain("INSERT INTO");
    }
    expect(await stored(profileTable)).toMatchObject({
      revision: 8,
      updated_at_ms: nowMs + 100,
      value: profileOutbox({ unknown, lastQueuedAtMs: 200 }),
    });
    expect(await stored(telegramTable)).toMatchObject({
      revision: 10,
      updated_at_ms: nowMs + 100,
      value: telegramOutbox({ unknown, updatedAtMs: 200 }),
    });
  });

  it("retains floored fractional timestamp matching and equal-time claims", async () => {
    await seed(
      profileTable,
      profileOutbox({ lastQueuedAtMs: 100.9, sourceUpdatedAtMs: 50.5 }),
    );
    await seed(telegramTable, telegramOutbox({ updatedAtMs: 100.9 }));
    const store = await writableStore();
    expect(
      await store.claimAutomatchProfileOutbox(
        "invite",
        "request-one",
        100,
        100,
      ),
    ).toBe(true);
    expect(
      await store.claimAutomatchTelegramOutbox(
        "invite",
        "request-one",
        100,
        100,
      ),
    ).toBe(true);
    expect((await stored(profileTable))?.value.sourceUpdatedAtMs).toBe(50.5);
    expect(
      await store.claimAutomatchProfileOutbox(
        "invite",
        "request-one",
        100,
        100.25,
      ),
    ).toBe(true);
    expect((await stored(profileTable))?.value.lastQueuedAtMs).toBe(100.25);
  });

  it("keeps missing, malformed, superseded and not-due operations as no-ops without guards", async () => {
    const observed = observeDatabase();
    const store = createAutomatchD1Store(observed.database, {
      now: () => Number.NaN,
    });
    expect(
      await store.acknowledgeAutomatchProfileOutbox("invite", "request-one"),
    ).toBe(false);
    await seed(
      profileTable,
      profileOutbox({ historicalMatches: { broken: {} } }),
    );
    expect(
      await store.claimAutomatchProfileOutbox(
        "invite",
        "request-one",
        100,
        200,
      ),
    ).toBe(false);
    expect(
      await store.finishAutomatchProfileOutbox("invite", "request-one", 200),
    ).toBe("superseded");
    await seed(profileTable, profileOutbox());
    expect(
      await store.claimAutomatchProfileOutbox("invite", "other", 100, 200),
    ).toBe(false);
    expect(
      await store.claimAutomatchProfileOutbox("invite", "request-one", 99, 200),
    ).toBe(false);
    expect(
      await store.claimAutomatchProfileOutbox("invite", "request-one", 100, 99),
    ).toBe(false);
    expect(observed.batches()).toBe(0);
    expect(observed.writes).toEqual([]);
  });

  it("requires write guards only for eligible writes and rejects exhausted revisions", async () => {
    await seed(profileTable, profileOutbox(), Number.MAX_SAFE_INTEGER);
    const readOnly = createAutomatchD1Store(db);
    expect(
      await readOnly.acknowledgeAutomatchProfileOutbox("invite", "other"),
    ).toBe(false);
    await expect(
      readOnly.acknowledgeAutomatchProfileOutbox("invite", "request-one"),
    ).rejects.toThrow("read-only");
    const store = await writableStore();
    expect(
      await store.claimAutomatchProfileOutbox("invite", "other", 100, 200),
    ).toBe(false);
    await expect(
      store.claimAutomatchProfileOutbox("invite", "request-one", 100, 200),
    ).rejects.toThrow("invalid-automatch-revision");
  });

  it("tombstones acknowledgements without strengthening Telegram's request-id-only check", async () => {
    await seed(profileTable, profileOutbox(), 3);
    await seed(telegramTable, { requestId: "request-one", unknown: true }, 4);
    const store = await writableStore();
    expect(
      await store.acknowledgeAutomatchTelegramOutbox("invite", "other"),
    ).toBe(false);
    expect(
      await store.acknowledgeAutomatchProfileOutbox("invite", "request-one"),
    ).toBe(true);
    expect(
      await store.acknowledgeAutomatchTelegramOutbox("invite", "request-one"),
    ).toBe(true);
    expect(await stored(profileTable)).toMatchObject({
      value: null,
      revision: 4,
    });
    expect(await stored(telegramTable)).toMatchObject({
      value: null,
      revision: 5,
    });
    expect(
      await store.acknowledgeAutomatchTelegramOutbox("invite", "request-one"),
    ).toBe(false);
  });

  it("preserves all completion outcomes and protects historical descriptors", async () => {
    const store = await writableStore();
    expect(
      await store.finishAutomatchProfileOutbox("invite", "request-one", 200),
    ).toBe("superseded");
    await seed(
      profileTable,
      profileOutbox({
        historicalMatches: { first: historical(), second: historical(300) },
      }),
    );
    expect(
      await store.finishAutomatchProfileOutbox("invite", "request-one", 200),
    ).toBe("continued");
    expect((await stored(profileTable))?.revision).toBe(1);
    const historicalMatches = {
      first: historical(400),
      second: historical(300),
    };
    await seed(
      profileTable,
      profileOutbox({ historicalMatches, unknown: { preserved: true } }),
    );
    expect(
      await store.finishAutomatchProfileOutbox("invite", "request-one", 200),
    ).toBe("deferred");
    expect(await stored(profileTable)).toMatchObject({
      revision: 2,
      value: {
        historicalMatches,
        lastQueuedAtMs: 200,
        archiveRetry: { requestId: "request-one", notBeforeMs: 300 },
        unknown: { preserved: true },
      },
    });
    await seed(profileTable, profileOutbox());
    expect(
      await store.finishAutomatchProfileOutbox("invite", "request-one", 200),
    ).toBe("projected");
    expect(await stored(profileTable)).toMatchObject({
      value: null,
      revision: 2,
    });
  });

  it("rereads after a revision race without losing a newer request", async () => {
    await seed(profileTable, profileOutbox());
    let changed = false;
    const observed = observeDatabase(async () => {
      if (changed) return;
      changed = true;
      await seed(profileTable, profileOutbox({ requestId: "request-two" }), 2);
    });
    const store = await writableStore(observed.database);
    expect(
      await store.acknowledgeAutomatchProfileOutbox("invite", "request-one"),
    ).toBe(false);
    expect(observed.reads).toHaveLength(2);
    expect(observed.batches()).toBe(1);
    expect(await stored(profileTable)).toMatchObject({
      revision: 2,
      value: { requestId: "request-two" },
    });
  });

  it("recomputes completion when a concurrent writer adds an unarchived descriptor", async () => {
    await seed(profileTable, profileOutbox());
    let changed = false;
    const observed = observeDatabase(async () => {
      if (changed) return;
      changed = true;
      await seed(
        profileTable,
        profileOutbox({ historicalMatches: { recent: historical() } }),
        2,
      );
    });
    const store = await writableStore(observed.database);
    expect(
      await store.finishAutomatchProfileOutbox("invite", "request-one", 200),
    ).toBe("continued");
    expect(observed.reads).toHaveLength(2);
    expect(
      (await stored(profileTable))?.value.historicalMatches.recent,
    ).toEqual(historical());
  });

  it("bounds repeated revision conflicts to 25 fresh reads", async () => {
    await seed(telegramTable, telegramOutbox());
    let revision = 1;
    const observed = observeDatabase(async () => {
      await seed(telegramTable, telegramOutbox(), ++revision);
    });
    const store = await writableStore(observed.database);
    await expect(
      store.claimAutomatchTelegramOutbox("invite", "request-one", 100, 200),
    ).rejects.toThrow("automatch-transaction-contention");
    expect(observed.reads).toHaveLength(25);
    expect(observed.batches()).toBe(25);
  });

  it("preserves server-marker normalization using the initial operation clock", async () => {
    await seed(
      profileTable,
      profileOutbox({
        future: {
          at: { ".sv": "timestamp" },
          count: { ".sv": { increment: 2 } },
        },
      }),
    );
    let clock = nowMs;
    const store = await writableStore(db, () => clock++);
    const operationClock = clock;
    expect(
      await store.claimAutomatchProfileOutbox(
        "invite",
        "request-one",
        100,
        200,
      ),
    ).toBe(true);
    expect(await stored(profileTable)).toMatchObject({
      value: { future: { at: operationClock, count: 2 } },
      updated_at_ms: operationClock + 1,
    });
  });

  it("rejects invalid stored keys before writing and skips validation for tombstones", async () => {
    await seed(profileTable, profileOutbox({ "invalid/key": true }));
    const store = await writableStore();
    await expect(
      store.claimAutomatchProfileOutbox("invite", "request-one", 100, 200),
    ).rejects.toThrow("invalid-automatch-key");
    expect((await stored(profileTable))?.revision).toBe(1);
    expect(
      await store.acknowledgeAutomatchProfileOutbox("invite", "request-one"),
    ).toBe(true);
  });

  it("fences a frozen admission and a retired backend before changing the outbox", async () => {
    await seed(profileTable, profileOutbox());
    const store = await writableStore();
    await db
      .prepare("UPDATE automatch_runtime_control SET state = 'frozen'")
      .run();
    await expect(
      store.claimAutomatchProfileOutbox("invite", "request-one", 100, 200),
    ).rejects.toThrow();
    expect((await stored(profileTable))?.revision).toBe(1);
    const unguarded = createAutomatchD1Store(db, {
      now: () => nowMs,
      writeGuards: () => [],
    });
    await db.prepare("DELETE FROM automatch_runtime_control").run();
    await expect(
      unguarded.acknowledgeAutomatchProfileOutbox("invite", "request-one"),
    ).rejects.toThrow();
    expect((await stored(profileTable))?.revision).toBe(1);
  });

  it("retains pending transition resource guards in the public persistence wrapper", async () => {
    await seed(profileTable, profileOutbox());
    await db.batch([
      db.prepare(`INSERT INTO game_session_transitions
        (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms)
        VALUES ('transition', 'invite', '{}', 'pending', 1, 1)`),
      db.prepare(`INSERT INTO game_session_transition_resources (resource_key, transition_id)
        VALUES ('invite', 'transition')`),
    ]);
    const raw = matchTestPort({
      async getPath() {
        return null;
      },
      async transactPath() {
        throw new Error("unused");
      },
    });
    const persistence = createAutomatchPersistence(db, raw, {
      now: () => nowMs,
    });
    await expect(
      persistence.client.claimAutomatchProfileOutbox(
        "invite",
        "request-one",
        100,
        200,
      ),
    ).rejects.toThrow();
    expect((await stored(profileTable))?.revision).toBe(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM automatch_write_admissions")
        .first("n"),
    ).toBe(0);
  });

  it("honors cancellation before reading or writing", async () => {
    await seed(profileTable, profileOutbox());
    const observed = observeDatabase();
    const store = await writableStore(observed.database);
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(
      store.claimAutomatchProfileOutbox(
        "invite",
        "request-one",
        100,
        200,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(observed.reads).toEqual([]);
    expect(observed.batches()).toBe(0);
  });
});
