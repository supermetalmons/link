import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applicationWriteFenceSql } from "../cloud/runtime/application-fence.js";
import {
  createGuardedOperatorRunner,
  GuardedOperatorSqlFailure,
  runGuardedOperatorSqlSync,
} from "./operator/guardedSql.ts";

const databaseIds = {
  PROFILE_GAMES_DB: "11111111-1111-4111-8111-111111111111",
  PROFILE_DB: "22222222-2222-4222-8222-222222222222",
  EVENT_DB: "33333333-3333-4333-8333-333333333333",
  EVENT_PRIZE_WITHDRAWALS_DB: "44444444-4444-4444-8444-444444444444",
};
const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
type Statement = { sql: string; params?: (string | number | null)[] };

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(resolve(tmpdir(), "guarded-operator-test-"));
  const configPath = resolve(directory, "wrangler.jsonc");
  writeFileSync(
    configPath,
    JSON.stringify({
      account_id: "a".repeat(32),
      name: "mons-link-api",
      d1_databases: Object.entries(databaseIds).map(
        ([binding, database_id]) => ({
          binding,
          database_id,
          database_name: binding,
        }),
      ),
    }),
  );
  const databases = Object.fromEntries(
    Object.keys(databaseIds).map((binding) => [
      binding,
      new DatabaseSync(":memory:"),
    ]),
  ) as Record<keyof typeof databaseIds, DatabaseSync>;
  const schema = readFileSync(
    resolve(
      import.meta.dirname,
      "../cloud/workers/api/migrations/0028_application_data_control.sql",
    ),
    "utf8",
  );
  for (const db of Object.values(databases)) {
    db.exec(schema);
    db.exec("UPDATE application_data_control SET generation=3,data_epoch=1");
  }
  const targets = {
    PROFILE_GAMES_DB: [
      "automatch_runtime_control",
      "automatch_write_admissions",
      "invite_source_write_admissions",
    ],
    PROFILE_DB: [
      "profile_canonical_control",
      "wager_reservation_runtime_control",
      "wager_reservation_write_admissions",
    ],
    EVENT_DB: ["event_runtime_control", "event_write_admissions"],
    EVENT_PRIZE_WITHDRAWALS_DB: ["event_prize_withdrawal_runtime_control"],
  };
  for (const [binding, tables] of Object.entries(targets)) {
    const db = databases[binding as keyof typeof databases];
    for (const table of tables) {
      db.exec(
        `CREATE TABLE ${table}(singleton INTEGER PRIMARY KEY,state TEXT NOT NULL,value INTEGER NOT NULL);INSERT INTO ${table} VALUES(1,'active',10);`,
      );
      db.exec(applicationWriteFenceSql(table));
    }
  }
  const requests: Array<{ binding: string; statements: Statement[] }> = [];
  let failTargetResponse = false;
  let failCompletionResponse = false;
  let failDisposal = false;
  let beforeTarget: (() => void) | null = null;
  const query = (
    binding: keyof typeof databaseIds,
    statements: Statement[],
  ) => {
    requests.push({ binding, statements });
    const db = databases[binding];
    const target = statements.some((statement) =>
      /^(?:UPDATE|DELETE FROM) (?:event_runtime_control|profile_canonical_control|wager_reservation_runtime_control|automatch_runtime_control|automatch_write_admissions|invite_source_write_admissions|event_prize_withdrawal_runtime_control|event_write_admissions)/.test(
        statement.sql,
      ),
    );
    if (target && beforeTarget) {
      const work = beforeTarget;
      beforeTarget = null;
      work();
    }
    db.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        const rows = db.prepare(statement.sql).all(...(statement.params ?? []));
        return {
          success: true,
          results: rows.map((row) => ({ ...row })),
          meta: {
            changes: Number(
              db.prepare("SELECT changes() AS count").get()!.count,
            ),
          },
        };
      });
      db.exec("COMMIT");
      if (target && failTargetResponse)
        throw new Error("response-lost-after-commit");
      if (
        failCompletionResponse &&
        statements.some(({ sql }) =>
          sql.startsWith("DELETE FROM application_data_admissions"),
        )
      )
        throw new Error("completion-response-lost-after-commit");
      return results;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input),
      id = /\/database\/([^/]+)\/query$/.exec(url)?.[1];
    const binding = Object.entries(databaseIds).find(
      ([, value]) => value === id,
    )?.[0] as keyof typeof databaseIds | undefined;
    assert.ok(binding);
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer fixture-token",
    );
    const body = JSON.parse(String(init?.body)) as {
      batch?: Statement[];
      sql: string;
      params?: Statement["params"];
    };
    assert.equal(body.batch, undefined, "REST writes must not be used");
    assert.match(body.sql, /^SELECT/);
    return Response.json({
      success: true,
      result: query(binding, [{ sql: body.sql, params: body.params ?? [] }]),
    });
  };
  let disposed = 0;
  const run = createGuardedOperatorRunner({
    apiToken: "fixture-token",
    configPath,
    fetcher,
    now: () => 100,
    createOperationId: () => operationId,
    openSession: async (targetBinding) => ({
      transport: {
        async readControl() {
          return query("PROFILE_GAMES_DB", [
            {
              sql: "SELECT singleton, generation, data_epoch, phase, migration_id FROM application_data_control WHERE singleton = 1",
            },
          ])[0]!.results;
        },
        async atomicBatch(binding, statements) {
          assert.ok(
            binding === "PROFILE_GAMES_DB" || binding === targetBinding,
          );
          return query(
            binding,
            statements.map(({ sql, bindings }) => ({
              sql,
              params: [...bindings],
            })),
          );
        },
      },
      async dispose() {
        disposed++;
        if (failDisposal) throw new Error("private-cleanup-error");
      },
    }),
  });
  t.after(() => {
    for (const db of Object.values(databases)) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    run,
    databases,
    requests,
    disposed: () => disposed,
    loseTargetResponse: () => {
      failTargetResponse = true;
    },
    loseCompletionResponse: () => {
      failCompletionResponse = true;
    },
    failDisposal: () => {
      failDisposal = true;
    },
    beforeTarget: (work: () => void) => {
      beforeTarget = work;
    },
  };
}

