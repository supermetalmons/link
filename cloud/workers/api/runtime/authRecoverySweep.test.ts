import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  sweepAuthRecoveryJobs,
  type AuthRecoveryTask,
} from "../src/authRecovery.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
} from "../src/profileCanonicalD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const nowMs = 10_000_000;
const logger = { error: vi.fn(), info: vi.fn() };
const send =
  vi.fn<
    (task: AuthRecoveryTask, options?: QueueSendOptions) => Promise<void>
  >();
const sweepEnv = new Proxy(testEnv, {
  get(target, property, receiver) {
    return property === "AUTH_RECOVERY_QUEUE"
      ? { send }
      : Reflect.get(target, property, receiver);
  },
});
let sequence = 0;

async function seedJob(
  options: {
    profileId?: string;
    loginUidsJson?: string;
    sourceProfileIdsJson?: string;
    lastEnqueuedAtMs?: number;
  } = {},
): Promise<string> {
  const originalId = `auth-sweep-${++sequence}`;
  const profileId = options.profileId ?? originalId;
  const value = materializeCanonicalProfile({
    profile: {
      id: originalId,
      nonce: 1,
      rating: 1500,
      totalManaPoints: 0,
      win: false,
      emoji: 1,
      username: `sweep${sequence}`,
      eth: null,
      sol: null,
      completedProblemIds: [],
      isTutorialCompleted: false,
      mining: {
        lastRockDate: null,
        materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    },
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [{ kind: "profile-absent", profileId: originalId }],
    mutations: [{ kind: "insert-active-profile", value }],
  });
  if (profileId !== originalId) {
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_records SET profile_id = ? WHERE profile_id = ?",
    )
      .bind(profileId, originalId)
      .run();
  }
  await testEnv.PROFILE_DB.prepare(
    `INSERT INTO profile_auth_recovery_jobs (
      profile_id, login_uids_json, source_profile_ids_json, source_phase,
      prize_cursor, phase_started_at_ms, last_enqueued_at_ms, created_at_ms,
      updated_at_ms, revision
    ) VALUES (?, ?, ?, 'finalize', NULL, 1000, ?, 1000, 1000, 1)`,
  )
    .bind(
      profileId,
      options.loginUidsJson ?? "[]",
      options.sourceProfileIdsJson ?? "[]",
      options.lastEnqueuedAtMs ?? 0,
    )
    .run();
  return profileId;
}

function readJob(profileId: string) {
  return testEnv.PROFILE_DB.prepare(
    "SELECT * FROM profile_auth_recovery_jobs WHERE profile_id = ?",
  )
    .bind(profileId)
    .first<Record<string, unknown>>();
}

function readQuarantine(profileId: string) {
  return testEnv.PROFILE_DB.prepare(
    "SELECT * FROM profile_auth_recovery_quarantine WHERE profile_id = ?",
  )
    .bind(profileId)
    .first<Record<string, unknown>>();
}

async function seedRawProfileId(
  storage: "blob" | "text",
  lastEnqueuedAtMs = 0,
) {
  const originalId = await seedJob({ lastEnqueuedAtMs });
  const hex = `${Array.from(new TextEncoder().encode(originalId), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}ff`;
  const keySql = storage === "blob" ? `x'${hex}'` : `CAST(x'${hex}' AS TEXT)`;
  await testEnv.PROFILE_DB.batch([
    testEnv.PROFILE_DB.prepare(
      "DELETE FROM profile_auth_recovery_jobs WHERE profile_id = ?",
    ).bind(originalId),
    testEnv.PROFILE_DB.prepare(
      `UPDATE profile_records SET profile_id = ${keySql} WHERE profile_id = ?`,
    ).bind(originalId),
    testEnv.PROFILE_DB.prepare(
      `INSERT INTO profile_auth_recovery_jobs (
        profile_id, login_uids_json, source_profile_ids_json, source_phase,
        prize_cursor, phase_started_at_ms, last_enqueued_at_ms, created_at_ms,
        updated_at_ms, revision
      ) VALUES (${keySql}, '[]', '[]', 'finalize', NULL, 1000, ?, 1000, 1000, 1)`,
    ).bind(lastEnqueuedAtMs),
  ]);
  return { originalId, hex: hex.toUpperCase(), keySql };
}

