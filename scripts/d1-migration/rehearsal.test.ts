import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { captureSchema, resetCloneTarget, type SqlQuery } from "./clone.ts";
import { runCloneRehearsal } from "./rehearsal.ts";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function queryFor(db: DatabaseSync, queries: string[] = []): SqlQuery {
  return async (sql, params = []) => {
    assert.ok(Buffer.byteLength(sql) <= 90 * 1_024);
    queries.push(sql);
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  };
}

test("the actual SQL-query rehearsal returns serializable verified evidence and leaves resettable fixtures", async () => {
  const source = database();
  const target = database();
  try {
    const progress: string[] = [];
    const sourceQuery = queryFor(source);
    const targetQuery = queryFor(target);
    const result = await runCloneRehearsal(sourceQuery, targetQuery, {
      onProgress(event) {
        progress.push(event.stage);
      },
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 10);
    assert.match(result.digest.sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      result.digest.tables.find(
        (table) => table.name === "clone_rehearsal_values",
      )?.rows,
      "10",
    );
    assert.equal(result.digest.sequences[0].value, "9007199254740993");
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.ok(
      progress.includes("copy") &&
        progress.includes("verify") &&
        progress.includes("complete"),
    );
    await resetCloneTarget(sourceQuery, result.schema);
    await resetCloneTarget(targetQuery, result.schema);
    assert.equal((await captureSchema(sourceQuery)).objects.length, 0);
    assert.equal((await captureSchema(targetQuery)).objects.length, 0);
  } finally {
    source.close();
    target.close();
  }
});

test("rehearsal refuses nonempty source or target before mutating either", async () => {
  for (const occupied of ["source", "target"]) {
    const source = database();
    const target = database();
    try {
      (occupied === "source" ? source : target).exec(
        "CREATE TABLE application_data (id INTEGER PRIMARY KEY)",
      );
      const queries: string[] = [];
      await assert.rejects(
        runCloneRehearsal(queryFor(source, queries), queryFor(target, queries)),
        /two empty application schemas/,
      );
      assert.ok(
        queries.every(
          (sql) => !/^\s*(CREATE|INSERT|UPDATE|DELETE|DROP)\b/.test(sql),
        ),
      );
    } finally {
      source.close();
      target.close();
    }
  }
});

test("rehearsal refuses the same query callback for both databases", async () => {
  const source = database();
  try {
    const query = queryFor(source);
    await assert.rejects(
      runCloneRehearsal(query, query),
      /distinct source and target/,
    );
    assert.equal((await captureSchema(query)).objects.length, 0);
  } finally {
    source.close();
  }
});

test("rehearsal detects byte transformations in the destination transport", async () => {
  const source = database();
  const target = database();
  try {
    const raw = queryFor(target);
    const corrupting: SqlQuery = (sql, params) =>
      raw(
        sql.startsWith('INSERT INTO "clone_rehearsal_values"')
          ? sql.replace("CAST(X'FF00C080' AS TEXT)", "CAST(X'EFBFBD' AS TEXT)")
          : sql,
        params,
      );
    await assert.rejects(
      runCloneRehearsal(queryFor(source), corrupting),
      /restored typed row comparison/,
    );
  } finally {
    source.close();
    target.close();
  }
});

test("a silently dropped source fixture chunk prevents rehearsal success", async () => {
  const source = database();
  const target = database();
  try {
    const raw = queryFor(source);
    const dropping: SqlQuery = (sql, params) =>
      sql.startsWith("UPDATE clone_rehearsal_large")
        ? Promise.resolve([])
        : raw(sql, params);
    await assert.rejects(
      runCloneRehearsal(dropping, queryFor(target)),
      /fixture comparison/,
    );
    assert.equal((await captureSchema(queryFor(target))).objects.length, 0);
  } finally {
    source.close();
    target.close();
  }
});