for (const [binding, table] of [
  ["PROFILE_GAMES_DB", "automatch_runtime_control"],
  ["PROFILE_DB", "profile_canonical_control"],
  ["PROFILE_DB", "wager_reservation_runtime_control"],
  ["EVENT_DB", "event_runtime_control"],
  ["EVENT_PRIZE_WITHDRAWALS_DB", "event_prize_withdrawal_runtime_control"],
] as const)
  test(`guarded ${table} maintenance preserves the existing business predicate and cleans up its own context`, async (t) => {
    const f = fixture(t),
      db = f.databases[binding];
    assert.throws(
      () => db.exec(`UPDATE ${table} SET value=20 WHERE singleton=1`),
      /application-write-fenced/,
    );
    const rows = await f.run(
      `UPDATE ${table} SET value=? WHERE singleton=1 AND state=? AND value=? RETURNING value`,
      binding,
      [20, "active", 10],
    );
    assert.deepEqual(rows, [{ value: 20 }]);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM application_write_context")
        .get()!.count,
      0,
    );
    assert.equal(
      f.databases.PROFILE_GAMES_DB.prepare(
        "SELECT COUNT(*) AS count FROM application_data_admissions",
      ).get()!.count,
      0,
    );
    const guarded = f.requests.find(
      (request) => request.statements.length === 4,
    )!;
    assert.ok(
      guarded.statements[1]!.sql.startsWith(
        "INSERT INTO application_write_context",
      ),
    );
    assert.doesNotMatch(guarded.statements[1]!.sql, /REPLACE|IGNORE/);
    assert.deepEqual(guarded.statements[3]!.params, [operationId]);
    assert.equal(f.disposed(), 1);
  });

