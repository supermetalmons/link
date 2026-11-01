import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applicationWriteFenceSql,
  parseApplicationDataControl,
} from "../src/applicationDataControl.ts";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL(
        "../migrations/0028_application_data_control.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  db.exec(
    "CREATE TABLE balances (id TEXT PRIMARY KEY, amount INTEGER NOT NULL)",
  );
  db.exec(applicationWriteFenceSql("balances"));
  return db;
}

function write(
  db: DatabaseSync,
  generation: number,
  migration: string | null,
  id = "player",
) {
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO application_write_context VALUES (1, ?, 0, 'operation', ?)",
    ).run(generation, migration);
    db.prepare("INSERT INTO balances VALUES (?, 10)").run(id);
    db.exec("DELETE FROM application_write_context");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("control decoding rejects unknown shapes and coerced generations", () => {
  const row = {
    singleton: 1,
    generation: 1,
    data_epoch: 0,
    phase: "active",
    migration_id: null,
  };
  assert.deepEqual(parseApplicationDataControl(row), {
    generation: 1,
    dataEpoch: 0,
    phase: "active",
    migrationId: null,
  });
  for (const invalid of [
    null,
    { ...row, generation: "1" },
    { ...row, extra: true },
    { ...row, phase: "closed" },
    { ...row, data_epoch: 2 },
  ])
    assert.throws(() => parseApplicationDataControl(invalid));
});

test("writes require a transaction-local context and preserve it on rollback", () => {
  const db = database();
  try {
    assert.throws(() => db.exec("INSERT INTO balances VALUES ('old-code', 1)"));
    write(db, 1, null);
    assert.equal(db.prepare("SELECT amount FROM balances").get()?.amount, 10);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM application_write_context")
        .get()?.count,
      0,
    );
    assert.throws(() => write(db, 1, null));
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM application_write_context")
        .get()?.count,
      0,
    );
    assert.throws(() => db.exec("UPDATE balances SET amount = 0"));
    assert.throws(() => db.exec("DELETE FROM balances"));
  } finally {
    db.close();
  }
});

test("stale admissions stay fenced after reopen and only the migration can write while closed", () => {
  const db = database();
  try {
    db.exec(
      "UPDATE application_data_control SET generation = 2, phase = 'closed', migration_id = 'cutover'",
    );
    assert.throws(() => write(db, 1, null));
    assert.throws(() => write(db, 2, null));
    assert.throws(() => write(db, 2, "wrong-migration"));
    write(db, 2, "cutover");
    db.exec("UPDATE application_data_control SET phase = 'active'");
    assert.throws(() => write(db, 1, null));
    assert.throws(() => write(db, 2, "cutover"));
    write(db, 2, null, "reopened");
    assert.equal(
      db.prepare("SELECT amount FROM balances WHERE id = 'reopened'").get()
        ?.amount,
      10,
    );
    assert.throws(() =>
      applicationWriteFenceSql("balances; DROP TABLE balances"),
    );
  } finally {
    db.close();
  }
});
