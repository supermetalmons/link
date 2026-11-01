import assert from "node:assert/strict";
import test from "node:test";
import {
  fenceApplicationDatabase,
  isApplicationReadSql,
} from "../src/applicationD1.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

test("SQL read classification cannot hide writes in CTEs, comments or extra statements", () => {
  for (const sql of [
    "SELECT * FROM profiles WHERE id = ?",
    "/* prefix */ WITH rows AS (SELECT 'UPDATE balance') SELECT * FROM rows; -- trailing",
    "WITH RECURSIVE rows(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM rows WHERE x < 10) SELECT * FROM rows",
    "EXPLAIN QUERY PLAN SELECT * FROM profiles",
    'WITH "delete" AS (SELECT 1) SELECT * FROM "delete"',
  ])
    assert.equal(isApplicationReadSql(sql), true, sql);
  for (const sql of [
    "INSERT INTO profiles VALUES (?)",
    "WITH rows AS (SELECT 1) UPDATE profiles SET balance = 0",
    "WITH rows AS (SELECT 1) DELETE FROM profiles",
    "WITH rows AS (SELECT 1) INSERT INTO profiles SELECT * FROM rows",
    "SELECT 1; DELETE FROM profiles",
    "SELECT 1; /* harmless */ UPDATE profiles SET balance = 0",
    "PRAGMA foreign_keys = OFF",
    "/* SELECT 1 */ DROP TABLE profiles",
    "SELECT 'unterminated",
  ])
    assert.equal(isApplicationReadSql(sql), false, sql);
});

test("writes add admission and cleanup to the same native batch, including RETURNING", async () => {
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
  const originals = new WeakMap<
    D1PreparedStatement,
    { sql: string; args: unknown[] }
  >();
  const prepare = (sql: string, args: unknown[] = []): D1PreparedStatement => {
    const statement: D1PreparedStatement = {
      first: TELEGRAM_TEST_ENV.PROFILE_DB.prepare("unused").first,
      run: TELEGRAM_TEST_ENV.PROFILE_DB.prepare("unused").run,
      raw: TELEGRAM_TEST_ENV.PROFILE_DB.prepare("unused").raw,
      bind: (...values) => prepare(sql, values),
      all: async <T>() => {
        queries.push({ sql, args });
        return {
          success: true,
          results: [],
          meta: {
            changed_db: false,
            changes: 0,
            duration: 0,
            last_row_id: 0,
            rows_read: 0,
            rows_written: 0,
            size_after: 0,
          },
        } satisfies D1Result<T>;
      },
    };
    originals.set(statement, { sql, args });
    return statement;
  };
  const native: D1Database = {
    ...TELEGRAM_TEST_ENV.PROFILE_DB,
    prepare,
    batch: async <T>(statements: D1PreparedStatement[]) => {
      batches.push(
        statements.map((statement) => {
          const recorded = originals.get(statement);
          assert.ok(recorded);
          return recorded;
        }),
      );
      return Promise.all(statements.map((statement) => statement.all<T>()));
    },
    withSession: () => ({
      prepare,
      batch: native.batch,
      getBookmark: () => "bookmark",
    }),
  };
  const db = fenceApplicationDatabase(native, {
    kind: "business",
    generation: 3,
    dataEpoch: 1,
    operationId: "operation",
  });
  await db.prepare("SELECT * FROM profiles").all();
  assert.equal(batches.length, 0);
  await db
    .prepare("INSERT INTO profiles VALUES (?) RETURNING id")
    .bind("profile")
    .all();
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0]?.map((entry) => entry.sql),
    [
      "INSERT INTO application_write_context (singleton, generation, data_epoch, operation_id, migration_id) VALUES (1, ?, ?, ?, ?)",
      "INSERT INTO profiles VALUES (?) RETURNING id",
      "DELETE FROM application_write_context WHERE singleton = 1 AND operation_id = ?",
    ],
  );
  assert.deepEqual(batches[0]?.[0]?.args, [3, 1, "operation", null]);
  assert.equal(db.withSession().getBookmark(), "bookmark");
  assert.throws(
    () => db.batch([native.prepare("DELETE FROM profiles")]),
    /application-data-unavailable/,
  );
  assert.throws(
    () => db.exec("DELETE FROM profiles"),
    /application-exec-unsupported/,
  );
});
