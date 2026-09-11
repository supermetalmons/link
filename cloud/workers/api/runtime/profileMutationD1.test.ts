import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import type { CompletePlayerProfile } from "@mons/shared/profiles";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalProfile,
  type CanonicalAuthMethodValue,
} from "../src/profileCanonicalD1.ts";
import {
  readCanonicalProfileMutationByLogin,
  type CanonicalProfileMutationSnapshot,
} from "../src/profileMutationD1.ts";
import { createProfileCustomizationRepository } from "../src/profileCustomizationRepository.ts";
import { createMiningRepository } from "../src/miningRepository.ts";
import { createUsernameRepository } from "../src/usernameRepository.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;

async function createProfile(
  fields: Partial<CompletePlayerProfile> = {},
  options: Partial<
    Omit<Parameters<typeof materializeCanonicalProfile>[0], "profile">
  > = {},
): Promise<CanonicalProfileMutationSnapshot> {
  const profileId = `mutation-profile-${crypto.randomUUID()}`;
  const loginUid = `mutation-login-${crypto.randomUUID()}`;
  const value = materializeCanonicalProfile({
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
      completedProblemIds: ["one"],
      isTutorialCompleted: true,
      mining: {
        lastRockDate: "2026-08-28",
        materials: { dust: 1, slime: 2, gum: 3, metal: 4, ice: 5 },
      },
      ...fields,
    },
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    ...options,
  });
  await commitCanonicalPlan(db, {
    expectations: [
      { kind: "profile-absent", profileId },
      { kind: "login-owner-absent", loginUid },
    ],
    mutations: [
      { kind: "insert-active-profile", value },
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
  return {
    owner: {
      loginUid,
      profileId,
      revision: 1,
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
    },
    profile: { ...value, profileId, revision: 1 },
  };
}

function observeDatabase(
  options: {
    beforeFirstBatch?: () => Promise<void>;
    afterFirstBatch?: () => Promise<void>;
    mapMutationRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  const firstQueries: string[] = [];
  const batchQueries: string[][] = [];
  const nativeStatements = new WeakMap<object, D1PreparedStatement>();
  const statementQueries = new WeakMap<object, string>();
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        if (property === "first") {
          return async () => {
            firstQueries.push(query);
            const row = await target.first<Record<string, unknown>>();
            return row &&
              query.includes("AS mutation_owner_login_uid") &&
              options.mapMutationRow
              ? options.mapMutationRow(row)
              : row;
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    nativeStatements.set(wrapped, statement);
    statementQueries.set(wrapped, query);
    return wrapped;
  };
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batchQueries.push(
            statements.map(
              (statement) => statementQueries.get(statement) || "",
            ),
          );
          if (batchQueries.length === 1) await options.beforeFirstBatch?.();
          const results = await target.batch(
            statements.map(
              (statement) => nativeStatements.get(statement) || statement,
            ),
          );
          if (batchQueries.length === 1) await options.afterFirstBatch?.();
          return results;
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database, firstQueries, batchQueries };
}

async function mergeOwner(
  source: CanonicalProfileMutationSnapshot,
  target: CanonicalProfileMutationSnapshot,
): Promise<void> {
  await commitCanonicalPlan(db, {
    expectations: [
      { kind: "profile-revision", ...source.profile },
      { kind: "profile-revision", ...target.profile },
      { kind: "login-owner-revision", ...source.owner },
      {
        kind: "merge-target-absent",
        sourceProfileId: source.profile.profileId,
      },
    ],
    mutations: [
      {
        kind: "update-login-owner",
        value: {
          ...source.owner,
          profileId: target.profile.profileId,
          updatedAtMs: 3_000,
        },
      },
      {
        kind: "retire-profile-with-redirect",
        profile: materializeCanonicalProfile({
          ...source.profile,
          state: "retiring",
          mergedIntoProfileId: target.profile.profileId,
          mergedAtMs: 3_000,
          updatedAtMs: 3_000,
        }),
        redirect: {
          sourceProfileId: source.profile.profileId,
          targetProfileId: target.profile.profileId,
          mergedAtMs: 3_000,
          opId: "mutation-test-merge",
          sourceLegacyFields: source.profile.legacyFields,
        },
      },
    ],
  });
}

describe("canonical profile mutation reads", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "c".repeat(64),
    );
  });

  it("reads the owner and complete mutable profile in one query", async () => {
    const initial = await createProfile(
      { eth: "0xwallet", sol: "sol-wallet" },
      {
        legacyFields: { imported: { missingRating: true }, custom: [1, null] },
        emojiPresent: false,
        gameplayEmoji: "legacy-emoji",
        winPresent: false,
        sortPresence: {
          rating: false,
          mp: true,
          nonce: true,
          dust: true,
          slime: true,
          gum: false,
          metal: true,
          ice: true,
        },
        sortValues: {
          rating: null,
          mp: null,
          nonce: null,
          dust: 1,
          slime: 2,
          gum: null,
          metal: 4,
          ice: 5,
        },
      },
    );
    const observed = observeDatabase();
    await expect(
      readCanonicalProfileMutationByLogin(
        observed.database,
        initial.owner.loginUid,
      ),
    ).resolves.toEqual(initial);
    expect(observed.firstQueries).toHaveLength(1);
    expect(observed.batchQueries).toHaveLength(0);
    expect(observed.firstQueries[0]).not.toMatch(
      /profile_auth_methods|profile_auth_recovery_jobs|profile_february_opponents/,
    );
  });

  it("returns null for a missing login without a second observation", async () => {
    const observed = observeDatabase();
    await expect(
      readCanonicalProfileMutationByLogin(
        observed.database,
        "missing-mutation-login",
      ),
    ).resolves.toBeNull();
    expect(observed.firstQueries).toHaveLength(1);
  });

  it.each([
    ["dangling owner", { profile_id: null, payload_json: null }],
    ["owner login mismatch", { mutation_owner_login_uid: "another-login" }],
    [
      "owner profile mismatch",
      { mutation_owner_profile_id: "another-profile" },
    ],
    ["owner revision", { mutation_owner_revision: 0 }],
    ["owner timestamp", { mutation_owner_created_at_ms: -1 }],
    ["profile revision", { revision: 0 }],
    ["profile payload", { payload_json: "{}" }],
    ["legacy fields", { legacy_fields_json: "[]" }],
    ["username key", { username_key: "unexpected-name" }],
    ["sort presence", { rating_sort_present: 0 }],
    ["gameplay emoji", { gameplay_emoji_json: "{}" }],
    [
      "retiring profile",
      { state: "retiring", merged_into_profile_id: "target" },
    ],
    ["active merge mapping", { mutation_merge_source_profile_id: "source" }],
  ])(
    "rejects corrupt %s without treating it as missing",
    async (_name, changes) => {
      const initial = await createProfile();
      const observed = observeDatabase({
        mapMutationRow: (row) => ({ ...row, ...changes }),
      });
      await expect(
        readCanonicalProfileMutationByLogin(
          observed.database,
          initial.owner.loginUid,
        ),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      expect(observed.firstQueries).toHaveLength(1);
    },
  );

  it("preserves legacy and sparse fields through a customization update", async () => {
    const initial = await createProfile(
      {},
      {
        legacyFields: { imported: { emoji: "" } },
        emojiPresent: false,
        gameplayEmoji: "legacy-gameplay-emoji",
        winPresent: false,
        sortPresence: { rating: false, nonce: false, mp: true },
        sortValues: { mp: null },
      },
    );
    const observed = observeDatabase();
    await expect(
      createProfileCustomizationRepository(testEnv, {
        d1: observed.database,
        now: () => 4_000,
      }).updateCustomization(
        initial.owner.loginUid,
        { field: "cardBackgroundId", value: 4 },
        async () => undefined,
      ),
    ).resolves.toBe("updated");
    await expect(
      readCanonicalProfile(db, initial.profile.profileId),
    ).resolves.toEqual({
      ...initial.profile,
      profile: { ...initial.profile.profile, cardBackgroundId: 4 },
      revision: 2,
      updatedAtMs: 4_000,
    });
    expect(observed.firstQueries).toHaveLength(1);
    expect(observed.batchQueries.map((queries) => queries.length)).toEqual([6]);
  });

  it("replaces a legacy emoji with zero without changing sparse fields", async () => {
    const initial = await createProfile(
      { aura: "rainbow" },
      {
        legacyFields: { imported: { emoji: "" } },
        emojiPresent: false,
        gameplayEmoji: "legacy-gameplay-emoji",
        winPresent: false,
        sortPresence: { rating: false, nonce: false, mp: true },
        sortValues: { mp: null },
      },
    );
    await expect(
      createProfileCustomizationRepository(testEnv, {
        now: () => 4_000,
      }).updateCustomization(
        initial.owner.loginUid,
        { field: "emojiAndAura", value: { emoji: 0, aura: "" } },
        async () => undefined,
      ),
    ).resolves.toBe("updated");
    await expect(
      readCanonicalProfile(db, initial.profile.profileId),
    ).resolves.toEqual({
      ...initial.profile,
      profile: { ...initial.profile.profile, emoji: 0, aura: "" },
      emojiPresent: true,
      gameplayEmoji: 0,
      revision: 2,
      updatedAtMs: 4_000,
    });
  });

  it("updates every mining sort while preserving unrelated sparse fields", async () => {
    const initial = await createProfile(
      {},
      {
        legacyFields: { imported: { mining: null } },
        emojiPresent: false,
        gameplayEmoji: "legacy-gameplay-emoji",
        winPresent: false,
        sortPresence: {
          rating: false,
          mp: true,
          dust: false,
          slime: false,
          gum: false,
          metal: false,
          ice: false,
        },
        sortValues: { mp: null },
      },
    );
    const mining = {
      lastRockDate: "2026-09-11",
      materials: { dust: 0, slime: 3, gum: 4, metal: 5, ice: 6 },
    };
    await expect(
      createMiningRepository(testEnv, { now: () => 4_000 }).updateMining(
        initial.profile.profileId,
        mining,
        `d1:${initial.profile.revision}`,
      ),
    ).resolves.toBe("updated");
    await expect(
      readCanonicalProfile(db, initial.profile.profileId),
    ).resolves.toEqual({
      ...initial.profile,
      profile: { ...initial.profile.profile, mining },
      sortPresence: {
        ...initial.profile.sortPresence,
        dust: true,
        slime: true,
        gum: true,
        metal: true,
        ice: true,
      },
      sortValues: { ...initial.profile.sortValues, ...mining.materials },
      revision: 2,
      updatedAtMs: 4_000,
    });
  });

  it("rejects a mining write after a concurrent edit without overwriting it", async () => {
    const initial = await createProfile();
    const observed = observeDatabase({
      beforeFirstBatch: async () => {
        await createProfileCustomizationRepository(testEnv, {
          now: () => 3_000,
        }).updateCustomization(
          initial.owner.loginUid,
          { field: "cardBackgroundId", value: 4 },
          async () => undefined,
        );
      },
    });
    await expect(
      createMiningRepository(testEnv, {
        d1: observed.database,
        now: () => 4_000,
      }).updateMining(
        initial.profile.profileId,
        {
          lastRockDate: "2026-09-11",
          materials: { dust: 0, slime: 3, gum: 4, metal: 5, ice: 6 },
        },
        `d1:${initial.profile.revision}`,
      ),
    ).resolves.toBe("conflict");
    await expect(
      readCanonicalProfile(db, initial.profile.profileId),
    ).resolves.toEqual({
      ...initial.profile,
      profile: { ...initial.profile.profile, cardBackgroundId: 4 },
      revision: 2,
      updatedAtMs: 3_000,
    });
    expect(observed.firstQueries).toHaveLength(1);
    expect(observed.batchQueries).toHaveLength(1);
  });

  it("never writes when customization authorization fails", async () => {
    const initial = await createProfile();
    const observed = observeDatabase();
    const failure = new Error("not-owned");
    await expect(
      createProfileCustomizationRepository(testEnv, {
        d1: observed.database,
      }).updateCustomization(
        initial.owner.loginUid,
        { field: "cardBackgroundId", value: 4 },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(observed.batchQueries).toHaveLength(0);
    await expect(
      readCanonicalProfile(db, initial.profile.profileId),
    ).resolves.toEqual(initial.profile);
  });

  it("rereads and reauthorizes after a concurrent profile edit", async () => {
    const initial = await createProfile();
    const observed = observeDatabase();
    let authorizations = 0;
    const username = `Concurrent${crypto.randomUUID()}`;
    await expect(
      createProfileCustomizationRepository(testEnv, {
        d1: observed.database,
      }).updateCustomization(
        initial.owner.loginUid,
        { field: "cardBackgroundId", value: 4 },
        async () => {
          authorizations += 1;
          if (authorizations === 1) {
            await createUsernameRepository(testEnv).editUsername(
              initial.owner.loginUid,
              username,
            );
          }
        },
      ),
    ).resolves.toBe("updated");
    expect(authorizations).toBe(2);
    expect(observed.firstQueries).toHaveLength(2);
    expect(observed.batchQueries).toHaveLength(2);
    await expect(
      readCanonicalProfile(db, initial.profile.profileId),
    ).resolves.toMatchObject({
      profile: { username, cardBackgroundId: 4 },
      revision: 3,
    });
  });

  it("reauthorizes against the new owner's wallets after a concurrent merge", async () => {
    const source = await createProfile({ eth: "0xsource", sol: "sol-source" });
    const target = await createProfile({ eth: "0xtarget", sol: "sol-target" });
    const authorizations: Array<{
      documentName: string;
      eth: string;
      sol: string;
    }> = [];
    const observed = observeDatabase();
    await expect(
      createProfileCustomizationRepository(testEnv, {
        d1: observed.database,
      }).updateCustomization(
        source.owner.loginUid,
        { field: "cardBackgroundId", value: 4 },
        async (profile) => {
          authorizations.push(profile);
          if (authorizations.length === 1) await mergeOwner(source, target);
        },
      ),
    ).resolves.toBe("updated");
    expect(authorizations).toEqual([
      {
        documentName: source.profile.profileId,
        eth: "0xsource",
        sol: "sol-source",
      },
      {
        documentName: target.profile.profileId,
        eth: "0xtarget",
        sol: "sol-target",
      },
    ]);
    expect(observed.firstQueries).toHaveLength(2);
    await expect(
      readCanonicalProfile(db, target.profile.profileId),
    ).resolves.toMatchObject({
      profile: { cardBackgroundId: 4 },
    });
    const retired = await readCanonicalProfile(db, source.profile.profileId);
    expect(retired?.state).toBe("retiring");
    expect(retired?.profile.cardBackgroundId).toBeUndefined();
  });

  it("keeps rename and unchanged-name reads within their query budgets", async () => {
    const initial = await createProfile();
    const username = `Rename${crypto.randomUUID()}`;
    const renamed = observeDatabase();
    await expect(
      createUsernameRepository(testEnv, { d1: renamed.database }).editUsername(
        initial.owner.loginUid,
        username,
      ),
    ).resolves.toBe("updated");
    expect(renamed.firstQueries).toHaveLength(2);
    expect(renamed.batchQueries.map((queries) => queries.length)).toEqual([7]);
    const unchanged = observeDatabase();
    await expect(
      createUsernameRepository(testEnv, {
        d1: unchanged.database,
      }).editUsername(initial.owner.loginUid, username),
    ).resolves.toBe("updated");
    expect(unchanged.firstQueries).toHaveLength(1);
    expect(unchanged.batchQueries).toHaveLength(0);
    await expect(
      createUsernameRepository(testEnv).editUsername(
        initial.owner.loginUid,
        username.toUpperCase(),
      ),
    ).resolves.toBe("updated");
  });

  it("reports a username claimed between its read and guarded commit", async () => {
    const initial = await createProfile();
    const competitor = await createProfile();
    const username = `Contested${crypto.randomUUID()}`;
    const observed = observeDatabase({
      beforeFirstBatch: async () => {
        await createUsernameRepository(testEnv).editUsername(
          competitor.owner.loginUid,
          username,
        );
      },
    });
    await expect(
      createUsernameRepository(testEnv, { d1: observed.database }).editUsername(
        initial.owner.loginUid,
        username,
      ),
    ).resolves.toBe("taken");
    expect(observed.firstQueries).toHaveLength(4);
    expect(observed.batchQueries).toHaveLength(1);
    await expect(
      readCanonicalProfile(db, initial.profile.profileId),
    ).resolves.toEqual(initial.profile);
  });

  it("rechecks username clearing after a concurrent social method link", async () => {
    const initial = await createProfile({
      username: `ClearRace${crypto.randomUUID()}`,
    });
    const normalizedValue = crypto.randomUUID();
    const observed = observeDatabase({
      afterFirstBatch: async () => {
        await commitCanonicalPlan(db, {
          expectations: [
            { kind: "profile-revision", ...initial.profile },
            { kind: "auth-method-absent", method: "x", normalizedValue },
          ],
          mutations: [
            {
              kind: "update-active-profile",
              value: materializeCanonicalProfile({
                ...initial.profile,
                updatedAtMs: 3_000,
              }),
            },
            {
              kind: "insert-auth-method",
              value: {
                method: "x",
                normalizedValue,
                rawValue: normalizedValue,
                profileId: initial.profile.profileId,
                appleEmailMasked: null,
                xUsername: "NewSocialMethod",
                linkedAtMs: 3_000,
                consentAtMs: null,
                consentSource: null,
                createdAtMs: 3_000,
                updatedAtMs: 3_000,
              },
            },
          ],
        });
      },
    });
    await expect(
      createUsernameRepository(testEnv, {
        d1: observed.database,
        now: () => 4_000,
      }).editUsername(initial.owner.loginUid, ""),
    ).resolves.toBe("cannot-clear");
    expect(observed.firstQueries).toHaveLength(0);
    expect(
      observed.batchQueries.filter((queries) =>
        queries.every((query) => query.trimStart().startsWith("SELECT")),
      ),
    ).toHaveLength(2);
    await expect(
      readCanonicalProfile(db, initial.profile.profileId),
    ).resolves.toMatchObject({
      profile: { username: initial.profile.profile.username },
      revision: 2,
    });
  });

  it.each<{
    methods: CanonicalAuthMethodValue["method"][];
    eth: string | null;
    outcome: "cannot-clear" | "updated";
  }>([
    { methods: ["apple"], eth: "0xlegacy-wallet", outcome: "cannot-clear" },
    { methods: ["x"], eth: null, outcome: "cannot-clear" },
    { methods: ["apple", "eth"], eth: null, outcome: "updated" },
    { methods: ["x", "sol"], eth: null, outcome: "updated" },
    { methods: [], eth: null, outcome: "updated" },
  ])(
    "keeps canonical auth-method clearing policy for $methods",
    async ({ methods, eth, outcome }) => {
      const initial = await createProfile({
        username: `Clear${crypto.randomUUID()}`,
        eth,
      });
      for (const method of methods) {
        const normalizedValue = crypto.randomUUID();
        await commitCanonicalPlan(db, {
          expectations: [
            { kind: "auth-method-absent", method, normalizedValue },
          ],
          mutations: [
            {
              kind: "insert-auth-method",
              value: {
                method,
                normalizedValue,
                rawValue: normalizedValue,
                profileId: initial.profile.profileId,
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
      const observed = observeDatabase();
      await expect(
        createUsernameRepository(testEnv, {
          d1: observed.database,
        }).editUsername(initial.owner.loginUid, ""),
      ).resolves.toBe(outcome);
      expect(observed.firstQueries).toHaveLength(0);
      expect(observed.batchQueries[0]).toHaveLength(7);
      expect(
        observed.batchQueries
          .flat()
          .some((query) => query.includes("FROM profile_auth_methods")),
      ).toBe(true);
      await expect(
        readCanonicalProfile(db, initial.profile.profileId),
      ).resolves.toMatchObject({
        profile: {
          username:
            outcome === "updated" ? null : initial.profile.profile.username,
        },
      });
    },
  );
});
