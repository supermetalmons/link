import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertFirebaseInviteSourceAvailable } from "./invite-source-retirement.ts";
import type { SqlRunner } from "./manage-wager-state.ts";

test("legacy source scans remain usable before provisioning and reject activated or corrupt invite authority", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const run: SqlRunner = async (sql, database, bindings = []) => {
    assert.equal(database, "mons-link-profile-games");
    return db.prepare(sql).all(...bindings) as Record<string, unknown>[];
  };
  await assertFirebaseInviteSourceAvailable(run);
  db.exec(
    "CREATE TABLE invite_source_control (singleton INTEGER, backend TEXT);",
  );
  await assert.rejects(
    assertFirebaseInviteSourceAvailable(run),
    /missing or invalid/,
  );
  db.exec("INSERT INTO invite_source_control VALUES (1, 'rtdb');");
  await assertFirebaseInviteSourceAvailable(run);
  db.exec("UPDATE invite_source_control SET backend = 'd1';");
  await assert.rejects(assertFirebaseInviteSourceAvailable(run), /retired/);
  db.exec("UPDATE invite_source_control SET backend = 'unknown';");
  await assert.rejects(
    assertFirebaseInviteSourceAvailable(run),
    /missing or invalid/,
  );
});
