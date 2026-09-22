import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AUTOMATCH_RECORD_TABLES,
  createAutomatchD1Store,
  type AutomatchD1Store,
  type AutomatchRoot,
} from "../src/automatchD1.ts";
import { createLegacyAutomatchD1Store } from "../test/legacyAutomatchStoreFixture.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const telegramRoot = "telegramProjectionOutbox/automatch";
const profileRoot = "profileGameProjectionOutbox/automatch";
const queryRoots = ["automatch", telegramRoot, profileRoot] as const;
const store = createAutomatchD1Store(db);
const legacy = createLegacyAutomatchD1Store(db);
const numericKeys = [
  "10",
  "2",
  "02",
  "002",
  "-1",
  "-01",
  "-000000001",
  "-0",
  "0",
  "00",
  "0000000000",
  "00000000000",
  "2147483647",
  "2147483648",
  "-2147483648",
  "-2147483649",
  "auto-z",
  "auto-a",
  "__proto__",
  "\uE000",
  "😀",
];

async function seed(root: AutomatchRoot, entries: [string, unknown][]) {
  const { table } = AUTOMATCH_RECORD_TABLES[root];
  await db.batch(
    entries.map(([key, value], index) =>
      db
        .prepare(
          `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(
          key,
          value === undefined ? null : JSON.stringify(value),
          index + 1,
          1_800_000_000_000,
        ),
    ),
  );
}

function mixedOutboxes(field: "updatedAtMs" | "lastQueuedAtMs") {
  const values = [
    null,
    false,
    true,
    -10,
    -0.5,
    0,
    0.25,
    1,
    10,
    10.25,
    100,
    "",
    "0",
    "same",
    "same",
    "\uE000",
    "😀",
    [],
    ["malformed"],
    {},
    { invalid: true },
  ];
  const entries: [string, unknown][] = [
    ["missing", {}],
    ["scalar-string", "broken"],
    ["scalar-number", 7],
    ["scalar-false", false],
    ["scalar-true", true],
    ["scalar-null", null],
    ["scalar-array", ["broken"]],
    ["deleted", undefined],
    ...values.map((value, index): [string, unknown] => [
      `value-${index}`,
      { [field]: value, requestId: `request-${index}` },
    ]),
    ...numericKeys.map((key): [string, unknown] => [
      key,
      { [field]: 0, requestId: key },
    ]),
  ];
  return entries;
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

describe("explicit D1 automatch queries", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.batch(
      queryRoots.map((root) =>
        db.prepare(`DELETE FROM ${AUTOMATCH_RECORD_TABLES[root].table}`),
      ),
    );
  });

  it("matches legacy due results across JSON types, timestamp boundaries, ties, and limits", async () => {
    await seed(telegramRoot, mixedOutboxes("updatedAtMs"));
    await seed(profileRoot, mixedOutboxes("lastQueuedAtMs"));
    for (const cutoff of [-11, -0.5, 0, 0.25, 1, 10, 10.25, 100]) {
      for (const limit of [1, 3, 12, 100]) {
        expect(
          await store.listDueAutomatchTelegramOutboxes(cutoff, limit),
          `Telegram cutoff ${cutoff}, limit ${limit}`,
        ).toEqual(
          await legacy.getPath(telegramRoot, {
            orderBy: "updatedAtMs",
            startAt: 0,
            endAt: cutoff,
            limitToFirst: limit,
          }),
        );
        expect(
          await store.listDueAutomatchProfileOutboxes(cutoff, limit),
          `profile cutoff ${cutoff}, limit ${limit}`,
        ).toEqual(
          await legacy.getPath(profileRoot, {
            orderBy: "lastQueuedAtMs",
            endAt: cutoff,
            limitToFirst: limit,
          }),
        );
      }
    }
  });

  it.each([
    { name: "missing", value: undefined },
    { name: "null", value: null },
    { name: "false", value: false },
    { name: "true", value: true },
    { name: "numeric", value: 10.25 },
  ])(
    "preserves key ordering within the $name profile recovery branch",
    async ({ value }) => {
      await seed(
        profileRoot,
        numericKeys.map((key) => [
          key,
          { lastQueuedAtMs: value, requestId: key },
        ]),
      );
      for (const limit of [1, 3, 12, 100]) {
        expect(
          await store.listDueAutomatchProfileOutboxes(10.25, limit),
        ).toEqual(
          await legacy.getPath(profileRoot, {
            orderBy: "lastQueuedAtMs",
            endAt: 10.25,
            limitToFirst: limit,
          }),
        );
      }
    },
  );

  it("matches legacy login selection and first-entry ordering, including numeric key boundaries", async () => {
    await seed("automatch", [
      ...numericKeys.map((key): [string, unknown] => [
        key,
        { uid: "owner", inviteId: key },
      ]),
      ["different", { uid: "other" }],
      ["empty-login", { uid: "" }],
      ["path-login", { uid: "login/with/slashes" }],
      ["numeric-login", { uid: 1 }],
      ["boolean-login", { uid: true }],
      ["string-login", { uid: "1" }],
      ["null-login", { uid: null }],
      ["array-login", { uid: ["owner"] }],
      ["object-login", { uid: { owner: true } }],
      ["missing-login", {}],
      ["scalar", "owner"],
      ["-21474836480", undefined],
    ]);
    for (const uid of [
      "owner",
      "other",
      "",
      "login/with/slashes",
      "1",
      "missing",
    ]) {
      for (const limit of [1, 2, 3, 10, 100]) {
        expect(await store.listAutomatchEntriesByLogin(uid, limit)).toEqual(
          await legacy.getPath("automatch", {
            orderBy: "uid",
            equalTo: uid,
            limitToFirst: limit,
          }),
        );
      }
    }
    expect(await store.readFirstAutomatchEntry()).toEqual(
      await legacy.getPath("automatch", { orderBy: "$key", limitToFirst: 1 }),
    );
    expect(await store.readFirstAutomatchEntry()).toEqual({
      "-2147483648": { uid: "owner", inviteId: "-2147483648" },
    });
  });

  it("matches legacy malformed recovery selection and text-before-object ordering", async () => {
    await seed(profileRoot, mixedOutboxes("lastQueuedAtMs"));
    for (const limit of [1, 2, 3, 5, 7, 100]) {
      expect(await store.listMalformedAutomatchProfileOutboxes(limit)).toEqual(
        await legacy.getPath(profileRoot, {
          orderBy: "lastQueuedAtMs",
          startAt: "",
          limitToFirst: limit,
        }),
      );
    }
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

  it("uses indexed searches without sorting within due recovery branches", async () => {
    await seed("automatch", [["entry", { uid: "owner" }]]);
    await seed(telegramRoot, mixedOutboxes("updatedAtMs"));
    await seed(profileRoot, mixedOutboxes("lastQueuedAtMs"));
    const observed = observeReads();
    await observed.store.listAutomatchEntriesByLogin("owner", 2);
    await observed.store.listDueAutomatchTelegramOutboxes(10, 2);
    await observed.store.listDueAutomatchProfileOutboxes(10, 2);
    await observed.store.listMalformedAutomatchProfileOutboxes(2);
    const plans: string[] = [];
    const sorts: { parent: number; detail: string }[][] = [];
    for (const { sql, values } of observed.queries) {
      const result = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...values)
        .all<{ parent: number; detail: string }>();
      plans.push(result.results.map(({ detail }) => detail).join("\n"));
      sorts.push(
        result.results.filter(({ detail }) => detail.includes("TEMP B-TREE")),
      );
    }
    expect(plans).toHaveLength(4);
    expect(plans[0]).toMatch(
      /SEARCH .* USING INDEX idx_automatch_entries_uid \(<expr>=\?\)/,
    );
    expect(plans[1]).toMatch(
      /SEARCH .* USING INDEX idx_automatch_telegram_projection_due \(<expr>>\? AND <expr><\?\)/,
    );
    expect(sorts[1], plans[1]).toEqual([]);
    expect(
      plans[2].match(
        /SEARCH .* USING INDEX idx_game_session_projection_due \(<expr>/g,
      ),
      plans[2],
    ).toHaveLength(4);
    expect(plans[2]).toMatch(
      /SEARCH .* USING INDEX idx_game_session_projection_due \(<expr><\?\)/,
    );
    expect(sorts[2], plans[2]).toMatchObject([
      { parent: 0, detail: "USE TEMP B-TREE FOR ORDER BY" },
    ]);
    expect(plans[3]).toMatch(
      /SEARCH .* USING INDEX idx_game_session_projection_due \(<expr>>\?\)/,
    );
    expect(sorts[3], plans[3]).toHaveLength(1);
  });
});
