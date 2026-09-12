import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { D1_MIGRATION_BINDINGS } from "../src/d1MigrationControl.ts";
import {
  D1_MIGRATION_FENCE_PREFIX,
  fenceD1MigrationSource,
  readD1MigrationStatus,
  verifyD1MigrationDatabase,
} from "../src/d1MigrationDatabase.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";

const runId = "migration-test";
const testEnv = env as Env & {
  TEST_AUTH_STATE_D1_MIGRATIONS: D1Migration[];
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_TELEGRAM_D1_MIGRATIONS: D1Migration[];
};

beforeAll(async () => {
  await Promise.all([
    applyD1Migrations(env.AUTH_STATE_DB, testEnv.TEST_AUTH_STATE_D1_MIGRATIONS),
    applyD1Migrations(env.TELEGRAM_DB, testEnv.TEST_TELEGRAM_D1_MIGRATIONS),
    applyD1Migrations(
      env.EVENT_PRIZE_WITHDRAWALS_DB,
      testEnv.TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS,
    ),
    applyStrictMatchStateTestMigrations(
      env.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    ),
    applyRetiredProfileMigrations(
      env.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    ),
    applyEventTestMigrations(env.EVENT_DB, testEnv.TEST_EVENT_D1_MIGRATIONS),
  ]);
  await env.PROFILE_DB.batch([
    env.PROFILE_DB.prepare(
      "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
    ),
    env.PROFILE_DB.prepare(
      "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
    ),
  ]);
  await env.PROFILE_GAMES_DB.batch([
    env.PROFILE_GAMES_DB.prepare(
      "UPDATE automatch_runtime_control SET backend = 'd1', state = 'frozen' WHERE singleton = 1",
    ),
    env.PROFILE_GAMES_DB.prepare(
      "UPDATE invite_source_control SET backend = 'd1', epoch = 1, verified_at_ms = 2, activated_at_ms = 3 WHERE singleton = 1",
    ),
  ]);
  await env.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
    "UPDATE event_prize_withdrawal_runtime_control SET storage_mode = 'frozen', previous_storage_mode = 'd1' WHERE singleton = 1",
  ).run();
  await transitionEventStorageMode(env.EVENT_DB, {
    expected: { storageMode: "d1" },
    next: { storageMode: "frozen" },
    nowMs: 7,
  });
  await env.AUTH_STATE_DB.batch([
    env.AUTH_STATE_DB.prepare(
      "CREATE TABLE migration_probe (id INTEGER PRIMARY KEY, value TEXT, bytes BLOB)",
    ),
    env.AUTH_STATE_DB.prepare(
      "INSERT INTO migration_probe VALUES (1, 'original', X'00FF')",
    ),
  ]);
});

afterEach(async () => {
  for (const binding of D1_MIGRATION_BINDINGS) {
    const db = env[binding];
    const triggers = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, ?) = ?",
      )
      .bind(D1_MIGRATION_FENCE_PREFIX.length, D1_MIGRATION_FENCE_PREFIX)
      .all<{ name: string }>();
    if (triggers.results.length)
      await db.batch(
        triggers.results.map(({ name }) =>
          db.prepare(`DROP TRIGGER "${name.replaceAll('"', '""')}"`),
        ),
      );
  }
  await env.AUTH_STATE_DB.prepare("DROP TABLE IF EXISTS drift_probe").run();
  await env.PROFILE_GAMES_DB.prepare(
    "DELETE FROM profile_game_projection_locks WHERE resource_id IN ('migration-race', 'migration-expired')",
  ).run();
});