test("read-only diagnostics do not register admissions or obtain a write context", async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    await f.run(
      "SELECT value FROM event_runtime_control WHERE singleton=1",
      "EVENT_DB",
    ),
    [{ value: 10 }],
  );
  assert.equal(f.requests.length, 1);
  assert.ok(
    f.requests.every((request) =>
      request.statements.every((statement) =>
        statement.sql.startsWith("SELECT"),
      ),
    ),
  );
});

for (const [binding, table] of [
  ["PROFILE_GAMES_DB", "automatch_write_admissions"],
  ["PROFILE_GAMES_DB", "invite_source_write_admissions"],
  ["PROFILE_DB", "wager_reservation_write_admissions"],
  ["EVENT_DB", "event_write_admissions"],
] as const)
  test(`named ${table} deletion preserves unselected rows and never broadens the caller CAS`, async (t) => {
    const f = fixture(t);
    const rows = await f.run(
      `DELETE FROM ${table} WHERE singleton=? AND state=? AND value=? RETURNING singleton`,
      binding,
      [1, "active", 99],
    );
    assert.deepEqual(rows, []);
    assert.equal(
      f.databases[binding]
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get()!.count,
      1,
    );
    assert.deepEqual(
      await f.run(
        `DELETE FROM ${table} WHERE singleton=? AND state=? AND value=? RETURNING singleton`,
        binding,
        [1, "active", 10],
      ),
      [{ singleton: 1 }],
    );
  });

test("different target generation rejects before registering a central admission", async (t) => {
  const f = fixture(t);
  f.databases.EVENT_DB.exec(
    "UPDATE application_data_control SET generation=4 WHERE singleton=1",
  );
  await assert.rejects(
    f.run(
      "UPDATE event_runtime_control SET value=20 WHERE singleton=1",
      "EVENT_DB",
    ),
    /operator-application-generation-mismatch/,
  );
  assert.equal(
    f.databases.PROFILE_GAMES_DB.prepare(
      "SELECT COUNT(*) AS count FROM application_data_admissions",
    ).get()!.count,
    0,
  );
  assert.equal(f.disposed(), 1);
});

test("occupied write contexts fail without erasing another operation or changing business state", async (t) => {
  const f = fixture(t),
    db = f.databases.EVENT_DB;
  db.prepare(
    "INSERT INTO application_write_context VALUES(1,3,1,'other-operation',NULL)",
  ).run();
  await assert.rejects(
    f.run(
      "UPDATE event_runtime_control SET value=20 WHERE singleton=1",
      "EVENT_DB",
    ),
    /operator-write-unconfirmed/,
  );
  assert.equal(
    db.prepare("SELECT operation_id FROM application_write_context").get()!
      .operation_id,
    "other-operation",
  );
  assert.equal(
    db.prepare("SELECT value FROM event_runtime_control").get()!.value,
    10,
  );
  assert.equal(
    f.databases.PROFILE_GAMES_DB.prepare(
      "SELECT status FROM application_data_admissions",
    ).get()!.status,
    "blocked",
  );
});

test("changed, wrong, and closed application control fails without touching business rows", async (t) => {
  const f = fixture(t),
    db = f.databases.EVENT_DB;
  db.exec(
    "UPDATE application_data_control SET phase='closed',migration_id='fixture'",
  );
  await assert.rejects(
    f.run(
      "UPDATE event_runtime_control SET value=20 WHERE singleton=1",
      "EVENT_DB",
    ),
    /operator-application-control-unavailable/,
  );
  db.exec(
    "UPDATE application_data_control SET phase='active',migration_id=NULL,data_epoch=0",
  );
  await assert.rejects(
    f.run(
      "UPDATE event_runtime_control SET value=20 WHERE singleton=1",
      "EVENT_DB",
    ),
    /operator-application-control-unavailable/,
  );
  db.exec("UPDATE application_data_control SET data_epoch=1");
  f.beforeTarget(() =>
    db.exec(
      "UPDATE application_data_control SET phase='closing',migration_id='changed'",
    ),
  );
  await assert.rejects(
    f.run(
      "UPDATE event_runtime_control SET value=20 WHERE singleton=1",
      "EVENT_DB",
    ),
    /operator-write-unconfirmed/,
  );
  assert.equal(
    db.prepare("SELECT value FROM event_runtime_control").get()!.value,
    10,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM application_write_context").get()!
      .count,
    0,
  );
});

