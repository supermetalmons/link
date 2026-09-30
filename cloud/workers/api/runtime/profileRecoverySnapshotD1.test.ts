import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAuthRecoveryService,
  MERGE_GAME_FINALIZE_DELAY_MS,
} from "../src/authRecovery.ts";
import {
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalAuthRecoveryJob,
  readCanonicalProfile,
  readCanonicalProfileAggregates,
} from "../src/profileCanonicalD1.ts";
import { readCanonicalRecoveryFinalizationSnapshot } from "../src/profileCanonical/recoverySnapshot.ts";
import type { AuthRecoveryPrizeStore } from "../src/eventRepository.ts";
import { commitProfileGameProjectionWrites } from "../src/profileGamesD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};
let sequence = 0;

async function insertProfile(profileId: string) {
  const value = materializeCanonicalProfile({
    profile: {
      id: profileId,
      nonce: 1,
      rating: 1500,
      totalManaPoints: 0,
      win: false,
      emoji: 1,
      username: null,
      eth: null,
      sol: null,
      completedProblemIds: [],
      isTutorialCompleted: false,
      mining: {
        lastRockDate: null,
        materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    },
    createdAtMs: 100,
    updatedAtMs: 100,
    legacyFields: { imported: [null, { exact: "é" }] },
  });
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [{ kind: "profile-absent", profileId }],
    mutations: [{ kind: "insert-active-profile", value }],
  });
  return value;
}

async function withoutMergeTriggers(work: () => Promise<void>) {
  const triggers = await testEnv.PROFILE_DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'profile_merge_targets'",
  ).all<{ name: string; sql: string }>();
  await testEnv.PROFILE_DB.batch(
    triggers.results.map(({ name }) =>
      testEnv.PROFILE_DB.prepare(`DROP TRIGGER ${name}`),
    ),
  );
  try {
    await work();
  } finally {
    await testEnv.PROFILE_DB.batch(
      triggers.results.map(({ sql }) => testEnv.PROFILE_DB.prepare(sql)),
    );
  }
}

async function insertMappings(mappings: Array<[string, string]>) {
  await withoutMergeTriggers(async () => {
    await testEnv.PROFILE_DB.batch(
      mappings.map(([source, target]) =>
        testEnv.PROFILE_DB.prepare(
          `INSERT INTO profile_merge_targets
           (source_profile_id, target_profile_id, merged_at_ms, op_id, source_legacy_fields_json)
           VALUES (?, ?, 200, NULL, '{}')`,
        ).bind(source, target),
      ),
    );
  });
}

async function fixture({
  edges = 1,
  sourcePresent = false,
  targetSuffix = "target",
} = {}) {
  const prefix = `recovery-snapshot-${++sequence}`;
  const targetId = `${prefix}-${targetSuffix}`;
  const sourceId = `${prefix}-source`;
  await insertProfile(targetId);
  const path = Array.from({ length: Math.max(1, edges) }, (_, index) =>
    index === 0 ? sourceId : `${prefix}-middle-${index}`,
  );
  if (sourcePresent) {
    const value = await insertProfile(sourceId);
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-revision", profileId: sourceId, revision: 1 },
        { kind: "profile-revision", profileId: targetId, revision: 1 },
        { kind: "merge-target-absent", sourceProfileId: sourceId },
      ],
      mutations: [
        {
          kind: "retire-profile-with-redirect",
          profile: materializeCanonicalProfile({
            ...value,
            state: "retiring",
            mergedIntoProfileId: targetId,
            mergedAtMs: 200,
            updatedAtMs: 200,
          }),
          redirect: {
            sourceProfileId: sourceId,
            targetProfileId: targetId,
            mergedAtMs: 200,
            opId: null,
            sourceLegacyFields: value.legacyFields,
          },
        },
      ],
    });
  } else if (edges > 0) {
    await insertMappings(
      path.map((id, index) => [id, path[index + 1] || targetId]),
    );
  }
  await testEnv.PROFILE_DB.prepare(
    `INSERT INTO profile_auth_recovery_jobs
     (profile_id, login_uids_json, source_profile_ids_json, source_phase, prize_cursor,
      phase_started_at_ms, last_enqueued_at_ms, created_at_ms, updated_at_ms, revision)
     VALUES (?, '[]', ?, 'finalize', NULL, 100, 0, 100, 100, 1)`,
  )
    .bind(targetId, JSON.stringify([sourceId]))
    .run();
  return { targetId, sourceId, path };
}

