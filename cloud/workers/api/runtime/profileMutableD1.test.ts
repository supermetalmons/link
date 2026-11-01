import { materializeProfileFixture as materializeCanonicalProfile } from "../test/profileDataBoundaryFixture.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  type CanonicalCommitPlan,
} from "../src/profileCanonicalD1.ts";
import { readCanonicalProfileMutationByLogin } from "../src/profileMutationD1.ts";
import {
  buildMutableProfileMutation,
  readMutableProfileMutationByLogin,
  readMutableRatingProfiles,
  resolveMutableProfiles,
  type CanonicalMutableProfileSnapshot,
} from "../src/profileMutableD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;

async function createProfile() {
  const profileId = `mutable-profile-${crypto.randomUUID()}`;
  const loginUid = `mutable-login-${crypto.randomUUID()}`;
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
    },
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
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
        value: { loginUid, profileId, createdAtMs: 1_000, updatedAtMs: 2_000 },
      },
    ],
  });
  return { profileId, loginUid };
}

function observeDatabase(
  database: D1Database,
  mapReadRow?: (
    row: Record<string, unknown>,
    statementIndex: number,
  ) => Record<string, unknown>,
) {
  const calls: Array<{
    queries: string[];
    bindings: unknown[][];
    rows: Record<string, unknown>[];
  }> = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const descriptions = new WeakMap<
    D1PreparedStatement,
    { query: string; values: unknown[] }
  >();
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
    values: unknown[] = [],
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...bound: unknown[]) =>
            wrap(target.bind(...bound), query, bound);
        if (property === "first")
          return async () => {
            const stored = await target.first<Record<string, unknown>>();
            const result =
              stored && mapReadRow ? mapReadRow(stored, 0) : stored;
            calls.push({
              queries: [query],
              bindings: [values],
              rows: result ? [result] : [],
            });
            return result;
          };
        if (property === "all" || property === "run")
          return async () => {
            const result = await target[property]<Record<string, unknown>>();
            calls.push({
              queries: [query],
              bindings: [values],
              rows: result.results,
            });
            return result;
          };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    originals.set(wrapped, statement);
    descriptions.set(wrapped, { query, values });
    return wrapped;
  };
  const observed = new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => wrap(target.prepare(query), query);
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const stored = await target.batch<Record<string, unknown>>(
            statements.map(
              (statement) => originals.get(statement) || statement,
            ),
          );
          const result = mapReadRow
            ? stored.map((entry, statementIndex) => ({
                ...entry,
                results: entry.results.map((row) =>
                  mapReadRow(row, statementIndex),
                ),
              }))
            : stored;
          calls.push({
            queries: statements.map(
              (statement) => descriptions.get(statement)?.query || "",
            ),
            bindings: statements.map(
              (statement) => descriptions.get(statement)?.values || [],
            ),
            rows: result.flatMap((entry) => entry.results),
          });
          return result;
        };
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database: observed, calls };
}

function updatePlan(
  snapshot: CanonicalMutableProfileSnapshot,
): CanonicalCommitPlan {
  return {
    expectations: [
      {
        kind: "profile-revision",
        profileId: snapshot.profileId,
        revision: snapshot.revision,
      },
    ],
    mutations: [
      buildMutableProfileMutation(
        snapshot,
        snapshot.profile,
        snapshot.updatedAtMs,
      ),
    ],
  };
}

beforeAll(async () => {
  await applyRetiredProfileMigrations(
    db,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "8".repeat(64),
  );
});