async function readRawRecoveryEvidence() {
  const result = await testEnv.PROFILE_DB.prepare(
    `SELECT typeof(profile_id) AS key_type, hex(profile_id) AS key_hex,
       hex(login_uids_json) AS logins_hex, hex(source_profile_ids_json) AS sources_hex,
       source_phase, typeof(prize_cursor) AS cursor_type, hex(prize_cursor) AS cursor_hex,
       phase_started_at_ms, last_enqueued_at_ms, created_at_ms, updated_at_ms,
       typeof(revision) AS revision_type, hex(revision) AS revision_hex
     FROM profile_auth_recovery_jobs ORDER BY hex(profile_id)`,
  ).all();
  return result.results;
}

async function readRawQuarantines() {
  const result = await testEnv.PROFILE_DB.prepare(
    `SELECT typeof(profile_id) AS key_type, hex(profile_id) AS key_hex,
       hex(revision_token) AS revision_hex, reason, quarantined_at_ms
     FROM profile_auth_recovery_quarantine ORDER BY hex(profile_id)`,
  ).all();
  return result.results;
}

function sweep(profileDb = testEnv.PROFILE_DB, currentTime = nowMs) {
  return sweepAuthRecoveryJobs(sweepEnv, {
    profileDb,
    logger,
    now: () => currentTime,
  });
}

