import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthProfileRepository } from "../src/authProfileRepository.ts";
import { handleAuthRoute } from "../src/authRoutes.ts";
import {
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  type CanonicalAuthMethodValue,
} from "../src/profileCanonicalD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;
const unlinked = { apple: false, eth: false, sol: false, x: false };
const validMethodValues = {
  apple: "apple-subject",
  eth: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
  sol: "11111111111111111111111111111111",
  x: "123456789",
};

async function createProfile(
  methods: Partial<Record<CanonicalAuthMethodValue["method"], string>> = {},
) {
  const profileId = `auth-methods-profile-${crypto.randomUUID()}`;
  const loginUid = `auth-methods-login-${crypto.randomUUID()}`;
  await commitCanonicalPlan(db, {
    expectations: [
      { kind: "profile-absent", profileId },
      { kind: "login-owner-absent", loginUid },
    ],
    mutations: [
      {
        kind: "insert-active-profile",
        value: materializeCanonicalProfile({
          profile: {
            id: profileId,
            nonce: 1,
            rating: 1500,
            totalManaPoints: 5,
            win: true,
            emoji: 2,
            username: null,
            eth: null,
            sol: null,
            completedProblemIds: [],
            isTutorialCompleted: false,
            mining: {
              lastRockDate: "2026-08-28",
              materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
            },
          },
          createdAtMs: 1_000,
          updatedAtMs: 2_000,
        }),
      },
      {
        kind: "insert-login-owner",
        value: {
          loginUid,
          profileId,
          createdAtMs: 1_000,
          updatedAtMs: 2_000,
        },
      },
    ],
  });
  for (const [method, rawValue] of Object.entries(methods) as Array<
    [CanonicalAuthMethodValue["method"], string]
  >) {
    const normalizedValue = crypto.randomUUID();
    await commitCanonicalPlan(db, {
      expectations: [{ kind: "auth-method-absent", method, normalizedValue }],
      mutations: [
        {
          kind: "insert-auth-method",
          value: {
            method,
            normalizedValue,
            rawValue,
            profileId,
            appleEmailMasked: null,
            xUsername: null,
            linkedAtMs: null,
            consentAtMs: null,
            consentSource: null,
            createdAtMs: 2_000,
            updatedAtMs: 2_000,
          },
        },
      ],
    });
  }
  return { profileId, loginUid };
}

