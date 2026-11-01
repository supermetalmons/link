import { materializeProfileFixture as materializeCanonicalProfile } from "../test/profileDataBoundaryFixture.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAuthProfileRepository,
  readAuthIdentityProfile,
} from "../src/authProfileRepository.ts";
import { AuthApiFailure } from "../src/authErrors.ts";
import { handleAuthRoute } from "../src/authRoutes.ts";
import {
  readCanonicalAuthProfileByLogin,
  readCanonicalAuthReadSnapshotByLogin,
  type CanonicalAuthProfileSnapshot,
} from "../src/profileCanonical/authProfile.ts";
import {
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  readCanonicalProfile,
  type CanonicalAuthMethodValue,
} from "../src/profileCanonicalD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;
const validationTable = "auth_profile_read_cases";
const unlinked = { apple: false, eth: false, sol: false, x: false };
const validMethodValues = {
  apple: "apple-subject",
  eth: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
  sol: "11111111111111111111111111111111",
  x: "123456789",
};

async function createProfile(
  methods: Partial<Record<CanonicalAuthMethodValue["method"], string>> = {},
  username: string | null = null,
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
            username,
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
    database?: D1Database;
    mapRow?: (
      row: Record<string, unknown>,
      resultIndex: number,
    ) => Record<string, unknown>;
    mapResults?: (
      results: D1Result<Record<string, unknown>>[],
    ) => D1Result<Record<string, unknown>>[];
    failure?: Error;
  } = {},
) {
  const batchQueries: string[][] = [];
  const batchResults: D1Result<Record<string, unknown>>[][] = [];
  const batchBindings: unknown[][][] = [];
  const nativeStatements = new WeakMap<object, D1PreparedStatement>();
  const statementQueries = new WeakMap<object, string>();
  const statementBindings = new WeakMap<object, unknown[]>();
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
    values: unknown[] = [],
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            wrap(target.bind(...values), query, values);
        }
        if (["all", "first", "run", "raw"].includes(String(property))) {
          return () => {
            throw new Error(`unexpected-auth-methods-${String(property)}`);
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    nativeStatements.set(wrapped, statement);
    statementQueries.set(wrapped, query);
    statementBindings.set(wrapped, values);
    return wrapped;
  };
  const database = new Proxy(options.database || db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const queries = statements.map(
            (statement) => statementQueries.get(statement) || "",
          );
          batchQueries.push(queries);
          batchBindings.push(
            statements.map(
              (statement) => statementBindings.get(statement) || [],
            ),
          );
          expect(queries).toHaveLength(2);
          for (const query of queries) expect(query).toMatch(/^\s*SELECT\b/);
          if (options.failure) throw options.failure;
          const results = await target.batch<Record<string, unknown>>(
            statements.map(
              (statement) => nativeStatements.get(statement) || statement,
            ),
          );
          batchResults.push(results);
          const mapped = results.map((result, index) => ({
            ...result,
            results: options.mapRow
              ? result.results.map((row) => options.mapRow!(row, index))
              : result.results,
          }));
          return options.mapResults ? options.mapResults(mapped) : mapped;
        };
      }
      if (property === "exec") {
        return () => {
          throw new Error("unexpected-auth-methods-exec");
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database, batchQueries, batchResults, batchBindings };
}

function validationDatabase(): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(sql.replace(/\bprofile_records\b/g, validationTable));
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

async function outcome<T>(work: () => Promise<T>) {
  try {
    return { ok: true as const, value: await work() };
  } catch (error) {
    return {
      ok: false as const,
      error: {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : "unknown",
      },
    };
  }
}

function withoutRetainedFields(snapshot: CanonicalAuthProfileSnapshot) {
  return snapshot;
}

