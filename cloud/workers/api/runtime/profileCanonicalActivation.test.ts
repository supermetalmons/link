import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { readCanonicalControl } from "../src/profileCanonicalD1.ts";
import {
  assertProfileMutationAllowed,
  profileBackgroundMutationsEnabled,
} from "../src/profileCanonicalActivation.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };

function controlEnvironment(value: unknown): Env {
  const statement = {
    first: async () => value,
  } as unknown as D1PreparedStatement;
  const database = {
    prepare: () => statement,
  } as unknown as D1Database;
  return { ...testEnv, PROFILE_DB: database } as unknown as Env;
}

describe("canonical profile runtime control", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "0".repeat(64),
    );
  });

  it("allows writes only while canonical D1 is active", async () => {
    expect(await readCanonicalControl(testEnv.PROFILE_DB)).toEqual({
      state: "active",
    });
    await expect(
      assertProfileMutationAllowed(testEnv),
    ).resolves.toBeUndefined();
    expect(await profileBackgroundMutationsEnabled(testEnv)).toBe(true);

    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET state = 'frozen'
       WHERE singleton = 1 AND state = 'active'`,
    ).run();
    await expect(assertProfileMutationAllowed(testEnv)).rejects.toThrow(
      "profile-writes-disabled",
    );
    expect(await profileBackgroundMutationsEnabled(testEnv)).toBe(false);

    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET state = 'active'
       WHERE singleton = 1 AND state = 'frozen'`,
    ).run();
    expect(await profileBackgroundMutationsEnabled(testEnv)).toBe(true);
  });

  it("retains canonical integrity after retiring legacy profile tables", async () => {
    const legacyTables = await testEnv.PROFILE_DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table'
         AND name IN (
           'profiles', 'profile_logins', 'profile_logins_v2',
           'profile_projection_failures'
         )`,
    ).all<{ name: string }>();
    expect(legacyTables.results).toEqual([]);
    const canonicalTables = await testEnv.PROFILE_DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table'
         AND name IN (
           'profile_records', 'profile_login_owners',
           'profile_canonical_control'
         )
       ORDER BY name`,
    ).all<{ name: string }>();
    expect(canonicalTables.results.map(({ name }) => name)).toEqual([
      "profile_canonical_control",
      "profile_login_owners",
      "profile_records",
    ]);
    const foreignKeyFailures = await testEnv.PROFILE_DB.prepare(
      "PRAGMA foreign_key_check",
    ).all();
    expect(foreignKeyFailures.results).toEqual([]);
  });

  it("fails invalid and unreadable control state closed", async () => {
    for (const value of [
      { state: "legacy" },
      { state: "pending" },
      { state: "invalid" },
      null,
    ]) {
      const runtimeEnv = controlEnvironment(value);
      expect(await profileBackgroundMutationsEnabled(runtimeEnv)).toBe(false);
      await expect(assertProfileMutationAllowed(runtimeEnv)).rejects.toThrow(
        "profile-writes-disabled",
      );
    }
    const unavailable = {
      ...testEnv,
      PROFILE_DB: {
        prepare() {
          throw new Error("profile-control-unavailable");
        },
      } as unknown as D1Database,
    } as unknown as Env;
    expect(await profileBackgroundMutationsEnabled(unavailable)).toBe(false);
    await expect(assertProfileMutationAllowed(unavailable)).rejects.toThrow(
      "profile-writes-disabled",
    );
    const active = controlEnvironment({
      state: "active",
    });
    expect(await profileBackgroundMutationsEnabled(active)).toBe(true);
  });
});
