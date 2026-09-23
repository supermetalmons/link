import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
} from "../src/profileCanonicalD1.ts";

const migrations = (env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] })
  .TEST_PROFILE_D1_MIGRATIONS;
const migrationIndex = migrations.findIndex(
  ({ name }) => name === "0018_drop_redundant_auth_method_index.sql",
);
const db = env.PROFILE_DB;
const profileId = "auth-index-profile";
const methodsQuery =
  "SELECT * FROM profile_auth_methods WHERE profile_id = ? ORDER BY method ASC";

function insertMethod(method: string, normalizedValue: string) {
  return db
    .prepare(
      `INSERT INTO profile_auth_methods (
         method, normalized_value, profile_id, raw_value,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, 100, 100)`,
    )
    .bind(method, normalizedValue, profileId, normalizedValue)
    .run();
}

describe("redundant auth method index migration", () => {
  beforeAll(async () => {
    expect(migrationIndex).toBeGreaterThan(0);
    await applyRetiredProfileMigrations(
      db,
      migrations.slice(0, migrationIndex),
      "a".repeat(64),
    );
  });

  it("preserves active writes, auth methods, uniqueness and indexed profile lookup", async () => {
    await commitCanonicalPlan(db, {
      expectations: [{ kind: "profile-absent", profileId }],
      mutations: [
        {
          kind: "insert-active-profile",
          value: materializeCanonicalProfile({
            profile: {
              id: profileId,
              nonce: 0,
              rating: 1500,
              totalManaPoints: 0,
              win: false,
              emoji: 0,
              username: null,
              eth: null,
              sol: null,
              mining: {
                lastRockDate: "",
                materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
              },
            },
            createdAtMs: 100,
            updatedAtMs: 100,
          }),
        },
      ],
    });
    await insertMethod("apple", "apple-user");
    const before = await db.prepare(methodsQuery).bind(profileId).all();
    expect(
      await db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'idx_profile_auth_methods_profile'",
        )
        .first("name"),
    ).toBe("idx_profile_auth_methods_profile");

    await applyD1Migrations(db, [migrations[migrationIndex]]);

    expect(
      (await db.prepare(methodsQuery).bind(profileId).all()).results,
    ).toEqual(before.results);
    expect(
      await db
        .prepare(
          "SELECT state FROM profile_canonical_control WHERE singleton = 1",
        )
        .first("state"),
    ).toBe("active");
    expect(
      await db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'idx_profile_auth_methods_profile'",
        )
        .first(),
    ).toBeNull();
    const uniqueIndexes = await db
      .prepare(
        `SELECT name FROM pragma_index_list('profile_auth_methods')
         WHERE origin = 'u'`,
      )
      .all<{ name: string }>();
    expect(uniqueIndexes.results).toHaveLength(1);
    expect(
      (
        await db
          .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
          .bind(uniqueIndexes.results[0].name)
          .all<{ name: string }>()
      ).results.map(({ name }) => name),
    ).toEqual(["profile_id", "method"]);
    await expect(insertMethod("apple", "another-apple-user")).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    await expect(insertMethod("x", "x-user")).resolves.toMatchObject({
      success: true,
    });
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${methodsQuery}`)
      .bind(profileId)
      .all<{ detail: string }>();
    const details = plan.results.map(({ detail }) => detail).join("\n");
    expect(details).toMatch(
      /SEARCH profile_auth_methods USING INDEX sqlite_autoindex_profile_auth_methods_\d+ \(profile_id=\?\)/,
    );
    expect(details).not.toMatch(/SCAN profile_auth_methods|USE TEMP B-TREE/);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
});
