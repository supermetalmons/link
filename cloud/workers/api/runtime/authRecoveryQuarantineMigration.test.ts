import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const migrations = (env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] })
  .TEST_PROFILE_D1_MIGRATIONS;
const migrationIndex = migrations.findIndex(
  ({ name }) => name === "0017_auth_recovery_quarantine.sql",
);

async function insertJob(
  db: D1Database,
  profileId: string,
  revision: number | string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO profile_records (
          profile_id, state, payload_json, created_at_ms, updated_at_ms,
          rating_sort_present, mana_points_sort_present, nonce_sort_present,
          dust_sort_present, slime_sort_present, gum_sort_present,
          metal_sort_present, ice_sort_present, win_present, emoji_present
        ) VALUES (?, 'active', '{}', 100, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
      )
      .bind(profileId),
    db
      .prepare(
        `INSERT INTO profile_auth_recovery_jobs (
          profile_id, login_uids_json, source_profile_ids_json, source_phase,
          prize_cursor, phase_started_at_ms, last_enqueued_at_ms,
          created_at_ms, updated_at_ms, revision
        ) VALUES (?, '[17]', '["source-id"]', 'games', 'saved-cursor',
          150, 175, 100, 200, ?)`,
      )
      .bind(profileId, revision),
  ]);
}

describe("auth recovery quarantine migration", () => {
  const db = env.PROFILE_DB;

  beforeAll(async () => {
    expect(migrationIndex).toBeGreaterThan(0);
    await applyRetiredProfileMigrations(
      db,
      migrations.slice(0, migrationIndex),
      "a".repeat(64),
    );
  });

  it("requires frozen canonical writes and preserves recovery jobs without backfilling", async () => {
    await insertJob(db, "retained-job", 7);
    await insertJob(db, "   ", "invalid-revision");
    const before = await db
      .prepare("SELECT * FROM profile_auth_recovery_jobs ORDER BY profile_id")
      .all();

    await expect(
      applyD1Migrations(db, [migrations[migrationIndex]]),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'profile_auth_recovery_quarantine'",
        )
        .first(),
    ).toBeNull();
    expect(
      await db
        .prepare("SELECT name FROM d1_migrations WHERE name = ?")
        .bind(migrations[migrationIndex].name)
        .first(),
    ).toBeNull();

    await db
      .prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    await applyD1Migrations(db, [migrations[migrationIndex]]);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM profile_auth_recovery_jobs ORDER BY profile_id",
          )
          .all()
      ).results,
    ).toEqual(before.results);
    expect(
      (await db.prepare("SELECT * FROM profile_auth_recovery_quarantine").all())
        .results,
    ).toEqual([]);
    expect(
      await db
        .prepare(
          "SELECT state FROM profile_canonical_control WHERE singleton = 1",
        )
        .first("state"),
    ).toBe("frozen");
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
});

describe("auth recovery quarantine schema", () => {
  const db = env.AUTH_STATE_DB;

  beforeAll(async () => {
    await applyRetiredProfileMigrations(db, migrations, "b".repeat(64));
  });

  it("retains raw keys and invalid revision tokens, and removes markers with their jobs", async () => {
    const profileId = " \t ";
    await insertJob(db, profileId, "invalid-revision");
    await db
      .prepare(
        `INSERT INTO profile_auth_recovery_quarantine (
          profile_id, revision_token, reason, quarantined_at_ms
        ) SELECT profile_id, CAST(revision AS TEXT), 'invalid-profile-id', 0
          FROM profile_auth_recovery_jobs WHERE profile_id = ?`,
      )
      .bind(profileId)
      .run();
    expect(
      await db
        .prepare("SELECT * FROM profile_auth_recovery_quarantine")
        .first(),
    ).toEqual({
      profile_id: profileId,
      revision_token: "invalid-revision",
      reason: "invalid-profile-id",
      quarantined_at_ms: 0,
    });
    await expect(
      db
        .prepare(
          `INSERT INTO profile_auth_recovery_quarantine
            (profile_id, revision_token, reason, quarantined_at_ms)
           VALUES ('missing-job', '1', 'invalid-record', 1)`,
        )
        .run(),
    ).rejects.toThrow();
    await db
      .prepare("DELETE FROM profile_auth_recovery_jobs WHERE profile_id = ?")
      .bind(profileId)
      .run();
    expect(
      (await db.prepare("SELECT * FROM profile_auth_recovery_quarantine").all())
        .results,
    ).toEqual([]);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });

  it("rejects unknown reasons and unsafe quarantine timestamps", async () => {
    const profileId = "constraint-job";
    await insertJob(db, profileId, 1);
    const insert = (reason: string, timestamp: number) =>
      db
        .prepare(
          `INSERT INTO profile_auth_recovery_quarantine
            (profile_id, revision_token, reason, quarantined_at_ms)
           VALUES (?, '1', ?, ?)`,
        )
        .bind(profileId, reason, timestamp)
        .run();
    await expect(insert("unknown", 1)).rejects.toThrow();
    for (const timestamp of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(insert("invalid-record", timestamp)).rejects.toThrow();
    }
    await expect(
      insert("invalid-record", Number.MAX_SAFE_INTEGER),
    ).resolves.toMatchObject({ success: true });
  });
});