describe("canonical mutable profile reads and writes", () => {
  it("returns one fully validated shape for full and mutable readers", async () => {
    const { loginUid } = await createProfile();
    const full = await readCanonicalProfileMutationByLogin(db, loginUid);
    const observed = observeDatabase(db);
    const mutable = await readMutableProfileMutationByLogin(
      observed.database,
      loginUid,
    );
    expect(mutable).toEqual(full);
    expect(mutable?.profile).not.toHaveProperty("legacyFields");
    expect(mutable?.profile).not.toHaveProperty("storageShape");
    expect(observed.calls[0]!.queries[0]).not.toMatch(/legacy_fields/);
  });
  it("rejects malformed profile payloads before a mutable update can be built", async () => {
    const { loginUid } = await createProfile();
    for (const patch of [
      { schema_version: 0 },
      { gameplay_emoji: "2" },
      { payload_json: "{}" },
      { payload_json: "[]" },
      { rating_sort: "1500" },
    ]) {
      const observed = observeDatabase(db, (row) => ({ ...row, ...patch }));
      await expect(
        readMutableProfileMutationByLogin(observed.database, loginUid),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    }
  });
  it("keeps paired reads ordered and resolves duplicate and missing wager targets in one batch", async () => {
    const first = await createProfile();
    const second = await createProfile();
    const observed = observeDatabase(db);
    const pair = await readMutableRatingProfiles(observed.database, {
      playerLoginUid: second.loginUid,
      opponentLoginUid: first.loginUid,
    });
    expect(pair.player?.profile.profileId).toBe(second.profileId);
    expect(pair.opponent?.profile.profileId).toBe(first.profileId);
    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0]!.queries).toHaveLength(2);
    expect(observed.calls[0]!.bindings).toEqual([
      [second.loginUid],
      [first.loginUid],
    ]);
    observed.calls.length = 0;
    const resolved = await resolveMutableProfiles(observed.database, [
      second.profileId,
      first.profileId,
      second.profileId,
      "absent-profile",
    ]);
    expect(resolved.map((profile) => profile?.profileId ?? null)).toEqual([
      second.profileId,
      first.profileId,
      second.profileId,
      null,
    ]);
    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0]!.queries).toHaveLength(4);
  });

  it("returns null only for missing logins in single and ordered paired reads", async () => {
    const existing = await createProfile();
    const missingLoginUid = `missing-mutable-login-${crypto.randomUUID()}`;
    const observed = observeDatabase(db);
    await expect(
      readMutableProfileMutationByLogin(observed.database, missingLoginUid),
    ).resolves.toBeNull();
    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0]!.queries).toHaveLength(1);
    expect(observed.calls[0]!.bindings).toEqual([[missingLoginUid]]);

    for (const [missingPlayer, missingOpponent] of [
      [true, false],
      [false, true],
      [true, true],
      [false, false],
    ]) {
      observed.calls.length = 0;
      const playerLoginUid = missingPlayer
        ? missingLoginUid
        : existing.loginUid;
      const opponentLoginUid = missingOpponent
        ? missingLoginUid
        : existing.loginUid;
      const pair = await readMutableRatingProfiles(observed.database, {
        playerLoginUid,
        opponentLoginUid,
      });
      expect(pair.player?.profile.profileId ?? null).toBe(
        missingPlayer ? null : existing.profileId,
      );
      expect(pair.opponent?.profile.profileId ?? null).toBe(
        missingOpponent ? null : existing.profileId,
      );
      expect(pair.player?.owner.loginUid ?? null).toBe(
        missingPlayer ? null : playerLoginUid,
      );
      expect(pair.opponent?.owner.loginUid ?? null).toBe(
        missingOpponent ? null : opponentLoginUid,
      );
      expect(observed.calls).toHaveLength(1);
      expect(observed.calls[0]!.queries).toHaveLength(2);
      expect(observed.calls[0]!.bindings).toEqual([
        [playerLoginUid],
        [opponentLoginUid],
      ]);
    }
  });

  it.each([
    ["dangling owner", { profile_id: null, payload_json: null }],
    ["owner login mismatch", { canonical_owner_login_uid: "another-login" }],
    [
      "owner profile mismatch",
      { canonical_owner_profile_id: "another-profile" },
    ],
    [
      "retiring profile",
      { state: "retiring", merged_into_profile_id: "another-profile" },
    ],
    [
      "unexpected redirect",
      { canonical_merge_source_profile_id: "another-profile" },
    ],
  ] as const)(
    "rejects a %s through single and paired mutable reads",
    async (_label, changes) => {
      const corrupt = await createProfile();
      const healthy = await createProfile();
      for (const role of ["single", "player", "opponent"] as const) {
        const index = role === "opponent" ? 1 : 0;
        const observed = observeDatabase(db, (row, statementIndex) =>
          statementIndex === index ? { ...row, ...changes } : row,
        );
        const playerLoginUid =
          role === "opponent" ? healthy.loginUid : corrupt.loginUid;
        const opponentLoginUid =
          role === "opponent" ? corrupt.loginUid : healthy.loginUid;
        await expect(
          role === "single"
            ? readMutableProfileMutationByLogin(
                observed.database,
                corrupt.loginUid,
              )
            : readMutableRatingProfiles(observed.database, {
                playerLoginUid,
                opponentLoginUid,
              }),
        ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
        expect(observed.calls).toHaveLength(1);
        expect(observed.calls[0]!.queries).toHaveLength(
          role === "single" ? 1 : 2,
        );
        expect(observed.calls[0]!.bindings).toEqual(
          role === "single"
            ? [[corrupt.loginUid]]
            : [[playerLoginUid], [opponentLoginUid]],
        );
      }
    },
  );

  it("requires the original revision and increments revision for a no-op field patch", async () => {
    const { profileId, loginUid } = await createProfile();
    const initial = (await readMutableProfileMutationByLogin(db, loginUid))!;
    const plan = updatePlan(initial.profile);
    await expect(
      commitCanonicalPlan(db, {
        ...plan,
        expectations: [
          {
            kind: "profile-revision",
            profileId,
            revision: initial.profile.revision + 1,
          },
        ],
      }),
    ).rejects.toThrow("unsafe-canonical-commit-plan");
    await commitCanonicalPlan(db, plan);
    const current = (await readMutableProfileMutationByLogin(db, loginUid))!;
    expect(current.profile).toEqual({
      ...initial.profile,
      revision: initial.profile.revision + 1,
    });
    await expect(commitCanonicalPlan(db, plan)).rejects.toBeInstanceOf(
      CanonicalProfileConflict,
    );
  });

  it("rejects retained or lifecycle fields in a mutable patch", async () => {
    const { loginUid } = await createProfile();
    const initial = (await readMutableProfileMutationByLogin(db, loginUid))!;
    for (const extra of [
      { legacyFields: {} },
      { state: "retiring" },
      { createdAtMs: 0 },
      { mergedIntoProfileId: "other" },
    ]) {
      const plan = updatePlan(initial.profile);
      const mutation = plan.mutations[0]!;
      if (mutation.kind !== "patch-profile-fields")
        throw new Error("expected-narrow-patch");
      await expect(
        commitCanonicalPlan(db, {
          ...plan,
          mutations: [{ ...mutation, value: { ...mutation.value, ...extra } }],
        }),
      ).rejects.toThrow();
    }
  });
});