describe("D1 relocation source fences", () => {
  it("validates and fences all six real schemas without changing their schema identity", async () => {
    for (const binding of D1_MIGRATION_BINDINGS) {
      const before = await readD1MigrationStatus(env[binding], binding, runId);
      expect(before.drained, binding).toBe(true);
      expect(before.tables, binding).toContain("d1_migrations");
      expect(before.fence.installedTriggers).toBe(0);
      const fenced = await fenceD1MigrationSource(
        env[binding],
        binding,
        runId,
        before.schemaDigest,
      );
      expect(fenced.schemaDigest).toBe(before.schemaDigest);
      expect(fenced.schema).toEqual(before.schema);
      expect(fenced.fence.complete, binding).toBe(true);
      expect(fenced.fence.installedTriggers).toBe(before.tables.length * 3);
      await expect(
        env[binding].prepare("UPDATE d1_migrations SET name = name").run(),
      ).rejects.toThrow("d1-migration-source-frozen");
      expect(
        (await verifyD1MigrationDatabase(env[binding], binding)).valid,
      ).toBe(true);
    }
  });

  it("rejects inserts, updates, deletes and replacements while retaining exact bytes", async () => {
    const db = env.AUTH_STATE_DB;
    const before = await readD1MigrationStatus(db, "AUTH_STATE_DB", runId);
    await fenceD1MigrationSource(
      db,
      "AUTH_STATE_DB",
      runId,
      before.schemaDigest,
    );
    for (const sql of [
      "INSERT INTO migration_probe VALUES (2, 'new', NULL)",
      "UPDATE migration_probe SET value = 'changed' WHERE id = 1",
      "DELETE FROM migration_probe WHERE id = 1",
      "INSERT OR REPLACE INTO migration_probe VALUES (1, 'replacement', NULL)",
    ])
      await expect(db.prepare(sql).run()).rejects.toThrow(
        "d1-migration-source-frozen",
      );
    expect(
      await db
        .prepare("SELECT id, value, hex(bytes) AS bytes FROM migration_probe")
        .all(),
    ).toMatchObject({
      results: [{ id: 1, value: "original", bytes: "00FF" }],
    });
    expect(
      (
        await fenceD1MigrationSource(
          db,
          "AUTH_STATE_DB",
          runId,
          before.schemaDigest,
        )
      ).fence.complete,
    ).toBe(true);
    await expect(
      readD1MigrationStatus(db, "AUTH_STATE_DB", "different-run"),
    ).rejects.toThrow("d1-migration-fence-conflict");
  });

  it("refuses schema drift before installing any source fence", async () => {
    const db = env.AUTH_STATE_DB;
    const before = await readD1MigrationStatus(db, "AUTH_STATE_DB", runId);
    await db.prepare("CREATE TABLE drift_probe (id INTEGER)").run();
    await expect(
      fenceD1MigrationSource(db, "AUTH_STATE_DB", runId, before.schemaDigest),
    ).rejects.toThrow("d1-migration-schema-conflict");
    expect(
      (await readD1MigrationStatus(db, "AUTH_STATE_DB", runId)).fence
        .installedTriggers,
    ).toBe(0);
  });

  it("rolls the whole fence back when a lease appears after preflight", async () => {
    const db = env.PROFILE_GAMES_DB;
    const before = await readD1MigrationStatus(db, "PROFILE_GAMES_DB", runId);
    const racing = new Proxy(db, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await db
              .prepare(
                "INSERT INTO profile_game_projection_locks VALUES ('invite', 'migration-race', 'writer', NULL, ?)",
              )
              .bind(Date.now() + 60_000)
              .run();
            return db.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      fenceD1MigrationSource(
        racing,
        "PROFILE_GAMES_DB",
        runId,
        before.schemaDigest,
      ),
    ).rejects.toThrow("CHECK constraint failed");
    const after = await readD1MigrationStatus(db, "PROFILE_GAMES_DB", runId);
    expect(after.fence.installedTriggers).toBe(0);
    expect(after.drained).toBe(false);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'd1_migration_guard_%'",
        )
        .first("count"),
    ).toBe(0);
  });

  it("retains expired leases while fencing new writes", async () => {
    const db = env.PROFILE_GAMES_DB;
    await db
      .prepare(
        "INSERT INTO profile_game_projection_locks VALUES ('invite', 'migration-expired', 'writer', NULL, 1)",
      )
      .run();
    const before = await readD1MigrationStatus(db, "PROFILE_GAMES_DB", runId);
    expect(before.drained).toBe(true);
    await fenceD1MigrationSource(
      db,
      "PROFILE_GAMES_DB",
      runId,
      before.schemaDigest,
    );
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM profile_game_projection_locks WHERE resource_id = 'migration-expired'",
        )
        .first("count"),
    ).toBe(1);
  });

  it("rejects a partial or altered fence instead of adopting it", async () => {
    const db = env.AUTH_STATE_DB;
    await db
      .prepare(
        `CREATE TRIGGER ${D1_MIGRATION_FENCE_PREFIX}unexpected BEFORE INSERT ON migration_probe BEGIN SELECT 1; END`,
      )
      .run();
    await expect(
      readD1MigrationStatus(db, "AUTH_STATE_DB", runId),
    ).rejects.toThrow("d1-migration-fence-conflict");
  });

  it("reports native session bookmarks and provided-token failures without writing", async () => {
    const db = env.AUTH_STATE_DB;
    const normal = await verifyD1MigrationDatabase(db, "AUTH_STATE_DB");
    expect(normal.bookmarkAccepted).toBe(true);
    expect(normal.migrationCount).toBeGreaterThan(0);
    expect(
      normal.bookmark === null || typeof normal.bookmark === "string",
    ).toBe(true);
    const rejecting = new Proxy(db, {
      get(target, property) {
        if (property === "withSession")
          return () => {
            throw new Error("native session rejected foreign-token");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const rejected = await verifyD1MigrationDatabase(
      rejecting,
      "AUTH_STATE_DB",
      "foreign-token",
    );
    expect(rejected).toMatchObject({
      valid: false,
      bookmarkAccepted: false,
      bookmark: null,
      migrationCount: null,
      bookmarkError: "native session rejected [bookmark]",
    });
    expect(rejected.foreignKeyViolations).toBe(0);
  });
});
