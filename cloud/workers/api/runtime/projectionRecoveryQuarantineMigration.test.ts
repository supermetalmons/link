import {
  applyPreCleanupTestMigrations,
  preCleanupTestMigrations,
} from "./canonicalTestMigrations.ts";
import { requiredFixture } from "../test/requiredFixture.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const migrations = preCleanupTestMigrations(
  (env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] })
    .TEST_PROFILE_D1_MIGRATIONS,
);
const migrationIndex = migrations.findIndex(
  ({ name }) => name === "0019_projection_recovery_quarantine.sql",
);

async function insertSources(db: D1Database, suffix = "") {
  await db.batch([
    db
      .prepare(
        `INSERT INTO profile_link_catchup_jobs (
      login_uid, request_id, profile_id, cleanup_profile_ids_json, match_cursor,
      source_updated_at_ms, last_queued_at_ms, revision
    ) VALUES (?, 'request', 'profile', '[1]', 'saved-cursor', 100, 100, 'invalid')`,
      )
      .bind(`login${suffix}`),
    db
      .prepare(
        `INSERT INTO rating_updates (
      operation_id, payload_json, status, invite_id, match_id, player_id,
      opponent_id, owner_uid, owner_token, started_at_ms, updated_at_ms,
      lease_expires_at_ms, completed_at_ms, revision
    ) VALUES (?, '{"retained":"evidence"}', 'done', 'invite', 'match',
      'player', 'opponent', 'owner', 'token', 100, 100, 100, 100, 'invalid')`,
      )
      .bind(`operation${suffix}`),
  ]);
}

async function sourceRows(db: D1Database) {
  return (
    await db.batch([
      db.prepare("SELECT * FROM profile_link_catchup_jobs"),
      db.prepare("SELECT * FROM rating_updates"),
    ])
  ).map((result) => result.results);
}

describe("additive projection recovery quarantine migration", () => {
  const db = env.PROFILE_DB;

  beforeAll(async () => {
    expect(migrationIndex).toBeGreaterThan(0);
    await applyRetiredProfileMigrations(
      db,
      migrations.slice(0, migrationIndex),
      "a".repeat(64),
    );
  });

  it("applies with active writers without backfills or existing-schema changes", async () => {
    await insertSources(db);
    const before = await sourceRows(db);
    const schemaBefore = (
      await db
        .prepare(
          "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
    ).results;
    await applyPreCleanupTestMigrations(db, [
      requiredFixture(migrations[migrationIndex]),
    ]);
    expect(await sourceRows(db)).toEqual(before);
    expect(
      await db
        .prepare("SELECT state FROM profile_canonical_control")
        .first("state"),
    ).toBe("active");
    expect(
      (await db.prepare("SELECT * FROM profile_link_catchup_quarantine").all())
        .results,
    ).toEqual([]);
    expect(
      (
        await db
          .prepare("SELECT * FROM rating_projection_recovery_quarantine")
          .all()
      ).results,
    ).toEqual([]);
    const existingNames = schemaBefore.map((row) => row.name);
    expect(
      (
        await db
          .prepare(
            "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
      ).results.filter((row) => existingNames.includes(row.name)),
    ).toEqual(schemaBefore);
    await db.batch([
      db.prepare(
        "UPDATE profile_link_catchup_jobs SET revision = 2, match_cursor = 'next-cursor' WHERE login_uid = 'login'",
      ),
      db.prepare(
        "UPDATE rating_updates SET revision = 2, payload_json = '{\"retained\":\"updated\"}' WHERE operation_id = 'operation'",
      ),
    ]);
    expect(
      await db
        .prepare("SELECT match_cursor FROM profile_link_catchup_jobs")
        .first("match_cursor"),
    ).toBe("next-cursor");
    await insertSources(db, "-old-writer");
    expect(await sourceRows(db)).toEqual([
      expect.arrayContaining([
        expect.objectContaining({ login_uid: "login-old-writer" }),
      ]),
      expect.arrayContaining([
        expect.objectContaining({ operation_id: "operation-old-writer" }),
      ]),
    ]);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });

  it("preserves a pre-existing freeze", async () => {
    const frozenDb = env.PROFILE_GAMES_DB;
    await applyRetiredProfileMigrations(
      frozenDb,
      migrations.slice(0, migrationIndex),
      "c".repeat(64),
    );
    expect(
      await frozenDb
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'profile_link_catchup_quarantine'",
        )
        .first(),
    ).toBeNull();
    await frozenDb
      .prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    await applyPreCleanupTestMigrations(frozenDb, [
      requiredFixture(migrations[migrationIndex]),
    ]);
    expect(
      await frozenDb
        .prepare("SELECT state FROM profile_canonical_control")
        .first("state"),
    ).toBe("frozen");
    expect(
      (
        await frozenDb
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('profile_link_catchup_quarantine', 'rating_projection_recovery_quarantine')",
          )
          .all()
      ).results,
    ).toHaveLength(2);
  });
});

