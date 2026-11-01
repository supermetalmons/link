import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { RETIRED_INVITE_IDS } from "../src/retiredInvites.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_TELEGRAM_D1_MIGRATIONS: D1Migration[];
};
const RETIRED = RETIRED_INVITE_IDS[0];
const OTHER = "auto_abcdefghijk";

type GuardCase = { table: string; columns: string[]; values: string[] };

const gameCases: GuardCase[] = [
  {
    table: "game_session_mutation_locks",
    columns: ["lock_id"],
    values: [RETIRED],
  },
  {
    table: "game_session_transitions_canonical",
    columns: ["invite_id", "transition_id"],
    values: [RETIRED, "transition"],
  },
  {
    table: "game_session_transition_resources_canonical",
    columns: ["resource_key", "transition_id"],
    values: [RETIRED, "transition"],
  },
  {
    table: "invite_sources_canonical",
    columns: ["invite_id"],
    values: [RETIRED],
  },
  {
    table: "automatch_entries_canonical",
    columns: ["record_key"],
    values: [RETIRED],
  },
  {
    table: "automatch_live_tickets_canonical",
    columns: ["invite_id"],
    values: [RETIRED],
  },
  {
    table: "automatch_pending_enqueues_canonical",
    columns: ["invite_id", "transition_id"],
    values: [RETIRED, "transition"],
  },
  {
    table: "automatch_telegram_sources_canonical",
    columns: ["record_key"],
    values: [RETIRED],
  },
  {
    table: "automatch_telegram_projection_outbox_canonical",
    columns: ["record_key"],
    values: [RETIRED],
  },
  {
    table: "game_session_projection_outbox_canonical",
    columns: ["record_key"],
    values: [RETIRED],
  },
  {
    table: "game_session_mutation_receipts_canonical",
    columns: ["payload_json"],
    values: [JSON.stringify({ inviteId: RETIRED })],
  },
  {
    table: "profile_game_projection_locks",
    columns: ["scope", "resource_id"],
    values: ["invite", RETIRED],
  },
  {
    table: "profile_game_projections_canonical",
    columns: ["entity_type", "projection_id"],
    values: ["game", RETIRED],
  },
  {
    table: "historical_match_pairs_canonical",
    columns: ["invite_id", "match_id"],
    values: [RETIRED, RETIRED],
  },
  {
    table: "login_match_discovery_canonical",
    columns: ["invite_id", "match_id"],
    values: [RETIRED, RETIRED],
  },
  {
    table: "match_presentation_registrations_canonical",
    columns: ["invite_id", "match_id"],
    values: [RETIRED, RETIRED],
  },
  {
    table: "match_state_routes_canonical",
    columns: ["invite_id", "match_id"],
    values: [RETIRED, RETIRED],
  },
];
const profileCases: GuardCase[] = [
  {
    table: "invite_wager_states_canonical",
    columns: ["invite_id", "match_id"],
    values: [RETIRED, RETIRED],
  },
  {
    table: "rating_updates_canonical",
    columns: ["invite_id", "match_id"],
    values: [RETIRED, RETIRED],
  },
  {
    table: "rating_completions_canonical",
    columns: ["invite_id", "match_id"],
    values: [RETIRED, RETIRED],
  },
];
const telegramCases: GuardCase[] = [
  {
    table: "telegram_messages_canonical",
    columns: ["message_key"],
    values: [`automatch:${RETIRED}`],
  },
];
const groups = [
  {
    db: env.AUTH_STATE_DB,
    cases: gameCases,
    migrations: testEnv.TEST_D1_MIGRATIONS,
    name: "0041_retired_invites.sql",
  },
  {
    db: env.EVENT_DB,
    cases: profileCases,
    migrations: testEnv.TEST_PROFILE_D1_MIGRATIONS,
    name: "0025_retired_invites.sql",
  },
  {
    db: env.EVENT_PRIZE_WITHDRAWALS_DB,
    cases: telegramCases,
    migrations: testEnv.TEST_TELEGRAM_D1_MIGRATIONS,
    name: "0009_retired_invites.sql",
  },
];

function statement(
  db: D1Database,
  item: GuardCase,
  id: string,
  values = item.values,
) {
  return db
    .prepare(
      `INSERT INTO ${item.table} (id, ${item.columns.join(", ")}) VALUES (?, ${item.columns.map(() => "?").join(", ")})`,
    )
    .bind(id, ...values);
}

function ordinary(values: string[]): string[] {
  return values.map((value) => value.replaceAll(RETIRED, OTHER));
}

