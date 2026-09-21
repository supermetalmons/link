import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getProfileFallbackEmojiId,
  type CompletePlayerProfile,
} from "@mons/shared/profiles";
import {
  buildCanonicalGuardStatements,
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalAuthRecoveryJob,
  readCanonicalLeaderboard,
  readCanonicalMergeTarget,
  readCanonicalProfile,
  readCanonicalProfileAggregate,
  readCanonicalProfileAggregates,
  readCanonicalProfileAggregateByLogin,
  readCanonicalProfileAggregateSnapshot,
  readCanonicalProfileAggregateSnapshots,
  readCanonicalProfileOwnershipSnapshot,
  readCanonicalPublicProfileByLogin,
  readCanonicalRatingUpdate,
  readCanonicalWagerSettlement,
  resolveCanonicalProfile,
  resolveCanonicalPublicProfile,
  type CanonicalAuthRecoveryValue,
  type CanonicalCommitPlan,
  type CanonicalExpectation,
  type CanonicalMutation,
  type CanonicalProfileSnapshot,
  type CanonicalProfileValue,
  type CanonicalRatingUpdateValue,
} from "../src/profileCanonicalD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { ProfileWritesDisabledFailure } from "../src/authErrors.ts";
import { classifyD1Failure } from "../src/d1Failure.ts";
import { createProfileCustomizationRepository } from "../src/profileCustomizationRepository.ts";
import { observeD1FailureDatabase } from "./d1FailureTestUtils.ts";
import { profileWriteRow } from "../src/profileCanonical/profiles.ts";
import { buildCanonicalRatingProjectionMutation } from "../src/profileCanonical/accounting.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };

function profile(
  id: string,
  overrides: Partial<CompletePlayerProfile> = {},
): CompletePlayerProfile {
  return {
    id,
    nonce: 1,
    rating: 1500,
    totalManaPoints: 5,
    win: true,
    emoji: 2,
    username: `${id}Name`,
    eth: null,
    sol: null,
    completedProblemIds: ["one"],
    isTutorialCompleted: true,
    mining: {
      lastRockDate: "2026-08-28",
      materials: { dust: 1, slime: 2, gum: 3, metal: 4, ice: 5 },
    },
    ...overrides,
  };
}

function profileValue(
  id: string,
  overrides: Partial<Parameters<typeof materializeCanonicalProfile>[0]> = {},
): CanonicalProfileValue {
  return materializeCanonicalProfile({
    profile: profile(id),
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  });
}

function ratingValue(
  operationId: string,
  overrides: Partial<CanonicalRatingUpdateValue> = {},
): CanonicalRatingUpdateValue {
  return {
    operationId,
    payload: { operationId, status: "processing" },
    status: "processing",
    inviteId: "invite-1",
    matchId: "match-1",
    playerId: "login-player",
    opponentId: "login-opponent",
    playerProfileId: null,
    opponentProfileId: null,
    ownerUid: "login-player",
    ownerToken: "owner-1",
    startedAtMs: 1_000,
    updatedAtMs: 1_000,
    leaseExpiresAtMs: 31_000,
    completedAtMs: null,
    telegramProjectionState: null,
    telegramProjectionUpdatedAtMs: null,
    telegramProjectionVersion: null,
    profileGameProjectionState: null,
    profileGameProjectionUpdatedAtMs: null,
    profileGameProjectionVersion: null,
    eventProgressState: null,
    eventProgressUpdatedAtMs: null,
    eventProgressVersion: null,
    ...overrides,
  };
}

function observeAggregateDatabase(
  options: {
    beforeBatch?: () => Promise<void>;
    afterBatch?: () => Promise<void>;
    mapResults?: (
      queries: string[],
      results: D1Result<Record<string, unknown>>[],
    ) => D1Result<Record<string, unknown>>[];
    mapFirst?: (
      row: Record<string, unknown> | null,
    ) => Record<string, unknown> | null;
    mapAll?: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
  } = {},
) {
  const batches: string[][] = [];
  const allQueries: string[] = [];
  const allBindings: unknown[][] = [];
  const statements = new WeakMap<object, D1PreparedStatement>();
  const queries = new WeakMap<object, string>();
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
    values: unknown[] = [],
  ) => {
    const wrapped: D1PreparedStatement = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...bound: unknown[]) =>
            wrap(target.bind(...bound), query, bound);
        }
        if (property === "first" && options.mapFirst) {
          return async () =>
            options.mapFirst!(await target.first<Record<string, unknown>>());
        }
        if (property === "all" && options.mapAll) {
          return async () => {
            allQueries.push(query);
            allBindings.push(values);
            const result = await target.all<Record<string, unknown>>();
            return { ...result, results: options.mapAll!(result.results) };
          };
        }
        if (["first", "all", "run", "raw"].includes(String(property))) {
          return () => {
            throw new Error("aggregate-read-outside-batch");
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    statements.set(wrapped, statement);
    queries.set(wrapped, query);
    return wrapped;
  };
  const database = new Proxy(testEnv.PROFILE_DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      if (property === "batch") {
        return async (prepared: D1PreparedStatement[]) => {
          const batchQueries = prepared.map(
            (statement) => queries.get(statement) || "",
          );
          batches.push(batchQueries);
          if (batches.length === 1) await options.beforeBatch?.();
          const results = await target.batch<Record<string, unknown>>(
            prepared.map((statement) => statements.get(statement) || statement),
          );
          if (batches.length === 1) await options.afterBatch?.();
          return options.mapResults?.(batchQueries, results) || results;
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database, batches, allQueries, allBindings };
}

function observeRecoveryDatabase(failure?: Error) {
  const reads: Array<{ query: string; values: unknown[] }> = [];
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
    values: unknown[] = [],
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...bound: unknown[]) =>
            wrap(target.bind(...bound), query, bound);
        }
        if (property === "first") {
          return async () => {
            reads.push({ query: query.replace(/\s+/g, " ").trim(), values });
            if (failure) throw failure;
            return target.first();
          };
        }
        throw new Error("unexpected-recovery-statement-operation");
      },
    });
  const database = new Proxy(testEnv.PROFILE_DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      throw new Error("unexpected-recovery-database-operation");
    },
  });
  return { database, reads };
}

async function resetCanonicalRows(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM rating_updates"),
    db.prepare("DELETE FROM profile_auth_operations"),
    db.prepare("DELETE FROM profile_auth_method_revocations"),
    db.prepare("DELETE FROM profile_auth_method_cooldowns"),
    db.prepare("DROP TRIGGER profile_merge_targets_reject_delete"),
    db.prepare("DROP TRIGGER wager_settlements_reject_delete"),
    db.prepare("DROP TRIGGER profile_records_reject_active_delete"),
    db.prepare("DELETE FROM profile_merge_targets"),
    db.prepare("DELETE FROM wager_settlements"),
    db.prepare("DELETE FROM profile_records"),
    db.prepare(
      `CREATE TRIGGER profile_merge_targets_reject_delete
       BEFORE DELETE ON profile_merge_targets
       BEGIN
         SELECT RAISE(ABORT, 'profile merge mappings are permanent');
       END`,
    ),
    db.prepare(
      `CREATE TRIGGER wager_settlements_reject_delete
       BEFORE DELETE ON wager_settlements
       BEGIN
         SELECT RAISE(ABORT, 'wager settlements are permanent');
       END`,
    ),
    db.prepare(
      `CREATE TRIGGER profile_records_reject_active_delete
       BEFORE DELETE ON profile_records
       WHEN OLD.state = 'active'
       AND (
         SELECT state FROM profile_canonical_control WHERE singleton = 1
       ) != 'importing'
       BEGIN
         SELECT RAISE(ABORT, 'active profiles cannot be deleted');
       END`,
    ),
  ]);
}

