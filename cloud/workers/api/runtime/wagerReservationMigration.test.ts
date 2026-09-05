import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_DB;
const finalizationIndex = testEnv.TEST_PROFILE_D1_MIGRATIONS.findIndex(
  (migration) => migration.name === "0014_finalize_wager_reservations.sql",
);
const finalize = () =>
  applyD1Migrations(db, [
    testEnv.TEST_PROFILE_D1_MIGRATIONS[finalizationIndex],
  ]);

describe("wager reservation schema finalization", () => {
  beforeAll(async () => {
    expect(finalizationIndex).toBeGreaterThan(0);
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS.slice(0, finalizationIndex),
      "a".repeat(64),
    );
  });

  it("requires activated frozen D1 and drained admissions, then preserves balances and replay records", async () => {
    await expect(finalize()).rejects.toThrow();
    await db.batch([
      db.prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen', previous_storage_mode = 'firebase', freeze_generation = 1 WHERE singleton = 1",
      ),
    ]);
    await expect(finalize()).rejects.toThrow();
    await db.batch([
      db.prepare(
        "UPDATE wager_reservation_runtime_control SET import_attempt_id = 'finalization-test', import_started_at_ms = 1000000 WHERE singleton = 1",
      ),
      db.prepare(`UPDATE wager_reservation_runtime_control
        SET verified_import_generation = 1, import_attempt_id = NULL, import_started_at_ms = NULL,
            source_digest = '${"a".repeat(64)}', source_balance_count = 0, source_operation_count = 0,
            source_first_exported_at_ms = 1000000, source_exported_at_ms = 2000000,
            queues_paused_at_ms = 1000000, bridge_deployed_at_ms = 900000, bridge_version_id = 'test'
        WHERE singleton = 1`),
      db.prepare(
        "UPDATE wager_reservation_runtime_control SET storage_mode = 'd1', previous_storage_mode = NULL, activated_at_ms = 2000000 WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
      ),
      db.prepare(
        "INSERT INTO wager_reservation_write_admissions (admission_id, storage_mode, freeze_generation, kind, created_at_ms, expires_at_ms, uncertain) VALUES ('pending', 'd1', 1, 'settlement', 1, 2, 1)",
      ),
      db.prepare(
        "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen', previous_storage_mode = 'd1', freeze_generation = 2, verified_import_generation = NULL WHERE singleton = 1",
      ),
    ]);
    await expect(finalize()).rejects.toThrow();
    await db
      .prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    await expect(finalize()).rejects.toThrow();
    await db
      .prepare(
        "DELETE FROM wager_reservation_write_admissions WHERE admission_id = 'pending'",
      )
      .run();
    const frozenJson = JSON.stringify({
      dust: 3,
      slime: 0,
      gum: 0,
      metal: 0,
      ice: 0,
    });
    const operationJson = JSON.stringify({
      appliedAtMs: 10,
      count: 3,
      deltas: { dust: 3 },
      fingerprint: "send-reserve|dust|3",
    });
    await db.batch([
      db
        .prepare(
          "INSERT INTO wager_frozen_balances (player_uid, frozen_json, revision, updated_at_ms) VALUES ('retained-uid', ?, 7, 10)",
        )
        .bind(frozenJson),
      db
        .prepare(
          "INSERT INTO wager_frozen_operations (player_uid, operation_id, record_json) VALUES ('retained-uid', 'active', ?)",
        )
        .bind(operationJson),
      db.prepare(
        "INSERT INTO wager_frozen_operations (player_uid, operation_id, record_json) VALUES ('retained-uid', 'consumed', '{\"consumed\":true}')",
      ),
    ]);
    await finalize();
    expect(
      await db
        .prepare("SELECT * FROM wager_reservation_runtime_control")
        .first(),
    ).toEqual({
      singleton: 1,
      storage_mode: "frozen",
      freeze_generation: 2,
      updated_at_ms: 0,
    });
    expect(
      await db.prepare("SELECT * FROM wager_frozen_balances").first(),
    ).toEqual({
      player_uid: "retained-uid",
      frozen_json: frozenJson,
      revision: 7,
      updated_at_ms: 10,
    });
    expect(
      (
        await db
          .prepare(
            "SELECT operation_id, record_json FROM wager_frozen_operations ORDER BY operation_id",
          )
          .all()
      ).results,
    ).toEqual([
      { operation_id: "active", record_json: operationJson },
      { operation_id: "consumed", record_json: '{"consumed":true}' },
    ]);
    const columns = (
      await db
        .prepare("PRAGMA table_info(wager_reservation_write_admissions)")
        .all<{ name: string }>()
    ).results.map((row) => row.name);
    expect(columns).not.toContain("storage_mode");
    const triggers = (
      await db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'wager_reservation_%'",
        )
        .all<{ name: string }>()
    ).results.map((row) => row.name);
    expect(triggers.sort()).toEqual([
      "wager_reservation_admission_gate",
      "wager_reservation_control_drain",
      "wager_reservation_control_freeze",
      "wager_reservation_control_generation",
      "wager_reservation_control_no_delete",
      "wager_reservation_control_no_replace",
    ]);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
});
