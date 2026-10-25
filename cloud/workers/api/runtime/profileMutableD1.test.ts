import { materializeProfileCompatibility as materializeCanonicalProfile } from "../test/profileDataBoundaryFixture.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  type CanonicalCommitPlan,
  type CanonicalProfileSnapshot,
} from "../src/profileCanonicalD1.ts";
import {
  commitCanonicalProfileUpdate,
  materializeCanonicalProfileUpdate,
  readCanonicalProfileMutationByLogin,
} from "../src/profileMutationD1.ts";
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
const tables = ["mutable_profile_cases", "full_profile_cases"] as const;

async function createProfile(legacyFields: Record<string, unknown> = {}) {
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
    legacyFields,
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

function tableDatabase(table: (typeof tables)[number]): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(sql.replace(/\bprofile_records\b/g, table));
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

async function copyProfile(profileId: string) {
  await db.batch(
    tables.map((table) =>
      db
        .prepare(
          `INSERT INTO ${table} SELECT * FROM profile_records WHERE profile_id = ?`,
        )
        .bind(profileId),
    ),
  );
}

async function replaceLegacy(
  profileId: string,
  value: string | number | null | Uint8Array,
  castText = false,
) {
  await db.batch(
    tables.map((table) =>
      db
        .prepare(
          `UPDATE ${table} SET legacy_fields_json = ${castText ? "CAST(? AS TEXT)" : "?"} WHERE profile_id = ?`,
        )
        .bind(value, profileId),
    ),
  );
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

function publicSnapshot(
  snapshot: CanonicalProfileSnapshot | CanonicalMutableProfileSnapshot,
) {
  return Object.fromEntries(
    Object.entries(snapshot).filter(
      ([key]) => key !== "legacyFields" && key !== "storageShape",
    ),
  );
}

type Observation = {
  queries: string[];
  bindings: unknown[][];
  rows: Record<string, unknown>[];
};

function observeDatabase(
  database: D1Database,
  mapReadRow?: (
    row: Record<string, unknown>,
    statementIndex: number,
  ) => Record<string, unknown>,
) {
  const calls: Observation[] = [];
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
  for (const table of tables)
    await db
      .prepare(`CREATE TABLE ${table} AS SELECT * FROM profile_records WHERE 0`)
      .run();
});

describe("narrow profile mutation compatibility", () => {
  const legacyCases = [
    { label: "empty object", value: "{}", valid: true },
    {
      label: "whitespace and duplicate keys",
      value: ' { "a": 1, "a": 2 } ',
      valid: true,
    },
    { label: "escaped NUL", value: '{"a":"\\u0000"}', valid: true },
    { label: "lone surrogate escape", value: '{"a":"\\ud800"}', valid: true },
    { label: "overflow number", value: '{"a":1e999}', valid: true },
    { label: "BOM inside string", value: '{"a":"\ufeff"}', valid: true },
    { label: "array", value: "[]", valid: false },
    { label: "scalar", value: '"value"', valid: false },
    { label: "JSON null", value: "null", valid: false },
    { label: "SQL null", value: null, valid: false },
    { label: "numeric storage", value: 5, valid: false },
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
    ...[998, 999, 1000, 1100].map((depth) => ({
      label: `nesting depth ${depth}`,
      value: '{"a":' + "[".repeat(depth) + "0" + "]".repeat(depth) + "}",
      valid: true,
    })),
  ];

  it.each(legacyCases)(
    "matches full-reader validation for $label",
    async ({ value, valid, ...options }) => {
      const { profileId, loginUid } = await createProfile();
      await copyProfile(profileId);
      await replaceLegacy(
        profileId,
        value,
        "castText" in options && options.castText === true,
      );
      const fullDb = observeDatabase(tableDatabase("full_profile_cases"));
      const mutableDb = observeDatabase(tableDatabase("mutable_profile_cases"));
      const full = await outcome(() =>
        readCanonicalProfileMutationByLogin(fullDb.database, loginUid),
      );
      const mutable = await outcome(() =>
        readMutableProfileMutationByLogin(mutableDb.database, loginUid),
      );
      expect(full.ok).toBe(valid);
      expect(mutable.ok).toBe(full.ok);
      expect(fullDb.calls).toHaveLength(1);
      expect(mutableDb.calls).toHaveLength(1);
      if (!full.ok || !mutable.ok) {
        expect(mutable).toEqual(full);
        return;
      }
      expect(full.value).not.toBeNull();
      expect(mutable.value).not.toBeNull();
      expect(mutable.value!.owner).toEqual(full.value!.owner);
      expect(publicSnapshot(mutable.value!.profile)).toEqual(
        publicSnapshot(full.value!.profile),
      );
      if (mutable.value!.profile.storageShape === "full")
        expect(mutable.value!.profile.legacyFields).toEqual(
          full.value!.profile.legacyFields,
        );
      else {
        expect(mutableDb.calls[0].rows[0]).not.toHaveProperty(
          "legacy_fields_json",
        );
        expect(
          mutableDb.calls[0].rows[0].legacy_fields_fallback_json,
        ).toBeNull();
      }
    },
  );

  it.each([
    ' { "old": 1, "old": 2 } ',
    '{"a":' + "[".repeat(1100) + "0" + "]".repeat(1100) + "}",
  ])(
    "preserves complete rows and write bindings for retained JSON %#",
    async (legacy) => {
      const { profileId, loginUid } = await createProfile();
      await copyProfile(profileId);
      await replaceLegacy(profileId, legacy);
      const fullDb = observeDatabase(tableDatabase("full_profile_cases"));
      const mutableDb = observeDatabase(tableDatabase("mutable_profile_cases"));
      const full = (await readCanonicalProfileMutationByLogin(
        fullDb.database,
        loginUid,
      ))!;
      const mutable = (await readMutableProfileMutationByLogin(
        mutableDb.database,
        loginUid,
      ))!;
      const nextProfile = {
        ...full.profile.profile,
        mining: {
          ...full.profile.profile.mining,
          materials: { ...full.profile.profile.mining.materials, dust: 7 },
        },
      };
      const options = { sortUpdates: { dust: 7 } };
      const fullValue = materializeCanonicalProfileUpdate(
        full.profile,
        nextProfile,
        3_000,
        options,
      );
      const mutation = buildMutableProfileMutation(
        mutable.profile,
        nextProfile,
        3_000,
        options,
      );
      expect(mutation.kind).toBe(
        mutable.profile.storageShape === "full"
          ? "patch-active-profile"
          : "patch-profile-fields",
      );
      fullDb.calls.length = 0;
      mutableDb.calls.length = 0;
      await commitCanonicalProfileUpdate(
        fullDb.database,
        full.profile,
        fullValue,
        { owner: full.owner },
      );
      await commitCanonicalPlan(mutableDb.database, {
        expectations: [
          {
            kind: "profile-revision",
            profileId,
            revision: mutable.profile.revision,
          },
          { kind: "login-owner-revision", ...mutable.owner },
        ],
        mutations: [mutation],
      });
      expect(mutableDb.calls).toEqual(fullDb.calls);
      const rows = await Promise.all(
        tables.map((table) =>
          db
            .prepare(`SELECT * FROM ${table} WHERE profile_id = ?`)
            .bind(profileId)
            .first(),
        ),
      );
      expect(rows[0]).toEqual(rows[1]);
      expect(rows[0]).toMatchObject({
        legacy_fields_json: legacy,
        revision: 2,
      });
    },
  );

  it("defers exceptional retained-object serialization failures until commit", async () => {
    const { profileId, loginUid } = await createProfile();
    await copyProfile(profileId);
    const deep = '{"a":' + "[".repeat(20_000) + "0" + "]".repeat(20_000) + "}";
    await replaceLegacy(profileId, deep);
    const fullDb = observeDatabase(tableDatabase("full_profile_cases"));
    const mutableDb = observeDatabase(tableDatabase("mutable_profile_cases"));
    const full = (await readCanonicalProfileMutationByLogin(
      fullDb.database,
      loginUid,
    ))!;
    const mutable = (await readMutableProfileMutationByLogin(
      mutableDb.database,
      loginUid,
    ))!;
    expect(mutable.profile.storageShape).toBe("full");
    if (mutable.profile.storageShape !== "full")
      throw new Error("expected-full-fallback");
    const retained = new Set([
      full.profile.legacyFields,
      mutable.profile.legacyFields,
    ]);
    const stringify = JSON.stringify;
    const spy = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value, ...args) => {
        if (retained.has(value))
          throw new RangeError("retained-serialization-failed");
        return stringify(value, ...args);
      });
    try {
      const fullValue = materializeCanonicalProfileUpdate(
        full.profile,
        full.profile.profile,
        full.profile.updatedAtMs,
      );
      const narrowPlan = updatePlan(mutable.profile);
      fullDb.calls.length = 0;
      mutableDb.calls.length = 0;
      const oldOutcome = await outcome(() =>
        commitCanonicalProfileUpdate(fullDb.database, full.profile, fullValue),
      );
      const newOutcome = await outcome(() =>
        commitCanonicalPlan(mutableDb.database, narrowPlan),
      );
      expect(oldOutcome.ok).toBe(false);
      expect(newOutcome).toEqual(oldOutcome);
      expect(fullDb.calls).toHaveLength(0);
      expect(mutableDb.calls).toHaveLength(0);
    } finally {
      spy.mockRestore();
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
    expect(observed.calls[0].queries).toHaveLength(2);
    expect(observed.calls[0].bindings).toEqual([
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
    expect(observed.calls[0].queries).toHaveLength(4);
  });

  it("returns null only for missing logins in single and ordered paired reads", async () => {
    const existing = await createProfile();
    const missingLoginUid = `missing-mutable-login-${crypto.randomUUID()}`;
    const observed = observeDatabase(db);
    await expect(
      readMutableProfileMutationByLogin(observed.database, missingLoginUid),
    ).resolves.toBeNull();
    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0].queries).toHaveLength(1);
    expect(observed.calls[0].bindings).toEqual([[missingLoginUid]]);

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
      expect(observed.calls[0].queries).toHaveLength(2);
      expect(observed.calls[0].bindings).toEqual([
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
        expect(observed.calls[0].queries).toHaveLength(
          role === "single" ? 1 : 2,
        );
        expect(observed.calls[0].bindings).toEqual(
          role === "single"
            ? [[corrupt.loginUid]]
            : [[playerLoginUid], [opponentLoginUid]],
        );
      }
    },
  );

  it("requires the original revision and increments revision for a no-op field patch", async () => {
    const { profileId, loginUid } = await createProfile({ old: true });
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
      const mutation = plan.mutations[0];
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

  it("bounds normal read payloads and write bindings independently of retained data size", async () => {
    const results: Array<Record<string, number>> = [];
    const narrowSizes: number[] = [];
    for (const legacySize of [0, 64 * 1024, 256 * 1024]) {
      const legacy = legacySize ? { archive: "x".repeat(legacySize) } : {};
      const { profileId, loginUid } = await createProfile(legacy);
      const fullDb = observeDatabase(db);
      const mutableDb = observeDatabase(db);
      const fullStarted = performance.now();
      const full = (await readCanonicalProfileMutationByLogin(
        fullDb.database,
        loginUid,
      ))!;
      const fullReadMs = performance.now() - fullStarted;
      const mutableStarted = performance.now();
      const mutable = (await readMutableProfileMutationByLogin(
        mutableDb.database,
        loginUid,
      ))!;
      const mutableReadMs = performance.now() - mutableStarted;
      const bytes = (rows: unknown) =>
        new TextEncoder().encode(JSON.stringify(rows)).byteLength;
      const fullBytes = bytes(fullDb.calls[0].rows);
      const mutableBytes = bytes(mutableDb.calls[0].rows);
      expect(fullDb.calls).toHaveLength(1);
      expect(mutableDb.calls).toHaveLength(1);
      expect(mutable.profile.storageShape).toBe("mutable");
      expect(mutableDb.calls[0].rows[0]).not.toHaveProperty(
        "legacy_fields_json",
      );
      narrowSizes.push(mutableBytes);
      await copyProfile(profileId);
      const fullWrites = observeDatabase(tableDatabase("full_profile_cases"));
      const mutableWrites = observeDatabase(
        tableDatabase("mutable_profile_cases"),
      );
      const nextProfile = { ...full.profile.profile, rating: 1600 };
      const options = { sortUpdates: { rating: 1600 } };
      const serialized: unknown[] = [];
      const stringify = JSON.stringify;
      const spy = vi
        .spyOn(JSON, "stringify")
        .mockImplementation((value, ...args) => {
          serialized.push(value);
          return stringify(value, ...args);
        });
      let fullWriteMs: number;
      let mutableWriteMs: number;
      let fullLegacySerializations: number;
      let mutableLegacySerializations: number;
      try {
        const startFull = performance.now();
        const fullValue = materializeCanonicalProfileUpdate(
          full.profile,
          nextProfile,
          3_000,
          options,
        );
        await commitCanonicalProfileUpdate(
          fullWrites.database,
          full.profile,
          fullValue,
        );
        fullWriteMs = performance.now() - startFull;
        fullLegacySerializations = serialized.filter(
          (value) => value === full.profile.legacyFields,
        ).length;
        serialized.length = 0;
        const startMutable = performance.now();
        await commitCanonicalPlan(mutableWrites.database, {
          expectations: [
            {
              kind: "profile-revision",
              profileId,
              revision: mutable.profile.revision,
            },
          ],
          mutations: [
            buildMutableProfileMutation(
              mutable.profile,
              nextProfile,
              3_000,
              options,
            ),
          ],
        });
        mutableWriteMs = performance.now() - startMutable;
        mutableLegacySerializations = serialized.filter(
          (value) => value === full.profile.legacyFields,
        ).length;
      } finally {
        spy.mockRestore();
      }
      expect(fullLegacySerializations).toBeGreaterThan(0);
      expect(mutableLegacySerializations).toBe(0);
      expect(mutableWrites.calls).toEqual(fullWrites.calls);
      if (legacySize)
        expect(
          JSON.stringify(mutableWrites.calls.flatMap((call) => call.bindings)),
        ).not.toContain("x".repeat(64));
      results.push({
        legacySize,
        fullBytes,
        mutableBytes,
        fullReadMs,
        mutableReadMs,
        fullWriteMs,
        mutableWriteMs,
        fullLegacySerializations,
        mutableLegacySerializations,
      });
    }
    expect(new Set(narrowSizes).size).toBe(1);
    expect(results[2].mutableBytes).toBeLessThan(results[2].fullBytes / 50);
    console.info(
      JSON.stringify({ event: "profile_mutation_benchmark", samples: results }),
    );
  });
});