test("a failed business statement rolls back both context and business changes", async (t) => {
  const f = fixture(t),
    db = f.databases.EVENT_DB;
  await assert.rejects(
    f.run(
      "UPDATE event_runtime_control SET value=NULL WHERE singleton=1",
      "EVENT_DB",
    ),
    /operator-write-unconfirmed/,
  );
  assert.equal(
    db.prepare("SELECT value FROM event_runtime_control").get()!.value,
    10,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM application_write_context").get()!
      .count,
    0,
  );
});

test("uncertain successful writes are not retried and keep the central admission blocked", async (t) => {
  const f = fixture(t);
  f.loseTargetResponse();
  await assert.rejects(
    f.run(
      "UPDATE event_runtime_control SET value=20 WHERE singleton=1",
      "EVENT_DB",
    ),
    /operator-write-unconfirmed/,
  );
  assert.equal(
    f.databases.EVENT_DB.prepare(
      "SELECT value FROM event_runtime_control",
    ).get()!.value,
    20,
  );
  assert.equal(
    f.databases.EVENT_DB.prepare(
      "SELECT COUNT(*) AS count FROM application_write_context",
    ).get()!.count,
    0,
  );
  assert.equal(
    f.requests.filter((request) => request.statements.length === 4).length,
    1,
  );
  assert.equal(
    f.databases.PROFILE_GAMES_DB.prepare(
      "SELECT status FROM application_data_admissions",
    ).get()!.status,
    "blocked",
  );
});

test("forbidden targets and multiple statements reject before network access", async (t) => {
  const f = fixture(t);
  for (const sql of [
    "UPDATE application_data_control SET phase='active'",
    "DELETE FROM anonymous_sessions",
    "INSERT INTO application_write_context VALUES(1,3,1,'x',NULL)",
    "SELECT 1; DELETE FROM event_write_admissions",
    "UPDATE event_runtime_control SET value=20; SELECT 1",
    "DELETE FROM event_write_admissions RETURNING (SELECT 1 WHERE 1)",
    "UPDATE event_runtime_control SET value=(SELECT 20 WHERE 1)",
    "UPDATE event_runtime_control SET state='WHERE'",
    "DELETE FROM event_write_admissions /* WHERE singleton=1 */",
  ])
    await assert.rejects(f.run(sql, "EVENT_DB"));
  await assert.rejects(
    f.run("UPDATE event_runtime_control SET value=20", "PROFILE_DB"),
  );
  assert.equal(f.requests.length, 0);
});

test("a disposal failure retains the primary mutation uncertainty and its operation ID", async (t) => {
  const f = fixture(t);
  f.loseTargetResponse();
  f.failDisposal();
  await assert.rejects(
    f.run(
      "UPDATE event_runtime_control SET value=20 WHERE singleton=1",
      "EVENT_DB",
    ),
    (error: unknown) => {
      assert.ok(error instanceof GuardedOperatorSqlFailure);
      assert.equal(error.code, "operator-write-unconfirmed");
      assert.equal(error.operationId, operationId);
      assert.equal(error.stage, "mutation");
      assert.equal(error.queryConfirmed, false);
      assert.equal(error.cleanupUnconfirmed, true);
      assert.doesNotMatch(error.message, /private-cleanup-error/);
      return true;
    },
  );
  assert.equal(
    f.requests.filter((request) => request.statements.length === 4).length,
    1,
  );
  assert.equal(f.disposed(), 1);
});

