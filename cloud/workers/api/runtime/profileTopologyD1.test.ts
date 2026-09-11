import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
  countCanonicalCommitStatements,
  materializeCanonicalProfile,
  readCanonicalProfile,
  readCanonicalProfileAggregate,
  readCanonicalMergeTarget,
  type CanonicalAuthMethodValue,
  type CanonicalAuthRecoveryValue,
  type CanonicalCommitPlan,
  type CanonicalProfileAggregateSnapshot,
  type CanonicalProfileSnapshot,
} from "../src/profileCanonicalD1.ts";
import {
  CANONICAL_PROFILE_TOPOLOGY_AUDIT_SQL,
  CANONICAL_PROFILE_TOPOLOGY_VIOLATION_PREDICATE,
} from "../src/profileTopologySql.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;
const healthyAudit = {
  retiring_profile_without_matching_redirect: 0,
  active_profile_with_redirect: 0,
  login_owner_without_active_profile: 0,
  auth_method_without_active_profile: 0,
  recovery_job_without_active_profile: 0,
};

type Relation = "owner" | "auth" | "recovery";
type Fixture = CanonicalProfileAggregateSnapshot & {
  profile: CanonicalProfileSnapshot;
};

function authValue(profileId: string): CanonicalAuthMethodValue {
  return {
    profileId,
    method: "x",
    normalizedValue: `x-${profileId}`,
    rawValue: `x-${profileId}`,
    appleEmailMasked: null,
    consentAtMs: null,
    consentSource: null,
    linkedAtMs: 1_000,
    xUsername: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function recoveryValue(profileId: string): CanonicalAuthRecoveryValue {
  return {
    profileId,
    loginUids: [],
    sourceProfileIds: [],
    sourcePhase: "prizes",
    prizeCursor: null,
    phaseStartedAtMs: 1_000,
    lastEnqueuedAtMs: 0,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

async function fixture(relations: Relation[] = []): Promise<Fixture> {
  const profileId = `topology-${crypto.randomUUID()}`;
  const value = materializeCanonicalProfile({
    profile: {
      id: profileId,
      nonce: 0,
      rating: 1_500,
      totalManaPoints: 0,
      win: false,
      emoji: 1,
      username: null,
      eth: null,
      sol: null,
      completedProblemIds: [],
      isTutorialCompleted: false,
      mining: {
        lastRockDate: "",
        materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    },
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  const plan: CanonicalCommitPlan = {
    expectations: [{ kind: "profile-absent", profileId }],
    mutations: [{ kind: "insert-active-profile", value }],
  };
  for (const relation of relations) {
    if (relation === "owner") {
      const loginUid = `login-${profileId}`;
      plan.expectations = [
        ...plan.expectations,
        { kind: "login-owner-absent", loginUid },
      ];
      plan.mutations = [
        ...plan.mutations,
        {
          kind: "insert-login-owner",
          value: {
            profileId,
            loginUid,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
      ];
    } else if (relation === "auth") {
      const auth = authValue(profileId);
      plan.expectations = [
        ...plan.expectations,
        {
          kind: "auth-method-absent",
          method: auth.method,
          normalizedValue: auth.normalizedValue,
        },
      ];
      plan.mutations = [
        ...plan.mutations,
        { kind: "insert-auth-method", value: auth },
      ];
    } else {
      plan.expectations = [
        ...plan.expectations,
        { kind: "auth-recovery-absent", profileId },
      ];
      plan.mutations = [
        ...plan.mutations,
        { kind: "insert-auth-recovery", value: recoveryValue(profileId) },
      ];
    }
  }
  await commitCanonicalPlan(db, plan);
  const aggregate = await readCanonicalProfileAggregate(db, profileId);
  if (!aggregate.profile) throw new Error("missing-topology-test-profile");
  return { ...aggregate, profile: aggregate.profile };
}

function retirementPlan(source: Fixture, target: Fixture): CanonicalCommitPlan {
  const sourceProfileId = source.profile.profileId;
  const targetProfileId = target.profile.profileId;
  return {
    expectations: [
      {
        kind: "profile-revision",
        profileId: sourceProfileId,
        revision: source.profile.revision,
      },
      {
        kind: "profile-revision",
        profileId: targetProfileId,
        revision: target.profile.revision,
      },
      { kind: "merge-target-absent", sourceProfileId },
    ],
    mutations: [
      {
        kind: "retire-profile-with-redirect",
        profile: materializeCanonicalProfile({
          ...source.profile,
          state: "retiring",
          mergedIntoProfileId: targetProfileId,
          mergedAtMs: 2_000,
          updatedAtMs: 2_000,
        }),
        redirect: {
          sourceProfileId,
          targetProfileId,
          mergedAtMs: 2_000,
          opId: null,
          sourceLegacyFields: source.profile.legacyFields,
        },
      },
    ],
  };
}

function updatePlan(profile: CanonicalProfileSnapshot): CanonicalCommitPlan {
  return {
    expectations: [
      {
        kind: "profile-revision",
        profileId: profile.profileId,
        revision: profile.revision,
      },
    ],
    mutations: [
      {
        kind: "update-active-profile",
        value: materializeCanonicalProfile({
          ...profile,
          profile: { ...profile.profile, isTutorialCompleted: true },
          updatedAtMs: 2_000,
        }),
      },
    ],
  };
}

async function corruptRetirement(source: Fixture, target: Fixture) {
  await db
    .prepare(
      `UPDATE profile_records SET state = 'retiring',
       merged_into_profile_id = ?, merged_at_ms = 2000 WHERE profile_id = ?`,
    )
    .bind(target.profile.profileId, source.profile.profileId)
    .run();
}

async function restoreActive(source: Fixture) {
  await db
    .prepare(
      `UPDATE profile_records SET state = 'active',
       merged_into_profile_id = NULL, merged_at_ms = NULL WHERE profile_id = ?`,
    )
    .bind(source.profile.profileId)
    .run();
}

function recordBatches() {
  const batches: Array<{ count: number; results: D1Result[] }> = [];
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          batches.push({ count: statements.length, results });
          return results;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, batches };
}

async function topologyViolation(profileIds: string[]) {
  return db
    .prepare(
      `SELECT ${CANONICAL_PROFILE_TOPOLOGY_VIOLATION_PREDICATE} AS invalid`,
    )
    .bind(JSON.stringify(profileIds))
    .first<{ invalid: number }>();
}

describe("scoped canonical profile topology", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "c".repeat(64),
    );
  });

  it.each<Relation>(["owner", "auth", "recovery"])(
    "rolls retirement back when an existing %s remains on the source",
    async (relation) => {
      const source = await fixture([relation]);
      const target = await fixture();
      await expect(
        commitCanonicalPlan(db, retirementPlan(source, target)),
      ).rejects.toBeInstanceOf(CanonicalProfileConflict);
      expect(
        await readCanonicalProfileAggregate(db, source.profile.profileId),
      ).toEqual(source);
      expect(
        await readCanonicalMergeTarget(db, source.profile.profileId),
      ).toBeNull();
    },
  );

  it("moves all relationships before retirement and retains redirects after source deletion", async () => {
    const source = await fixture(["owner", "auth", "recovery"]);
    const target = await fixture();
    const method = source.authMethods[0];
    const plan = retirementPlan(source, target);
    plan.expectations = [
      ...plan.expectations,
      {
        kind: "login-owner-set",
        profileId: source.profile.profileId,
        owners: source.loginOwners,
      },
      {
        kind: "login-owner-set",
        profileId: target.profile.profileId,
        owners: target.loginOwners,
      },
      { kind: "auth-method-revision", ...method },
      {
        kind: "auth-recovery-revision",
        profileId: source.profile.profileId,
        revision: source.recovery!.revision,
      },
      { kind: "auth-recovery-absent", profileId: target.profile.profileId },
    ];
    plan.mutations = [
      {
        kind: "move-login-owner-set",
        sourceProfileId: source.profile.profileId,
        targetProfileId: target.profile.profileId,
        updatedAtMs: 2_000,
      },
      {
        kind: "update-auth-method",
        value: { ...method, profileId: target.profile.profileId },
      },
      { kind: "delete-auth-recovery", profileId: source.profile.profileId },
      {
        kind: "insert-auth-recovery",
        value: recoveryValue(target.profile.profileId),
      },
      ...plan.mutations,
    ];
    const recorded = recordBatches();
    await commitCanonicalPlan(recorded.database, plan);
    expect(recorded.batches[0].count).toBe(
      countCanonicalCommitStatements(plan),
    );
    const moved = await readCanonicalProfileAggregate(
      db,
      target.profile.profileId,
    );
    expect(moved.loginOwners).toMatchObject([
      { loginUid: source.loginOwners[0].loginUid, revision: 2 },
    ]);
    expect(moved.authMethods).toMatchObject([
      { normalizedValue: method.normalizedValue, revision: 2 },
    ]);
    expect(moved.recovery?.profileId).toBe(target.profile.profileId);
    await commitCanonicalPlan(db, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: source.profile.profileId,
          revision: 2,
        },
        {
          kind: "merge-target",
          sourceProfileId: source.profile.profileId,
          targetProfileId: target.profile.profileId,
        },
      ],
      mutations: [
        {
          kind: "delete-retired-profile",
          profileId: source.profile.profileId,
          targetProfileId: target.profile.profileId,
        },
      ],
    });
    expect(await readCanonicalProfile(db, source.profile.profileId)).toBeNull();
    expect(
      await readCanonicalMergeTarget(db, source.profile.profileId),
    ).toMatchObject({ targetProfileId: target.profile.profileId });
  });

  it.each(["insert-auth-method", "insert-auth-recovery"] as const)(
    "rejects %s targeting an already retired profile",
    async (kind) => {
      const source = await fixture();
      const target = await fixture();
      await commitCanonicalPlan(db, retirementPlan(source, target));
      const method = authValue(source.profile.profileId);
      const plan: CanonicalCommitPlan =
        kind === "insert-auth-method"
          ? {
              expectations: [{ kind: "auth-method-absent", ...method }],
              mutations: [{ kind, value: method }],
            }
          : {
              expectations: [
                {
                  kind: "auth-recovery-absent",
                  profileId: source.profile.profileId,
                },
              ],
              mutations: [
                { kind, value: recoveryValue(source.profile.profileId) },
              ],
            };
      await expect(commitCanonicalPlan(db, plan)).rejects.toBeInstanceOf(
        CanonicalProfileConflict,
      );
      const stored = await readCanonicalProfileAggregate(
        db,
        source.profile.profileId,
      );
      expect(stored.authMethods).toEqual([]);
      expect(stored.recovery).toBeNull();
    },
  );

  it.each([
    "update-login-owner",
    "delete-login-owner",
    "update-auth-method",
    "delete-auth-method",
  ] as const)("checks the previous profile during %s", async (kind) => {
    const source = await fixture(["owner", "auth", "recovery"]);
    const target = await fixture();
    const owner = source.loginOwners[0];
    const method = source.authMethods[0];
    const plan: CanonicalCommitPlan = kind.includes("login")
      ? {
          expectations: [{ kind: "login-owner-revision", ...owner }],
          mutations: [
            kind === "update-login-owner"
              ? {
                  kind,
                  value: { ...owner, profileId: target.profile.profileId },
                }
              : { kind: "delete-login-owner", loginUid: owner.loginUid },
          ],
        }
      : {
          expectations: [{ kind: "auth-method-revision", ...method }],
          mutations: [
            kind === "update-auth-method"
              ? {
                  kind,
                  value: { ...method, profileId: target.profile.profileId },
                }
              : {
                  kind: "delete-auth-method",
                  method: method.method,
                  normalizedValue: method.normalizedValue,
                },
          ],
        };
    await corruptRetirement(source, target);
    try {
      await expect(commitCanonicalPlan(db, plan)).rejects.toBeInstanceOf(
        CanonicalProfileConflict,
      );
      const stored = await readCanonicalProfileAggregate(
        db,
        source.profile.profileId,
      );
      expect(stored.loginOwners).toEqual(source.loginOwners);
      expect(stored.authMethods).toEqual(source.authMethods);
    } finally {
      await restoreActive(source);
    }
  });

  it("permits healthy writes while the audit reports unrelated corruption", async () => {
    const source = await fixture(["owner", "auth", "recovery"]);
    const healthy = await fixture();
    await corruptRetirement(source, healthy);
    try {
      expect(await topologyViolation([source.profile.profileId])).toEqual({
        invalid: 1,
      });
      expect(await topologyViolation([healthy.profile.profileId])).toEqual({
        invalid: 0,
      });
      await commitCanonicalPlan(db, updatePlan(healthy.profile));
      expect(
        (await readCanonicalProfile(db, healthy.profile.profileId))?.profile
          .isTutorialCompleted,
      ).toBe(true);
      expect(
        await db.prepare(CANONICAL_PROFILE_TOPOLOGY_AUDIT_SQL).first(),
      ).toEqual({
        ...healthyAudit,
        retiring_profile_without_matching_redirect: 1,
        login_owner_without_active_profile: 1,
        auth_method_without_active_profile: 1,
        recovery_job_without_active_profile: 1,
      });
      const operationId = `op-${crypto.randomUUID()}`;
      const plan: CanonicalCommitPlan = {
        expectations: [{ kind: "auth-operation-absent", operationId }],
        mutations: [
          {
            kind: "insert-auth-operation",
            value: {
              operationId,
              kind: "verify",
              method: "x",
              loginUid: "operation-only-login",
              status: "started",
              meta: null,
              result: null,
              errorCode: null,
              errorMessage: null,
              startedAtMs: 1_000,
              updatedAtMs: 1_000,
            },
          },
        ],
      };
      const recorded = recordBatches();
      await commitCanonicalPlan(recorded.database, plan);
      expect(recorded.batches).toHaveLength(1);
      expect(recorded.batches[0].count).toBe(
        countCanonicalCommitStatements(plan),
      );
      expect(recorded.batches[0].count).toBe(4);
    } finally {
      await restoreActive(source);
    }
  });

  it("audits an active profile with a retained redirect without blocking another profile", async () => {
    const source = await fixture();
    const target = await fixture();
    const healthy = await fixture();
    await commitCanonicalPlan(db, retirementPlan(source, target));
    const trigger = await db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'trigger'
         AND name = 'profile_records_require_matching_merge_target_update'`,
      )
      .first<{ sql: string }>();
    if (!trigger) throw new Error("missing-profile-topology-trigger");
    await db.batch([
      db.prepare(
        "DROP TRIGGER profile_records_require_matching_merge_target_update",
      ),
      db
        .prepare(
          `UPDATE profile_records SET state = 'active',
           merged_into_profile_id = NULL WHERE profile_id = ?`,
        )
        .bind(source.profile.profileId),
      db.prepare(trigger.sql),
    ]);
    try {
      expect(await topologyViolation([source.profile.profileId])).toEqual({
        invalid: 1,
      });
      await commitCanonicalPlan(db, updatePlan(healthy.profile));
      expect(
        await db.prepare(CANONICAL_PROFILE_TOPOLOGY_AUDIT_SQL).first(),
      ).toEqual({ ...healthyAudit, active_profile_with_redirect: 1 });
    } finally {
      await corruptRetirement(source, target);
    }
  });

  it("uses indexed checks whose rows read stay bounded as unrelated profiles grow", async () => {
    const healthy = await fixture(["owner", "auth", "recovery"]);
    const recorded = recordBatches();
    await commitCanonicalPlan(recorded.database, updatePlan(healthy.profile));
    const before = recorded.batches[0].results.at(-1)!.meta.rows_read;
    const auditBefore = await db
      .prepare(CANONICAL_PROFILE_TOPOLOGY_AUDIT_SQL)
      .all();
    const columns = await db
      .prepare("PRAGMA table_info(profile_records)")
      .all<{ name: string }>();
    const id = "template.profile_id || '-bulk-' || seed.value";
    const values = columns.results.map(({ name }) => {
      if (name === "profile_id") return id;
      if (name === "payload_json") {
        return `json_set(template.payload_json, '$.id', ${id})`;
      }
      if (name === "username_key") return "NULL";
      return `template.${name}`;
    });
    const prefix = `${healthy.profile.profileId}-bulk-`;
    const prefixEnd = `${healthy.profile.profileId}-bulk.`;
    await db.batch([
      db
        .prepare(
          `INSERT INTO profile_records (${columns.results.map(({ name }) => name).join(", ")})
           SELECT ${values.join(", ")} FROM profile_records AS template
           CROSS JOIN json_each(?) AS seed WHERE template.profile_id = ?`,
        )
        .bind(
          JSON.stringify(Array.from({ length: 1_000 }, (_, index) => index)),
          healthy.profile.profileId,
        ),
      db
        .prepare(
          `INSERT INTO profile_login_owners
           (login_uid, profile_id, revision, created_at_ms, updated_at_ms)
           SELECT 'login-' || profile_id, profile_id, 1, 1000, 1000
           FROM profile_records WHERE profile_id >= ? AND profile_id < ?`,
        )
        .bind(prefix, prefixEnd),
      db
        .prepare(
          `INSERT INTO profile_auth_methods
           (method, normalized_value, profile_id, raw_value, revision, created_at_ms, updated_at_ms)
           SELECT 'x', 'x-' || profile_id, profile_id, 'x-' || profile_id, 1, 1000, 1000
           FROM profile_records WHERE profile_id >= ? AND profile_id < ?`,
        )
        .bind(prefix, prefixEnd),
      db
        .prepare(
          `INSERT INTO profile_auth_recovery_jobs
           (profile_id, login_uids_json, source_profile_ids_json, source_phase,
            phase_started_at_ms, last_enqueued_at_ms, created_at_ms, updated_at_ms)
           SELECT profile_id, '[]', '[]', 'prizes', 1000, 0, 1000, 1000
           FROM profile_records WHERE profile_id >= ? AND profile_id < ?`,
        )
        .bind(prefix, prefixEnd),
    ]);
    const current = await readCanonicalProfile(db, healthy.profile.profileId);
    if (!current) throw new Error("missing-healthy-profile");
    await commitCanonicalPlan(recorded.database, updatePlan(current));
    const after = recorded.batches[1].results.at(-1)!.meta.rows_read;
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before + 10);
    expect(after).toBeLessThan(100);
    const auditAfter = await db
      .prepare(CANONICAL_PROFILE_TOPOLOGY_AUDIT_SQL)
      .all();
    expect(auditAfter.results).toEqual([healthyAudit]);
    expect(auditAfter.meta.rows_read).toBeGreaterThan(
      auditBefore.meta.rows_read + 1_000,
    );
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT ${CANONICAL_PROFILE_TOPOLOGY_VIOLATION_PREDICATE}`,
      )
      .bind(JSON.stringify([healthy.profile.profileId]))
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toMatch(/USING (?:COVERING )?(?:PRIMARY KEY|INDEX)/);
    expect(details).not.toMatch(
      /\bSCAN (?:profile|mapping|owner|method|recovery|profile_records|profile_merge_targets|profile_login_owners|profile_auth_methods|profile_auth_recovery_jobs)\b/,
    );
  });
});