type Query = { sql: string; values: unknown[] };
type SnapshotResult = D1Result<Record<string, unknown>>;

function observeDatabase(
  options: {
    afterSnapshot?: () => Promise<void>;
    mapSnapshot?: (results: SnapshotResult[]) => SnapshotResult[];
  } = {},
) {
  const batches: Query[][] = [];
  const reads: Query[] = [];
  const native = new WeakMap<object, D1PreparedStatement>();
  const queries = new WeakMap<object, Query>();
  const wrap = (
    statement: D1PreparedStatement,
    query: Query,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            wrap(target.bind(...values), { ...query, values });
        const member = Reflect.get(target, property, target);
        if (property === "first" || property === "all")
          return (...args: unknown[]) => {
            reads.push(query);
            return Reflect.apply(member, target, args);
          };
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    native.set(wrapped, statement);
    queries.set(wrapped, query);
    return wrapped;
  };
  const database = new Proxy(testEnv.PROFILE_DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), { sql, values: [] });
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const batch = statements.map((statement) => queries.get(statement)!);
          batches.push(batch);
          let results = await target.batch<Record<string, unknown>>(
            statements.map((statement) => native.get(statement) || statement),
          );
          if (batch[0]?.sql.includes("recovery_request_index")) {
            results = options.mapSnapshot?.(results) || results;
            await options.afterSnapshot?.();
          }
          return results;
        };
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database, batches, reads };
}

const emptyPrizes: AuthRecoveryPrizeStore = {
  readProfileEventPrizeAssignment: async () => null,
  listProfileEventPrizeAssignments: async () => ({}),
  transactEventLease: async () => {
    throw new Error("unexpected prize lease");
  },
  transactStoredProfileEventPrizeWithEventLease: async () => {
    throw new Error("unexpected prize write");
  },
};

function recoveryService(
  db: D1Database,
  now = () => 100_000,
  prizeStore: AuthRecoveryPrizeStore = emptyPrizes,
) {
  return createAuthRecoveryService(testEnv, {
    profileDb: db,
    d1: testEnv.PROFILE_GAMES_DB,
    prizeStore,
    withdrawalStore: { get: async () => null },
    logger: { info: vi.fn(), error: vi.fn() },
    now,
  });
}