function afterSweepRead(afterRead: () => Promise<void>): D1Database {
  let intercepted = false;
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        if (
          property === "all" &&
          query.includes("profile_auth_recovery_jobs") &&
          /\bLIMIT\b/i.test(query)
        ) {
          return async () => {
            const result = await target.all();
            if (!intercepted) {
              intercepted = true;
              await afterRead();
            }
            return result;
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  return new Proxy(testEnv.PROFILE_DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

describe("canonical auth recovery sweep quarantine", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "b".repeat(64),
    );
  });

  beforeEach(async () => {
    send.mockReset();
    send.mockResolvedValue(undefined);
    logger.error.mockClear();
    logger.info.mockClear();
    await testEnv.PROFILE_DB.prepare(
      "DELETE FROM profile_auth_recovery_jobs",
    ).run();
  });

  afterEach(async () => {
    await testEnv.PROFILE_DB.batch([
      testEnv.PROFILE_DB.prepare(
        "DROP TRIGGER IF EXISTS reject_auth_recovery_quarantine",
      ),
      testEnv.PROFILE_DB.prepare(
        "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1 AND state = 'frozen'",
      ),
    ]);
  });

  it("advances beyond a full malformed page on the next bounded sweep", async () => {
    const invalid: string[] = [];
    for (let index = 0; index < 10; index++) {
      invalid.push(
        await seedJob({
          loginUidsJson: '["login", false]',
          lastEnqueuedAtMs: index,
        }),
      );
    }
    const healthy = await seedJob({ lastEnqueuedAtMs: 10 });
    const original = await Promise.all(invalid.map(readJob));

    await expect(sweep()).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await Promise.all(invalid.map(readJob))).toEqual(original);
    expect(
      await testEnv.PROFILE_DB.prepare(
        "SELECT COUNT(*) AS count FROM profile_auth_recovery_quarantine",
      ).first<number>("count"),
    ).toBe(10);

    await expect(sweep()).resolves.toBe(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { kind: "auth-profile-recovery", profileId: healthy },
      { delaySeconds: 60 },
    );
  });

  it.each(["blob-id", "blob-revision", "invalid-text-cursor"] as const)(
    "advances beyond ten %s rows without losing stored bytes",
    async (kind) => {
      for (let index = 0; index < 10; index++) {
        if (kind === "blob-id") {
          await seedRawProfileId("blob", index);
        } else {
          const profileId = await seedJob({
            lastEnqueuedAtMs: index,
            ...(kind === "invalid-text-cursor"
              ? { loginUidsJson: "[false]" }
              : {}),
          });
          const assignment =
            kind === "blob-revision"
              ? "revision = x'ff'"
              : "prize_cursor = CAST(x'ff' AS TEXT)";
          await testEnv.PROFILE_DB.prepare(
            `UPDATE profile_auth_recovery_jobs SET ${assignment} WHERE profile_id = ?`,
          )
            .bind(profileId)
            .run();
        }
      }
      const healthy = await seedJob({ lastEnqueuedAtMs: 10 });
      const original = await readRawRecoveryEvidence();

      await expect(sweep()).resolves.toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(await readRawRecoveryEvidence()).toEqual(original);
      const quarantines = await readRawQuarantines();
      expect(quarantines).toHaveLength(10);
      for (const quarantine of quarantines) {
        expect(quarantine).toMatchObject({
          key_type: kind === "blob-id" ? "blob" : "text",
          revision_hex: kind === "blob-revision" ? "FF" : "31",
          reason: kind === "blob-id" ? "invalid-profile-id" : "invalid-record",
          quarantined_at_ms: nowMs,
        });
      }

      await expect(sweep(testEnv.PROFILE_DB, nowMs + 1)).resolves.toBe(1);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        { kind: "auth-profile-recovery", profileId: healthy },
        { delaySeconds: 60 },
      );
      await expect(sweep(testEnv.PROFILE_DB, nowMs + 2)).resolves.toBe(0);
      expect(await readRawQuarantines()).toEqual(quarantines);
    },
  );

  it("quarantines an invalid UTF-8 TEXT ID without enqueueing its decoded replacement", async () => {
    const raw = await seedRawProfileId("text");
    const replacementId = `${raw.originalId}\uFFFD`;
    await seedJob({ profileId: replacementId, lastEnqueuedAtMs: nowMs });
    const original = await readRawRecoveryEvidence();

    await expect(sweep()).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await readRawRecoveryEvidence()).toEqual(original);
    expect(await readRawQuarantines()).toEqual([
      {
        key_type: "text",
        key_hex: raw.hex,
        revision_hex: "31",
        reason: "invalid-profile-id",
        quarantined_at_ms: nowMs,
      },
    ]);
    expect(await readQuarantine(replacementId)).toBeNull();
    await expect(sweep(testEnv.PROFILE_DB, nowMs + 1)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["blob", "text"] as const)(
    "does not quarantine a raw %s ID replaced by a valid key at the same revision",
    async (storage) => {
      const raw = await seedRawProfileId(storage);
      const repairedId = `${raw.originalId}-repaired`;
      const database = afterSweepRead(async () => {
        await testEnv.PROFILE_DB.batch([
          testEnv.PROFILE_DB.prepare(
            `DELETE FROM profile_auth_recovery_jobs WHERE profile_id = ${raw.keySql}`,
          ),
          testEnv.PROFILE_DB.prepare(
            `UPDATE profile_records SET profile_id = ? WHERE profile_id = ${raw.keySql}`,
          ).bind(repairedId),
          testEnv.PROFILE_DB.prepare(
            `INSERT INTO profile_auth_recovery_jobs (
              profile_id, login_uids_json, source_profile_ids_json, source_phase,
              prize_cursor, phase_started_at_ms, last_enqueued_at_ms, created_at_ms,
              updated_at_ms, revision
            ) VALUES (?, '[]', '[]', 'finalize', NULL, 1000, 0, 1000, 1000, 1)`,
          ).bind(repairedId),
        ]);
      });

      await expect(sweep(database)).resolves.toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(await readRawQuarantines()).toEqual([]);
      expect(await readJob(repairedId)).toMatchObject({ revision: 1 });
      await expect(sweep()).resolves.toBe(1);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        { kind: "auth-profile-recovery", profileId: repairedId },
        { delaySeconds: 60 },
      );
    },
  );

  it("honors previously persisted plain revision markers without rewriting them", async () => {
    const profileId = await seedJob({ loginUidsJson: "[false]" });
    await testEnv.PROFILE_DB.prepare(
      `INSERT INTO profile_auth_recovery_quarantine
       (profile_id, revision_token, reason, quarantined_at_ms)
       VALUES (?, '1', 'invalid-record', 1000)`,
    )
      .bind(profileId)
      .run();
    const original = await readJob(profileId);
    const quarantine = await readQuarantine(profileId);

    await expect(sweep()).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(await readJob(profileId)).toEqual(original);
    expect(await readQuarantine(profileId)).toEqual(quarantine);
  });

  it("quarantines malformed arrays and exact unsafe IDs while dispatching healthy work", async () => {
    const invalidLogin = await seedJob({ loginUidsJson: '["valid", false]' });
    const invalidSource = await seedJob({ sourceProfileIdsJson: "[42]" });
    const invalidIds = await Promise.all(
      ["   ", " profile-with-space ", "profile#unsafe"].map((profileId) =>
        seedJob({ profileId }),
      ),
    );
    const invalid = [invalidLogin, invalidSource, ...invalidIds];
    const original = await Promise.all(invalid.map(readJob));
    const healthy = await seedJob();

    await expect(sweep()).resolves.toBe(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { kind: "auth-profile-recovery", profileId: healthy },
      { delaySeconds: 60 },
    );
    expect(await Promise.all(invalid.map(readJob))).toEqual(original);
    for (const profileId of invalid) {
      expect(await readQuarantine(profileId)).toMatchObject({
        profile_id: profileId,
        revision_token: "1",
        reason: invalidIds.includes(profileId)
          ? "invalid-profile-id"
          : "invalid-record",
        quarantined_at_ms: nowMs,
      });
    }
  });

  it.each(["1.5", "9223372036854775807"])(
    "quarantines an invalid revision %s using its exact SQL token",
    async (revision) => {
      const profileId = await seedJob();
      await testEnv.PROFILE_DB.prepare(
        `UPDATE profile_auth_recovery_jobs SET revision = ${revision} WHERE profile_id = ?`,
      )
        .bind(profileId)
        .run();
      const original = await readJob(profileId);

      await expect(sweep()).resolves.toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(await readJob(profileId)).toEqual(original);
      expect(await readQuarantine(profileId)).toMatchObject({
        profile_id: profileId,
        revision_token: revision,
        reason: "invalid-record",
      });
    },
  );

  it("quarantines a BLOB cursor without blocking healthy work or changing its bytes", async () => {
    const invalid = await seedJob();
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_auth_recovery_jobs SET prize_cursor = x'61' WHERE profile_id = ?",
    )
      .bind(invalid)
      .run();
    const original = await readJob(invalid);
    const healthy = await seedJob();

    await expect(sweep()).resolves.toBe(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { kind: "auth-profile-recovery", profileId: healthy },
      { delaySeconds: 60 },
    );
    expect(await readJob(invalid)).toEqual(original);
    expect(
      await testEnv.PROFILE_DB.prepare(
        "SELECT typeof(prize_cursor) AS storage_type, hex(prize_cursor) AS bytes FROM profile_auth_recovery_jobs WHERE profile_id = ?",
      )
        .bind(invalid)
        .first(),
    ).toEqual({ storage_type: "blob", bytes: "61" });
    expect(await readQuarantine(invalid)).toMatchObject({
      profile_id: invalid,
      revision_token: "1",
      reason: "invalid-record",
    });
  });

  it("does not quarantine a BLOB cursor repaired to matching hex text at the same revision", async () => {
    const profileId = await seedJob();
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_auth_recovery_jobs SET prize_cursor = x'61' WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();
    const database = afterSweepRead(async () => {
      await testEnv.PROFILE_DB.prepare(
        "UPDATE profile_auth_recovery_jobs SET prize_cursor = '61' WHERE profile_id = ?",
      )
        .bind(profileId)
        .run();
    });

    await expect(sweep(database)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await readQuarantine(profileId)).toBeNull();
    expect(await readJob(profileId)).toMatchObject({
      prize_cursor: "61",
      revision: 1,
    });
    await expect(sweep()).resolves.toBe(1);
  });

  it("keeps the same revision quarantined and resumes after a versioned repair", async () => {
    const profileId = await seedJob({ loginUidsJson: "[false]" });
    await expect(sweep()).resolves.toBe(0);
    const quarantine = await readQuarantine(profileId);
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_auth_recovery_jobs SET login_uids_json = '[]' WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();

    await expect(sweep(testEnv.PROFILE_DB, nowMs + 1)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await readQuarantine(profileId)).toEqual(quarantine);

    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_auth_recovery_jobs SET revision = revision + 1 WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();
    await expect(sweep()).resolves.toBe(1);
    expect(await readJob(profileId)).toMatchObject({
      login_uids_json: "[]",
      revision: 3,
      last_enqueued_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
  });

  it.each(["new-revision", "same-revision", "recreated"] as const)(
    "does not quarantine a concurrent %s repair from an obsolete snapshot",
    async (repair) => {
      const profileId = await seedJob({ loginUidsJson: "[false]" });
      const database = afterSweepRead(async () => {
        if (repair === "recreated") {
          await testEnv.PROFILE_DB.batch([
            testEnv.PROFILE_DB.prepare(
              "DELETE FROM profile_auth_recovery_jobs WHERE profile_id = ?",
            ).bind(profileId),
            testEnv.PROFILE_DB.prepare(
              `INSERT INTO profile_auth_recovery_jobs (
                profile_id, login_uids_json, source_profile_ids_json, source_phase,
                prize_cursor, phase_started_at_ms, last_enqueued_at_ms, created_at_ms,
                updated_at_ms, revision
              ) VALUES (?, '[]', '[]', 'finalize', NULL, 1000, 0, 1000, 1000, 1)`,
            ).bind(profileId),
          ]);
        } else {
          await testEnv.PROFILE_DB.prepare(
            `UPDATE profile_auth_recovery_jobs SET login_uids_json = '[]',
               revision = revision + ? WHERE profile_id = ?`,
          )
            .bind(repair === "new-revision" ? 1 : 0, profileId)
            .run();
        }
      });

      await expect(sweep(database)).resolves.toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(await readQuarantine(profileId)).toBeNull();
      expect(await readJob(profileId)).toMatchObject({ login_uids_json: "[]" });
      await expect(sweep()).resolves.toBe(1);
    },
  );

  it("records quarantine once and cascades it when the job is deleted", async () => {
    const profileId = await seedJob({ sourceProfileIdsJson: "[false]" });
    await expect(sweep()).resolves.toBe(0);
    const quarantine = await readQuarantine(profileId);
    expect(quarantine).not.toBeNull();
    await expect(sweep(testEnv.PROFILE_DB, nowMs + 1_000)).resolves.toBe(0);
    expect(await readQuarantine(profileId)).toEqual(quarantine);

    await testEnv.PROFILE_DB.prepare(
      "DELETE FROM profile_auth_recovery_jobs WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();
    expect(await readQuarantine(profileId)).toBeNull();
  });

  it("honors a freeze that occurs after reading the malformed job", async () => {
    const profileId = await seedJob({ loginUidsJson: "[false]" });
    const original = await readJob(profileId);
    const database = afterSweepRead(async () => {
      await testEnv.PROFILE_DB.prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      ).run();
    });

    await expect(sweep(database)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await readQuarantine(profileId)).toBeNull();
    expect(await readJob(profileId)).toEqual(original);
  });

  it("continues healthy work and reports a failed quarantine write", async () => {
    const invalid = await seedJob({ loginUidsJson: "[false]" });
    const original = await readJob(invalid);
    const healthy = await seedJob();
    await testEnv.PROFILE_DB.prepare(
      `CREATE TRIGGER reject_auth_recovery_quarantine
       BEFORE INSERT ON profile_auth_recovery_quarantine
       BEGIN SELECT RAISE(ABORT, 'simulated-quarantine-failure'); END`,
    ).run();

    await expect(sweep()).rejects.toThrow("simulated-quarantine-failure");
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { kind: "auth-profile-recovery", profileId: healthy },
      { delaySeconds: 60 },
    );
    expect(await readQuarantine(invalid)).toBeNull();
    expect(await readJob(invalid)).toEqual(original);
    expect(await readJob(healthy)).toMatchObject({
      last_enqueued_at_ms: nowMs,
    });
  });

  it("does not quarantine transport failures or advance their dispatch timestamp", async () => {
    const failed = await seedJob();
    const healthy = await seedJob();
    const original = await readJob(failed);
    const failure = new Error("queue-unavailable");
    send.mockImplementation(async (task) => {
      if (task.profileId === failed) throw failure;
    });

    await expect(sweep()).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await readJob(failed)).toEqual(original);
    expect(await readQuarantine(failed)).toBeNull();
    expect(await readJob(healthy)).toMatchObject({
      last_enqueued_at_ms: nowMs,
      updated_at_ms: nowMs,
      revision: 2,
    });
  });

  it("does not quarantine a transient D1 read failure", async () => {
    const profileId = await seedJob();
    const original = await readJob(profileId);
    const failure = new Error("recovery-read-unavailable");
    const database = afterSweepRead(async () => {
      throw failure;
    });

    await expect(sweep(database)).rejects.toBe(failure);
    expect(send).not.toHaveBeenCalled();
    expect(await readQuarantine(profileId)).toBeNull();
    expect(await readJob(profileId)).toEqual(original);
  });
});
