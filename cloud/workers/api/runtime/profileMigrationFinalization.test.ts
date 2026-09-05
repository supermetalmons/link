import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const migrations = (env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] })
  .TEST_PROFILE_D1_MIGRATIONS;
const finalizationIndex = migrations.findIndex(
  ({ name }) => name === "0015_finalize_profile_migrations.sql",
);
const legacyRatingCompletions = [{ inviteId: "historical", matchId: "match" }];

async function count(db: D1Database, table: string): Promise<number> {
  return Number(
    await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count"),
  );
}

describe("profile migration finalization", () => {
  it("preserves imported completions and produces the current schema from the complete migration chain", async () => {
    await applyRetiredProfileMigrations(
      env.PROFILE_DB,
      migrations,
      "a".repeat(64),
      {
        legacyRatingCompletions,
      },
    );
    expect(await count(env.PROFILE_DB, "legacy_rating_completions")).toBe(1);
    const removed = await env.PROFILE_DB.prepare(
      `SELECT name FROM sqlite_schema WHERE name IN (
        'profile_link_catchup_import', 'profile_link_catchup_import_guards',
        'rating_completion_control', 'profile_canonical_control_copy'
      )`,
    ).all();
    expect(removed.results).toEqual([]);
    const columns = await env.PROFILE_DB.prepare(
      "PRAGMA table_info(profile_canonical_control)",
    ).all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual([
      "singleton",
      "state",
    ]);
    expect(
      (await env.PROFILE_DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    await expect(
      env.PROFILE_DB.prepare("DELETE FROM profile_canonical_control").run(),
    ).rejects.toThrow();
    await expect(
      env.PROFILE_DB.prepare("DELETE FROM legacy_rating_completions").run(),
    ).rejects.toThrow();
    await expect(
      env.PROFILE_DB.prepare(
        "UPDATE profile_canonical_control SET state = 'firestore'",
      ).run(),
    ).rejects.toThrow();
  });

  it("rejects unfinished rating imports without dropping their control or data", async () => {
    await expect(
      applyRetiredProfileMigrations(
        env.AUTH_STATE_DB,
        migrations,
        "b".repeat(64),
        {
          activateRatingCompletions: false,
        },
      ),
    ).rejects.toThrow();
    expect(await count(env.AUTH_STATE_DB, "rating_completion_control")).toBe(1);
    expect(
      await env.AUTH_STATE_DB.prepare(
        "SELECT activated_at_ms FROM rating_completion_control WHERE singleton = 1",
      ).first("activated_at_ms"),
    ).toBeNull();
    expect(await count(env.AUTH_STATE_DB, "profile_link_catchup_import")).toBe(
      1,
    );
  });

  it("requires maintenance and verified catch-up completion before removing migration bookkeeping", async () => {
    expect(finalizationIndex).toBeGreaterThan(0);
    const db = env.PROFILE_GAMES_DB;
    await applyRetiredProfileMigrations(
      db,
      migrations.slice(0, finalizationIndex),
      "c".repeat(64),
      {
        legacyRatingCompletions,
      },
    );
    await expect(
      applyD1Migrations(db, migrations.slice(finalizationIndex)),
    ).rejects.toThrow();
    await db.batch([
      db.prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE profile_link_catchup_import SET activated_at_ms = NULL WHERE singleton = 1",
      ),
    ]);
    await expect(
      applyD1Migrations(db, migrations.slice(finalizationIndex)),
    ).rejects.toThrow();
    expect(await count(db, "legacy_rating_completions")).toBe(1);
    await db
      .prepare(
        "UPDATE profile_link_catchup_import SET activated_at_ms = 1 WHERE singleton = 1",
      )
      .run();
    await applyD1Migrations(db, migrations.slice(finalizationIndex));
    expect(await count(db, "legacy_rating_completions")).toBe(1);
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