describe("profile recovery finalization snapshot", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "e".repeat(64),
    );
    await applyD1Migrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
  });

  it("reads both complete aggregates and the merge path in seven statements", async () => {
    const f = await fixture({ sourcePresent: true });
    await testEnv.PROFILE_DB.batch([
      ...["z", "é", "a"].map((suffix) =>
        testEnv.PROFILE_DB.prepare(
          `INSERT INTO profile_login_owners (login_uid, profile_id, revision, created_at_ms, updated_at_ms)
         VALUES (?, ?, 1, 100, 100)`,
        ).bind(`${f.targetId}-${suffix}`, f.targetId),
      ),
      ...["sol", "eth"].map((method) =>
        testEnv.PROFILE_DB.prepare(
          `INSERT INTO profile_auth_methods (method, normalized_value, raw_value, profile_id, revision, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, 1, 100, 100)`,
        ).bind(method, f.targetId, f.targetId, f.targetId),
      ),
      ...["z", "a"].map((opponent) =>
        testEnv.PROFILE_DB.prepare(
          `INSERT INTO profile_february_opponents (profile_id, opponent_profile_id, recorded_at_ms)
         VALUES (?, ?, 100)`,
        ).bind(f.targetId, opponent),
      ),
    ]);
    const expected = await readCanonicalProfileAggregates(testEnv.PROFILE_DB, [
      f.targetId,
      f.sourceId,
    ]);
    const observed = observeDatabase();
    const snapshot = await readCanonicalRecoveryFinalizationSnapshot(
      observed.database,
      f.targetId,
      f.sourceId,
    );
    expect([snapshot.target, snapshot.source]).toEqual(expected);
    expect(snapshot.mergePath).toEqual([expected[1].mergeTarget]);
    expect(observed.batches.map((batch) => batch.length)).toEqual([7]);
    expect(
      observed.batches[0].slice(0, 6).map((query) => query.values),
    ).toEqual(Array.from({ length: 6 }, () => [f.targetId, f.sourceId]));
    expect(observed.reads).toEqual([]);
    const plans = await testEnv.PROFILE_DB.batch<{ detail: string }>(
      observed.batches[0].map(({ sql, values }) =>
        testEnv.PROFILE_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values),
      ),
    );
    expect(
      plans
        .slice(0, 6)
        .every((plan) =>
          plan.results.some(({ detail }) => detail.includes("SEARCH value")),
        ),
    ).toBe(true);
    expect(
      plans[6].results.some(({ detail }) =>
        detail.includes("SEARCH profile_merge_targets"),
      ),
    ).toBe(true);
    expect(
      plans[6].results.some(({ detail }) => detail.includes("SEARCH target")),
    ).toBe(true);
  });

  it("keeps duplicate profile requests independent and preserves missing aggregates", async () => {
    const f = await fixture();
    const duplicate = await readCanonicalRecoveryFinalizationSnapshot(
      testEnv.PROFILE_DB,
      f.targetId,
      f.targetId,
    );
    expect(duplicate.target).toEqual(duplicate.source);
    expect(duplicate.target).not.toBe(duplicate.source);
    expect(duplicate.target.recovery?.sourceProfileIds).not.toBe(
      duplicate.source.recovery?.sourceProfileIds,
    );
    const absent = await readCanonicalRecoveryFinalizationSnapshot(
      testEnv.PROFILE_DB,
      "missing-target",
      "missing-source",
    );
    expect(absent.target).toEqual(absent.source);
    expect(absent.target.profile).toBeNull();
    expect(absent.mergePath).toBeNull();
  });

  it("retains raw aggregate topology semantics", async () => {
    const f = await fixture({ sourcePresent: true });
    const observed = observeDatabase({
      mapSnapshot(results) {
        results[4].results = results[4].results.filter(
          (row) => row.recovery_request_index !== 1,
        );
        return results;
      },
    });
    const snapshot = await readCanonicalRecoveryFinalizationSnapshot(
      observed.database,
      f.targetId,
      f.sourceId,
    );
    expect(snapshot.source.profile?.state).toBe("retiring");
    expect(snapshot.source.mergeTarget).toBeNull();
    expect(snapshot.mergePath).toHaveLength(1);
  });

  it.each([
    [0, "revision", 0],
    [0, "legacy_fields_json", [123]],
    [4, "merged_at_ms", -1],
    [5, "source_phase", "invalid"],
  ])(
    "preserves aggregate corruption at table %i field %s",
    async (table, field, value) => {
      const f = await fixture({ sourcePresent: true });
      const observed = observeDatabase({
        mapSnapshot(results) {
          results[Number(table)].results[0][String(field)] = value;
          return results;
        },
      });
      await expect(
        readCanonicalRecoveryFinalizationSnapshot(
          observed.database,
          f.targetId,
          f.sourceId,
        ),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    },
  );

  it.each([1, 2, 32, 33, 34])(
    "preserves the finalization boundary for %i redirect edges",
    async (edges) => {
      const f = await fixture({ edges });
      const observed = observeDatabase();
      const snapshot = await readCanonicalRecoveryFinalizationSnapshot(
        observed.database,
        f.targetId,
        f.sourceId,
      );
      expect(snapshot.mergePath?.length ?? null).toBe(
        edges <= 33 ? edges : null,
      );
      expect(
        snapshot.mergePath?.map((mapping) => mapping.sourceProfileId) ?? [],
      ).toEqual(edges <= 33 ? f.path : []);
      expect(observed.batches.map((batch) => batch.length)).toEqual([7]);
      expect(observed.reads).toEqual([]);
    },
  );

  it("leaves missing mappings and cycles pending", async () => {
    const f = await fixture({ edges: 0 });
    expect(
      (
        await readCanonicalRecoveryFinalizationSnapshot(
          testEnv.PROFILE_DB,
          f.targetId,
          f.sourceId,
        )
      ).mergePath,
    ).toBeNull();
    await insertMappings([
      [f.sourceId, `${f.sourceId}-middle`],
      [`${f.sourceId}-middle`, f.sourceId],
    ]);
    expect(
      (
        await readCanonicalRecoveryFinalizationSnapshot(
          testEnv.PROFILE_DB,
          f.targetId,
          f.sourceId,
        )
      ).mergePath,
    ).toBeNull();
  });

  it.each(["merged_at_ms", "op_id", "target_profile_id"])(
    "rejects an encountered malformed redirect %s",
    async (field) => {
      const f = await fixture({ edges: 2 });
      const observed = observeDatabase({
        mapSnapshot(results) {
          results[6].results[1][field] = field === "merged_at_ms" ? -1 : false;
          return results;
        },
      });
      await expect(
        readCanonicalRecoveryFinalizationSnapshot(
          observed.database,
          f.targetId,
          f.sourceId,
        ),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
    },
  );

  it("stops decoding after reaching the target or detecting a cycle", async () => {
    const f = await fixture();
    const observed = observeDatabase({
      mapSnapshot(results) {
        results[6].results.push({ depth: 1, source_profile_id: false });
        return results;
      },
    });
    expect(
      (
        await readCanonicalRecoveryFinalizationSnapshot(
          observed.database,
          f.targetId,
          f.sourceId,
        )
      ).mergePath,
    ).toHaveLength(1);
    const cycle = await fixture({ edges: 0 });
    await insertMappings([
      [cycle.sourceId, `${cycle.sourceId}-middle`],
      [`${cycle.sourceId}-middle`, cycle.sourceId],
    ]);
    const cycleObserved = observeDatabase({
      mapSnapshot(results) {
        results[6].results[2].merged_at_ms = -1;
        return results;
      },
    });
    expect(
      (
        await readCanonicalRecoveryFinalizationSnapshot(
          cycleObserved.database,
          cycle.targetId,
          cycle.sourceId,
        )
      ).mergePath,
    ).toBeNull();
  });

  it("does not decode the path without the target recovery job", async () => {
    const f = await fixture();
    const observed = observeDatabase({
      mapSnapshot(results) {
        results[5].results = [];
        results[6].results[0].op_id = false;
        return results;
      },
    });
    expect(
      (
        await readCanonicalRecoveryFinalizationSnapshot(
          observed.database,
          f.targetId,
          f.sourceId,
        )
      ).mergePath,
    ).toBeNull();
  });

  it.each(["source", "target"])(
    "keeps a lone surrogate %s bound directly during fallback",
    async (kind) => {
      const f = await fixture({ targetSuffix: "target-�" });
      const sourceId = kind === "source" ? `${f.sourceId}-\ud800` : f.sourceId;
      const targetId =
        kind === "target" ? f.targetId.replace("�", "\ud800") : f.targetId;
      const [profileRow, recoveryRow] = await Promise.all([
        testEnv.PROFILE_DB.prepare(
          "SELECT * FROM profile_records WHERE profile_id = ?",
        )
          .bind(f.targetId)
          .first<Record<string, unknown>>(),
        testEnv.PROFILE_DB.prepare(
          "SELECT * FROM profile_auth_recovery_jobs WHERE profile_id = ?",
        )
          .bind(f.targetId)
          .first<Record<string, unknown>>(),
      ]);
      const observed = observeDatabase({
        mapSnapshot(results) {
          if (kind === "target") {
            results[0].results = [{ ...profileRow, recovery_request_index: 0 }];
            results[5].results = [
              { ...recoveryRow, recovery_request_index: 0 },
            ];
          }
          return results;
        },
      });
      expect(
        (
          await readCanonicalRecoveryFinalizationSnapshot(
            observed.database,
            targetId,
            sourceId,
          )
        ).mergePath,
      ).toBeNull();
      expect(observed.reads[0]?.values).toEqual([sourceId]);
      expect(observed.batches[0][0].values).toEqual([targetId, sourceId]);
    },
  );

  it("follows decode-and-bind semantics for invalid UTF-8 mapping text", async () => {
    const f = await fixture({ edges: 0 });
    const bytes = new TextEncoder().encode(`${f.sourceId}-invalid-`);
    const invalidHex = [...bytes, 128]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const decodedId = `${f.sourceId}-invalid-�`;
    await withoutMergeTriggers(async () => {
      await testEnv.PROFILE_DB.batch([
        testEnv.PROFILE_DB.prepare(
          `INSERT INTO profile_merge_targets VALUES (?, CAST(X'${invalidHex}' AS TEXT), 200, NULL, '{}')`,
        ).bind(f.sourceId),
        testEnv.PROFILE_DB.prepare(
          `INSERT INTO profile_merge_targets VALUES (CAST(X'${invalidHex}' AS TEXT), 'wrong-target', 200, NULL, '{}')`,
        ),
        testEnv.PROFILE_DB.prepare(
          "INSERT INTO profile_merge_targets VALUES (?, ?, 200, NULL, '{}')",
        ).bind(decodedId, f.targetId),
      ]);
    });
    const observed = observeDatabase();
    const snapshot = await readCanonicalRecoveryFinalizationSnapshot(
      observed.database,
      f.targetId,
      f.sourceId,
    );
    expect(
      snapshot.mergePath?.map((mapping) => mapping.targetProfileId),
    ).toEqual([decodedId, f.targetId]);
    expect(observed.reads.map((query) => query.values)).toEqual([
      [f.sourceId],
      [decodedId],
    ]);
  });

  it("preserves D1 failures and rejects incomplete batch results", async () => {
    const f = await fixture();
    const failure = new Error("snapshot database unavailable");
    const failed = observeDatabase({
      mapSnapshot() {
        throw failure;
      },
    });
    await expect(
      readCanonicalRecoveryFinalizationSnapshot(
        failed.database,
        f.targetId,
        f.sourceId,
      ),
    ).rejects.toBe(failure);
    const incomplete = observeDatabase({
      mapSnapshot: (results) => results.slice(0, 6),
    });
    await expect(
      readCanonicalRecoveryFinalizationSnapshot(
        incomplete.database,
        f.targetId,
        f.sourceId,
      ),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
  });

  it("deletes a retired source without prematurely advancing the source list", async () => {
    const f = await fixture({ sourcePresent: true });
    const observed = observeDatabase();
    expect(
      await recoveryService(observed.database).recoverProfile(f.targetId),
    ).toBe(false);
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, f.sourceId),
    ).toBeNull();
    expect(
      await readCanonicalAuthRecoveryJob(testEnv.PROFILE_DB, f.targetId),
    ).toMatchObject({
      sourcePhase: "games",
      sourceProfileIds: [f.sourceId],
      prizeCursor: null,
    });
    const write = observed.batches.find((batch) =>
      batch[0]?.sql.includes("INSERT INTO profile_transaction_guards"),
    );
    expect(
      write?.some(
        (query) =>
          query.values.includes(f.sourceId) &&
          query.values.includes(f.targetId),
      ),
    ).toBe(true);
  });

  it("advances an already deleted source and retains the completion delay", async () => {
    const f = await fixture();
    let nowMs = 100_000;
    const service = recoveryService(testEnv.PROFILE_DB, () => nowMs);
    expect(await service.recoverProfile(f.targetId)).toBe(false);
    expect(
      await readCanonicalAuthRecoveryJob(testEnv.PROFILE_DB, f.targetId),
    ).toMatchObject({
      sourcePhase: "finalize",
      sourceProfileIds: [],
      updatedAtMs: nowMs,
    });
    expect(await service.recoverProfile(f.targetId)).toBe(false);
    nowMs += MERGE_GAME_FINALIZE_DELAY_MS;
    expect(await service.recoverProfile(f.targetId)).toBe(true);
  });

  it("returns to game recovery when a game appears before finalization", async () => {
    const f = await fixture({ sourcePresent: true });
    await commitProfileGameProjectionWrites(testEnv.PROFILE_GAMES_DB, [
      {
        type: "create",
        profileId: f.sourceId,
        projectionId: f.sourceId,
        data: {
          entityType: "game",
          inviteId: f.sourceId,
          kind: "direct",
          status: "waiting",
          sortBucket: 30,
          listSortAt: 2_000,
          updatedAt: 3_000,
          ownerProfileId: f.sourceId,
          hostLoginId: "host",
          guestLoginId: null,
          opponentProfileId: null,
          opponentName: null,
          opponentEmoji: null,
          automatchStateHint: null,
          isPendingAutomatch: false,
        },
      },
    ]);
    const observed = observeDatabase();
    expect(
      await recoveryService(observed.database).recoverProfile(f.targetId),
    ).toBe(false);
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, f.sourceId),
    ).not.toBeNull();
    expect(
      await readCanonicalAuthRecoveryJob(testEnv.PROFILE_DB, f.targetId),
    ).toMatchObject({ sourcePhase: "games", sourceProfileIds: [f.sourceId] });
    expect(
      observed.batches.some((batch) =>
        batch[0]?.sql.includes("recovery_request_index"),
      ),
    ).toBe(false);
  });

  it("retains finalization while a newly visible prize cannot yet be copied", async () => {
    const f = await fixture({ sourcePresent: true });
    const before = await readCanonicalAuthRecoveryJob(
      testEnv.PROFILE_DB,
      f.targetId,
    );
    const observed = observeDatabase();
    const prizes: AuthRecoveryPrizeStore = {
      ...emptyPrizes,
      listProfileEventPrizeAssignments: async () => ({
        "late-prize-event": {
          eventId: "late-prize-event",
          profileId: f.sourceId,
          place: 1,
          prizeId: "retired-prize",
          assignedAtMs: 100,
        },
      }),
      transactEventLease: async () => ({
        committed: false,
        decision: "locked",
        value: null,
      }),
    };
    expect(
      await recoveryService(
        observed.database,
        () => 100_000,
        prizes,
      ).recoverProfile(f.targetId),
    ).toBe(false);
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, f.sourceId),
    ).not.toBeNull();
    expect(
      await readCanonicalAuthRecoveryJob(testEnv.PROFILE_DB, f.targetId),
    ).toEqual(before);
    expect(observed.batches).toEqual([]);
  });

  it.each(["target", "source", "job"])(
    "retains the job and source when the %s revision changes after the snapshot",
    async (kind) => {
      const f = await fixture({ sourcePresent: true });
      const before = await readCanonicalAuthRecoveryJob(
        testEnv.PROFILE_DB,
        f.targetId,
      );
      const observed = observeDatabase({
        afterSnapshot: async () => {
          const table =
            kind === "job" ? "profile_auth_recovery_jobs" : "profile_records";
          await testEnv.PROFILE_DB.prepare(
            `UPDATE ${table} SET revision = revision + 1 WHERE profile_id = ?`,
          )
            .bind(kind === "source" ? f.sourceId : f.targetId)
            .run();
        },
      });
      expect(
        await recoveryService(observed.database).recoverProfile(f.targetId),
      ).toBe(false);
      expect(
        await readCanonicalProfile(testEnv.PROFILE_DB, f.sourceId),
      ).not.toBeNull();
      expect(
        await readCanonicalAuthRecoveryJob(testEnv.PROFILE_DB, f.targetId),
      ).toEqual({ ...before, revision: kind === "job" ? 2 : 1 });
    },
  );

  it("guards every intermediate redirect before advancing the recovery job", async () => {
    const f = await fixture({ edges: 3 });
    const before = await readCanonicalAuthRecoveryJob(
      testEnv.PROFILE_DB,
      f.targetId,
    );
    const observed = observeDatabase({
      afterSnapshot: () =>
        withoutMergeTriggers(async () => {
          await testEnv.PROFILE_DB.prepare(
            "UPDATE profile_merge_targets SET target_profile_id = ? WHERE source_profile_id = ?",
          )
            .bind("changed-target", f.path[1])
            .run();
        }),
    });
    expect(
      await recoveryService(observed.database).recoverProfile(f.targetId),
    ).toBe(false);
    expect(
      await readCanonicalAuthRecoveryJob(testEnv.PROFILE_DB, f.targetId),
    ).toEqual(before);
    const expectedGuards = f.path.map((sourceProfileId, index) => [
      sourceProfileId,
      f.path[index + 1] || f.targetId,
    ]);
    const guardValues = observed.batches
      .flat()
      .filter(
        (query) =>
          query.sql.includes("FROM profile_merge_targets") &&
          query.sql.includes("INSERT INTO profile_transaction_guards"),
      )
      .map((query) => query.values);
    expect(guardValues).toEqual(expectedGuards);
  });
});