describe("projection recovery quarantine schema", () => {
  const db = env.AUTH_STATE_DB;

  beforeAll(async () => {
    await applyRetiredProfileMigrations(db, migrations, "b".repeat(64));
  });

  it("constrains markers, retains invalid revision tokens, and cascades source deletion", async () => {
    await insertSources(db);
    const profile = (reason: string, nowMs: number, login = "login") =>
      db
        .prepare(
          `INSERT INTO profile_link_catchup_quarantine
       (login_uid, revision_token, reason, quarantined_at_ms) VALUES (?, 'invalid', ?, ?)`,
        )
        .bind(login, reason, nowMs)
        .run();
    const rating = (
      reason: string,
      projection: string,
      nowMs: number,
      operation = "operation",
    ) =>
      db
        .prepare(
          `INSERT INTO rating_projection_recovery_quarantine
       (operation_id, projection_kind, revision_token, reason, quarantined_at_ms)
       VALUES (?, ?, 'invalid', ?, ?)`,
        )
        .bind(operation, projection, reason, nowMs)
        .run();
    await expect(profile("invalid-record", 0, "missing")).rejects.toThrow();
    await expect(
      rating("invalid-record", "telegram", 0, "missing"),
    ).rejects.toThrow();
    await expect(profile("unknown", 0)).rejects.toThrow();
    await expect(rating("unknown", "telegram", 0)).rejects.toThrow();
    await expect(rating("invalid-record", "unknown", 0)).rejects.toThrow();
    for (const time of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(profile("invalid-record", time)).rejects.toThrow();
      await expect(
        rating("invalid-record", "telegram", time),
      ).rejects.toThrow();
    }
    await profile("invalid-record", Number.MAX_SAFE_INTEGER);
    for (const projection of ["telegram", "event-progress", "profile-game"]) {
      await rating("invalid-record", projection, 0);
    }
    expect(
      (
        await db
          .prepare("SELECT revision_token FROM profile_link_catchup_quarantine")
          .all()
      ).results,
    ).toEqual([{ revision_token: "invalid" }]);
    expect(
      (
        await db
          .prepare("SELECT * FROM rating_projection_recovery_quarantine")
          .all()
      ).results,
    ).toHaveLength(3);
    await db.batch([
      db.prepare("DELETE FROM profile_link_catchup_jobs"),
      db.prepare("DELETE FROM rating_updates"),
    ]);
    expect(
      (await db.prepare("SELECT * FROM profile_link_catchup_quarantine").all())
        .results,
    ).toEqual([]);
    expect(
      (
        await db
          .prepare("SELECT * FROM rating_projection_recovery_quarantine")
          .all()
      ).results,
    ).toEqual([]);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    await insertSources(db);
    expect(
      (await db.prepare("SELECT * FROM profile_link_catchup_quarantine").all())
        .results,
    ).toEqual([]);
  });
});
