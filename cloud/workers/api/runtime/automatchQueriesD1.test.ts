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

const recoveryReads = [
  {
    name: "Telegram due",
    root: telegramRoot,
    field: "updatedAtMs",
    value: 10,
    run: (
      target: AutomatchD1Store,
      limit: number,
      excludedIdentities: readonly string[] = [],
      signal?: AbortSignal,
    ) =>
      target.listDueAutomatchTelegramOutboxesPage(
        10,
        limit,
        excludedIdentities,
        signal,
      ),
  },
  {
    name: "profile due",
    root: profileRoot,
    field: "lastQueuedAtMs",
    value: 10,
    run: (
      target: AutomatchD1Store,
      limit: number,
      excludedIdentities: readonly string[] = [],
      signal?: AbortSignal,
    ) =>
      target.listDueAutomatchProfileOutboxesPage(
        10,
        limit,
        excludedIdentities,
        signal,
      ),
  },
  {
    name: "malformed profile",
    root: profileRoot,
    field: "lastQueuedAtMs",
    value: "10",
    run: (
      target: AutomatchD1Store,
      limit: number,
      excludedIdentities: readonly string[] = [],
      signal?: AbortSignal,
    ) =>
      target.listMalformedAutomatchProfileOutboxesPage(
        limit,
        excludedIdentities,
        signal,
      ),
  },
] as const;

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

  it("preserves raw JSON number precision, duplicate fields, and numeric text ordering", async () => {
    for (const [root, field] of [
      [telegramRoot, "updatedAtMs"],
      [profileRoot, "lastQueuedAtMs"],
    ] as const) {
      const { table } = AUTOMATCH_RECORD_TABLES[root];
      const values = [
        ["integer", "9007199254740993"],
        ["maximum-integer", "9223372036854775807"],
        ["real", "10.0"],
        ["fraction", "10.25"],
        ["numeric-text", '"0010"'],
        ["numeric-text-later", '"10"'],
        ["positive-overflow", "1e999"],
        ["negative-overflow", "-1e999"],
        ["underflow", "1e-999"],
      ];
      await db.batch([
        ...values.map(([key, value]) =>
          db
            .prepare(
              `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
               VALUES (?, ?, 1, 100)`,
            )
            .bind(key, `{ "${field}" : ${value}, "future": "\\u03b1" }`),
        ),
        db
          .prepare(
            `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
             VALUES ('duplicate', ?, 1, 100)`,
          )
          .bind(`{"${field}":1,"${field}":50}`),
      ]);
    }
    for (const cutoff of [
      -Number.MAX_VALUE,
      -0.5,
      0,
      1,
      10,
      10.25,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_VALUE,
    ]) {
      for (const limit of [1, 3, 100]) {
        expect(
          await store.listDueAutomatchTelegramOutboxes(cutoff, limit),
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
        ).toEqual(
          await legacy.getPath(profileRoot, {
            orderBy: "lastQueuedAtMs",
            endAt: cutoff,
            limitToFirst: limit,
          }),
        );
      }
    }
    for (const limit of [1, 2, 100]) {
      expect(await store.listMalformedAutomatchProfileOutboxes(limit)).toEqual(
        await legacy.getPath(profileRoot, {
          orderBy: "lastQueuedAtMs",
          startAt: "",
          limitToFirst: limit,
        }),
      );
    }
    for (const [table, field] of [
      ["automatch_telegram_projection_outbox", "updatedAtMs"],
      ["game_session_projection_outbox", "lastQueuedAtMs"],
    ]) {
      const types = await db
        .prepare(
          `SELECT record_key, typeof(recovery_sort_value) AS generated_type,
             typeof(json_extract(payload_json, '$.${field}')) AS original_type,
             recovery_sort_value IS json_extract(payload_json, '$.${field}') AS same_value
           FROM ${table} ORDER BY record_key`,
        )
        .all<{
          record_key: string;
          generated_type: string;
          original_type: string;
          same_value: number;
        }>();
      for (const row of types.results) {
        expect(row.generated_type, row.record_key).toBe(row.original_type);
        expect(row.same_value, row.record_key).toBe(1);
      }
    }
  });

  it.each(recoveryReads)(
    "returns raw identities and excludes earlier $name pages before applying the limit",
    async ({ root, field, value, run }) => {
      const keys = ["2", "02", "10", "alpha", "😀"];
      await seed(
        root,
        keys.map((key) => [key, { [field]: value, requestId: key }]),
      );
      const first = await run(store, 2);
      expect(first.scannedIdentities).toEqual(["text:32", "text:3032"]);
      expect(first.entries).toEqual({
        "2": { [field]: value, requestId: "2" },
        "02": { [field]: value, requestId: "02" },
      });
      if (typeof value === "number") {
        expect([...first.snapshots!.keys()]).toEqual(["2", "02"]);
        for (const [index, key] of ["2", "02"].entries()) {
          expect(first.snapshots!.get(key)).toEqual({
            root,
            key,
            value: first.entries![key],
            revision: index + 1,
          });
          expect(first.snapshots!.get(key)!.value).toBe(first.entries![key]);
        }
      } else {
        expect(first).not.toHaveProperty("snapshots");
      }
      const second = await run(store, 2, ["text:32", "text:3032"]);
      expect(second.scannedIdentities).toEqual([
        "text:3130",
        "text:616C706861",
      ]);
      expect(second.entries).toEqual({
        "10": { [field]: value, requestId: "10" },
        alpha: { [field]: value, requestId: "alpha" },
      });
      const excluded = ["text:32", "text:3032", "text:3130", "text:616C706861"];
      const third = await run(store, 2, excluded);
      expect(third.scannedIdentities).toEqual(["text:F09F9880"]);
      expect(third.entries).toEqual({
        "😀": { [field]: value, requestId: "😀" },
      });
      expect(await run(store, 2, [...excluded, "text:F09F9880"])).toEqual({
        entries: null,
        scannedIdentities: [],
      });
    },
  );

  it.each([telegramRoot, profileRoot] as const)(
    "retains decoded snapshots from the existing %s page query without rewriting JSON",
    async (root) => {
      const field = root === telegramRoot ? "updatedAtMs" : "lastQueuedAtMs";
      const { table } = AUTOMATCH_RECORD_TABLES[root];
      const payload = `{"${field}":10.9,"requestId":"first","requestId":"last","large":9007199254740993,"future":{".sv":"timestamp"}}`;
      await db
        .prepare(
          `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
           VALUES ('invite', ?, 7, 1)`,
        )
        .bind(payload)
        .run();
      const observed = observeReads();
      const page =
        root === telegramRoot
          ? await observed.store.listDueAutomatchTelegramOutboxesPage(11, 10)
          : await observed.store.listDueAutomatchProfileOutboxesPage(11, 10);
      expect(page.snapshots!.get("invite")).toEqual({
        root,
        key: "invite",
        value: JSON.parse(payload),
        revision: 7,
      });
      expect(observed.sessions).toEqual(["first-primary"]);
      expect(observed.queries).toHaveLength(1);
      expect(
        await db
          .prepare(
            `SELECT payload_json FROM ${table} WHERE record_key = 'invite'`,
          )
          .first<string>("payload_json"),
      ).toBe(payload);
    },
  );

  it.each([
    [telegramRoot, 0x80],
    [telegramRoot, 0xff],
    [profileRoot, 0x80],
    [profileRoot, 0xff],
  ] as const)(
    "retains only exact text identities for %s with malformed byte %s",
    async (root, malformedByte) => {
      const field = root === telegramRoot ? "updatedAtMs" : "lastQueuedAtMs";
      const { table } = AUTOMATCH_RECORD_TABLES[root];
      const key = "\uFFFD";
      const valid = { [field]: 10, requestId: "same", source: "valid" };
      const malformed = { [field]: 10, requestId: "same", source: "malformed" };
      await db.batch([
        db
          .prepare(
            `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
             VALUES (?, ?, 7, 1)`,
          )
          .bind(key, JSON.stringify(valid)),
        db
          .prepare(
            `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
             VALUES (CAST(? AS TEXT), ?, 7, 1)`,
          )
          .bind(Uint8Array.of(malformedByte).buffer, JSON.stringify(malformed)),
      ]);
      const page =
        root === telegramRoot
          ? await store.listDueAutomatchTelegramOutboxesPage(10, 10)
          : await store.listDueAutomatchProfileOutboxesPage(10, 10);
      const malformedIdentity = `text:${malformedByte.toString(16).toUpperCase()}`;
      const validLast = malformedByte < 0xef;
      expect(page.scannedIdentities).toEqual(
        validLast
          ? [malformedIdentity, "text:EFBFBD"]
          : ["text:EFBFBD", malformedIdentity],
      );
      expect(page.entries).toEqual({ [key]: validLast ? valid : malformed });
      expect(page.snapshots!.get(key)).toEqual(
        validLast ? { root, key, value: valid, revision: 7 } : undefined,
      );
      expect(page.entries).toEqual(
        root === telegramRoot
          ? await store.listDueAutomatchTelegramOutboxes(10, 10)
          : await store.listDueAutomatchProfileOutboxes(10, 10),
      );
      expect(await store.read(root, key)).toEqual({
        root,
        key,
        value: valid,
        revision: 7,
      });
    },
  );

  it.each(recoveryReads)(
    "rejects invalid $name exclusions before querying and retains strict row decoding",
    async ({ root, field, value, run }) => {
      const observed = observeReads();
      for (const excluded of [
        ["text:32", "text:32"],
        ["text:ab"],
        ["text:0"],
        ["numeric:32"],
        Array.from(
          { length: 11 },
          (_, index) =>
            `text:${index.toString(16).toUpperCase().padStart(2, "0")}`,
        ),
      ]) {
        await expect(run(observed.store, 2, excluded)).rejects.toThrow(
          "invalid-recovery-scan-exclusions",
        );
      }
      expect(observed.sessions).toEqual([]);
      expect(observed.queries).toEqual([]);
      await seed(root, [["bad.key", { [field]: value }]]);
      await expect(run(store, 2)).rejects.toThrow("invalid-automatch-key");
    },
  );

  it.each(recoveryReads)(
    "checks cancellation around $name page reads and keeps their index with exclusions",
    async ({ root, field, value, run }) => {
      await seed(root, [
        ["one", { [field]: value }],
        ["two", { [field]: value }],
      ]);
      const reason = new Error("cancelled-automatch-page");
      const before = new AbortController();
      before.abort(reason);
      const cancelled = observeReads();
      await expect(run(cancelled.store, 2, [], before.signal)).rejects.toBe(
        reason,
      );
      expect(cancelled.sessions).toEqual([]);
      expect(cancelled.queries).toEqual([]);

      const after = new AbortController();
      const completed = observeReads(() => after.abort(reason));
      await expect(
        run(completed.store, 2, ["text:6F6E65"], after.signal),
      ).rejects.toBe(reason);
      expect(completed.sessions).toEqual(["first-primary"]);
      expect(completed.queries).toHaveLength(1);
      const query = completed.queries[0];
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.values)
        .all<{ detail: string }>();
      const details = plan.results.map(({ detail }) => detail).join("\n");
      expect(details).toContain(
        root === telegramRoot
          ? "USING INDEX idx_automatch_telegram_projection_recovery"
          : "USING INDEX idx_game_session_projection_recovery",
      );
      expect(details).not.toContain("TEMP B-TREE");
    },
  );

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

  it("uses indexed searches without sorting recovery rows", async () => {
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
      /SEARCH .* USING INDEX idx_automatch_telegram_projection_recovery /,
    );
    expect(sorts[1], plans[1]).toEqual([]);
    expect(plans[2]).toMatch(
      /SEARCH .* USING INDEX idx_game_session_projection_recovery /,
    );
    expect(sorts[2], plans[2]).toEqual([]);
    expect(plans[3]).toMatch(
      /SEARCH .* USING INDEX idx_game_session_projection_recovery /,
    );
    expect(sorts[3], plans[3]).toEqual([]);
  });
});