function observeDatabase(
  options: {
    mapRow?: (row: Record<string, unknown>) => Record<string, unknown>;
    failure?: Error;
  } = {},
) {
  const allQueries: string[] = [];
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        if (property === "all") {
          return async () => {
            allQueries.push(query);
            if (options.failure) throw options.failure;
            const result = await target.all<Record<string, unknown>>();
            return {
              ...result,
              results: options.mapRow
                ? result.results.map(options.mapRow)
                : result.results,
            };
          };
        }
        if (property === "first" || property === "run" || property === "raw") {
          return () => {
            throw new Error(`unexpected-auth-methods-${property}`);
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      if (property === "batch" || property === "exec") {
        return () => {
          throw new Error(`unexpected-auth-methods-${property}`);
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database, allQueries };
}

describe("canonical auth profile reads", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "c".repeat(64),
    );
  });

  it("returns the missing-login response in one query", async () => {
    const observed = observeDatabase();
    await expect(
      createAuthProfileRepository(testEnv, {
        d1: observed.database,
      }).getLinkedAuthMethods("missing-auth-methods-login"),
    ).resolves.toEqual({
      ok: true,
      profileId: null,
      linkedMethods: unlinked,
      appleLinked: false,
    });
    expect(observed.allQueries).toHaveLength(1);
  });

  it("retains a profile with no linked methods", async () => {
    const profile = await createProfile();
    const observed = observeDatabase();
    await expect(
      createAuthProfileRepository(testEnv, {
        d1: observed.database,
      }).getLinkedAuthMethods(profile.loginUid),
    ).resolves.toEqual({
      ok: true,
      profileId: profile.profileId,
      linkedMethods: unlinked,
      appleLinked: false,
    });
    expect(observed.allQueries).toHaveLength(1);
  });

  it.each([
    { methods: { apple: validMethodValues.apple }, flags: { apple: true } },
    { methods: { eth: validMethodValues.eth }, flags: { eth: true } },
    { methods: { sol: validMethodValues.sol }, flags: { sol: true } },
    { methods: { x: validMethodValues.x }, flags: { x: true } },
    {
      methods: validMethodValues,
      flags: { apple: true, eth: true, sol: true, x: true },
    },
    {
      methods: {
        apple: "short",
        eth: "0xinvalid",
        sol: "short",
        x: "user-name",
      },
      flags: unlinked,
    },
  ])(
    "derives flags from canonical raw values: $methods",
    async ({ methods, flags }) => {
      const profile = await createProfile(methods);
      const observed = observeDatabase();
      const linkedMethods = { ...unlinked, ...flags };
      await expect(
        createAuthProfileRepository(testEnv, {
          d1: observed.database,
        }).getLinkedAuthMethods(profile.loginUid),
      ).resolves.toEqual({
        ok: true,
        profileId: profile.profileId,
        linkedMethods,
        appleLinked: linkedMethods.apple,
      });
      expect(observed.allQueries).toHaveLength(1);
      expect(observed.allQueries[0]).not.toMatch(
        /profile_auth_recovery_jobs|profile_february_opponents/,
      );
    },
  );

  it.each([
    ["dangling owner", { profile_id: null, payload_json: null }],
    ["owner login mismatch", { auth_owner_login_uid: "another-login" }],
    ["owner profile mismatch", { auth_owner_profile_id: "another-profile" }],
    ["owner revision", { auth_owner_revision: 0 }],
    ["owner timestamp", { auth_owner_created_at_ms: -1 }],
    ["profile revision", { revision: 0 }],
    ["profile payload", { payload_json: "{}" }],
    ["legacy fields", { legacy_fields_json: "[]" }],
    [
      "retiring profile",
      { state: "retiring", merged_into_profile_id: "target" },
    ],
    ["active merge mapping", { auth_merge_source_profile_id: "source" }],
    ["method name", { auth_method_method: "unsupported" }],
    ["method owner mismatch", { auth_method_profile_id: "another-profile" }],
    ["partial method row", { auth_method_method: null }],
    ["method raw value", { auth_method_raw_value: "" }],
    ["method revision", { auth_method_revision: 0 }],
    ["method metadata", { auth_method_apple_email_masked: "unexpected" }],
  ])(
    "rejects corrupt %s instead of returning an unlinked profile",
    async (_name, changes) => {
      const profile = await createProfile({ sol: validMethodValues.sol });
      const observed = observeDatabase({
        mapRow: (row) => ({ ...row, ...changes }),
      });
      await expect(
        createAuthProfileRepository(testEnv, {
          d1: observed.database,
        }).getLinkedAuthMethods(profile.loginUid),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      expect(observed.allQueries).toHaveLength(1);
    },
  );

  it("keeps the unavailable HTTP response for D1 read failures", async () => {
    const observed = observeDatabase({ failure: new Error("d1-unavailable") });
    const logFailure = vi.fn();
    const response = await handleAuthRoute(
      new Request("https://api.mons.link/auth/methods"),
      testEnv,
      { waitUntil() {} },
      {
        repository: createAuthProfileRepository(testEnv, {
          d1: observed.database,
        }),
        verifyIdentity: async () => ({ uid: "auth-methods-login" }),
        logFailure,
      },
    );
    expect(observed.allQueries).toHaveLength(1);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "unavailable",
      message: "auth-service-unavailable",
    });
    expect(logFailure).toHaveBeenCalledWith("auth-service-unavailable");
  });
});
