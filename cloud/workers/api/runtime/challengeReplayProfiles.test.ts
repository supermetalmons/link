import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import type { CompletePlayerProfile } from "@mons/shared/profiles";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalProfileAggregateSnapshot,
  type CanonicalProfileSnapshot,
} from "../src/profileCanonicalD1.ts";
import { readCanonicalChallengeReplayProfiles } from "../src/profileMutationD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;

async function createProfile(
  fields: Partial<CompletePlayerProfile> = {},
  options: Partial<
    Omit<Parameters<typeof materializeCanonicalProfile>[0], "profile">
  > = {},
): Promise<CanonicalProfileSnapshot> {
  const profileId = `challenge-replay-${crypto.randomUUID()}`;
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
    expectations: [{ kind: "profile-absent", profileId }],
    mutations: [{ kind: "insert-active-profile", value }],
  });
  return { ...value, profileId, revision: 1 };
}

async function addOpponents(
  profileId: string,
  opponentProfileIds: string[],
): Promise<void> {
  await commitCanonicalPlan(db, {
    expectations: opponentProfileIds.map((opponentProfileId) => ({
      kind: "february-opponent-absent",
      profileId,
      opponentProfileId,
    })),
    mutations: opponentProfileIds.map((opponentProfileId) => ({
      kind: "insert-february-opponent",
      profileId,
      opponentProfileId,
      recordedAtMs: 2_000,
    })),
  });
}

async function retireProfile(
  source: CanonicalProfileSnapshot,
  target: CanonicalProfileSnapshot,
): Promise<CanonicalProfileSnapshot> {
  const value = materializeCanonicalProfile({
    ...source,
    state: "retiring",
    mergedIntoProfileId: target.profileId,
    mergedAtMs: 3_000,
    updatedAtMs: 3_000,
  });
  await commitCanonicalPlan(db, {
    expectations: [
      { kind: "profile-revision", ...source },
      { kind: "profile-revision", ...target },
      { kind: "merge-target-absent", sourceProfileId: source.profileId },
    ],
    mutations: [
      {
        kind: "retire-profile-with-redirect",
        profile: value,
        redirect: {
          sourceProfileId: source.profileId,
          targetProfileId: target.profileId,
          mergedAtMs: 3_000,
          opId: "challenge-replay-merge",
          sourceLegacyFields: source.legacyFields,
        },
      },
    ],
  });
  return {
    ...value,
    profileId: source.profileId,
    revision: source.revision + 1,
  };
}

function observeDatabase(
  options: {
    beforeBatch?: () => Promise<void>;
    afterBatch?: () => Promise<void>;
    mapResults?: (
      results: D1Result<Record<string, unknown>>[],
    ) => D1Result<Record<string, unknown>>[];
  } = {},
) {
  const batches: string[][] = [];
  const nativeStatements = new WeakMap<object, D1PreparedStatement>();
  const queries = new WeakMap<object, string>();
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        if (["first", "all", "run", "raw"].includes(String(property))) {
          return () => {
            throw new Error("challenge-replay-read-outside-batch");
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    nativeStatements.set(wrapped, statement);
    queries.set(wrapped, query);
    return wrapped;
  };
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batches.push(
            statements.map((statement) => queries.get(statement) || ""),
          );
          await options.beforeBatch?.();
          const results = await target.batch<Record<string, unknown>>(
            statements.map(
              (statement) => nativeStatements.get(statement) || statement,
            ),
          );
          await options.afterBatch?.();
          return options.mapResults?.(results) || results;
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database, batches };
}

function changeRow(index: number, changes: Record<string, unknown>) {
  return (results: D1Result<Record<string, unknown>>[]) =>
    results.map((result, resultIndex) =>
      resultIndex === index
        ? {
            ...result,
            results: result.results.map((row) => ({ ...row, ...changes })),
          }
        : result,
    );
}