describe("canonical profile D1 store", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
  });

  beforeEach(async () => {
    await resetCanonicalRows(testEnv.PROFILE_DB);
  });

  it("enforces the actual statement budget before executing any writes", async () => {
    const value = profileValue("canonical-budget-profile");
    const loginUid = "canonical-budget-login";
    const plan: CanonicalCommitPlan = {
      expectations: [
        { kind: "profile-absent", profileId: value.profile.id },
        { kind: "login-owner-absent", loginUid },
      ],
      mutations: [
        { kind: "insert-active-profile", value },
        {
          kind: "insert-login-owner",
          value: {
            loginUid,
            profileId: value.profile.id,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
      ],
    };
    const observed = observeAggregateDatabase();
    await expect(
      commitCanonicalPlan(observed.database, plan, { maxStatements: 6 }),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    expect(observed.batches).toHaveLength(0);
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, value.profile.id),
    ).toBeNull();

    await commitCanonicalPlan(observed.database, plan, { maxStatements: 7 });
    expect(observed.batches.map((queries) => queries.length)).toEqual([7]);
    const aggregate = await readCanonicalProfileAggregate(
      testEnv.PROFILE_DB,
      value.profile.id,
    );
    expect(aggregate.profile?.revision).toBe(1);
    expect(aggregate.loginOwners.map((owner) => owner.loginUid)).toEqual([
      loginUid,
    ]);
  });

  it("allows an empty plan with a zero statement budget", async () => {
    const observed = observeAggregateDatabase();
    await commitCanonicalPlan(
      observed.database,
      { expectations: [], mutations: [] },
      { maxStatements: 0 },
    );
    expect(observed.batches).toHaveLength(0);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid statement budget %s before calling D1",
    async (maxStatements) => {
      const observed = observeAggregateDatabase();
      await expect(
        commitCanonicalPlan(
          observed.database,
          { expectations: [], mutations: [] },
          { maxStatements },
        ),
      ).rejects.toThrow("invalid-canonical-commit-budget");
      expect(observed.batches).toHaveLength(0);
    },
  );

  describe("commit failure classification", () => {
    it("uses the runtime guard signature without diagnostic reads on success or conflict", async () => {
      const value = profileValue("guard-signature");
      const plan = {
        expectations: [{ kind: "profile-absent", profileId: value.profile.id }],
        mutations: [{ kind: "insert-active-profile", value }],
      } as const;
      const observed = observeD1FailureDatabase(testEnv.PROFILE_DB);
      await commitCanonicalPlan(observed.database, plan);
      const failure = await commitCanonicalPlan(observed.database, plan).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(CanonicalProfileConflict);
      expect(failure).toHaveProperty("cause", observed.errors[0]);
      expect(classifyD1Failure(observed.errors[0])).toBe("profile-conflict");
      expect(observed.batches).toHaveLength(2);
      expect(observed.sessions).toEqual([]);
      expect(
        (await readCanonicalProfile(testEnv.PROFILE_DB, value.profile.id))
          ?.revision,
      ).toBe(1);
    });

    it.each(["frozen", "diagnostic unavailable", "integrity", "revision"])(
      "customization handles %s without retrying permanent failures",
      async (mode) => {
        const value = profileValue("guard-customization");
        const loginUid = "guard-customization-login";
        await commitCanonicalPlan(testEnv.PROFILE_DB, {
          expectations: [
            { kind: "profile-absent", profileId: value.profile.id },
            { kind: "login-owner-absent", loginUid },
          ],
          mutations: [
            { kind: "insert-active-profile", value },
            {
              kind: "insert-login-owner",
              value: {
                loginUid,
                profileId: value.profile.id,
                createdAtMs: 1_000,
                updatedAtMs: 1_000,
              },
            },
          ],
        });
        const observed = observeD1FailureDatabase(testEnv.PROFILE_DB, {
          diagnosticFailure:
            mode === "diagnostic unavailable"
              ? new Error("diagnostic-failed")
              : undefined,
          async beforeBatch(attempt) {
            if (attempt !== 1) return;
            if (mode === "revision") {
              await testEnv.PROFILE_DB.prepare(
                "UPDATE profile_records SET revision = revision + 1 WHERE profile_id = ?",
              )
                .bind(value.profile.id)
                .run();
            } else if (mode === "integrity") {
              await testEnv.PROFILE_DB.prepare(
                `CREATE TRIGGER guard_test_profile_update BEFORE UPDATE ON profile_records
                 BEGIN SELECT RAISE(ABORT, 'profile merge mappings are immutable'); END`,
              ).run();
            } else {
              await testEnv.PROFILE_DB.prepare(
                "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
              ).run();
            }
          },
        });
        try {
          const repository = createProfileCustomizationRepository(testEnv, {
            d1: observed.database,
            now: () => 2_000,
          });
          const result = await repository
            .updateCustomization(
              loginUid,
              { field: "tutorialCompleted", value: false },
              async () => {},
            )
            .catch((error: unknown) => error);
          if (mode === "revision") {
            expect(result).toBe("updated");
            expect(observed.batches).toHaveLength(2);
            expect(observed.sessions).toEqual([]);
            expect(classifyD1Failure(observed.errors[0])).toBe(
              "profile-conflict",
            );
            expect(
              (await readCanonicalProfile(testEnv.PROFILE_DB, value.profile.id))
                ?.profile.isTutorialCompleted,
            ).toBe(false);
          } else {
            expect(result).not.toBeInstanceOf(CanonicalProfileConflict);
            expect(result).toHaveProperty("cause", observed.errors[0]);
            expect(observed.batches).toHaveLength(1);
            expect(observed.sessions).toEqual(
              mode === "integrity" ? [] : ["first-primary"],
            );
            if (mode === "frozen")
              expect(result).toBeInstanceOf(ProfileWritesDisabledFailure);
            if (mode === "integrity")
              expect(result).toBeInstanceOf(CanonicalProfileCorruption);
            if (mode === "diagnostic unavailable")
              expect(result).toHaveProperty(
                "message",
                "canonical-profile-unavailable",
              );
            expect(
              (await readCanonicalProfile(testEnv.PROFILE_DB, value.profile.id))
                ?.revision,
            ).toBe(1);
          }
        } finally {
          if (mode === "integrity") {
            await testEnv.PROFILE_DB.prepare(
              "DROP TRIGGER IF EXISTS guard_test_profile_update",
            ).run();
          } else if (mode !== "revision") {
            await testEnv.PROFILE_DB.prepare(
              "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
            ).run();
          }
        }
      },
    );
  });

  describe("auth recovery reader", () => {
    async function seedRecovery(): Promise<CanonicalAuthRecoveryValue> {
      const value = profileValue("canonical-recovery-reader");
      const recovery: CanonicalAuthRecoveryValue = {
        profileId: value.profile.id,
        loginUids: ["login-recovery-one", "login-recovery-two"],
        sourceProfileIds: ["source-recovery-one", "source-recovery-two"],
        sourcePhase: "prizes",
        prizeCursor: "event-recovery-cursor",
        phaseStartedAtMs: 2_000,
        lastEnqueuedAtMs: 3_000,
        createdAtMs: 1_000,
        updatedAtMs: 4_000,
      };
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          { kind: "profile-absent", profileId: value.profile.id },
          { kind: "auth-recovery-absent", profileId: value.profile.id },
        ],
        mutations: [
          { kind: "insert-active-profile", value },
          { kind: "insert-auth-recovery", value: recovery },
        ],
      });
      return recovery;
    }

    it("reads every recovery field with one query to the recovery table", async () => {
      const recovery = await seedRecovery();
      const observed = observeRecoveryDatabase();

      await expect(
        readCanonicalAuthRecoveryJob(observed.database, recovery.profileId),
      ).resolves.toEqual({ ...recovery, revision: 1 });
      expect(observed.reads).toEqual([
        {
          query:
            "SELECT * FROM profile_auth_recovery_jobs WHERE profile_id = ?",
          values: [recovery.profileId],
        },
      ]);
    });

    it("returns null for missing recovery and binds the profile ID unchanged", async () => {
      await seedRecovery();
      const profileId = " canonical-recovery-reader' OR 1 = 1 -- ";
      const observed = observeRecoveryDatabase();

      await expect(
        readCanonicalAuthRecoveryJob(observed.database, profileId),
      ).resolves.toBeNull();
      expect(observed.reads).toEqual([
        {
          query:
            "SELECT * FROM profile_auth_recovery_jobs WHERE profile_id = ?",
          values: [profileId],
        },
      ]);
    });

    it.each(["login_uids_json", "source_profile_ids_json"] as const)(
      "rejects malformed recovery contents in %s",
      async (column) => {
        const recovery = await seedRecovery();
        await testEnv.PROFILE_DB.prepare(
          `UPDATE profile_auth_recovery_jobs SET ${column} = ? WHERE profile_id = ?`,
        )
          .bind('["valid", false]', recovery.profileId)
          .run();

        await expect(
          readCanonicalAuthRecoveryJob(testEnv.PROFILE_DB, recovery.profileId),
        ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      },
    );

    it("preserves D1 read failures", async () => {
      const failure = new Error("D1 unavailable");
      const observed = observeRecoveryDatabase(failure);

      await expect(
        readCanonicalAuthRecoveryJob(observed.database, "recovery-profile"),
      ).rejects.toBe(failure);
      expect(observed.reads).toHaveLength(1);
    });
  });

  describe("public profile login reader", () => {
    const loginUid = "public-reader-login";
    const resolvers = [
      ["full", resolveCanonicalProfile],
      ["public", resolveCanonicalPublicProfile],
    ] as const;

    async function seedLookup() {
      const value = profileValue("public-reader-profile", {
        legacyFields: { retained: "original" },
      });
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          { kind: "profile-absent", profileId: value.profile.id },
          { kind: "login-owner-absent", loginUid },
        ],
        mutations: [
          { kind: "insert-active-profile", value },
          {
            kind: "insert-login-owner",
            value: {
              loginUid,
              profileId: value.profile.id,
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
            },
          },
        ],
      });
      return value;
    }

    it("reads a healthy profile with one query", async () => {
      const value = await seedLookup();
      const observed = observeRecoveryDatabase();
      await expect(
        readCanonicalPublicProfileByLogin(observed.database, loginUid),
      ).resolves.toMatchObject({
        profileId: value.profile.id,
        profile: value.profile,
        state: "active",
      });
      expect(observed.reads).toHaveLength(1);
      expect(observed.reads[0].values).toEqual([loginUid]);
      expect(observed.reads[0].query).not.toContain("legacy_fields_json");
    });

    it.each(resolvers)(
      "reads %s profiles with one query and preserves exact keys",
      async (kind, resolve) => {
        const value = await seedLookup();
        for (const profileId of [
          value.profile.id,
          ` ${value.profile.id}' OR 1 = 1 -- `,
          "",
          "é",
          "e\u0301",
          "\ud83d\ude00",
        ]) {
          const observed = observeAggregateDatabase({ mapAll: (rows) => rows });
          const result = await resolve(observed.database, profileId, 4);
          expect(result?.profileId ?? null).toBe(
            profileId === value.profile.id ? profileId : null,
          );
          expect(observed.allQueries).toHaveLength(1);
          expect(observed.allBindings).toEqual([
            [JSON.stringify([profileId]), 4],
          ]);
          expect(observed.batches).toHaveLength(0);
          if (kind === "full" && profileId === value.profile.id) {
            expect(result).toEqual({
              ...value,
              profileId: value.profile.id,
              revision: 1,
            });
          }
          if (kind === "public") {
            expect(observed.allQueries[0]).not.toContain("legacy_fields_json");
            expect(observed.allQueries[0]).not.toContain("profile.*");
          }
        }
      },
    );

    it.each(["\ud800", "\udc00"])(
      "preserves direct binding for a lone surrogate %j",
      async (surrogate) => {
        const profileId = `a${surrogate}b`;
        for (const policy of ["null", "throw"] as const) {
          for (const [kind, resolve] of resolvers) {
            const observed = observeAggregateDatabase();
            await expect(
              resolve(observed.database, profileId, 4, policy),
            ).resolves.toBeNull();
            expect(observed.batches).toHaveLength(1);
            expect(observed.allQueries).toHaveLength(0);
            if (kind === "public") {
              for (const query of observed.batches[0]) {
                expect(query).not.toContain("legacy_fields_json");
                expect(query).not.toContain("SELECT *");
              }
            }
          }
        }
      },
    );

    it.each([
      ["payload_json", "{}"],
      ["rating_sort", 99],
      ["merged_into_profile_id", "wrong-target"],
      ["redirect_merged_at_ms", -1],
      ["redirect_op_id", false],
    ])(
      "validates intermediate public redirect %s even with null failure policy",
      async (column, invalid) => {
        const source = profileValue("public-invalid-source", {
          state: "retiring",
          mergedIntoProfileId: "public-valid-target",
          mergedAtMs: 2_000,
          updatedAtMs: 2_000,
        });
        const target = profileValue("public-valid-target");
        const observed = observeAggregateDatabase({
          mapAll: () => [
            {
              ...profileWriteRow(source),
              chain_profile_id: source.profile.id,
              chain_depth: 0,
              redirect_source_profile_id: source.profile.id,
              redirect_target_profile_id: target.profile.id,
              redirect_merged_at_ms: 2_000,
              redirect_op_id: null,
              [column]: invalid,
            },
            {
              ...profileWriteRow(target),
              chain_profile_id: target.profile.id,
              chain_depth: 1,
              redirect_source_profile_id: null,
              redirect_target_profile_id: null,
              redirect_merged_at_ms: null,
              redirect_op_id: null,
            },
          ],
        });
        await expect(
          resolveCanonicalPublicProfile(
            observed.database,
            source.profile.id,
            4,
            "null",
          ),
        ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
        expect(observed.allQueries).toHaveLength(1);
      },
    );

    it.each([
      ["revision", 0],
      ["legacy_fields_json", "invalid-json"],
      ["created_at_ms", -1],
      ["updated_at_ms", -1],
      ["merged_at_ms", -1],
    ])(
      "validates intermediate full profile %s independently of the redirect",
      async (column, invalid) => {
        const source = profileValue("full-invalid-source", {
          state: "retiring",
          mergedIntoProfileId: "full-valid-target",
          mergedAtMs: 2_000,
          updatedAtMs: 2_000,
        });
        const target = profileValue("full-valid-target");
        const observed = observeAggregateDatabase({
          mapAll: () => [
            {
              ...profileWriteRow(source),
              revision: 1,
              chain_profile_id: source.profile.id,
              chain_depth: 0,
              redirect_source_profile_id: source.profile.id,
              redirect_target_profile_id: target.profile.id,
              redirect_merged_at_ms: 3_000,
              redirect_op_id: null,
              [column]: invalid,
            },
            {
              ...profileWriteRow(target),
              revision: 1,
              chain_profile_id: target.profile.id,
              chain_depth: 1,
              redirect_source_profile_id: null,
              redirect_target_profile_id: null,
              redirect_merged_at_ms: null,
              redirect_op_id: null,
            },
          ],
        });
        await expect(
          resolveCanonicalProfile(
            observed.database,
            source.profile.id,
            4,
            "null",
          ),
        ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
        expect(observed.allQueries).toHaveLength(1);
        expect(observed.batches).toHaveLength(0);
        await expect(
          resolveCanonicalPublicProfile(
            observed.database,
            source.profile.id,
            4,
          ),
        ).resolves.toMatchObject({ profileId: target.profile.id });
      },
    );

    it.each(resolvers)(
      "preserves %s invalid redirect limit policies without querying",
      async (_kind, resolve) => {
        for (const limit of [-1, Number.NaN, -Infinity]) {
          const observed = observeAggregateDatabase();
          await expect(
            resolve(observed.database, "missing", limit, "null"),
          ).resolves.toBeNull();
          await expect(
            resolve(observed.database, "missing", limit),
          ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
          expect(observed.batches).toHaveLength(0);
          expect(observed.allQueries).toHaveLength(0);
        }
      },
    );

    it("keeps stored profile timestamps separate from absent redirect timestamps", async () => {
      const value = await seedLookup();
      await testEnv.PROFILE_DB.prepare(
        "UPDATE profile_records SET merged_at_ms = 1.5 WHERE profile_id = ?",
      )
        .bind(value.profile.id)
        .run();
      await expect(
        resolveCanonicalProfile(
          testEnv.PROFILE_DB,
          value.profile.id,
          4,
          "null",
        ),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      await expect(
        resolveCanonicalPublicProfile(testEnv.PROFILE_DB, value.profile.id),
      ).resolves.toMatchObject({ profileId: value.profile.id });
    });

    it("preserves full profile resolution without a finite redirect limit", async () => {
      const value = await seedLookup();
      const observed = observeAggregateDatabase();
      await expect(
        resolveCanonicalProfile(observed.database, value.profile.id, Infinity),
      ).resolves.toEqual({
        ...value,
        profileId: value.profile.id,
        revision: 1,
      });
      expect(observed.batches).toHaveLength(1);
      expect(observed.allQueries).toHaveLength(0);
    });

    it.each(resolvers)(
      "preserves %s null results for dangling redirects",
      async (_kind, resolve) => {
        const sourceId = "public-dangling-source";
        const observed = observeAggregateDatabase({
          mapAll: () => [
            {
              profile_id: null,
              chain_profile_id: sourceId,
              chain_depth: 0,
              redirect_source_profile_id: sourceId,
              redirect_target_profile_id: "missing-target",
              redirect_merged_at_ms: 2_000,
              redirect_op_id: null,
            },
            {
              profile_id: null,
              chain_profile_id: "missing-target",
              chain_depth: 1,
              redirect_source_profile_id: null,
            },
          ],
        });
        await expect(resolve(observed.database, sourceId)).resolves.toBeNull();
      },
    );

    it.each(resolvers)(
      "preserves %s chain read failures",
      async (_kind, resolve) => {
        const failure = new Error("D1 unavailable");
        const observed = observeAggregateDatabase({
          mapAll: () => {
            throw failure;
          },
        });
        await expect(
          resolve(observed.database, "missing", 4, "null"),
        ).rejects.toBe(failure);
      },
    );

    it("returns null for an unknown login with one unchanged bound lookup", async () => {
      await seedLookup();
      const missingLogin = ` ${loginUid}' OR 1 = 1 -- `;
      const observed = observeRecoveryDatabase();
      await expect(
        readCanonicalPublicProfileByLogin(observed.database, missingLogin),
      ).resolves.toBeNull();
      expect(observed.reads).toHaveLength(1);
      expect(observed.reads[0].values).toEqual([missingLogin]);
    });

    it.each([
      ["lookup_login_uid", ""],
      ["lookup_profile_id", ""],
      ["lookup_revision", 0],
      ["lookup_created_at_ms", -1],
      ["lookup_updated_at_ms", -1],
      ["payload_json", "{}"],
      ["rating_sort", 99],
    ])("rejects malformed %s", async (column, invalid) => {
      await seedLookup();
      const observed = observeAggregateDatabase({
        mapFirst: (row) => ({ ...row, [column]: invalid }),
      });
      await expect(
        readCanonicalPublicProfileByLogin(observed.database, loginUid),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      expect(observed.batches).toHaveLength(0);
    });

    it("preserves a missing profile without a redirect as null", async () => {
      await seedLookup();
      const observed = observeAggregateDatabase({
        mapFirst: (row) => ({ ...row, profile_id: null }),
      });
      await expect(
        readCanonicalPublicProfileByLogin(observed.database, loginUid),
      ).resolves.toBeNull();
      expect(observed.batches).toHaveLength(0);
    });

    it("rejects a retiring profile without a merge record", async () => {
      await seedLookup();
      const observed = observeAggregateDatabase({
        mapFirst: (row) => ({
          ...row,
          state: "retiring",
          merged_into_profile_id: "missing-target",
        }),
      });
      await expect(
        readCanonicalPublicProfileByLogin(observed.database, loginUid),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      expect(observed.batches).toHaveLength(0);
    });

    it.each(["active", "retiring", "deleted"] as const)(
      "preserves redirect behavior for an %s source",
      async (sourceState) => {
        const value = await seedLookup();
        const target = profileValue("public-reader-target");
        await commitCanonicalPlan(testEnv.PROFILE_DB, {
          expectations: [
            { kind: "profile-absent", profileId: target.profile.id },
          ],
          mutations: [{ kind: "insert-active-profile", value: target }],
        });
        const targetRow = await testEnv.PROFILE_DB.prepare(
          "SELECT * FROM profile_records WHERE profile_id = ?",
        )
          .bind(target.profile.id)
          .first<Record<string, unknown>>();
        const observed = observeAggregateDatabase({
          mapFirst: (row) => ({
            ...row,
            lookup_merge_source_profile_id: value.profile.id,
          }),
          mapAll: (rows) => {
            const source = rows[0];
            return [
              {
                ...source,
                profile_id:
                  sourceState === "deleted" ? null : source.profile_id,
                state: sourceState,
                merged_into_profile_id:
                  sourceState === "retiring" ? target.profile.id : null,
                redirect_source_profile_id: value.profile.id,
                redirect_target_profile_id: target.profile.id,
                redirect_merged_at_ms: 2_000,
                redirect_op_id: null,
              },
              {
                ...targetRow,
                chain_profile_id: target.profile.id,
                chain_depth: 1,
                redirect_source_profile_id: null,
                redirect_target_profile_id: null,
                redirect_merged_at_ms: null,
                redirect_op_id: null,
              },
            ];
          },
        });
        const result = readCanonicalPublicProfileByLogin(
          observed.database,
          loginUid,
        );
        if (sourceState === "active") {
          await expect(result).rejects.toBeInstanceOf(
            CanonicalProfileCorruption,
          );
        } else {
          await expect(result).resolves.toMatchObject({
            profileId: target.profile.id,
          });
        }
        expect(observed.batches).toHaveLength(0);
        expect(observed.allQueries).toHaveLength(1);
      },
    );

    it.each(["cycle", "depth"] as const)(
      "keeps the original source and rejects redirect %s failures",
      async (failure) => {
        const value = await seedLookup();
        const observed = observeAggregateDatabase({
          mapFirst: (row) => ({
            ...row,
            lookup_merge_source_profile_id: value.profile.id,
          }),
          mapAll: () =>
            Array.from({ length: 33 }, (_, hop) => {
              const source =
                hop === 0 ? value.profile.id : `deleted-source-${hop}`;
              const target =
                failure === "cycle" && hop === 1
                  ? value.profile.id
                  : `deleted-source-${hop + 1}`;
              return {
                profile_id: null,
                chain_profile_id: source,
                chain_depth: hop,
                redirect_source_profile_id: source,
                redirect_target_profile_id: target,
                redirect_merged_at_ms: 2_000,
                redirect_op_id: null,
              };
            }),
        });
        await expect(
          readCanonicalPublicProfileByLogin(observed.database, loginUid),
        ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
        expect(observed.batches).toHaveLength(0);
        expect(observed.allQueries).toHaveLength(1);
        for (const [, resolve] of resolvers) {
          await expect(
            resolve(observed.database, value.profile.id, 32, "null"),
          ).resolves.toBeNull();
          await expect(
            resolve(observed.database, value.profile.id, 32),
          ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
        }
      },
    );
  });

  it("commits a revisioned profile aggregate atomically", async () => {
    const value = profileValue("canonical-success", {
      emojiPresent: false,
      gameplayEmoji: "gameplay-only",
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: value.profile.id },
        { kind: "login-owner-absent", loginUid: "login-success" },
        {
          kind: "auth-method-absent",
          method: "eth",
          normalizedValue: "0xabc",
        },
        { kind: "auth-recovery-absent", profileId: value.profile.id },
        {
          kind: "february-opponent-absent",
          profileId: value.profile.id,
          opponentProfileId: "opponent-1",
        },
      ],
      mutations: [
        { kind: "insert-active-profile", value },
        {
          kind: "insert-login-owner",
          value: {
            loginUid: "login-success",
            profileId: value.profile.id,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
        {
          kind: "insert-auth-method",
          value: {
            method: "eth",
            normalizedValue: "0xabc",
            profileId: value.profile.id,
            rawValue: "0xAbC",
            appleEmailMasked: null,
            xUsername: null,
            linkedAtMs: null,
            consentAtMs: null,
            consentSource: null,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
        {
          kind: "insert-february-opponent",
          profileId: value.profile.id,
          opponentProfileId: "opponent-1",
          recordedAtMs: 1_000,
        },
        {
          kind: "insert-auth-recovery",
          value: {
            profileId: value.profile.id,
            loginUids: ["login-success"],
            sourceProfileIds: [],
            sourcePhase: "finalize",
            prizeCursor: null,
            phaseStartedAtMs: 1_000,
            lastEnqueuedAtMs: 0,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
      ],
    });

    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "login-owner-absent", loginUid: "login-a-success" },
        {
          kind: "auth-method-absent",
          method: "apple",
          normalizedValue: "apple-success",
        },
        {
          kind: "february-opponent-absent",
          profileId: value.profile.id,
          opponentProfileId: "opponent-0",
        },
      ],
      mutations: [
        {
          kind: "insert-login-owner",
          value: {
            loginUid: "login-a-success",
            profileId: value.profile.id,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
        {
          kind: "insert-auth-method",
          value: {
            method: "apple",
            normalizedValue: "apple-success",
            rawValue: "apple-success",
            profileId: value.profile.id,
            appleEmailMasked: null,
            xUsername: null,
            linkedAtMs: null,
            consentAtMs: null,
            consentSource: null,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
        {
          kind: "insert-february-opponent",
          profileId: value.profile.id,
          opponentProfileId: "opponent-0",
          recordedAtMs: 1_000,
        },
      ],
    });
    const aggregate = await readCanonicalProfileAggregate(
      testEnv.PROFILE_DB,
      value.profile.id,
    );
    expect(aggregate.profile?.revision).toBe(1);
    expect(aggregate.profile?.gameplayEmoji).toBe("gameplay-only");
    expect(aggregate.loginOwners.map((owner) => owner.loginUid)).toEqual([
      "login-a-success",
      "login-success",
    ]);
    expect(aggregate.authMethods.map((method) => method.method)).toEqual([
      "apple",
      "eth",
    ]);
    expect(aggregate.authMethods[1]).toMatchObject({
      method: "eth",
      normalizedValue: "0xabc",
      rawValue: "0xAbC",
      revision: 1,
    });
    expect(aggregate.februaryOpponentProfileIds).toEqual([
      "opponent-0",
      "opponent-1",
    ]);
    expect(aggregate.recovery?.loginUids).toEqual(["login-success"]);
    const direct = observeAggregateDatabase();
    await expect(
      readCanonicalProfileAggregateSnapshot(direct.database, value.profile.id),
    ).resolves.toEqual(aggregate);
    expect(direct.batches.map((queries) => queries.length)).toEqual([6]);
    const byLogin = observeAggregateDatabase();
    const resolved = await readCanonicalProfileAggregateByLogin(
      byLogin.database,
      "login-success",
    );
    expect(resolved?.aggregate).toEqual(aggregate);
    expect(resolved?.owner).toEqual(aggregate.loginOwners[1]);
    expect(byLogin.batches.map((queries) => queries.length)).toEqual([7]);
  });

  it("keeps opaque archives out of public profile reads", async () => {
    const value = profileValue("canonical-public-lightweight", {
      legacyFields: { opaque: "x".repeat(700_000) },
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: value.profile.id },
        { kind: "login-owner-absent", loginUid: "public-lightweight-login" },
      ],
      mutations: [
        { kind: "insert-active-profile", value },
        {
          kind: "insert-login-owner",
          value: {
            loginUid: "public-lightweight-login",
            profileId: value.profile.id,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
      ],
    });

    await expect(
      resolveCanonicalPublicProfile(testEnv.PROFILE_DB, value.profile.id),
    ).resolves.toMatchObject({ profileId: value.profile.id });
    await expect(
      readCanonicalPublicProfileByLogin(
        testEnv.PROFILE_DB,
        "public-lightweight-login",
      ),
    ).resolves.toMatchObject({ profileId: value.profile.id });
    for (const type of [
      "rating",
      "mp",
      "dust",
      "slime",
      "gum",
      "metal",
      "ice",
    ] as const) {
      await expect(
        readCanonicalLeaderboard(testEnv.PROFILE_DB, type),
      ).resolves.toMatchObject([{ id: value.profile.id }]);
    }
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, value.profile.id))
        ?.legacyFields,
    ).toEqual(value.legacyFields);

    const sql: string[] = [];
    const fakeDb = {
      prepare: (statement: string) => {
        sql.push(statement);
        return {
          all: async () => ({
            results: statement.includes("chain_profile_id")
              ? [
                  {
                    chain_profile_id: "missing",
                    chain_depth: 0,
                    profile_id: null,
                    redirect_source_profile_id: null,
                  },
                ]
              : [],
          }),
          bind() {
            return this;
          },
        };
      },
    } as unknown as D1Database;
    await resolveCanonicalPublicProfile(fakeDb, "missing");
    await readCanonicalLeaderboard(fakeDb, "rating");
    const publicProfileQueries = sql.filter((statement) =>
      statement.includes("profile_records"),
    );
    expect(publicProfileQueries).toHaveLength(2);
    for (const statement of publicProfileQueries) {
      expect(statement).not.toContain("SELECT *");
      expect(statement).not.toContain("legacy_fields_json");
    }
  });

  it("rolls an earlier write back when a stale guard fails later", async () => {
    const initial = profileValue("canonical-rollback");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [{ kind: "profile-absent", profileId: initial.profile.id }],
      mutations: [{ kind: "insert-active-profile", value: initial }],
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: initial.profile.id,
          revision: 1,
        },
      ],
      mutations: [
        {
          kind: "update-active-profile",
          value: profileValue(initial.profile.id, {
            profile: profile(initial.profile.id, { rating: 1600 }),
            updatedAtMs: 2_000,
          }),
        },
      ],
    });

    await expect(
      testEnv.PROFILE_DB.batch([
        testEnv.PROFILE_DB.prepare(
          `UPDATE profile_records
           SET legacy_fields_json = '{"transient":true}'
           WHERE profile_id = ?`,
        ).bind(initial.profile.id),
        ...buildCanonicalGuardStatements(testEnv.PROFILE_DB, [
          {
            kind: "profile-revision",
            profileId: initial.profile.id,
            revision: 1,
          },
        ]),
      ]),
    ).rejects.toThrow();

    const stored = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      initial.profile.id,
    );
    expect(stored?.revision).toBe(2);
    expect(stored?.profile.rating).toBe(1600);
    expect(stored?.legacyFields).toEqual({});
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: initial.profile.id,
            revision: 1,
          },
        ],
        mutations: [
          {
            kind: "update-active-profile",
            value: profileValue(initial.profile.id, {
              updatedAtMs: 3_000,
            }),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
  });

  describe("active profile patches", () => {
    async function insertProfile(
      id: string,
    ): Promise<CanonicalProfileSnapshot> {
      const value = profileValue(id);
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [{ kind: "profile-absent", profileId: id }],
        mutations: [{ kind: "insert-active-profile", value }],
      });
      return (await readCanonicalProfile(testEnv.PROFILE_DB, id))!;
    }

    function patchPlan(
      current: CanonicalProfileSnapshot,
      value: CanonicalProfileValue = {
        ...current,
        profile: { ...current.profile, cardBackgroundId: 4 },
        updatedAtMs: 2_000,
      },
    ): CanonicalCommitPlan {
      return {
        expectations: [
          {
            kind: "profile-revision",
            profileId: current.profileId,
            revision: current.revision,
          },
        ],
        mutations: [{ kind: "patch-active-profile", current, value }],
      };
    }

    function settlementMutation(operationId: string): CanonicalMutation {
      return {
        kind: "insert-wager-settlement",
        value: {
          operationId,
          fingerprint: `${operationId}-fingerprint`,
          winnerProfileId: "patch-winner",
          loserProfileId: "patch-loser",
          material: "dust",
          count: 1,
          appliedAtMs: 2_000,
          outcome: "applied",
          revision: 1,
        },
      };
    }

    it.each([
      "missing revision",
      "different revision",
      "different expectation profile",
      "different snapshot profile ID",
      "different snapshot payload ID",
      "different next profile ID",
      "retiring snapshot",
      "retiring next value",
    ])("rejects %s before executing a patch", async (mode) => {
      const initial = profileValue("patch-invalid");
      let current: CanonicalProfileSnapshot = {
        ...initial,
        profileId: initial.profile.id,
        revision: 1,
      };
      let value = initial;
      let expectations: CanonicalExpectation[] = [
        {
          kind: "profile-revision",
          profileId: initial.profile.id,
          revision: 1,
        },
      ];
      if (mode === "missing revision") expectations = [];
      if (mode === "different revision") {
        expectations = [
          {
            kind: "profile-revision",
            profileId: initial.profile.id,
            revision: 2,
          },
        ];
      }
      if (mode === "different expectation profile") {
        expectations = [
          { kind: "profile-revision", profileId: "patch-other", revision: 1 },
        ];
      }
      if (mode === "different snapshot profile ID") {
        current = { ...current, profileId: "patch-other" };
      }
      if (mode === "different snapshot payload ID") {
        current = { ...current, profile: profile("patch-other") };
      }
      if (mode === "different next profile ID")
        value = profileValue("patch-other");
      if (mode === "retiring snapshot") {
        current = {
          ...current,
          state: "retiring",
          mergedIntoProfileId: "patch-other",
          mergedAtMs: 2_000,
        };
      }
      if (mode === "retiring next value") {
        value = {
          ...value,
          state: "retiring",
          mergedIntoProfileId: "patch-other",
          mergedAtMs: 2_000,
        };
      }
      const observed = observeAggregateDatabase();
      await expect(
        commitCanonicalPlan(observed.database, {
          expectations,
          mutations: [{ kind: "patch-active-profile", current, value }],
        }),
      ).rejects.toThrow("unsafe-canonical-commit-plan");
      expect(observed.batches).toHaveLength(0);
    });

    it.each(["patch", "full update"])(
      "rejects a patch and a duplicate %s for the same profile",
      async (mode) => {
        const current = await insertProfile("patch-duplicate");
        const plan = patchPlan(current);
        const observed = observeAggregateDatabase();
        await expect(
          commitCanonicalPlan(observed.database, {
            ...plan,
            mutations: [
              ...plan.mutations,
              mode === "patch"
                ? plan.mutations[0]
                : { kind: "update-active-profile", value: current },
            ],
          }),
        ).rejects.toThrow("unsafe-canonical-commit-plan");
        expect(observed.batches).toHaveLength(0);
        await expect(
          readCanonicalProfile(testEnv.PROFILE_DB, current.profileId),
        ).resolves.toEqual(current);
      },
    );

    it("increments the revision when a patch changes no stored values", async () => {
      const current = await insertProfile("patch-unchanged");
      const observed = observeAggregateDatabase();
      await commitCanonicalPlan(observed.database, patchPlan(current, current));
      expect(observed.batches.map((queries) => queries.length)).toEqual([5]);
      await expect(
        readCanonicalProfile(testEnv.PROFILE_DB, current.profileId),
      ).resolves.toEqual({ ...current, revision: current.revision + 1 });
    });

    it("rejects a stale patch without committing another profile or settlement", async () => {
      const current = await insertProfile("patch-stale");
      const other = await insertProfile("patch-unaffected");
      await commitCanonicalPlan(testEnv.PROFILE_DB, patchPlan(current));
      const advanced = await readCanonicalProfile(
        testEnv.PROFILE_DB,
        current.profileId,
      );
      const stalePlan = patchPlan(current, {
        ...current,
        profile: { ...current.profile, isTutorialCompleted: false },
        updatedAtMs: 3_000,
      });
      const otherPlan = patchPlan(other);
      const operationId = "patch-stale-settlement";
      const observed = observeD1FailureDatabase(testEnv.PROFILE_DB);
      const failure = await commitCanonicalPlan(observed.database, {
        expectations: [
          ...otherPlan.expectations,
          { kind: "wager-settlement-absent", operationId },
          ...stalePlan.expectations,
        ],
        mutations: [
          ...otherPlan.mutations,
          settlementMutation(operationId),
          ...stalePlan.mutations,
        ],
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CanonicalProfileConflict);
      expect(failure).toHaveProperty("cause", observed.errors[0]);
      expect(classifyD1Failure(observed.errors[0])).toBe("profile-conflict");
      expect(observed.sessions).toEqual([]);
      await expect(
        readCanonicalProfile(testEnv.PROFILE_DB, current.profileId),
      ).resolves.toEqual(advanced);
      await expect(
        readCanonicalProfile(testEnv.PROFILE_DB, other.profileId),
      ).resolves.toEqual(other);
      await expect(
        readCanonicalWagerSettlement(testEnv.PROFILE_DB, operationId),
      ).resolves.toBeNull();
    });

    it.each(["frozen", "retired"])(
      "rejects a patch when its database state becomes %s",
      async (mode) => {
        const current = await insertProfile("patch-state-guard");
        if (mode === "frozen") {
          await testEnv.PROFILE_DB.prepare(
            "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
          ).run();
        } else {
          await testEnv.PROFILE_DB.prepare(
            `UPDATE profile_records SET state = 'retiring',
             merged_into_profile_id = 'patch-other', merged_at_ms = 2_000
             WHERE profile_id = ?`,
          )
            .bind(current.profileId)
            .run();
        }
        const before = await readCanonicalProfile(
          testEnv.PROFILE_DB,
          current.profileId,
        );
        const observed = observeD1FailureDatabase(testEnv.PROFILE_DB);
        try {
          const failure = await commitCanonicalPlan(
            observed.database,
            patchPlan(current),
          ).catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(
            mode === "frozen"
              ? ProfileWritesDisabledFailure
              : CanonicalProfileCorruption,
          );
          expect(failure).toHaveProperty("cause", observed.errors[0]);
          expect(classifyD1Failure(observed.errors[0])).toBe("guard");
          expect(observed.sessions).toEqual(["first-primary"]);
          await expect(
            readCanonicalProfile(testEnv.PROFILE_DB, current.profileId),
          ).resolves.toEqual(before);
        } finally {
          if (mode === "frozen") {
            await testEnv.PROFILE_DB.prepare(
              "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
            ).run();
          }
        }
      },
    );

    it("rolls a patch and settlement back when the final topology guard fails", async () => {
      const current = await insertProfile("patch-topology");
      const operationId = "patch-topology-settlement";
      const plan = patchPlan(current);
      await testEnv.PROFILE_DB.prepare(
        `CREATE TRIGGER patch_test_profile_topology
         AFTER UPDATE OF payload_json ON profile_records
         BEGIN
           UPDATE profile_records SET state = 'retiring',
             merged_into_profile_id = 'patch-other', merged_at_ms = 2_000
           WHERE profile_id = NEW.profile_id;
         END`,
      ).run();
      const observed = observeD1FailureDatabase(testEnv.PROFILE_DB);
      try {
        const failure = await commitCanonicalPlan(observed.database, {
          expectations: [
            { kind: "wager-settlement-absent", operationId },
            ...plan.expectations,
          ],
          mutations: [settlementMutation(operationId), ...plan.mutations],
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CanonicalProfileCorruption);
        expect(failure).toHaveProperty("cause", observed.errors[0]);
        expect(classifyD1Failure(observed.errors[0])).toBe("guard");
        expect(observed.sessions).toEqual(["first-primary"]);
        await expect(
          readCanonicalProfile(testEnv.PROFILE_DB, current.profileId),
        ).resolves.toEqual(current);
        await expect(
          readCanonicalWagerSettlement(testEnv.PROFILE_DB, operationId),
        ).resolves.toBeNull();
      } finally {
        await testEnv.PROFILE_DB.prepare(
          "DROP TRIGGER IF EXISTS patch_test_profile_topology",
        ).run();
      }
    });
  });

  it("roundtrips every profile write field on insert and update", async () => {
    const profileId = "canonical-profile-fields";
    const initial = profileValue(profileId, {
      profile: profile(profileId, { username: "InitialFields", emoji: 3 }),
      createdAtMs: 101,
      updatedAtMs: 202,
      legacyFields: { opaque: ["initial", null, { preserved: true }] },
      sortPresence: {
        rating: true,
        mp: true,
        nonce: false,
        dust: true,
        slime: false,
        gum: true,
        metal: true,
        ice: true,
      },
      sortValues: {
        rating: 1411,
        mp: null,
        nonce: null,
        dust: 23,
        slime: null,
        gum: 0,
        metal: 73,
        ice: 91,
      },
      winPresent: false,
      emojiPresent: true,
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [{ kind: "profile-absent", profileId }],
      mutations: [{ kind: "insert-active-profile", value: initial }],
    });
    await expect(
      readCanonicalProfile(testEnv.PROFILE_DB, profileId),
    ).resolves.toEqual({
      ...initial,
      profileId,
      revision: 1,
    });
    const updated = profileValue(profileId, {
      profile: profile(profileId, {
        username: "UpdatedFields",
        win: false,
        completedProblemIds: ["two", "three"],
        isTutorialCompleted: false,
      }),
      createdAtMs: 303,
      updatedAtMs: 404,
      legacyFields: { opaque: ["updated", { values: [0, false, null] }] },
      sortPresence: {
        rating: false,
        mp: true,
        nonce: true,
        dust: false,
        slime: true,
        gum: true,
        metal: true,
        ice: false,
      },
      sortValues: {
        rating: null,
        mp: 52,
        nonce: 63,
        dust: null,
        slime: 85,
        gum: null,
        metal: 0,
        ice: null,
      },
      winPresent: true,
      emojiPresent: false,
      gameplayEmoji: "legacy-emoji",
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [{ kind: "profile-revision", profileId, revision: 1 }],
      mutations: [{ kind: "update-active-profile", value: updated }],
    });
    await expect(
      readCanonicalProfile(testEnv.PROFILE_DB, profileId),
    ).resolves.toEqual({
      ...updated,
      profileId,
      revision: 2,
    });
  });

  it("rejects unsafe plans and missing-row updates", async () => {
    const value = profileValue("canonical-unsafe-plan");
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [],
        mutations: [{ kind: "update-active-profile", value }],
      }),
    ).rejects.toThrow("unsafe-canonical-commit-plan");
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: value.profile.id,
            revision: 1,
          },
        ],
        mutations: [{ kind: "update-active-profile", value }],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, value.profile.id),
    ).toBeNull();
  });

  it("enforces explicit profile lifecycle transitions", async () => {
    const source = profileValue("canonical-lifecycle-source");
    const target = profileValue("canonical-lifecycle-target");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: source.profile.id },
        { kind: "profile-absent", profileId: target.profile.id },
      ],
      mutations: [
        { kind: "insert-active-profile", value: source },
        { kind: "insert-active-profile", value: target },
      ],
    });
    await expect(
      testEnv.PROFILE_DB.prepare(
        "DELETE FROM profile_records WHERE profile_id = ?",
      )
        .bind(source.profile.id)
        .run(),
    ).rejects.toThrow();
    const sourceSnapshot = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      source.profile.id,
    );
    const targetSnapshot = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      target.profile.id,
    );
    if (!sourceSnapshot || !targetSnapshot) throw new Error("missing profiles");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: sourceSnapshot.profileId,
          revision: sourceSnapshot.revision,
        },
        {
          kind: "profile-revision",
          profileId: targetSnapshot.profileId,
          revision: targetSnapshot.revision,
        },
        {
          kind: "merge-target-absent",
          sourceProfileId: sourceSnapshot.profileId,
        },
      ],
      mutations: [
        {
          kind: "retire-profile-with-redirect",
          profile: materializeCanonicalProfile({
            ...sourceSnapshot,
            state: "retiring",
            mergedIntoProfileId: targetSnapshot.profileId,
            mergedAtMs: 2_000,
            updatedAtMs: 2_000,
          }),
          redirect: {
            sourceProfileId: sourceSnapshot.profileId,
            targetProfileId: targetSnapshot.profileId,
            mergedAtMs: 2_000,
            opId: "canonical-lifecycle-merge",
            sourceLegacyFields: sourceSnapshot.legacyFields,
          },
        },
      ],
    });
    const retired = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      source.profile.id,
    );
    if (!retired) throw new Error("missing retired profile");
    expect(retired).toEqual({
      ...sourceSnapshot,
      state: "retiring",
      mergedIntoProfileId: targetSnapshot.profileId,
      mergedAtMs: 2_000,
      updatedAtMs: 2_000,
      revision: sourceSnapshot.revision + 1,
    });
    await expect(
      readCanonicalProfileAggregateSnapshot(
        testEnv.PROFILE_DB,
        source.profile.id,
      ),
    ).resolves.toMatchObject({
      profile: retired,
      mergeTarget: { targetProfileId: target.profile.id },
    });
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: retired.profileId,
            revision: retired.revision,
          },
        ],
        mutations: [
          {
            kind: "update-active-profile",
            value: source,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: retired.profileId,
            revision: retired.revision,
          },
        ],
        mutations: [
          {
            kind: "delete-retired-profile",
            profileId: retired.profileId,
            targetProfileId: targetSnapshot.profileId,
          },
        ],
      }),
    ).rejects.toThrow("unsafe-canonical-commit-plan");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: retired.profileId,
          revision: retired.revision,
        },
        {
          kind: "merge-target",
          sourceProfileId: retired.profileId,
          targetProfileId: targetSnapshot.profileId,
        },
      ],
      mutations: [
        {
          kind: "delete-retired-profile",
          profileId: retired.profileId,
          targetProfileId: targetSnapshot.profileId,
        },
      ],
    });
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, source.profile.id),
    ).toBeNull();
    await expect(
      readCanonicalProfileAggregateSnapshot(
        testEnv.PROFILE_DB,
        source.profile.id,
      ),
    ).resolves.toEqual({
      profile: null,
      loginOwners: [],
      authMethods: [],
      februaryOpponentProfileIds: [],
      mergeTarget: {
        sourceProfileId: source.profile.id,
        targetProfileId: target.profile.id,
        mergedAtMs: 2_000,
        opId: "canonical-lifecycle-merge",
      },
      recovery: null,
    });
    await expect(
      readCanonicalMergeTarget(testEnv.PROFILE_DB, source.profile.id),
    ).resolves.toMatchObject({ targetProfileId: target.profile.id });
    const ownership = await readCanonicalProfileOwnershipSnapshot(
      testEnv.PROFILE_DB,
      {
        loginUids: [],
        profileIds: [source.profile.id, target.profile.id],
      },
    );
    expect(
      [source.profile.id, target.profile.id].map((profileId) =>
        ownership.canonicalProfileIdByProfileId.get(profileId),
      ),
    ).toEqual([target.profile.id, target.profile.id]);
  });

  it("resolves a merge chain after every retired source is deleted", async () => {
    const profileIds = [
      "canonical-deleted-chain-source",
      "canonical-deleted-chain-middle",
      "canonical-deleted-chain-target",
    ];
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: profileIds.map((profileId) => ({
        kind: "profile-absent" as const,
        profileId,
      })),
      mutations: profileIds.map((profileId) => ({
        kind: "insert-active-profile" as const,
        value: profileValue(profileId),
      })),
    });

    for (let index = 0; index < profileIds.length - 1; index += 1) {
      const sourceProfileId = profileIds[index];
      const targetProfileId = profileIds[index + 1];
      const source = await readCanonicalProfile(
        testEnv.PROFILE_DB,
        sourceProfileId,
      );
      const target = await readCanonicalProfile(
        testEnv.PROFILE_DB,
        targetProfileId,
      );
      if (!source || !target) throw new Error("missing chain profile");
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: sourceProfileId,
            revision: source.revision,
          },
          {
            kind: "profile-revision",
            profileId: targetProfileId,
            revision: target.revision,
          },
          { kind: "merge-target-absent", sourceProfileId },
        ],
        mutations: [
          {
            kind: "retire-profile-with-redirect",
            profile: materializeCanonicalProfile({
              ...source,
              mergedAtMs: 2_000 + index,
              mergedIntoProfileId: targetProfileId,
              state: "retiring",
              updatedAtMs: 2_000 + index,
            }),
            redirect: {
              mergedAtMs: 2_000 + index,
              opId: `deleted-chain-${index}`,
              sourceLegacyFields: source.legacyFields,
              sourceProfileId,
              targetProfileId,
            },
          },
        ],
      });
      const retired = await readCanonicalProfile(
        testEnv.PROFILE_DB,
        sourceProfileId,
      );
      if (!retired) throw new Error("missing retired chain profile");
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: sourceProfileId,
            revision: retired.revision,
          },
          { kind: "merge-target", sourceProfileId, targetProfileId },
        ],
        mutations: [
          {
            kind: "delete-retired-profile",
            profileId: sourceProfileId,
            targetProfileId,
          },
        ],
      });
    }

    const ownership = await readCanonicalProfileOwnershipSnapshot(
      testEnv.PROFILE_DB,
      { loginUids: [], profileIds },
    );
    expect(
      profileIds.map((profileId) =>
        ownership.canonicalProfileIdByProfileId.get(profileId),
      ),
    ).toEqual(profileIds.map(() => profileIds.at(-1)));
    for (const resolve of [
      resolveCanonicalProfile,
      resolveCanonicalPublicProfile,
    ]) {
      const observed = observeAggregateDatabase({ mapAll: (rows) => rows });
      await expect(
        resolve(observed.database, profileIds[0], 2),
      ).resolves.toMatchObject({ profileId: profileIds[2] });
      expect(observed.allQueries).toHaveLength(1);
      expect(observed.batches).toHaveLength(0);
      await expect(
        resolve(testEnv.PROFILE_DB, profileIds[0], 2.5),
      ).resolves.toMatchObject({ profileId: profileIds[2] });
      await expect(
        resolve(testEnv.PROFILE_DB, profileIds[0], 1),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      await expect(
        resolve(testEnv.PROFILE_DB, profileIds[0], 1, "null"),
      ).resolves.toBeNull();
    }
  });

  it("materializes public defaults and rejects public or emoji drift", async () => {
    const value = materializeCanonicalProfile({
      profile: profile("canonical-public-defaults", {
        nonce: 9,
        rating: 9,
        totalManaPoints: 9,
        win: false,
        mining: {
          lastRockDate: "2026-08-28",
          materials: { dust: 9, slime: 9, gum: 9, metal: 9, ice: 9 },
        },
      }),
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      sortPresence: {
        rating: true,
        nonce: true,
        mp: false,
        dust: true,
        slime: true,
        gum: true,
        metal: true,
        ice: true,
      },
      sortValues: {
        rating: 0,
        nonce: null,
        dust: null,
        slime: 0,
        gum: null,
        metal: 0,
        ice: null,
      },
      winPresent: false,
    });
    expect(value.profile).toMatchObject({
      nonce: -1,
      rating: 1500,
      totalManaPoints: 0,
      win: true,
      mining: {
        materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    });
    expect(value.sortValues).toMatchObject({
      rating: 0,
      nonce: null,
      mp: null,
    });
    expect(value.gameplayEmoji).toBe(value.profile.emoji);
    const fallbackEmoji = materializeCanonicalProfile({
      profile: profile("canonical-fallback-emoji", { emoji: 99 }),
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      emojiPresent: false,
      gameplayEmoji: 7,
    });
    expect(fallbackEmoji.profile.emoji).toBe(
      getProfileFallbackEmojiId(fallbackEmoji.profile.id),
    );
    expect(fallbackEmoji.gameplayEmoji).toBe(7);

    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [{ kind: "profile-absent", profileId: value.profile.id }],
        mutations: [
          {
            kind: "insert-active-profile",
            value: {
              ...value,
              profile: { ...value.profile, rating: 0 },
            },
          },
        ],
      }),
    ).rejects.toThrow("invalid-canonical-public-profile");
    expect(() =>
      materializeCanonicalProfile({
        profile: profile("canonical-emoji-mismatch"),
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        gameplayEmoji: 3,
      }),
    ).toThrow("invalid-canonical-public-profile");

    const emojiValue = profileValue("canonical-emoji-drift");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: value.profile.id },
        { kind: "profile-absent", profileId: emojiValue.profile.id },
      ],
      mutations: [
        { kind: "insert-active-profile", value },
        { kind: "insert-active-profile", value: emojiValue },
      ],
    });
    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_records
       SET payload_json = json_set(payload_json, '$.rating', 0)
       WHERE profile_id = ?`,
    )
      .bind(value.profile.id)
      .run();
    await expect(
      readCanonicalProfile(testEnv.PROFILE_DB, value.profile.id),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_records SET gameplay_emoji_json = '3'
       WHERE profile_id = ?`,
    )
      .bind(emojiValue.profile.id)
      .run();
    await expect(
      readCanonicalProfile(testEnv.PROFILE_DB, emojiValue.profile.id),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
  });

  it("rejects duplicate login, method, and username ownership", async () => {
    const first = profileValue("canonical-owner-a", {
      profile: profile("canonical-owner-a", { username: "SharedName" }),
    });
    const second = profileValue("canonical-owner-b", {
      profile: profile("canonical-owner-b", { username: "OtherName" }),
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: first.profile.id },
        { kind: "profile-absent", profileId: second.profile.id },
        { kind: "login-owner-absent", loginUid: "shared-login" },
        {
          kind: "auth-method-absent",
          method: "sol",
          normalizedValue: "shared-sol",
        },
      ],
      mutations: [
        { kind: "insert-active-profile", value: first },
        { kind: "insert-active-profile", value: second },
        {
          kind: "insert-login-owner",
          value: {
            loginUid: "shared-login",
            profileId: first.profile.id,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        },
        {
          kind: "insert-auth-method",
          value: {
            method: "sol",
            normalizedValue: "shared-sol",
            profileId: first.profile.id,
            rawValue: "shared-sol",
            appleEmailMasked: null,
            xUsername: null,
            linkedAtMs: null,
            consentAtMs: null,
            consentSource: null,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        },
      ],
    });

    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          { kind: "login-owner-absent", loginUid: "shared-login" },
        ],
        mutations: [
          {
            kind: "insert-login-owner",
            value: {
              loginUid: "shared-login",
              profileId: second.profile.id,
              createdAtMs: 2,
              updatedAtMs: 2,
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "auth-method-absent",
            method: "sol",
            normalizedValue: "shared-sol",
          },
        ],
        mutations: [
          {
            kind: "insert-auth-method",
            value: {
              method: "sol",
              normalizedValue: "shared-sol",
              profileId: second.profile.id,
              rawValue: "shared-sol",
              appleEmailMasked: null,
              xUsername: null,
              linkedAtMs: null,
              consentAtMs: null,
              consentSource: null,
              createdAtMs: 2,
              updatedAtMs: 2,
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          { kind: "profile-absent", profileId: "canonical-owner-c" },
        ],
        mutations: [
          {
            kind: "insert-active-profile",
            value: profileValue("canonical-owner-c", {
              profile: profile("canonical-owner-c", {
                username: "sharedname",
              }),
            }),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
  });

  it("guards and moves login owners with constant-size statements", async () => {
    const source = profileValue("canonical-owner-set-source");
    const target = profileValue("canonical-owner-set-target");
    const loginUids = [
      ...Array.from(
        { length: 120 },
        (_, index) => `owner-set-${String(index).padStart(3, "0")}`,
      ),
      "owner-set-\u{10000}",
      "owner-set-\u{e000}",
    ];
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: source.profile.id },
        { kind: "profile-absent", profileId: target.profile.id },
        ...loginUids.map((loginUid) => ({
          kind: "login-owner-absent" as const,
          loginUid,
        })),
      ],
      mutations: [
        { kind: "insert-active-profile", value: source },
        { kind: "insert-active-profile", value: target },
        ...loginUids.map((loginUid) => ({
          kind: "insert-login-owner" as const,
          value: {
            loginUid,
            profileId: source.profile.id,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        })),
      ],
    });
    const sourceAggregate = await readCanonicalProfileAggregate(
      testEnv.PROFILE_DB,
      source.profile.id,
    );
    const targetAggregate = await readCanonicalProfileAggregate(
      testEnv.PROFILE_DB,
      target.profile.id,
    );
    const plan = {
      expectations: [
        {
          kind: "login-owner-set" as const,
          profileId: source.profile.id,
          owners: sourceAggregate.loginOwners,
        },
        {
          kind: "login-owner-set" as const,
          profileId: target.profile.id,
          owners: targetAggregate.loginOwners,
        },
      ],
      mutations: [
        {
          kind: "move-login-owner-set" as const,
          sourceProfileId: source.profile.id,
          targetProfileId: target.profile.id,
          updatedAtMs: 2_000,
        },
      ],
    };
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          ...plan.expectations,
          {
            kind: "login-owner-revision",
            loginUid: sourceAggregate.loginOwners[0].loginUid,
            profileId: source.profile.id,
            revision: sourceAggregate.loginOwners[0].revision,
          },
        ],
        mutations: [
          ...plan.mutations,
          {
            kind: "delete-login-owner",
            loginUid: sourceAggregate.loginOwners[0].loginUid,
          },
        ],
      }),
    ).rejects.toThrow("unsafe-canonical-commit-plan");
    await commitCanonicalPlan(testEnv.PROFILE_DB, plan);

    const moved = await readCanonicalProfileAggregate(
      testEnv.PROFILE_DB,
      target.profile.id,
    );
    expect(moved.loginOwners).toHaveLength(loginUids.length);
    expect(moved.loginOwners[0]).toMatchObject({
      profileId: target.profile.id,
      revision: 2,
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
    });
    const unicodeLoginUids = loginUids.slice(-2);
    const ownership = await readCanonicalProfileOwnershipSnapshot(
      testEnv.PROFILE_DB,
      {
        loginUids: unicodeLoginUids,
        profileIds: [source.profile.id, target.profile.id],
      },
    );
    expect(
      unicodeLoginUids.map(
        (loginUid) => ownership.loginOwnerByUid.get(loginUid)?.profileId,
      ),
    ).toEqual(unicodeLoginUids.map(() => target.profile.id));
    expect(ownership.loginOwnersByProfileId.get(source.profile.id)).toEqual([]);
    expect(
      ownership.loginOwnersByProfileId.get(target.profile.id),
    ).toHaveLength(loginUids.length);
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, plan),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
  });

  it("does not impose a product limit on login owners", async () => {
    const profileId = "canonical-owner-unbounded";
    const initialLoginUids = Array.from(
      { length: 512 },
      (_, index) => `unbounded-owner-${index}`,
    );
    const finalLoginUid = "unbounded-owner-512";
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [{ kind: "profile-absent", profileId }],
      mutations: [
        { kind: "insert-active-profile", value: profileValue(profileId) },
      ],
    });
    const ownerStatements = initialLoginUids.map((loginUid) =>
      testEnv.PROFILE_DB.prepare(
        `INSERT INTO profile_login_owners (
             login_uid, profile_id, revision, created_at_ms, updated_at_ms
           ) VALUES (?, ?, 1, 1, 1)`,
      ).bind(loginUid, profileId),
    );
    for (let offset = 0; offset < ownerStatements.length; offset += 100) {
      await testEnv.PROFILE_DB.batch(
        ownerStatements.slice(offset, offset + 100),
      );
    }

    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "login-owner-absent",
            loginUid: finalLoginUid,
          },
        ],
        mutations: [
          {
            kind: "insert-login-owner",
            value: {
              loginUid: finalLoginUid,
              profileId,
              createdAtMs: 2,
              updatedAtMs: 2,
            },
          },
        ],
      }),
    ).resolves.toBeUndefined();
    const ownerCount = await testEnv.PROFILE_DB.prepare(
      "SELECT COUNT(*) AS count FROM profile_login_owners WHERE profile_id = ?",
    )
      .bind(profileId)
      .first<{ count: number }>();
    expect(ownerCount?.count).toBe(513);
    const loginUids = [...initialLoginUids, finalLoginUid];
    const ownership = await readCanonicalProfileOwnershipSnapshot(
      testEnv.PROFILE_DB,
      { loginUids, profileIds: [profileId] },
    );
    expect(
      loginUids.every(
        (loginUid) =>
          ownership.loginOwnerByUid.get(loginUid)?.profileId === profileId,
      ),
    ).toBe(true);
    expect(ownership.loginOwnersByProfileId.get(profileId)).toHaveLength(513);
    expect(ownership.profileById.get(profileId)?.profileId).toBe(profileId);
  });

  it("returns one coherent aggregate without waiting for later writes to settle", async () => {
    const value = profileValue("canonical-snapshot-profile", {
      emojiPresent: false,
      gameplayEmoji: 17,
      winPresent: false,
      sortPresence: { rating: false, nonce: false, mp: true },
      sortValues: { mp: null },
      legacyFields: { imported: { emoji: "" }, opaque: [1, null] },
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [{ kind: "profile-absent", profileId: value.profile.id }],
      mutations: [{ kind: "insert-active-profile", value }],
    });
    const expected = await readCanonicalProfileAggregate(
      testEnv.PROFILE_DB,
      value.profile.id,
    );
    const observed = observeAggregateDatabase({
      afterBatch: async () => {
        await commitCanonicalPlan(testEnv.PROFILE_DB, {
          expectations: [
            {
              kind: "profile-revision",
              profileId: value.profile.id,
              revision: 1,
            },
          ],
          mutations: [
            {
              kind: "update-active-profile",
              value: { ...value, updatedAtMs: 2_000 },
            },
          ],
        });
      },
    });
    const snapshot = await readCanonicalProfileAggregateSnapshot(
      observed.database,
      value.profile.id,
    );
    expect(snapshot).toEqual(expected);
    expect(observed.batches.map((queries) => queries.length)).toEqual([6]);
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: value.profile.id,
            revision: snapshot.profile!.revision,
          },
        ],
        mutations: [{ kind: "update-active-profile", value }],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, value.profile.id))
        ?.revision,
    ).toBe(2);
  });

  it("reads aggregate groups in input order, including duplicates and missing profiles", async () => {
    const first = profileValue("bulk-aggregate-first");
    const second = profileValue("bulk-aggregate-second");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [first, second].map((value) => ({
        kind: "profile-absent",
        profileId: value.profile.id,
      })),
      mutations: [first, second].map((value) => ({
        kind: "insert-active-profile",
        value,
      })),
    });
    const observed = observeAggregateDatabase();
    const aggregates = await readCanonicalProfileAggregates(observed.database, [
      second.profile.id,
      "missing-bulk-profile",
      first.profile.id,
      second.profile.id,
    ]);
    expect(
      aggregates.map((aggregate) => aggregate.profile?.profileId ?? null),
    ).toEqual([second.profile.id, null, first.profile.id, second.profile.id]);
    expect(aggregates[0]).toEqual(aggregates[3]);
    expect(aggregates[0]).not.toBe(aggregates[3]);
    expect(observed.batches.map((queries) => queries.length)).toEqual([24]);

    const checked = observeAggregateDatabase();
    await expect(
      readCanonicalProfileAggregateSnapshots(checked.database, [
        second.profile.id,
        first.profile.id,
      ]),
    ).resolves.toEqual([aggregates[0], aggregates[2]]);
    expect(checked.batches.map((queries) => queries.length)).toEqual([12]);
  });

  it("skips D1 for empty raw and checked aggregate groups", async () => {
    const observed = observeAggregateDatabase();
    await expect(
      readCanonicalProfileAggregates(observed.database, []),
    ).resolves.toEqual([]);
    await expect(
      readCanonicalProfileAggregateSnapshots(observed.database, []),
    ).resolves.toEqual([]);
    expect(observed.batches).toHaveLength(0);
  });

  it("checks every aggregate topology only in the checked bulk reader", async () => {
    const first = profileValue("bulk-topology-first");
    const second = profileValue("bulk-topology-second");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [first, second].map((value) => ({
        kind: "profile-absent",
        profileId: value.profile.id,
      })),
      mutations: [first, second].map((value) => ({
        kind: "insert-active-profile",
        value,
      })),
    });
    const observed = observeAggregateDatabase({
      mapResults: (_queries, results) =>
        results.map((result) => ({
          ...result,
          results: result.results.map((row) =>
            row.profile_id === second.profile.id && "payload_json" in row
              ? {
                  ...row,
                  state: "retiring",
                  merged_into_profile_id: first.profile.id,
                  merged_at_ms: 2_000,
                }
              : row,
          ),
        })),
    });
    const profileIds = [first.profile.id, second.profile.id];
    const raw = await readCanonicalProfileAggregates(
      observed.database,
      profileIds,
    );
    expect(raw[1]).toMatchObject({
      profile: { state: "retiring" },
      mergeTarget: null,
    });
    await expect(
      readCanonicalProfileAggregateSnapshots(observed.database, profileIds),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    expect(observed.batches.map((queries) => queries.length)).toEqual([12, 12]);
  });

  it("reads missing profiles and logins in one batch each", async () => {
    const direct = observeAggregateDatabase();
    await expect(
      readCanonicalProfileAggregateSnapshot(
        direct.database,
        "missing-snapshot-profile",
      ),
    ).resolves.toEqual({
      profile: null,
      loginOwners: [],
      authMethods: [],
      februaryOpponentProfileIds: [],
      mergeTarget: null,
      recovery: null,
    });
    expect(direct.batches.map((queries) => queries.length)).toEqual([6]);
    const byLogin = observeAggregateDatabase();
    await expect(
      readCanonicalProfileAggregateByLogin(
        byLogin.database,
        "missing-snapshot-login",
      ),
    ).resolves.toBeNull();
    expect(byLogin.batches.map((queries) => queries.length)).toEqual([7]);
  });

  it.each(["before", "after"] as const)(
    "reads the complete old or new aggregate when an owner merges %s the batch",
    async (timing) => {
      const source = profileValue("snapshot-merge-source");
      const target = profileValue("snapshot-merge-target");
      const loginUid = "snapshot-merge-login";
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          { kind: "profile-absent", profileId: source.profile.id },
          { kind: "profile-absent", profileId: target.profile.id },
          { kind: "login-owner-absent", loginUid },
          {
            kind: "auth-method-absent",
            method: "sol",
            normalizedValue: "snapshot-sol",
          },
          {
            kind: "february-opponent-absent",
            profileId: target.profile.id,
            opponentProfileId: "snapshot-opponent",
          },
          { kind: "auth-recovery-absent", profileId: target.profile.id },
        ],
        mutations: [
          { kind: "insert-active-profile", value: source },
          { kind: "insert-active-profile", value: target },
          {
            kind: "insert-login-owner",
            value: {
              loginUid,
              profileId: source.profile.id,
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
            },
          },
          {
            kind: "insert-auth-method",
            value: {
              method: "sol",
              normalizedValue: "snapshot-sol",
              rawValue: "snapshot-sol",
              profileId: target.profile.id,
              appleEmailMasked: null,
              xUsername: null,
              linkedAtMs: null,
              consentAtMs: null,
              consentSource: null,
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
            },
          },
          {
            kind: "insert-february-opponent",
            profileId: target.profile.id,
            opponentProfileId: "snapshot-opponent",
            recordedAtMs: 1_000,
          },
          {
            kind: "insert-auth-recovery",
            value: {
              profileId: target.profile.id,
              loginUids: [],
              sourceProfileIds: [],
              sourcePhase: "finalize",
              prizeCursor: null,
              phaseStartedAtMs: 1_000,
              lastEnqueuedAtMs: 0,
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
            },
          },
        ],
      });
      const old = await readCanonicalProfileAggregateByLogin(
        testEnv.PROFILE_DB,
        loginUid,
      );
      let merged = 0;
      const merge = async () => {
        merged++;
        await commitCanonicalPlan(testEnv.PROFILE_DB, {
          expectations: [
            {
              kind: "profile-revision",
              profileId: source.profile.id,
              revision: 1,
            },
            {
              kind: "profile-revision",
              profileId: target.profile.id,
              revision: 1,
            },
            {
              kind: "login-owner-revision",
              loginUid,
              profileId: source.profile.id,
              revision: 1,
            },
            { kind: "merge-target-absent", sourceProfileId: source.profile.id },
          ],
          mutations: [
            {
              kind: "update-login-owner",
              value: {
                loginUid,
                profileId: target.profile.id,
                createdAtMs: 1_000,
                updatedAtMs: 2_000,
              },
            },
            {
              kind: "retire-profile-with-redirect",
              profile: materializeCanonicalProfile({
                ...source,
                state: "retiring",
                mergedIntoProfileId: target.profile.id,
                mergedAtMs: 2_000,
                updatedAtMs: 2_000,
              }),
              redirect: {
                sourceProfileId: source.profile.id,
                targetProfileId: target.profile.id,
                mergedAtMs: 2_000,
                opId: "snapshot-merge",
                sourceLegacyFields: source.legacyFields,
              },
            },
          ],
        });
      };
      const observed = observeAggregateDatabase(
        timing === "before" ? { beforeBatch: merge } : { afterBatch: merge },
      );
      const snapshot = await readCanonicalProfileAggregateByLogin(
        observed.database,
        loginUid,
      );
      const current = await readCanonicalProfileAggregateByLogin(
        testEnv.PROFILE_DB,
        loginUid,
      );
      expect(snapshot).toEqual(timing === "before" ? current : old);
      expect(current).toMatchObject({
        owner: { profileId: target.profile.id, revision: 2 },
        aggregate: {
          profile: { profileId: target.profile.id },
          loginOwners: [{ loginUid, profileId: target.profile.id }],
          authMethods: [{ method: "sol" }],
          februaryOpponentProfileIds: ["snapshot-opponent"],
          recovery: { profileId: target.profile.id },
        },
      });
      expect(merged).toBe(1);
      expect(observed.batches.map((queries) => queries.length)).toEqual([7]);
    },
  );

  it.each([
    ["orphaned owner", "profile_records", "missing"],
    ["invalid profile", "profile_records", "revision"],
    ["invalid owner", "profile_login_owners", "revision"],
    ["inactive owner", "profile_records", "retiring"],
    ["active redirect", "profile_merge_targets", "redirect"],
  ] as const)(
    "rejects %s in a transactional login snapshot",
    async (_name, table, corruption) => {
      const value = profileValue("snapshot-corruption-profile");
      const loginUid = "snapshot-corruption-login";
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          { kind: "profile-absent", profileId: value.profile.id },
          { kind: "login-owner-absent", loginUid },
        ],
        mutations: [
          { kind: "insert-active-profile", value },
          {
            kind: "insert-login-owner",
            value: {
              loginUid,
              profileId: value.profile.id,
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
            },
          },
        ],
      });
      const observed = observeAggregateDatabase({
        mapResults: (queries, results) =>
          results.map((result, index) => {
            if (/\bFROM\s+([a-z_]+)/i.exec(queries[index])?.[1] !== table)
              return result;
            if (corruption === "missing") return { ...result, results: [] };
            if (corruption === "redirect")
              return {
                ...result,
                results: [
                  {
                    source_profile_id: value.profile.id,
                    target_profile_id: "different-profile",
                    merged_at_ms: 2_000,
                    op_id: null,
                  },
                ],
              };
            return {
              ...result,
              results: result.results.map((row) => ({
                ...row,
                ...(corruption === "revision"
                  ? { revision: 0 }
                  : {
                      state: "retiring",
                      merged_into_profile_id: "different-profile",
                      merged_at_ms: 2_000,
                    }),
              })),
            };
          }),
      });
      await expect(
        readCanonicalProfileAggregateByLogin(observed.database, loginUid),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      expect(observed.batches.map((queries) => queries.length)).toEqual([7]);
    },
  );

  it("resolves bulk ownership in one transactional batch", async () => {
    const value = profileValue("canonical-bulk-owner");
    const loginUids = Array.from(
      { length: 40 },
      (_, index) => `canonical-bulk-login-${index}`,
    );
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: value.profile.id },
        ...loginUids.map((loginUid) => ({
          kind: "login-owner-absent" as const,
          loginUid,
        })),
      ],
      mutations: [
        { kind: "insert-active-profile", value },
        ...loginUids.map((loginUid) => ({
          kind: "insert-login-owner" as const,
          value: {
            loginUid,
            profileId: value.profile.id,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        })),
      ],
    });
    let batchReads = 0;
    let preparedReads = 0;
    const preparedQueries: string[] = [];
    const countingDb = new Proxy(testEnv.PROFILE_DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batchReads += 1;
            return target.batch(statements);
          };
        }
        if (property === "prepare") {
          return (query: string) => {
            preparedReads += 1;
            preparedQueries.push(query);
            return target.prepare(query);
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });

    const ownership = await readCanonicalProfileOwnershipSnapshot(countingDb, {
      loginUids,
      profileIds: [value.profile.id, "canonical-bulk-missing"],
    });
    expect(
      loginUids.every(
        (loginUid) =>
          ownership.loginOwnerByUid.get(loginUid)?.profileId ===
          value.profile.id,
      ),
    ).toBe(true);
    expect(ownership.loginOwnersByProfileId.get(value.profile.id)).toHaveLength(
      loginUids.length,
    );
    expect(ownership.profileById.get(value.profile.id)).toMatchObject({
      profileId: value.profile.id,
      state: "active",
    });
    expect(ownership.canonicalProfileIdByProfileId.get(value.profile.id)).toBe(
      value.profile.id,
    );
    expect(
      ownership.canonicalProfileIdByProfileId.get("canonical-bulk-missing"),
    ).toBeNull();
    expect(batchReads).toBe(1);
    expect(preparedReads).toBe(4);
    expect(
      preparedQueries.every(
        (query) =>
          !query.includes("legacy_fields_json") && !query.includes("profile.*"),
      ),
    ).toBe(true);
  });

  it("resolves redirects and rejects unsafe merge topology", async () => {
    const target = profileValue("canonical-redirect-target");
    const sourceLegacyFields = {
      authMetadata: { rawWallet: " 0xSourceWallet " },
    };
    const source = profileValue("canonical-redirect-source", {
      profile: profile("canonical-redirect-source", { username: null }),
      legacyFields: sourceLegacyFields,
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: target.profile.id },
        { kind: "profile-absent", profileId: source.profile.id },
      ],
      mutations: [
        { kind: "insert-active-profile", value: target },
        { kind: "insert-active-profile", value: source },
      ],
    });
    const sourceSnapshot = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      source.profile.id,
    );
    const targetSnapshot = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      target.profile.id,
    );
    if (!sourceSnapshot || !targetSnapshot) throw new Error("missing profiles");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: sourceSnapshot.profileId,
          revision: sourceSnapshot.revision,
        },
        {
          kind: "profile-revision",
          profileId: targetSnapshot.profileId,
          revision: targetSnapshot.revision,
        },
        {
          kind: "merge-target-absent",
          sourceProfileId: sourceSnapshot.profileId,
        },
      ],
      mutations: [
        {
          kind: "retire-profile-with-redirect",
          profile: materializeCanonicalProfile({
            ...sourceSnapshot,
            state: "retiring",
            mergedIntoProfileId: targetSnapshot.profileId,
            mergedAtMs: 2_000,
            updatedAtMs: 2_000,
          }),
          redirect: {
            sourceProfileId: sourceSnapshot.profileId,
            targetProfileId: targetSnapshot.profileId,
            mergedAtMs: 2_000,
            opId: "merge-redirect",
            sourceLegacyFields: sourceSnapshot.legacyFields,
          },
        },
      ],
    });
    expect(
      (await resolveCanonicalProfile(testEnv.PROFILE_DB, source.profile.id))
        ?.profileId,
    ).toBe(target.profile.id);
    await expect(
      readCanonicalMergeTarget(testEnv.PROFILE_DB, source.profile.id),
    ).resolves.toEqual({
      sourceProfileId: source.profile.id,
      targetProfileId: target.profile.id,
      mergedAtMs: 2_000,
      opId: "merge-redirect",
    });
    const archive = await testEnv.PROFILE_DB.prepare(
      `SELECT source_legacy_fields_json
       FROM profile_merge_targets WHERE source_profile_id = ?`,
    )
      .bind(source.profile.id)
      .first<{ source_legacy_fields_json: string }>();
    expect(JSON.parse(archive?.source_legacy_fields_json || "null")).toEqual(
      sourceLegacyFields,
    );
    await expect(
      testEnv.PROFILE_DB.prepare(
        `INSERT INTO profile_merge_targets (
           source_profile_id, target_profile_id, merged_at_ms, op_id,
           source_legacy_fields_json
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source_profile_id) DO NOTHING`,
      )
        .bind(
          source.profile.id,
          target.profile.id,
          2_000,
          "merge-redirect",
          JSON.stringify(sourceSnapshot.legacyFields),
        )
        .run(),
    ).resolves.toBeDefined();
    await expect(
      testEnv.PROFILE_DB.prepare(
        `INSERT OR REPLACE INTO profile_merge_targets (
           source_profile_id, target_profile_id, merged_at_ms,
           source_legacy_fields_json
         ) VALUES (?, ?, ?, '{}')`,
      )
        .bind(source.profile.id, "replacement-target", 3_000)
        .run(),
    ).rejects.toThrow();

    const activeSource = profileValue("canonical-active-mapping-source");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: activeSource.profile.id },
      ],
      mutations: [{ kind: "insert-active-profile", value: activeSource }],
    });
    await expect(
      testEnv.PROFILE_DB.prepare(
        `INSERT INTO profile_merge_targets (
           source_profile_id, target_profile_id, merged_at_ms,
           source_legacy_fields_json
         ) VALUES (?, ?, ?, '{}')`,
      )
        .bind(activeSource.profile.id, target.profile.id, 2_500)
        .run(),
    ).rejects.toThrow();
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "merge-target-absent",
            sourceProfileId: activeSource.profile.id,
          },
          {
            kind: "profile-revision",
            profileId: target.profile.id,
            revision: 1,
          },
        ],
        mutations: [
          {
            kind: "retire-profile-with-redirect",
            profile: materializeCanonicalProfile({
              ...activeSource,
              state: "retiring",
              mergedIntoProfileId: target.profile.id,
              mergedAtMs: 2_500,
              updatedAtMs: 2_500,
            }),
            redirect: {
              sourceProfileId: activeSource.profile.id,
              targetProfileId: target.profile.id,
              mergedAtMs: 2_500,
              opId: null,
              sourceLegacyFields: activeSource.legacyFields,
            },
          },
        ],
      }),
    ).rejects.toThrow("unsafe-canonical-commit-plan");

    const missingTargetSource = profileValue("canonical-missing-target-source");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-absent",
          profileId: missingTargetSource.profile.id,
        },
      ],
      mutations: [
        { kind: "insert-active-profile", value: missingTargetSource },
      ],
    });
    const missingSourceSnapshot = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      missingTargetSource.profile.id,
    );
    if (!missingSourceSnapshot) throw new Error("missing source");
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: missingSourceSnapshot.profileId,
            revision: missingSourceSnapshot.revision,
          },
          {
            kind: "profile-revision",
            profileId: "canonical-missing-target",
            revision: 1,
          },
          {
            kind: "merge-target-absent",
            sourceProfileId: missingSourceSnapshot.profileId,
          },
        ],
        mutations: [
          {
            kind: "retire-profile-with-redirect",
            profile: materializeCanonicalProfile({
              ...missingSourceSnapshot,
              state: "retiring",
              mergedIntoProfileId: "canonical-missing-target",
              mergedAtMs: 3_000,
              updatedAtMs: 3_000,
            }),
            redirect: {
              sourceProfileId: missingSourceSnapshot.profileId,
              targetProfileId: "canonical-missing-target",
              mergedAtMs: 3_000,
              opId: null,
              sourceLegacyFields: missingSourceSnapshot.legacyFields,
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    expect(
      (
        await readCanonicalProfile(
          testEnv.PROFILE_DB,
          missingSourceSnapshot.profileId,
        )
      )?.state,
    ).toBe("active");

    const chainExpectations: CanonicalExpectation[] = [];
    const chainMutations: CanonicalMutation[] = [];
    for (let index = 0; index <= 33; index += 1) {
      const profileId = `canonical-chain-${index}`;
      chainExpectations.push({ kind: "profile-absent", profileId });
      chainMutations.push({
        kind: "insert-active-profile",
        value: profileValue(profileId),
      });
    }
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: chainExpectations,
      mutations: chainMutations,
    });
    for (let index = 0; index < 32; index += 1) {
      const sourceProfileId = `canonical-chain-${index}`;
      const targetProfileId = `canonical-chain-${index + 1}`;
      const chainSource = await readCanonicalProfile(
        testEnv.PROFILE_DB,
        sourceProfileId,
      );
      const chainTarget = await readCanonicalProfile(
        testEnv.PROFILE_DB,
        targetProfileId,
      );
      if (!chainSource || !chainTarget) throw new Error("missing chain");
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: sourceProfileId,
            revision: chainSource.revision,
          },
          {
            kind: "profile-revision",
            profileId: targetProfileId,
            revision: chainTarget.revision,
          },
          { kind: "merge-target-absent", sourceProfileId },
        ],
        mutations: [
          {
            kind: "retire-profile-with-redirect",
            profile: materializeCanonicalProfile({
              ...chainSource,
              state: "retiring",
              mergedIntoProfileId: targetProfileId,
              mergedAtMs: index + 1,
              updatedAtMs: 2_000 + index,
            }),
            redirect: {
              sourceProfileId,
              targetProfileId,
              mergedAtMs: index + 1,
              opId: null,
              sourceLegacyFields: chainSource.legacyFields,
            },
          },
        ],
      });
    }
    const fullObserved = observeAggregateDatabase({ mapAll: (rows) => rows });
    expect(
      (
        await resolveCanonicalProfile(
          fullObserved.database,
          "canonical-chain-0",
        )
      )?.profileId,
    ).toBe("canonical-chain-32");
    expect(fullObserved.allQueries).toHaveLength(1);
    expect(fullObserved.batches).toHaveLength(0);
    const observed = observeAggregateDatabase({ mapAll: (rows) => rows });
    await expect(
      resolveCanonicalPublicProfile(observed.database, "canonical-chain-28", 4),
    ).resolves.toMatchObject({ profileId: "canonical-chain-32" });
    expect(observed.allQueries).toHaveLength(1);
    await expect(
      resolveCanonicalPublicProfile(
        testEnv.PROFILE_DB,
        "canonical-chain-27",
        4,
      ),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    await expect(
      resolveCanonicalPublicProfile(
        testEnv.PROFILE_DB,
        "canonical-chain-27",
        4,
        "null",
      ),
    ).resolves.toBeNull();
    await expect(
      resolveCanonicalProfile(testEnv.PROFILE_DB, "canonical-chain-0", 4),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    await expect(
      resolveCanonicalProfile(
        testEnv.PROFILE_DB,
        "canonical-chain-0",
        4,
        "null",
      ),
    ).resolves.toBeNull();
    const depthSource = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      "canonical-chain-32",
    );
    const depthTarget = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      "canonical-chain-33",
    );
    if (!depthSource || !depthTarget) throw new Error("missing depth profiles");
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: depthSource.profileId,
            revision: depthSource.revision,
          },
          {
            kind: "profile-revision",
            profileId: depthTarget.profileId,
            revision: depthTarget.revision,
          },
          {
            kind: "merge-target-absent",
            sourceProfileId: depthSource.profileId,
          },
        ],
        mutations: [
          {
            kind: "retire-profile-with-redirect",
            profile: materializeCanonicalProfile({
              ...depthSource,
              state: "retiring",
              mergedIntoProfileId: depthTarget.profileId,
              mergedAtMs: 33,
              updatedAtMs: 3_000,
            }),
            redirect: {
              sourceProfileId: depthSource.profileId,
              targetProfileId: depthTarget.profileId,
              mergedAtMs: 33,
              opId: null,
              sourceLegacyFields: depthSource.legacyFields,
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, depthSource.profileId))
        ?.state,
    ).toBe("active");
  });

  it("preserves present nulls, excludes missing sorts, and strips tutorials", async () => {
    const allKeys = [
      "rating",
      "mp",
      "nonce",
      "dust",
      "slime",
      "gum",
      "metal",
      "ice",
    ] as const;
    const leaderboardTypes = [
      "rating",
      "mp",
      "dust",
      "slime",
      "gum",
      "metal",
      "ice",
    ] as const;
    const present = Object.fromEntries(allKeys.map((key) => [key, true]));
    const missing = Object.fromEntries(allKeys.map((key) => [key, false]));
    const nulls = Object.fromEntries(allKeys.map((key) => [key, null]));
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: "canonical-sort-number" },
        { kind: "profile-absent", profileId: "canonical-sort-null-a" },
        { kind: "profile-absent", profileId: "canonical-sort-null-z" },
        { kind: "profile-absent", profileId: "canonical-sort-missing" },
      ],
      mutations: [
        {
          kind: "insert-active-profile",
          value: profileValue("canonical-sort-number"),
        },
        {
          kind: "insert-active-profile",
          value: profileValue("canonical-sort-null-a", {
            emojiPresent: false,
            gameplayEmoji: "raw-gameplay-emoji",
            sortPresence: present,
            sortValues: nulls,
          }),
        },
        {
          kind: "insert-active-profile",
          value: profileValue("canonical-sort-null-z", {
            sortPresence: present,
            sortValues: nulls,
          }),
        },
        {
          kind: "insert-active-profile",
          value: profileValue("canonical-sort-missing", {
            sortPresence: missing,
          }),
        },
      ],
    });
    const nullSnapshot = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      "canonical-sort-null-a",
    );
    expect(nullSnapshot).not.toBeNull();
    if (!nullSnapshot) throw new Error("missing null profile");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: nullSnapshot.profileId,
          revision: nullSnapshot.revision,
        },
      ],
      mutations: [
        {
          kind: "update-active-profile",
          value: materializeCanonicalProfile({
            profile: { ...nullSnapshot.profile, aura: "updated" },
            gameplayEmoji: nullSnapshot.gameplayEmoji,
            state: nullSnapshot.state,
            mergedIntoProfileId: nullSnapshot.mergedIntoProfileId,
            legacyFields: nullSnapshot.legacyFields,
            createdAtMs: nullSnapshot.createdAtMs,
            updatedAtMs: 2_000,
            mergedAtMs: nullSnapshot.mergedAtMs,
            sortPresence: nullSnapshot.sortPresence,
            sortValues: nullSnapshot.sortValues,
            winPresent: nullSnapshot.winPresent,
            emojiPresent: nullSnapshot.emojiPresent,
          }),
        },
      ],
    });
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, nullSnapshot.profileId))
        ?.sortValues,
    ).toEqual(nulls);
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, nullSnapshot.profileId))
        ?.gameplayEmoji,
    ).toBe("raw-gameplay-emoji");
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, "canonical-sort-number"))
        ?.gameplayEmoji,
    ).toBe(2);
    for (const type of leaderboardTypes) {
      const leaderboard = await readCanonicalLeaderboard(
        testEnv.PROFILE_DB,
        type,
      );
      expect(leaderboard.map((entry) => entry.id)).toEqual([
        "canonical-sort-number",
        "canonical-sort-null-z",
        "canonical-sort-null-a",
      ]);
      expect(leaderboard[0].completedProblemIds).toBeUndefined();
      expect(leaderboard[0].isTutorialCompleted).toBeUndefined();
    }
  });

  it("revision-fences rating finalization", async () => {
    const operationId = "canonical-rating-guard";
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [{ kind: "rating-update-absent", operationId }],
      mutations: [
        {
          kind: "insert-rating-update",
          value: ratingValue(operationId),
        },
      ],
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "rating-update-revision", operationId, revision: 1 },
      ],
      mutations: [
        {
          kind: "update-rating-update",
          value: ratingValue(operationId, {
            payload: { operationId, status: "done" },
            status: "done",
            updatedAtMs: 2_000,
            completedAtMs: 2_000,
            telegramProjectionState: "pending",
            telegramProjectionUpdatedAtMs: 2_000,
            telegramProjectionVersion: 1,
          }),
        },
      ],
    });
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          { kind: "rating-update-revision", operationId, revision: 1 },
        ],
        mutations: [
          {
            kind: "update-rating-update",
            value: ratingValue(operationId),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    expect(
      await readCanonicalRatingUpdate(testEnv.PROFILE_DB, operationId),
    ).toMatchObject({ status: "done", revision: 2, completedAtMs: 2_000 });
  });

  it.each(["missing", "different operation"] as const)(
    "rejects a narrow rating projection mutation with %s revision coverage",
    async (coverage) => {
      const operationId = "projection-guard-coverage";
      const initial = ratingValue(operationId);
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [{ kind: "rating-update-absent", operationId }],
        mutations: [{ kind: "insert-rating-update", value: initial }],
      });
      const mutation = buildCanonicalRatingProjectionMutation(
        { ...initial, revision: 1 },
        { ...initial, eventProgressUpdatedAtMs: 2_000 },
        "event-progress",
      );
      expect(mutation.kind).toBe("update-rating-projection");
      await expect(
        commitCanonicalPlan(testEnv.PROFILE_DB, {
          expectations:
            coverage === "missing"
              ? []
              : [
                  {
                    kind: "rating-update-revision",
                    operationId: "another-operation",
                    revision: 1,
                  },
                ],
          mutations: [mutation],
        }),
      ).rejects.toThrow("unsafe-canonical-commit-plan");
      expect(
        await readCanonicalRatingUpdate(testEnv.PROFILE_DB, operationId),
      ).toEqual({ ...initial, revision: 1 });
    },
  );

  it("serializes a narrow rating payload only when compiling its commit", async () => {
    const operationId = "projection-payload-serialization";
    const initial = ratingValue(operationId);
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [{ kind: "rating-update-absent", operationId }],
      mutations: [{ kind: "insert-rating-update", value: initial }],
    });
    let serializations = 0;
    const payload = {
      ...initial.payload,
      retained: [null, { nested: true }],
      eventProgressUpdatedAtMs: 2_000,
    };
    const mutation = buildCanonicalRatingProjectionMutation(
      { ...initial, revision: 1 },
      {
        ...initial,
        eventProgressUpdatedAtMs: 2_000,
        payload: {
          toJSON() {
            serializations++;
            return payload;
          },
        },
      },
      "event-progress",
    );
    expect(serializations).toBe(0);
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "rating-update-revision", operationId, revision: 1 },
      ],
      mutations: [mutation],
    });
    expect(serializations).toBe(1);
    expect(
      await readCanonicalRatingUpdate(testEnv.PROFILE_DB, operationId),
    ).toEqual({
      ...initial,
      eventProgressUpdatedAtMs: 2_000,
      payload,
      revision: 2,
    });
  });

  it.each(["integrity", "unknown"] as const)(
    "preserves %s failure classification for narrow rating projection writes",
    async (failure) => {
      const operationId = `projection-${failure}-failure`;
      const initial = ratingValue(operationId);
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [{ kind: "rating-update-absent", operationId }],
        mutations: [{ kind: "insert-rating-update", value: initial }],
      });
      const unknownError = new Error("projection-d1-unavailable");
      const observed = observeD1FailureDatabase(testEnv.PROFILE_DB, {
        async beforeBatch() {
          if (failure === "unknown") throw unknownError;
        },
      });
      const mutation = buildCanonicalRatingProjectionMutation(
        { ...initial, revision: 1 },
        { ...initial, eventProgressUpdatedAtMs: -1 },
        "event-progress",
      );
      const result = commitCanonicalPlan(observed.database, {
        expectations: [
          { kind: "rating-update-revision", operationId, revision: 1 },
        ],
        mutations: [mutation],
      });
      if (failure === "unknown") {
        await expect(result).rejects.toBe(unknownError);
      } else {
        await expect(result).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      }
      expect(observed.batches).toHaveLength(1);
      expect(observed.sessions).toEqual([]);
      expect(
        await readCanonicalRatingUpdate(testEnv.PROFILE_DB, operationId),
      ).toEqual({ ...initial, revision: 1 });
    },
  );

  it("roundtrips every rating write field on insert and update", async () => {
    const operationId = "canonical-rating-fields";
    const initial = ratingValue(operationId, {
      payload: { operationId, nested: ["initial", null, { retained: true }] },
      playerProfileId: "player-profile",
      opponentProfileId: "opponent-profile",
      startedAtMs: 101,
      updatedAtMs: 202,
      leaseExpiresAtMs: 303,
      telegramProjectionState: "pending",
      telegramProjectionUpdatedAtMs: 404,
      telegramProjectionVersion: 5,
      profileGameProjectionState: "done",
      profileGameProjectionUpdatedAtMs: 606,
      profileGameProjectionVersion: 7,
      eventProgressState: "dead",
      eventProgressUpdatedAtMs: 808,
      eventProgressVersion: 9,
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [{ kind: "rating-update-absent", operationId }],
      mutations: [{ kind: "insert-rating-update", value: initial }],
    });
    await expect(
      readCanonicalRatingUpdate(testEnv.PROFILE_DB, operationId),
    ).resolves.toEqual({ ...initial, revision: 1 });
    const updated = ratingValue(operationId, {
      payload: { operationId, nested: ["updated", false, { retained: null }] },
      status: "done",
      inviteId: "updated-invite",
      matchId: "updated-match",
      playerId: "updated-player",
      opponentId: "updated-opponent",
      playerProfileId: null,
      opponentProfileId: null,
      ownerUid: "updated-owner",
      ownerToken: "updated-token",
      startedAtMs: 1_101,
      updatedAtMs: 1_202,
      leaseExpiresAtMs: 1_303,
      completedAtMs: 1_204,
      telegramProjectionState: "dead",
      telegramProjectionUpdatedAtMs: 1_405,
      telegramProjectionVersion: 16,
      profileGameProjectionState: "pending",
      profileGameProjectionUpdatedAtMs: 1_607,
      profileGameProjectionVersion: 18,
      eventProgressState: null,
      eventProgressUpdatedAtMs: null,
      eventProgressVersion: null,
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "rating-update-revision", operationId, revision: 1 },
      ],
      mutations: [{ kind: "update-rating-update", value: updated }],
    });
    await expect(
      readCanonicalRatingUpdate(testEnv.PROFILE_DB, operationId),
    ).resolves.toEqual({ ...updated, revision: 2 });
  });

  it("keeps wager fingerprints immutable and rejects mismatched replay", async () => {
    const operationId = "canonical-wager-fingerprint";
    const settlement = {
      operationId,
      fingerprint: "fingerprint-a",
      winnerProfileId: "winner",
      loserProfileId: "loser",
      material: "dust" as const,
      count: 3,
      appliedAtMs: 1_000,
      outcome: "applied" as const,
      revision: 1 as const,
    };
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [{ kind: "wager-settlement-absent", operationId }],
      mutations: [{ kind: "insert-wager-settlement", value: settlement }],
    });
    expect(
      await readCanonicalWagerSettlement(
        testEnv.PROFILE_DB,
        operationId,
        settlement.fingerprint,
      ),
    ).toMatchObject(settlement);
    await expect(
      testEnv.PROFILE_DB.prepare(
        `INSERT INTO wager_settlements (
           operation_id, fingerprint, winner_profile_id, loser_profile_id,
           material, count, applied_at_ms, revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (operation_id) DO NOTHING`,
      )
        .bind(
          operationId,
          settlement.fingerprint,
          settlement.winnerProfileId,
          settlement.loserProfileId,
          settlement.material,
          settlement.count,
          settlement.appliedAtMs,
          settlement.revision,
        )
        .run(),
    ).resolves.toBeDefined();
    await expect(
      readCanonicalWagerSettlement(
        testEnv.PROFILE_DB,
        operationId,
        "fingerprint-b",
      ),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [{ kind: "wager-settlement-absent", operationId }],
        mutations: [
          {
            kind: "insert-wager-settlement",
            value: { ...settlement, fingerprint: "fingerprint-b" },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    await expect(
      testEnv.PROFILE_DB.prepare(
        `INSERT OR REPLACE INTO wager_settlements (
           operation_id, fingerprint, winner_profile_id, loser_profile_id,
           material, count, applied_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(operationId, "fingerprint-b", "winner", "loser", "dust", 3, 2_000)
        .run(),
    ).rejects.toThrow();
  });
});