describe("retired invite native storage guards", () => {
  beforeAll(async () => {
    for (const group of groups) {
      await group.db
        .prepare(
          "CREATE TABLE application_data_control (singleton INTEGER PRIMARY KEY, generation INTEGER, data_epoch INTEGER, phase TEXT)",
        )
        .run();
      await group.db
        .prepare(
          "INSERT INTO application_data_control VALUES (1, 2, 0, 'closed')",
        )
        .run();
      for (const item of group.cases) {
        await group.db
          .prepare(
            `CREATE TABLE ${item.table} (id TEXT PRIMARY KEY, ${item.columns.map((column) => `${column} TEXT`).join(", ")})`,
          )
          .run();
      }
      const migration = group.migrations.find(
        ({ name }) => name === group.name,
      );
      if (!migration) throw new Error("retired-invite-test-migration-missing");
      for (const control of [
        [2, 1, "active"],
        [3, 0, "active"],
        [3, 1, "closing"],
      ]) {
        await group.db
          .prepare(
            "UPDATE application_data_control SET generation = ?, data_epoch = ?, phase = ? WHERE singleton = 1",
          )
          .bind(...control)
          .run();
        await expect(applyD1Migrations(group.db, [migration])).rejects.toThrow(
          "retired-invite-control-changed",
        );
        expect(
          await group.db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name = 'retired_invites'",
            )
            .first(),
        ).toBeNull();
      }
      await group.db
        .prepare(
          "UPDATE application_data_control SET generation = 3, data_epoch = 1, phase = 'active' WHERE singleton = 1",
        )
        .run();
      const first = group.cases[0]!;
      await statement(group.db, first, "existing-dependency").run();
      await expect(applyD1Migrations(group.db, [migration])).rejects.toThrow(
        "retired-invite-has-dependencies",
      );
      expect(
        await group.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'retired_invites'",
          )
          .first(),
      ).toBeNull();
      expect(
        await group.db
          .prepare(
            `SELECT id FROM ${first.table} WHERE id = 'existing-dependency'`,
          )
          .first(),
      ).not.toBeNull();
      await group.db
        .prepare(`DELETE FROM ${first.table} WHERE id = 'existing-dependency'`)
        .run();
      await applyD1Migrations(group.db, [migration]);
    }
  });

  for (const { db, cases } of groups) {
    for (const item of cases) {
      it(`fences insert, update and upsert for ${item.table} while preserving unrelated rows`, async () => {
        for (const inviteId of RETIRED_INVITE_IDS) {
          const values = item.values.map((value) =>
            value.replaceAll(RETIRED, inviteId),
          );
          await expect(
            statement(db, item, `denied-${inviteId}`, values).run(),
          ).rejects.toThrow("retired-invite-write");
        }
        await statement(db, item, "ordinary", ordinary(item.values)).run();
        const before = await db
          .prepare(`SELECT * FROM ${item.table} WHERE id = 'ordinary'`)
          .first();
        await expect(
          db
            .prepare(
              `UPDATE ${item.table} SET ${item.columns.map((column) => `${column} = ?`).join(", ")} WHERE id = 'ordinary'`,
            )
            .bind(...item.values)
            .run(),
        ).rejects.toThrow("retired-invite-write");
        await expect(
          db
            .prepare(
              `INSERT INTO ${item.table} (id, ${item.columns.join(", ")}) VALUES (?, ${item.columns.map(() => "?").join(", ")}) ON CONFLICT (id) DO UPDATE SET ${item.columns.map((column) => `${column} = excluded.${column}`).join(", ")}`,
            )
            .bind("ordinary", ...item.values)
            .run(),
        ).rejects.toThrow("retired-invite-write");
        expect(
          await db
            .prepare(`SELECT * FROM ${item.table} WHERE id = 'ordinary'`)
            .first(),
        ).toEqual(before);
      });
    }
  }

  it("rejects a held writer and rolls its entire native batch back", async () => {
    const db = env.AUTH_STATE_DB;
    const held = db
      .prepare(
        "INSERT INTO game_session_mutation_locks (id, lock_id) VALUES ('held', ?)",
      )
      .bind(RETIRED);
    await expect(
      db.batch([
        db
          .prepare(
            "INSERT INTO game_session_mutation_locks (id, lock_id) VALUES ('batch-side-effect', ?)",
          )
          .bind(OTHER),
        held,
      ]),
    ).rejects.toThrow("retired-invite-write");
    expect(
      await db
        .prepare(
          "SELECT id FROM game_session_mutation_locks WHERE id IN ('held', 'batch-side-effect')",
        )
        .all(),
    ).toMatchObject({ results: [] });
  });

  it("guards derived canonical rematches without treating adjacent names as those matches", async () => {
    const db = env.AUTH_STATE_DB;
    for (const suffix of ["", "1", "9007199254740991"]) {
      await expect(
        db
          .prepare(
            "INSERT INTO match_state_routes_canonical (id, invite_id, match_id) VALUES (?, NULL, ?)",
          )
          .bind(`retired-${suffix}`, `${RETIRED}${suffix}`)
          .run(),
      ).rejects.toThrow("retired-invite-write");
    }
    for (const suffix of ["x", "01", "9007199254740992", "-1"]) {
      await db
        .prepare(
          "INSERT INTO match_state_routes_canonical (id, invite_id, match_id) VALUES (?, NULL, ?)",
        )
        .bind(`adjacent-${suffix}`, `${RETIRED}${suffix}`)
        .run();
    }
  });

  it("preserves non-invite projection scopes and immutable retirement evidence", async () => {
    const db = env.AUTH_STATE_DB;
    await db
      .prepare(
        "INSERT INTO profile_game_projection_locks (id, scope, resource_id) VALUES ('profile-link', 'profile-link', ?)",
      )
      .bind(RETIRED)
      .run();
    const before = await db
      .prepare("SELECT * FROM retired_invites ORDER BY invite_id")
      .all();
    expect(before.results.map((row) => row.invite_id)).toEqual(
      [...RETIRED_INVITE_IDS].sort(),
    );
    for (const sql of [
      "DELETE FROM retired_invites",
      "UPDATE retired_invites SET source_scope_digest = source_scope_digest",
      "INSERT OR REPLACE INTO retired_invites SELECT * FROM retired_invites LIMIT 1",
    ])
      await expect(db.prepare(sql).run()).rejects.toThrow(
        "retired-invite-immutable",
      );
    expect(
      await db
        .prepare("SELECT * FROM retired_invites ORDER BY invite_id")
        .all(),
    ).toEqual(before);
  });

  it("uses the migration journal for idempotent application without replaying immutable seeds", async () => {
    for (const group of groups) {
      const migration = group.migrations.find(
        ({ name }) => name === group.name,
      );
      if (!migration) throw new Error("retired-invite-test-migration-missing");
      const before = (
        await group.db
          .prepare("SELECT * FROM retired_invites ORDER BY invite_id")
          .all()
      ).results;
      await applyD1Migrations(group.db, [migration]);
      expect(
        (
          await group.db
            .prepare("SELECT * FROM retired_invites ORDER BY invite_id")
            .all()
        ).results,
      ).toEqual(before);
      expect(
        await group.db
          .prepare("SELECT count(*) AS count FROM d1_migrations WHERE name = ?")
          .bind(group.name)
          .first("count"),
      ).toBe(1);
    }
  });
});

