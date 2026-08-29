import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationsDirectory = resolve(
  import.meta.dirname,
  "../profile-migrations",
);
const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const retirementMigration = "0009_retire_legacy_profile_projection.sql";

function migrationSql(name: string): string {
  return readFileSync(resolve(migrationsDirectory, name), "utf8");
}

function legacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    if (name === retirementMigration) break;
    database.exec(migrationSql(name));
  }
  return database;
}

function finalizeControl(database: DatabaseSync, state: "active" | "frozen") {
  database.exec(
    `UPDATE profile_canonical_control
     SET state = 'importing'
     WHERE singleton = 1 AND state = 'firestore'`,
  );
  database
    .prepare(
      `UPDATE profile_canonical_control
       SET import_digest = ?, import_plan_version = 1
       WHERE singleton = 1 AND state = 'importing'`,
    )
    .run("0".repeat(64));
  database.exec(
    `UPDATE profile_canonical_control
     SET state = 'frozen', imported_at_ms = 1
     WHERE singleton = 1 AND state = 'importing'`,
  );
  if (state === "active") {
    database.exec(
      `UPDATE profile_canonical_control
       SET state = 'active'
       WHERE singleton = 1 AND state = 'frozen'`,
    );
  }
}

function insertLegacyProfile(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO profiles (
         profile_id, payload_json, source_update_seconds,
         source_update_nanos, source_digest, projected_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("profile-1", '{"id":"profile-1"}', 1, 0, "1".repeat(64), 1);
}

function insertCanonicalProfile(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO profile_records (
         profile_id, state, payload_json, gameplay_emoji_json,
         legacy_fields_json, created_at_ms, updated_at_ms,
         rating_sort_present, mana_points_sort_present, nonce_sort_present,
         dust_sort_present, slime_sort_present, gum_sort_present,
         metal_sort_present, ice_sort_present, win_present, emoji_present
       ) VALUES (
         ?, 'active', ?, ?, ?, 1, 1,
         0, 0, 0, 0, 0, 0, 0, 0, 0, 0
       )`,
    )
    .run(
      "profile-1",
      '{"id":"profile-1"}',
      "1",
      '{"futureField":{"preserved":true}}',
    );
}

function insertProfileParents(database: DatabaseSync): void {
  insertLegacyProfile(database);
  insertCanonicalProfile(database);
}

function insertLegacyMapping(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO profile_logins_v2 (
         login_uid, profile_id, projection_schema_version
       ) VALUES (?, ?, 1)`,
    )
    .run("login-1", "profile-1");
}

function insertCanonicalMapping(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO profile_login_owners (
         login_uid, profile_id, created_at_ms, updated_at_ms
       ) VALUES (?, ?, 1, 1)`,
    )
    .run("login-1", "profile-1");
}

function applyRetirement(database: DatabaseSync): void {
  database.exec(migrationSql(retirementMigration));
}

test("retires legacy profile tables after all guards pass", () => {
  const database = legacyDatabase();
  try {
    insertProfileParents(database);
    insertLegacyMapping(database);
    insertCanonicalMapping(database);
    finalizeControl(database, "frozen");

    applyRetirement(database);

    const remainingLegacyTables = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table'
           AND name IN (
             'profiles', 'profile_logins', 'profile_logins_v2',
             'profile_projection_failures'
           )`,
      )
      .all();
    assert.deepEqual(remainingLegacyTables, []);
    assert.equal(
      database
        .prepare(
          "SELECT legacy_fields_json FROM profile_records WHERE profile_id = ?",
        )
        .get("profile-1")?.legacy_fields_json,
      '{"futureField":{"preserved":true}}',
    );
    assert.equal(
      database
        .prepare(
          "SELECT state FROM profile_canonical_control WHERE singleton = 1",
        )
        .get()?.state,
      "frozen",
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("blocks retirement until canonical import finalization", () => {
  for (const importing of [false, true]) {
    const database = legacyDatabase();
    try {
      if (importing) {
        database.exec(
          `UPDATE profile_canonical_control
           SET state = 'importing'
           WHERE singleton = 1 AND state = 'firestore'`,
        );
      }
      assert.throws(() => applyRetirement(database), /CHECK constraint failed/);
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_schema
             WHERE type = 'table'
               AND name IN (
                 'profiles', 'profile_logins', 'profile_logins_v2',
                 'profile_projection_failures'
               )`,
          )
          .get()?.count,
        4,
      );
    } finally {
      database.close();
    }
  }
});

test("blocks retirement while canonical writes are active", () => {
  const database = legacyDatabase();
  try {
    insertProfileParents(database);
    finalizeControl(database, "active");
    assert.throws(() => applyRetirement(database), /CHECK constraint failed/);
  } finally {
    database.close();
  }
});

test("blocks retirement for login-owner drift in either direction", () => {
  for (const mapping of ["legacy-only", "canonical-only"] as const) {
    const database = legacyDatabase();
    try {
      insertProfileParents(database);
      if (mapping === "legacy-only") insertLegacyMapping(database);
      if (mapping === "canonical-only") insertCanonicalMapping(database);
      finalizeControl(database, "frozen");
      assert.throws(() => applyRetirement(database), /CHECK constraint failed/);
    } finally {
      database.close();
    }
  }
});

test("blocks retirement for active profile-key drift in either direction", () => {
  for (const mapping of ["legacy-only", "canonical-only"] as const) {
    const database = legacyDatabase();
    try {
      if (mapping === "legacy-only") insertLegacyProfile(database);
      if (mapping === "canonical-only") insertCanonicalProfile(database);
      finalizeControl(database, "frozen");
      assert.throws(() => applyRetirement(database), /CHECK constraint failed/);
    } finally {
      database.close();
    }
  }
});

test("ignores retired legacy tombstones when comparing profile keys", () => {
  const database = legacyDatabase();
  try {
    insertLegacyProfile(database);
    database
      .prepare("UPDATE profiles SET is_deleted = 1 WHERE profile_id = ?")
      .run("profile-1");
    finalizeControl(database, "frozen");
    assert.doesNotThrow(() => applyRetirement(database));
  } finally {
    database.close();
  }
});

test("blocks retirement while projection failures remain", () => {
  const database = legacyDatabase();
  try {
    finalizeControl(database, "frozen");
    database
      .prepare(
        `INSERT INTO profile_projection_failures (
           profile_id, source_update_seconds, source_update_nanos,
           recorded_at_ms
         ) VALUES (?, 1, 0, 1)`,
      )
      .run("profile-1");
    assert.throws(() => applyRetirement(database), /CHECK constraint failed/);
  } finally {
    database.close();
  }
});