test("a disposal failure after confirmed SQL reports the completed outcome without inviting a retry", async (t) => {
  const f = fixture(t);
  f.failDisposal();
  await assert.rejects(
    f.run(
      "UPDATE event_runtime_control SET value=20 WHERE singleton=1",
      "EVENT_DB",
    ),
    (error: unknown) => {
      assert.ok(error instanceof GuardedOperatorSqlFailure);
      assert.equal(error.code, "operator-write-confirmed-cleanup-unconfirmed");
      assert.equal(error.operationId, operationId);
      assert.equal(error.stage, "cleanup");
      assert.equal(error.queryConfirmed, true);
      assert.equal(error.cleanupUnconfirmed, true);
      assert.match(error.message, /without repeating the SQL/);
      return true;
    },
  );
  assert.equal(
    f.databases.EVENT_DB.prepare(
      "SELECT value FROM event_runtime_control",
    ).get()!.value,
    20,
  );
  assert.equal(
    f.databases.PROFILE_GAMES_DB.prepare(
      "SELECT COUNT(*) AS count FROM application_data_admissions",
    ).get()!.count,
    0,
  );
  assert.equal(
    f.requests.filter((request) => request.statements.length === 4).length,
    1,
  );
});

test("lost admission completion preserves the confirmed SQL outcome and completion stage", async (t) => {
  const f = fixture(t);
  f.loseCompletionResponse();
  await assert.rejects(
    f.run(
      "UPDATE event_runtime_control SET value=20 WHERE singleton=1",
      "EVENT_DB",
    ),
    (error: unknown) => {
      assert.ok(error instanceof GuardedOperatorSqlFailure);
      assert.equal(
        error.code,
        "operator-write-confirmed-admission-unconfirmed",
      );
      assert.equal(error.operationId, operationId);
      assert.equal(error.stage, "completion");
      assert.equal(error.queryConfirmed, true);
      return true;
    },
  );
  assert.equal(
    f.requests.filter((request) => request.statements.length === 4).length,
    1,
  );
});

test("sync adapter sends SQL and parameters only through stdin and sanitizes failures", () => {
  const rows = runGuardedOperatorSqlSync(
    "SELECT value FROM event_runtime_control WHERE state=?",
    "EVENT_DB",
    ["private-state"],
    (input) => {
      assert.deepEqual(JSON.parse(input), {
        sql: "SELECT value FROM event_runtime_control WHERE state=?",
        database: "EVENT_DB",
        bindings: ["private-state"],
      });
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, rows: [{ value: 10 }] }),
      };
    },
  );
  assert.deepEqual(rows, [{ value: 10 }]);
  assert.throws(
    () =>
      runGuardedOperatorSqlSync("SELECT 1", "EVENT_DB", [], () => ({
        status: 1,
        stdout: "private-token",
      })),
    /operator-rpc-unconfirmed/,
  );
  assert.throws(
    () =>
      runGuardedOperatorSqlSync(
        "UPDATE event_runtime_control SET value=20 WHERE singleton=1",
        "EVENT_DB",
        [],
        () => ({
          status: 1,
          stdout: JSON.stringify({
            ok: false,
            code: "operator-write-confirmed-cleanup-unconfirmed",
            operationId,
            stage: "cleanup",
            queryConfirmed: true,
            cleanupUnconfirmed: true,
          }),
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof GuardedOperatorSqlFailure);
      assert.equal(error.code, "operator-write-confirmed-cleanup-unconfirmed");
      assert.equal(error.operationId, operationId);
      assert.equal(error.stage, "cleanup");
      assert.equal(error.queryConfirmed, true);
      assert.equal(error.cleanupUnconfirmed, true);
      return true;
    },
  );
});
