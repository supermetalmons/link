import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AUTOMATCH_RECORD_TABLES,
  createAutomatchD1Store,
  type AutomatchD1Store,
  type AutomatchRoot,
} from "../src/automatchD1.ts";
import { canonicalAutomatchFixture } from "../test/automatchRecordFixture.ts";
const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const telegramRoot = "telegramProjectionOutbox/automatch";
const profileRoot = "profileGameProjectionOutbox/automatch";
const queryRoots = ["automatch", telegramRoot, profileRoot] as const;
const store = createAutomatchD1Store(db);
async function seed(root: AutomatchRoot, entries: [string, unknown][]) {
  const { table } = AUTOMATCH_RECORD_TABLES[root];
  await db.batch(
    entries.map(([key, value], index) =>
      db
        .prepare(
          `INSERT INTO ${table}(record_key,payload_json,revision,updated_at_ms) VALUES(?,?,?,?)`,
        )
        .bind(
          key,
          value == null
            ? null
            : JSON.stringify(canonicalAutomatchFixture(root, value)),
          index + 1,
          1000,
        ),
    ),
  );
}
function observeReads(afterRead?: () => void) {
  const sessions: (D1SessionConstraint | D1SessionBookmark | undefined)[] = [];
  const queries: { sql: string; values: unknown[] }[] = [];
  function wrapStatement(
    statement: D1PreparedStatement,
    sql: string,
    values: unknown[] = [],
  ): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...nextValues: unknown[]) =>
            wrapStatement(target.bind(...nextValues), sql, nextValues);
        }
        const value = Reflect.get(target, property, target);
        if (property === "all" || property === "first") {
          return async (...args: unknown[]) => {
            queries.push({ sql, values });
            const result = await Reflect.apply(value, target, args);
            afterRead?.();
            return result;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "withSession") {
        return (constraint?: D1SessionConstraint | D1SessionBookmark) => {
          sessions.push(constraint);
          const session = target.withSession(constraint);
          return new Proxy(session, {
            get(target, property) {
              if (property === "prepare") {
                return (sql: string) => wrapStatement(target.prepare(sql), sql);
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
      }
      if (property === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql), sql);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store: createAutomatchD1Store(database), sessions, queries };
}

const reads: {
  name: string;
  run: (store: AutomatchD1Store, signal?: AbortSignal) => Promise<unknown>;
}[] = [
  {
    name: "login lookup",
    run: (store, signal) =>
      store.listAutomatchEntriesByLogin("owner", 2, signal),
  },
  {
    name: "first entry",
    run: (store, signal) => store.readFirstAutomatchEntry(signal),
  },
  {
    name: "Telegram due outboxes",
    run: (store, signal) =>
      store.listDueAutomatchTelegramOutboxes(10, 2, signal),
  },
  {
    name: "profile due outboxes",
    run: (store, signal) =>
      store.listDueAutomatchProfileOutboxes(10, 2, signal),
  },
  {
    name: "malformed profile outboxes",
    run: (store, signal) =>
      store.listMalformedAutomatchProfileOutboxes(2, signal),
  },
];

describe("canonical D1 automatch queries", () => {
  beforeAll(async () => {
    await applyCanonicalTestMigrations(db, testEnv.TEST_D1_MIGRATIONS);
  });
  beforeEach(async () => {
    await db.batch(
      queryRoots.map((root) =>
        db.prepare(`DELETE FROM ${AUTOMATCH_RECORD_TABLES[root].table}`),
      ),
    );
  });
  it("keeps deterministic numeric-key ordering and applies owner limits before decoding", async () => {
    await seed(
      "automatch",
      ["a", "10", "2", "02", "-1", "z"].map((key) => [
        key,
        { uid: "owner", timestamp: 10 },
      ]),
    );
    await seed("automatch", [["other", { uid: "other", timestamp: 1 }]]);
    expect(
      Object.keys((await store.listAutomatchEntriesByLogin("owner", 10)) ?? {}),
    ).toEqual(["2", "10", "-1", "02", "a", "z"]);
    expect(
      Object.keys((await store.listAutomatchEntriesByLogin("owner", 2)) ?? {}),
    ).toEqual(["2", "-1"]);
    expect(Object.keys((await store.readFirstAutomatchEntry()) ?? {})).toEqual([
      "-1",
    ]);
  });
  for (const root of [telegramRoot, profileRoot] as const) {
    it(`${root} pages exact due boundaries and excludes visited and retired records`, async () => {
      const timeField =
        root === telegramRoot ? "updatedAtMs" : "lastQueuedAtMs";
      await seed(root, [
        ["a", { [timeField]: 0 }],
        ["b", { [timeField]: 10 }],
        ["c", { [timeField]: 10 }],
        ["future", { [timeField]: 11 }],
        ["deleted", null],
      ]);
      const retirement = {
        state: "retired",
        retiredAtMs: 1,
        sourceDigest: "a".repeat(64),
      };
      await seed(root, [
        [
          "retired",
          root === telegramRoot
            ? {
                status: "cancelled",
                requestId: "old",
                updatedAtMs: null,
                sourceUpdatedAtMs: 0,
                retirement,
              }
            : { status: "cancelled", lastQueuedAtMs: 0, retirement },
        ],
      ]);
      const read = (excluded: readonly string[], limit = 2) =>
        root === telegramRoot
          ? store.listDueAutomatchTelegramOutboxesPage(10, limit, excluded)
          : store.listDueAutomatchProfileOutboxesPage(10, limit, excluded);
      const first = await read([]);
      expect(Object.keys(first.entries ?? {})).toEqual(["a", "b"]);
      expect(first.scannedIdentities).toHaveLength(2);
      const second = await read(
        first.scannedIdentities.filter((id): id is string => id !== null),
      );
      expect(Object.keys(second.entries ?? {})).toEqual(["c"]);
      expect(await store.listMalformedAutomatchProfileOutboxes(10)).toBeNull();
    });
  }
  it("rejects malformed payloads, unsafe timestamps, and extension fields at the SQL boundary", async () => {
    const valid = canonicalAutomatchFixture(telegramRoot, {
      requestId: "fixture",
      updatedAtMs: 1,
    });
    for (const value of [
      {},
      { ...valid, extra: true },
      { ...valid, updatedAtMs: "1" },
      { ...valid, updatedAtMs: 1.5 },
      { ...valid, updatedAtMs: -1 },
    ]) {
      await expect(
        db
          .prepare(
            "INSERT INTO automatch_telegram_projection_outbox_canonical(record_key,payload_json,revision,updated_at_ms) VALUES('invalid',?,1,1)",
          )
          .bind(JSON.stringify(value))
          .run(),
      ).rejects.toThrow();
    }
    expect(await store.listDueAutomatchTelegramOutboxes(10, 10)).toBeNull();
  });
  it("returns null for empty and tombstone-only collections", async () => {
    for (const { run } of reads) expect(await run(store)).toBeNull();
    for (const root of queryRoots) await seed(root, [["deleted", undefined]]);
    for (const { run } of reads) expect(await run(store)).toBeNull();
  });

  it("rejects invalid limits and nonfinite bounds before accessing D1", async () => {
    const observed = observeReads();
    for (const limit of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const calls = [
        () => observed.store.listAutomatchEntriesByLogin("owner", limit),
        () => observed.store.listDueAutomatchTelegramOutboxes(10, limit),
        () => observed.store.listDueAutomatchProfileOutboxes(10, limit),
        () => observed.store.listMalformedAutomatchProfileOutboxes(limit),
      ];
      for (const call of calls) {
        await expect(call()).rejects.toThrow("invalid-automatch-query-limit");
      }
    }
    for (const cutoff of [NaN, Infinity, -Infinity]) {
      await expect(
        observed.store.listDueAutomatchTelegramOutboxes(cutoff, 1),
      ).rejects.toThrow("invalid-automatch-query-bound");
      await expect(
        observed.store.listDueAutomatchProfileOutboxes(cutoff, 1),
      ).rejects.toThrow("invalid-automatch-query-bound");
    }
    expect(observed.sessions).toEqual([]);
    expect(observed.queries).toEqual([]);
  });

  it.each(reads)(
    "checks cancellation before and after $name, using primary reads",
    async ({ run }) => {
      const before = new AbortController();
      const reason = new Error("cancelled-automatch-query");
      before.abort(reason);
      const cancelled = observeReads();
      await expect(run(cancelled.store, before.signal)).rejects.toBe(reason);
      expect(cancelled.sessions).toEqual([]);
      expect(cancelled.queries).toEqual([]);

      const after = new AbortController();
      const completed = observeReads(() => after.abort(reason));
      await expect(run(completed.store, after.signal)).rejects.toBe(reason);
      expect(completed.sessions).toEqual(["first-primary"]);
      expect(completed.queries).toHaveLength(1);
    },
  );

  it("uses indexed owner and recovery scans without sorting due rows", async () => {
    await seed("automatch", [["entry", { uid: "owner" }]]);
    await seed(telegramRoot, [["pending", { updatedAtMs: 1 }]]);
    await seed(profileRoot, [["pending", { lastQueuedAtMs: 1 }]]);
    const observed = observeReads();
    await observed.store.listAutomatchEntriesByLogin("owner", 2);
    await observed.store.listDueAutomatchTelegramOutboxes(10, 2);
    await observed.store.listDueAutomatchProfileOutboxes(10, 2);
    const plans: string[] = [];
    for (const { sql, values } of observed.queries) {
      const result = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...values)
        .all<{ detail: string }>();
      plans.push(result.results.map((row) => row.detail).join("\n"));
    }
    expect(plans[0]).toContain("idx_automatch_entries_uid_canonical");
    expect(plans[1]).toContain(
      "idx_automatch_telegram_projection_recovery_canonical",
    );
    expect(plans[2]).toContain(
      "idx_game_session_projection_recovery_canonical",
    );
    expect(plans[1]).not.toContain("TEMP B-TREE");
    expect(plans[2]).not.toContain("TEMP B-TREE");
  });
});