describe("canonical challenge replay profile reads", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "d".repeat(64),
    );
  });

  it("reads complete profiles and sorted opponents in one four-statement batch", async () => {
    const player = await createProfile(
      { rating: 0, nonce: 0, totalManaPoints: 0, emoji: 0 },
      { gameplayEmoji: 0 },
    );
    const opponent = await createProfile(
      {},
      {
        legacyFields: { imported: { missingRating: true }, custom: [1, null] },
        emojiPresent: false,
        gameplayEmoji: "legacy-emoji",
        winPresent: false,
        sortPresence: { rating: false, nonce: false, mp: true, gum: false },
        sortValues: { mp: null, gum: null },
      },
    );
    await addOpponents(player.profileId, ["zulu", "alpha"]);
    await addOpponents(opponent.profileId, ["other"]);
    const observed = observeDatabase();
    await expect(
      readCanonicalChallengeReplayProfiles(observed.database, {
        playerProfileId: player.profileId,
        opponentProfileId: opponent.profileId,
      }),
    ).resolves.toEqual({
      player: {
        profile: player,
        februaryOpponentProfileIds: ["alpha", "zulu"],
      },
      opponent: { profile: opponent, februaryOpponentProfileIds: ["other"] },
    });
    expect(observed.batches.map((batch) => batch.length)).toEqual([4]);
  });

  it.each(["player", "opponent", "both"])(
    "preserves missing %s profiles",
    async (missing) => {
      const profile = await createProfile();
      const observed = observeDatabase();
      const result = await readCanonicalChallengeReplayProfiles(
        observed.database,
        {
          playerProfileId:
            missing === "opponent" ? profile.profileId : "missing-player",
          opponentProfileId:
            missing === "player" ? profile.profileId : "missing-opponent",
        },
      );
      expect(result).toEqual({
        player: {
          profile: missing === "opponent" ? profile : null,
          februaryOpponentProfileIds: [],
        },
        opponent: {
          profile: missing === "player" ? profile : null,
          februaryOpponentProfileIds: [],
        },
      });
      expect(observed.batches.map((batch) => batch.length)).toEqual([4]);
    },
  );

  it("preserves both roles for duplicate profile IDs", async () => {
    const profile = await createProfile();
    await addOpponents(profile.profileId, ["same-opponent"]);
    const observed = observeDatabase();
    const result = await readCanonicalChallengeReplayProfiles(
      observed.database,
      {
        playerProfileId: profile.profileId,
        opponentProfileId: profile.profileId,
      },
    );
    const snapshot = { profile, februaryOpponentProfileIds: ["same-opponent"] };
    expect(result).toEqual({ player: snapshot, opponent: snapshot });
    expect(observed.batches.map((batch) => batch.length)).toEqual([4]);
  });

  it.each(["before", "after"] as const)(
    "keeps both profiles and opponent lists coherent across changes %s the batch",
    async (timing) => {
      const player = await createProfile({ rating: 1200 });
      const opponent = await createProfile({ rating: 1800 });
      const updates = [player, opponent].map((profile) =>
        materializeCanonicalProfile({
          ...profile,
          profile: { ...profile.profile, rating: profile.profile.rating + 50 },
          updatedAtMs: 3_000,
        }),
      );
      const update = () =>
        commitCanonicalPlan(db, {
          expectations: [player, opponent].flatMap((profile) => [
            { kind: "profile-revision" as const, ...profile },
            {
              kind: "february-opponent-absent" as const,
              profileId: profile.profileId,
              opponentProfileId: "new-opponent",
            },
          ]),
          mutations: updates.flatMap((value) => [
            { kind: "update-active-profile" as const, value },
            {
              kind: "insert-february-opponent" as const,
              profileId: value.profile.id,
              opponentProfileId: "new-opponent",
              recordedAtMs: 3_000,
            },
          ]),
        });
      const observed = observeDatabase(
        timing === "before" ? { beforeBatch: update } : { afterBatch: update },
      );
      const result = await readCanonicalChallengeReplayProfiles(
        observed.database,
        {
          playerProfileId: player.profileId,
          opponentProfileId: opponent.profileId,
        },
      );
      for (const [index, role] of ["player", "opponent"].entries()) {
        expect(result[role as "player" | "opponent"]).toEqual({
          profile:
            timing === "before"
              ? {
                  ...updates[index],
                  profileId: updates[index].profile.id,
                  revision: 2,
                }
              : [player, opponent][index],
          februaryOpponentProfileIds:
            timing === "before" ? ["new-opponent"] : [],
        });
      }
      expect(observed.batches.map((batch) => batch.length)).toEqual([4]);
    },
  );

  it.each([false, true])(
    "preserves a valid merge source with deleted=%s without resolving its target",
    async (deleted) => {
      const source = await createProfile({ rating: 1200 });
      const target = await createProfile({ rating: 1800 });
      const retired = await retireProfile(source, target);
      if (deleted) {
        await commitCanonicalPlan(db, {
          expectations: [
            { kind: "profile-revision", ...retired },
            {
              kind: "merge-target",
              sourceProfileId: source.profileId,
              targetProfileId: target.profileId,
            },
          ],
          mutations: [
            {
              kind: "delete-retired-profile",
              profileId: source.profileId,
              targetProfileId: target.profileId,
            },
          ],
        });
      }
      const observed = observeDatabase();
      await expect(
        readCanonicalChallengeReplayProfiles(observed.database, {
          playerProfileId: source.profileId,
          opponentProfileId: target.profileId,
        }),
      ).resolves.toEqual({
        player: {
          profile: deleted ? null : retired,
          februaryOpponentProfileIds: [],
        },
        opponent: { profile: target, februaryOpponentProfileIds: [] },
      });
      expect(observed.batches.map((batch) => batch.length)).toEqual([4]);
    },
  );

  it.each([
    ["profile revision", { revision: 0 }],
    ["profile identity", { profile_id: "wrong-profile" }],
    ["profile payload", { payload_json: "{}" }],
    ["legacy fields", { legacy_fields_json: "[]" }],
    ["gameplay emoji", { gameplay_emoji_json: "{}" }],
    ["active redirect", { canonical_merge_source_profile_id: "source" }],
    ["orphan flag", { canonical_orphaned_dependents: 2 }],
  ])("rejects corrupt %s in either role", async (_label, changes) => {
    const profile = await createProfile();
    for (const index of [0, 2]) {
      const observed = observeDatabase({
        mapResults: changeRow(index, changes as Record<string, unknown>),
      });
      await expect(
        readCanonicalChallengeReplayProfiles(observed.database, {
          playerProfileId: profile.profileId,
          opponentProfileId: profile.profileId,
        }),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    }
  });

  it.each([
    [
      "missing redirect",
      {
        canonical_merge_source_profile_id: null,
        canonical_merge_target_profile_id: null,
        canonical_merge_merged_at_ms: null,
        canonical_merge_op_id: null,
      },
    ],
    ["source mismatch", { canonical_merge_source_profile_id: "wrong-source" }],
    ["target mismatch", { canonical_merge_target_profile_id: "wrong-target" }],
    ["merge timestamp", { canonical_merge_merged_at_ms: -1 }],
    ["merge operation", { canonical_merge_op_id: false }],
  ])("rejects a retiring profile with %s", async (_label, changes) => {
    const source = await createProfile();
    const target = await createProfile();
    await retireProfile(source, target);
    const observed = observeDatabase({
      mapResults: changeRow(0, changes as Record<string, unknown>),
    });
    await expect(
      readCanonicalChallengeReplayProfiles(observed.database, {
        playerProfileId: source.profileId,
        opponentProfileId: target.profileId,
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
  });

  it.each(["", null, 7, false, {}])(
    "rejects malformed opponent ID %j in either role",
    async (opponentProfileId) => {
      const profile = await createProfile();
      for (const index of [1, 3]) {
        const observed = observeDatabase({
          mapResults: (results) =>
            results.map((result, resultIndex) =>
              resultIndex === index
                ? {
                    ...result,
                    results: [{ opponent_profile_id: opponentProfileId }],
                  }
                : result,
            ),
        });
        await expect(
          readCanonicalChallengeReplayProfiles(observed.database, {
            playerProfileId: profile.profileId,
            opponentProfileId: profile.profileId,
          }),
        ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      }
    },
  );

  it.each([0, 2])(
    "rejects orphaned dependents for missing profile at batch index %s",
    async (index) => {
      const observed = observeDatabase({
        mapResults: changeRow(index, { canonical_orphaned_dependents: 1 }),
      });
      await expect(
        readCanonicalChallengeReplayProfiles(observed.database, {
          playerProfileId: "missing-orphan-player",
          opponentProfileId: "missing-orphan-opponent",
        }),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    },
  );

  it("rejects opponent rows belonging to a missing profile", async () => {
    const observed = observeDatabase({
      mapResults: (results) =>
        results.map((result, index) =>
          index === 1
            ? {
                ...result,
                results: [{ opponent_profile_id: "orphan-opponent" }],
              }
            : result,
        ),
    });
    await expect(
      readCanonicalChallengeReplayProfiles(observed.database, {
        playerProfileId: "missing-orphan-player",
        opponentProfileId: "missing-opponent",
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
  });

  it("rejects a malformed leftover redirect for a missing profile", async () => {
    const observed = observeDatabase({
      mapResults: changeRow(0, {
        canonical_merge_source_profile_id: "missing-merge-source",
        canonical_merge_target_profile_id: "merge-target",
        canonical_merge_merged_at_ms: -1,
        canonical_merge_op_id: null,
      }),
    });
    await expect(
      readCanonicalChallengeReplayProfiles(observed.database, {
        playerProfileId: "missing-merge-source",
        opponentProfileId: "missing-opponent",
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
  });

  it("does not hydrate unrelated auth or recovery payloads", async () => {
    const profile = await createProfile();
    await db.batch([
      db
        .prepare(
          `INSERT INTO profile_auth_methods
        (method, normalized_value, profile_id, raw_value, linked_at_ms, created_at_ms, updated_at_ms)
        VALUES ('apple', ?, ?, 'apple-subject', 0.5, 1000, 2000)`,
        )
        .bind(crypto.randomUUID(), profile.profileId),
      db
        .prepare(
          `INSERT INTO profile_auth_recovery_jobs
        (profile_id, login_uids_json, source_profile_ids_json, source_phase,
         phase_started_at_ms, last_enqueued_at_ms, created_at_ms, updated_at_ms)
        VALUES (?, '[false]', '[]', 'prizes', 1000, 1000, 1000, 2000)`,
        )
        .bind(profile.profileId),
    ]);
    await expect(
      readCanonicalProfileAggregateSnapshot(db, profile.profileId),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    const observed = observeDatabase();
    const result = await readCanonicalChallengeReplayProfiles(
      observed.database,
      {
        playerProfileId: profile.profileId,
        opponentProfileId: profile.profileId,
      },
    );
    const snapshot = { profile, februaryOpponentProfileIds: [] };
    expect(result).toEqual({ player: snapshot, opponent: snapshot });
    expect(observed.batches.map((batch) => batch.length)).toEqual([4]);
    expect(observed.batches[0].join("\n")).not.toMatch(
      /login_uids_json|source_profile_ids_json|raw_value|linked_at_ms/,
    );
  });

  it("preserves D1 failures", async () => {
    const failure = new Error("challenge-replay-d1-failed");
    const observed = observeDatabase({
      beforeBatch: async () => {
        throw failure;
      },
    });
    await expect(
      readCanonicalChallengeReplayProfiles(observed.database, {
        playerProfileId: "player",
        opponentProfileId: "opponent",
      }),
    ).rejects.toBe(failure);
    expect(observed.batches.map((batch) => batch.length)).toEqual([4]);
  });
});