describe("canonical auth profile reads", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "c".repeat(64),
    );
    expect(
      await db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'profile_records'",
        )
        .first(),
    ).toBeNull();
    await db
      .prepare(
        `CREATE TABLE ${validationTable} AS SELECT *, NULL AS legacy_fields_json FROM profile_records_canonical WHERE 0`,
      )
      .run();
  });

  it("returns the missing-login response in one batch", async () => {
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
    expect(observed.batchQueries).toHaveLength(1);
  });

  it("retains owner, profile, and method revisions in the shared snapshot", async () => {
    const initial = await createProfile({ sol: validMethodValues.sol });
    const observed = observeDatabase();
    const result = await readCanonicalAuthProfileByLogin(
      observed.database,
      initial.loginUid,
    );
    expect(observed.batchQueries).toHaveLength(1);
    expect(result?.owner).toEqual({
      loginUid: initial.loginUid,
      profileId: initial.profileId,
      revision: 1,
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
    });
    expect(result?.profile).toEqual(
      await readCanonicalProfile(db, initial.profileId),
    );
    expect(result?.authMethods).toEqual([
      expect.objectContaining({
        method: "sol",
        profileId: initial.profileId,
        revision: 1,
        rawValue: validMethodValues.sol,
      }),
    ]);
  });

  it("reads missing and complete identity profiles with one batch and no mutations", async () => {
    const profile = await createProfile({ sol: validMethodValues.sol });
    for (const loginUid of ["missing-identity-login", profile.loginUid]) {
      const observed = observeDatabase();
      const result = await readAuthIdentityProfile(observed.database, loginUid);
      expect(observed.batchQueries).toHaveLength(1);
      expect(observed.batchQueries[0]!.join("\n")).not.toMatch(
        /profile_auth_recovery_jobs_canonical|profile_february_opponents_canonical/,
      );
      if (loginUid !== profile.loginUid) {
        expect(result).toEqual({ ok: true, profile: null });
      } else {
        expect(result.profile).toMatchObject({
          id: profile.profileId,
          rating: 1500,
          nonce: 1,
          emoji: 2,
          mining: { materials: { dust: 0 } },
        });
        expect(JSON.stringify(result)).not.toMatch(
          /legacy_fields|auth_method|revision|normalized_value/,
        );
      }
    }
  });

  it("returns the complete canonical profile once for four methods without writes", async () => {
    const profile = await createProfile(validMethodValues, "FourMethods");
    const before = await readCanonicalProfile(db, profile.profileId);
    const observed = observeDatabase();
    const snapshot = await readCanonicalAuthProfileByLogin(
      observed.database,
      profile.loginUid,
    );
    expect(snapshot?.profile).toEqual(before);
    expect(snapshot?.authMethods.map((method) => method.method)).toEqual([
      "apple",
      "eth",
      "sol",
      "x",
    ]);
    expect(observed.batchQueries).toHaveLength(1);
    const [profileResult, methodsResult] = observed.batchResults[0]!;
    expect(profileResult!.results).toHaveLength(1);
    expect(profileResult!.results[0]).not.toHaveProperty("legacy_fields_json");
    expect(methodsResult!.results).toHaveLength(4);
    for (const method of methodsResult!.results) {
      expect(method).not.toHaveProperty("payload_json");
      expect(method).not.toHaveProperty("legacy_fields_json");
    }
    for (const result of observed.batchResults[0]!) {
      expect(result.meta.rows_written).toBe(0);
    }
    expect(observed.batchQueries[0]![0]!).not.toContain(
      "profile_auth_methods_canonical",
    );
    expect(observed.batchQueries[0]![1]!).not.toContain(
      "profile_records_canonical",
    );
    await expect(readCanonicalProfile(db, profile.profileId)).resolves.toEqual(
      before,
    );
  });

  it("preserves absent-login results and exact bindings in narrow auth snapshots", async () => {
    const loginUid = " missing-login' OR 1 = 1 -- ";
    for (const read of [
      readCanonicalAuthProfileByLogin,
      readCanonicalAuthReadSnapshotByLogin,
    ]) {
      const observed = observeDatabase();
      await expect(read(observed.database, loginUid)).resolves.toBeNull();
      expect(observed.batchQueries).toHaveLength(1);
      expect(observed.batchBindings).toEqual([[[loginUid], [loginUid]]]);
      expect(
        observed.batchResults[0]!.map((result) => result.meta.rows_written),
      ).toEqual([0, 0]);
    }
  });

  const retainedCases = [
    { label: "empty object", value: "{}", valid: true },
    {
      label: "whitespace and duplicate keys",
      value: ' { "a": 1, "a": 2 } ',
      valid: true,
    },
    { label: "escaped NUL", value: '{"a":"\\u0000"}', valid: true },
    { label: "surrogate escape", value: '{"a":"\\ud800"}', valid: true },
    { label: "overflow number", value: '{"a":1e999}', valid: true },
    { label: "BOM inside string", value: '{"a":"\ufeff"}', valid: true },
    { label: "array", value: "[]", valid: false },
    { label: "scalar", value: '"value"', valid: false },
    { label: "JSON null", value: "null", valid: false },
    { label: "SQL null", value: null, valid: false },
    { label: "numeric value", value: 5, valid: false },
    { label: "malformed text", value: '{"a":', valid: false },
    { label: "JSON5", value: "{a:1}", valid: false },
    { label: "leading BOM", value: '\ufeff{"a":1}', valid: false },
    { label: "trailing BOM", value: '{"a":1}\ufeff', valid: false },
    { label: "raw NUL", value: '{"a":1}\u0000', valid: false },
    {
      label: "JSON BLOB",
      value: new TextEncoder().encode('{"a":1}'),
      valid: false,
    },
    {
      label: "invalid UTF-8 inside a string",
      value: new Uint8Array([123, 34, 97, 34, 58, 34, 255, 34, 125]),
      castText: true,
      valid: true,
    },
    ...[998, 999, 1000, 1100, 20_000].map((depth) => ({
      label: `nesting depth ${depth}`,
      value: '{"a":' + "[".repeat(depth) + "0" + "]".repeat(depth) + "}",
      valid: true,
    })),
  ];

  it.each(retainedCases)(
    "reads canonical profiles independently from archived bytes for $label",
    async ({ value, valid: _valid, ...options }) => {
      const { profileId, loginUid } = await createProfile({
        sol: validMethodValues.sol,
      });
      await db
        .prepare(
          `INSERT INTO ${validationTable} SELECT *, NULL FROM profile_records_canonical WHERE profile_id = ?`,
        )
        .bind(profileId)
        .run();
      await db
        .prepare(
          `UPDATE ${validationTable} SET legacy_fields_json = ${"castText" in options && options.castText ? "CAST(? AS TEXT)" : "?"} WHERE profile_id = ?`,
        )
        .bind(value, profileId)
        .run();
      const retainedBytes = () =>
        db
          .prepare(
            `SELECT typeof(legacy_fields_json) AS storage_type,
               hex(CAST(legacy_fields_json AS BLOB)) AS stored_bytes
             FROM ${validationTable} WHERE profile_id = ?`,
          )
          .bind(profileId)
          .first();
      const before = await retainedBytes();
      const fullDb = observeDatabase({ database: validationDatabase() });
      const narrowDb = observeDatabase({ database: validationDatabase() });
      const full = await outcome(() =>
        readCanonicalAuthProfileByLogin(fullDb.database, loginUid),
      );
      const narrow = await outcome(async () => {
        const stringify = JSON.stringify;
        const spy = vi
          .spyOn(JSON, "stringify")
          .mockImplementation((entry, ...args) => {
            if (
              options.label === "nesting depth 20000" &&
              entry &&
              typeof entry === "object" &&
              Object.hasOwn(entry, "a")
            ) {
              throw new Error("unexpected-retained-serialization");
            }
            return stringify(entry, ...args);
          });
        try {
          return await readCanonicalAuthReadSnapshotByLogin(
            narrowDb.database,
            loginUid,
          );
        } finally {
          spy.mockRestore();
        }
      });
      expect(full.ok).toBe(true);
      expect(narrow.ok).toBe(full.ok);
      if (full.ok && narrow.ok) {
        expect(full.value).not.toBeNull();
        expect(narrow.value).toEqual(withoutRetainedFields(full.value!));
        expect(narrow.value!.profile).not.toHaveProperty("legacyFields");
        expect(narrow.value!.profile).not.toHaveProperty("storageShape");
        expect(() => JSON.stringify(narrow.value)).not.toThrow();
      } else {
        expect(narrow).toEqual(full);
      }
      for (const consumer of ["identity", "methods"] as const) {
        const observed = observeDatabase({ database: validationDatabase() });
        const result = await outcome<unknown>(() =>
          consumer === "identity"
            ? readAuthIdentityProfile(observed.database, loginUid)
            : createAuthProfileRepository(testEnv, {
                d1: observed.database,
              }).getLinkedAuthMethods(loginUid),
        );
        if (full.ok) {
          expect(result).toEqual({
            ok: true,
            value:
              consumer === "identity"
                ? { ok: true, profile: full.value!.profile.profile }
                : {
                    ok: true,
                    profileId,
                    linkedMethods: { ...unlinked, sol: true },
                    appleLinked: false,
                  },
          });
        } else {
          expect(result).toEqual(full);
        }
        expect(observed.batchQueries).toHaveLength(1);
        expect(observed.batchBindings).toEqual([[[loginUid], [loginUid]]]);
        expect(
          observed.batchResults[0]!.map((result) => result.meta.rows_written),
        ).toEqual([0, 0]);
      }
      for (const observed of [fullDb, narrowDb]) {
        expect(observed.batchQueries).toHaveLength(1);
        expect(observed.batchBindings).toEqual([[[loginUid], [loginUid]]]);
        expect(
          observed.batchResults[0]!.map((result) => result.meta.rows_written),
        ).toEqual([0, 0]);
      }
      expect(await retainedBytes()).toEqual(before);
    },
  );

  it("bounds canonical auth reads to one profile and its linked methods", async () => {
    const { profileId, loginUid } = await createProfile(
      validMethodValues,
      "ReadOnlyProfile",
    );
    const before = await db
      .prepare("SELECT * FROM profile_records_canonical WHERE profile_id = ?")
      .bind(profileId)
      .first();
    const fullDb = observeDatabase();
    const narrowDb = observeDatabase();
    const full = (await readCanonicalAuthProfileByLogin(
      fullDb.database,
      loginUid,
    ))!;
    const narrow = await readCanonicalAuthReadSnapshotByLogin(
      narrowDb.database,
      loginUid,
    );
    expect(narrow).toEqual(withoutRetainedFields(full));
    const rowBytes = (observed: ReturnType<typeof observeDatabase>) =>
      new TextEncoder().encode(
        JSON.stringify(
          observed.batchResults[0]!.map((result) => result.results),
        ),
      ).byteLength;
    const fullBytes = rowBytes(fullDb);
    const narrowBytes = rowBytes(narrowDb);
    for (const consumer of ["identity", "methods"] as const) {
      const observed = observeDatabase();
      if (consumer === "identity") {
        await expect(
          readAuthIdentityProfile(observed.database, loginUid),
        ).resolves.toEqual({ ok: true, profile: full.profile.profile });
      } else {
        await expect(
          createAuthProfileRepository(testEnv, {
            d1: observed.database,
          }).getLinkedAuthMethods(loginUid),
        ).resolves.toEqual({
          ok: true,
          profileId,
          linkedMethods: { apple: true, eth: true, sol: true, x: true },
          appleLinked: true,
        });
      }
      expect(observed.batchQueries).toHaveLength(1);
      expect(observed.batchBindings).toEqual([[[loginUid], [loginUid]]]);
      expect(rowBytes(observed)).toBe(narrowBytes);
      const [profileResult, methodsResult] = observed.batchResults[0]!;
      expect(profileResult!.results[0]).not.toHaveProperty(
        "legacy_fields_json",
      );
      expect(profileResult!.results[0]).not.toHaveProperty(
        "legacy_fields_fallback_json",
      );
      expect(methodsResult!.results).toEqual(
        fullDb.batchResults[0]![1]!.results,
      );
      expect(
        observed.batchResults[0]!.map((result) => result.meta.rows_written),
      ).toEqual([0, 0]);
    }
    expect(
      await db
        .prepare("SELECT * FROM profile_records_canonical WHERE profile_id = ?")
        .bind(profileId)
        .first(),
    ).toEqual(before);
    expect(narrowBytes).toBeLessThanOrEqual(fullBytes);
    expect(fullDb.batchResults[0]![0]!.results).toHaveLength(1);
    expect(fullDb.batchResults[0]![1]!.results).toHaveLength(4);
  });

  it.each([
    "missing",
    "extra",
    "failed",
    "invalid-results",
    "duplicate-profile",
    "missing-owner",
  ] as const)(
    "rejects %s batch results instead of returning a partial identity",
    async (failure) => {
      const profile = await createProfile({ sol: validMethodValues.sol });
      const observed = observeDatabase({
        mapResults: (results) => {
          const [profileResult, methodsResult] = results;
          if (!profileResult || !methodsResult)
            throw new Error("missing-auth-fixture-results");
          switch (failure) {
            case "missing":
              return [profileResult];
            case "extra":
              return [...results, methodsResult];
            case "failed":
              return [
                profileResult,
                { ...methodsResult, success: false } as unknown as D1Result<
                  Record<string, unknown>
                >,
              ];
            case "invalid-results":
              return [
                profileResult,
                {
                  ...methodsResult,
                  results: null as unknown as Record<string, unknown>[],
                },
              ];
            case "duplicate-profile":
              return [
                {
                  ...profileResult,
                  results: [
                    ...profileResult!.results,
                    ...profileResult!.results,
                  ],
                },
                methodsResult,
              ];
            case "missing-owner":
              return [{ ...profileResult, results: [] }, methodsResult];
          }
        },
      });
      await expect(
        readAuthIdentityProfile(observed.database, profile.loginUid),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      expect(observed.batchQueries).toHaveLength(1);
    },
  );

  it("requests username repair only for unnamed Apple or X profiles without wallets", async () => {
    for (const method of ["apple", "x"] as const) {
      const profile = await createProfile({
        [method]: validMethodValues[method],
      });
      const observed = observeDatabase();
      await expect(
        readAuthIdentityProfile(observed.database, profile.loginUid),
      ).rejects.toMatchObject({
        status: 409,
        code: "failed-precondition",
        message: "profile-repair-required",
      } satisfies Partial<AuthApiFailure>);
      expect(observed.batchQueries).toHaveLength(1);
    }
    for (const profile of [
      await createProfile({
        apple: validMethodValues.apple,
        sol: validMethodValues.sol,
      }),
      await createProfile({ apple: validMethodValues.apple }, "SeedName"),
      await createProfile(),
    ]) {
      const result = await readAuthIdentityProfile(db, profile.loginUid);
      expect(result).toMatchObject({
        ok: true,
        profile: { id: profile.profileId },
      });
      expect(JSON.stringify(result)).not.toContain(validMethodValues.apple);
    }
  });

  it("identity reads reject corrupt ownership instead of reporting a missing profile", async () => {
    const profile = await createProfile({ sol: validMethodValues.sol });
    for (const changes of [
      { profile_id: null, payload_json: null },
      { canonical_owner_login_uid: "another-login" },
      { canonical_owner_profile_id: "another-profile" },
      { state: "retiring", merged_into_profile_id: "target" },
      { canonical_merge_source_profile_id: "source" },
    ]) {
      const observed = observeDatabase({
        mapRow: (row, resultIndex) =>
          resultIndex === 0 ? { ...row, ...changes } : row,
      });
      await expect(
        readAuthIdentityProfile(observed.database, profile.loginUid),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      expect(observed.batchQueries).toHaveLength(1);
    }
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
    expect(observed.batchQueries).toHaveLength(1);
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
      expect(observed.batchQueries).toHaveLength(1);
      expect(observed.batchQueries[0]!.join("\n")).not.toMatch(
        /profile_auth_recovery_jobs_canonical|profile_february_opponents_canonical/,
      );
    },
  );

  it.each([
    ["dangling owner", 0, { profile_id: null, payload_json: null }],
    ["owner login mismatch", 0, { canonical_owner_login_uid: "another-login" }],
    [
      "owner profile mismatch",
      0,
      { canonical_owner_profile_id: "another-profile" },
    ],
    ["owner revision", 0, { canonical_owner_revision: 0 }],
    ["owner timestamp", 0, { canonical_owner_created_at_ms: -1 }],
    ["profile revision", 0, { revision: 0 }],
    ["profile payload", 0, { payload_json: "{}" }],
    ["gameplay emoji", 0, { gameplay_emoji: "1" }],
    ["missing gameplay emoji", 0, { gameplay_emoji: undefined }],
    ["invalid profile presence", 0, { emoji_present: 2 }],
    ["unexpected schema version", 0, { schema_version: 2 }],
    [
      "retiring profile",
      0,
      { state: "retiring", merged_into_profile_id: "target" },
    ],
    [
      "active merge mapping",
      0,
      { canonical_merge_source_profile_id: "source" },
    ],
    ["method name", 1, { method: "unsupported" }],
    ["method owner mismatch", 1, { profile_id: "another-profile" }],
    ["partial method row", 1, { method: null }],
    ["method raw value", 1, { raw_value: "" }],
    ["method revision", 1, { revision: 0 }],
    ["method metadata", 1, { apple_email_masked: "unexpected" }],
  ])(
    "rejects corrupt %s instead of returning an unlinked profile",
    async (_name, corruptedResultIndex, changes) => {
      const profile = await createProfile({ sol: validMethodValues.sol });
      const observed = observeDatabase({
        mapRow: (row, resultIndex) =>
          resultIndex === corruptedResultIndex ? { ...row, ...changes } : row,
      });
      await expect(
        createAuthProfileRepository(testEnv, {
          d1: observed.database,
        }).getLinkedAuthMethods(profile.loginUid),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      expect(observed.batchQueries).toHaveLength(1);
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
    expect(observed.batchQueries).toHaveLength(1);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "unavailable",
      message: "auth-service-unavailable",
    });
    expect(logFailure).toHaveBeenCalledWith("auth-service-unavailable");
  });
});