describe("retired invite migrations on the complete application schema", () => {
  let heldLock: D1PreparedStatement;
  beforeAll(async () => {
    const index = testEnv.TEST_D1_MIGRATIONS.findIndex(
      ({ name }) => name === "0041_retired_invites.sql",
    );
    expect(index).toBeGreaterThan(0);
    await applyCanonicalTestMigrations(
      env.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS.slice(0, index),
    );
    heldLock = env.PROFILE_GAMES_DB.prepare(
      "INSERT INTO game_session_mutation_locks (lock_id, owner_id, operation_id, expires_at_ms, writer_generation, writer_owner_id) VALUES (?, 'owner', 'operation', 100000, 2, 'owner')",
    ).bind(RETIRED);
    await applyD1Migrations(
      env.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS.slice(index),
    );
    await applyRetiredProfileMigrations(
      env.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
    await applyCanonicalTestMigrations(
      env.TELEGRAM_DB,
      testEnv.TEST_TELEGRAM_D1_MIGRATIONS,
    );
  });

  it("installs the exact same immutable scope in the three affected databases", async () => {
    for (const db of [env.PROFILE_GAMES_DB, env.PROFILE_DB, env.TELEGRAM_DB]) {
      expect(
        (
          await db
            .prepare("SELECT invite_id FROM retired_invites ORDER BY invite_id")
            .all()
        ).results,
      ).toEqual(
        [...RETIRED_INVITE_IDS].sort().map((invite_id) => ({ invite_id })),
      );
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    }
  });

  it("fences a real pre-retirement prepared lock statement without disturbing a normal lock", async () => {
    const db = env.PROFILE_GAMES_DB;
    const insert = (inviteId: string) =>
      db
        .prepare(
          "INSERT INTO game_session_mutation_locks (lock_id, owner_id, operation_id, expires_at_ms, writer_generation, writer_owner_id) VALUES (?, 'owner', 'operation', 100000, 2, 'owner')",
        )
        .bind(inviteId);
    await expect(heldLock.run()).rejects.toThrow("retired-invite-write");
    await insert(OTHER).run();
    expect(
      await db
        .prepare(
          "SELECT lock_id FROM game_session_mutation_locks WHERE lock_id = ?",
        )
        .bind(OTHER)
        .first(),
    ).toEqual({ lock_id: OTHER });
  });
});
