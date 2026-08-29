import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { readCanonicalControl } from "../src/profileCanonicalD1.ts";
import {
  assertProfileMutationAllowed,
  profileBackgroundMutationsEnabled,
} from "../src/profileCanonicalActivation.ts";

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

describe("Firestore profile maintenance bridge", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
    );
  });

  it("allows writes only before the forward-only import begins", async () => {
    expect(await readCanonicalControl(testEnv.PROFILE_DB)).toMatchObject({
      state: "firestore",
      importedAtMs: null,
    });
    await expect(
      assertProfileMutationAllowed(testEnv),
    ).resolves.toBeUndefined();
    expect(await profileBackgroundMutationsEnabled(testEnv)).toBe(true);

    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET state = 'importing'
       WHERE singleton = 1 AND state = 'firestore'`,
    ).run();
    await expect(assertProfileMutationAllowed(testEnv)).rejects.toThrow(
      "profile-writes-disabled",
    );
    expect(await profileBackgroundMutationsEnabled(testEnv)).toBe(false);

    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET import_digest = ?, import_plan_version = 1
       WHERE singleton = 1 AND state = 'importing'`,
    )
      .bind("0".repeat(64))
      .run();
    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET state = 'frozen', imported_at_ms = 1
       WHERE singleton = 1 AND state = 'importing'`,
    ).run();
    await expect(assertProfileMutationAllowed(testEnv)).rejects.toThrow(
      "profile-writes-disabled",
    );

    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET state = 'active'
       WHERE singleton = 1 AND state = 'frozen'`,
    ).run();
    await expect(assertProfileMutationAllowed(testEnv)).rejects.toThrow(
      "profile-writes-disabled",
    );
    expect(await profileBackgroundMutationsEnabled(testEnv)).toBe(false);
  });

  it("fails invalid and unreadable control state closed", async () => {
    for (const value of [
      {
        state: "invalid",
        import_digest: null,
        import_plan_version: null,
        imported_at_ms: null,
      },
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
    const wrongBackend = {
      ...controlEnvironment({
        state: "firestore",
        import_digest: null,
        import_plan_version: null,
        imported_at_ms: null,
      }),
      PROFILE_STORAGE_MODE: "d1",
    } as unknown as Env;
    expect(await profileBackgroundMutationsEnabled(wrongBackend)).toBe(false);
    await expect(assertProfileMutationAllowed(wrongBackend)).rejects.toThrow(
      "profile-writes-disabled",
    );
  });
});
