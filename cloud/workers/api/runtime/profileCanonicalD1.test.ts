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
  countCanonicalCommitStatements,
  materializeCanonicalProfile,
  readCanonicalLeaderboard,
  readCanonicalMergeTarget,
  readCanonicalProfile,
  readCanonicalProfileAggregate,
  readCanonicalProfileOwnershipSnapshot,
  readCanonicalPublicProfileByLogin,
  readCanonicalRatingUpdate,
  readCanonicalWagerSettlement,
  readStableCanonicalProfileAggregate,
  readStableCanonicalProfileAggregateByLogin,
  resolveCanonicalProfile,
  resolveCanonicalPublicProfile,
  type CanonicalExpectation,
  type CanonicalMutation,
  type CanonicalProfileValue,
  type CanonicalRatingUpdateValue,
} from "../src/profileCanonicalD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

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

    const aggregate = await readCanonicalProfileAggregate(
      testEnv.PROFILE_DB,
      value.profile.id,
    );
    expect(aggregate.profile?.revision).toBe(1);
    expect(aggregate.profile?.gameplayEmoji).toBe("gameplay-only");
    expect(aggregate.loginOwners.map((owner) => owner.loginUid)).toEqual([
      "login-success",
    ]);
    expect(aggregate.authMethods[0]).toMatchObject({
      method: "eth",
      normalizedValue: "0xabc",
      rawValue: "0xAbC",
      revision: 1,
    });
    expect(aggregate.februaryOpponentProfileIds).toEqual(["opponent-1"]);
    expect(aggregate.recovery?.loginUids).toEqual(["login-success"]);
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
      batch: async () => [{ results: [] }, { results: [] }],
      prepare: (statement: string) => {
        sql.push(statement);
        return {
          all: async () => ({ results: [] }),
          bind() {
            return this;
          },
        };
      },
    } as unknown as D1Database;
    await resolveCanonicalPublicProfile(fakeDb, "missing");
    await readCanonicalLeaderboard(fakeDb, "rating");
    const publicProfileQueries = sql.filter((statement) =>
      statement.includes("FROM profile_records"),
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
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
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
    expect(countCanonicalCommitStatements(plan)).toBe(5);
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

  it("retries changing aggregates and rejects stable owner corruption", async () => {
    const value = profileValue("canonical-stable-profile", {
      emojiPresent: false,
      gameplayEmoji: 17,
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: value.profile.id },
        { kind: "login-owner-absent", loginUid: "canonical-stable-login" },
      ],
      mutations: [
        { kind: "insert-active-profile", value },
        {
          kind: "insert-login-owner",
          value: {
            loginUid: "canonical-stable-login",
            profileId: value.profile.id,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
      ],
    });
    expect(
      (
        await readStableCanonicalProfileAggregateByLogin(
          testEnv.PROFILE_DB,
          "canonical-stable-login",
        )
      )?.aggregate.profile?.gameplayEmoji,
    ).toBe(17);

    let batchReads = 0;
    const changingDb = new Proxy(testEnv.PROFILE_DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            batchReads += 1;
            if (batchReads === 1) {
              await target
                .prepare(
                  `UPDATE profile_records
                   SET revision = revision + 1
                   WHERE profile_id = ?`,
                )
                .bind(value.profile.id)
                .run();
            }
            return results;
          };
        }
        const member = Reflect.get(target, property);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    expect(
      (await readStableCanonicalProfileAggregate(changingDb, value.profile.id))
        .profile?.revision,
    ).toBe(2);
    expect(batchReads).toBe(3);

    const alwaysChangingDb = new Proxy(testEnv.PROFILE_DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            await target
              .prepare(
                `UPDATE profile_records
                 SET revision = revision + 1
                 WHERE profile_id = ?`,
              )
              .bind(value.profile.id)
              .run();
            return results;
          };
        }
        const member = Reflect.get(target, property);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    await expect(
      readStableCanonicalProfileAggregate(
        alwaysChangingDb,
        value.profile.id,
        3,
      ),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);

    const redirectSource = profileValue("canonical-stable-source");
    const redirectTarget = profileValue("canonical-stable-target");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: redirectSource.profile.id },
        { kind: "profile-absent", profileId: redirectTarget.profile.id },
        { kind: "login-owner-absent", loginUid: "canonical-stale-owner" },
      ],
      mutations: [
        { kind: "insert-active-profile", value: redirectSource },
        { kind: "insert-active-profile", value: redirectTarget },
        {
          kind: "insert-login-owner",
          value: {
            loginUid: "canonical-stale-owner",
            profileId: redirectSource.profile.id,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
      ],
    });
    const redirectSourceSnapshot = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      redirectSource.profile.id,
    );
    const redirectTargetSnapshot = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      redirectTarget.profile.id,
    );
    if (!redirectSourceSnapshot || !redirectTargetSnapshot) {
      throw new Error("missing redirect profiles");
    }
    await expect(
      commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId: redirectSourceSnapshot.profileId,
            revision: redirectSourceSnapshot.revision,
          },
          {
            kind: "profile-revision",
            profileId: redirectTargetSnapshot.profileId,
            revision: redirectTargetSnapshot.revision,
          },
          {
            kind: "merge-target-absent",
            sourceProfileId: redirectSourceSnapshot.profileId,
          },
        ],
        mutations: [
          {
            kind: "retire-profile-with-redirect",
            profile: materializeCanonicalProfile({
              ...redirectSourceSnapshot,
              state: "retiring",
              mergedIntoProfileId: redirectTargetSnapshot.profileId,
              mergedAtMs: 2_000,
              updatedAtMs: 2_000,
            }),
            redirect: {
              sourceProfileId: redirectSourceSnapshot.profileId,
              targetProfileId: redirectTargetSnapshot.profileId,
              mergedAtMs: 2_000,
              opId: null,
              sourceLegacyFields: redirectSourceSnapshot.legacyFields,
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    await expect(
      readStableCanonicalProfileAggregateByLogin(
        testEnv.PROFILE_DB,
        "canonical-stale-owner",
      ),
    ).resolves.toMatchObject({
      aggregate: { profile: { state: "active" } },
    });
  });

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
    expect(
      (await resolveCanonicalProfile(testEnv.PROFILE_DB, "canonical-chain-0"))
        ?.profileId,
    ).toBe("canonical-chain-32");
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
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
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
