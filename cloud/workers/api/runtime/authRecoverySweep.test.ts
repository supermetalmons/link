import { canonicalQueuePayloadFixture } from "../test/canonicalQueueFixture.ts";
import { parseAuthRecoveryTask } from "../src/authRecovery.ts";
import { materializeProfileFixture as materializeCanonicalProfile } from "../test/profileDataBoundaryFixture.ts";
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
import { commitCanonicalPlan } from "../src/profileCanonicalD1.ts";
import {
  inspectCanonicalAuthRecoverySweepRow,
  listCanonicalAuthRecoverySweepRows,
  quarantineCanonicalAuthRecoveryJob,
  readCanonicalAuthRecoveryQuarantineEntry,
} from "../src/profileCanonical/recovery.ts";
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
      ? {
          send: async (body: unknown, options?: QueueSendOptions) => {
            const task = parseAuthRecoveryTask(
              canonicalQueuePayloadFixture(body),
            );
            if (!task) throw new Error("invalid-auth-task-fixture");
            return send(task, options);
          },
        }
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
      "UPDATE profile_records_canonical SET profile_id = ?, payload_json = json_set(payload_json, '$.id', ?) WHERE profile_id = ?",
    )
      .bind(profileId, profileId, originalId)
      .run();
  }
  await testEnv.PROFILE_DB.prepare(
    `INSERT INTO profile_auth_recovery_jobs_canonical (
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
    "SELECT * FROM profile_auth_recovery_jobs_canonical WHERE profile_id = ?",
  )
    .bind(profileId)
    .first<Record<string, unknown>>();
}

function readQuarantine(profileId: string) {
  return testEnv.PROFILE_DB.prepare(
    "SELECT * FROM profile_auth_recovery_quarantine_canonical WHERE profile_id = ?",
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
      "DELETE FROM profile_auth_recovery_jobs_canonical WHERE profile_id = ?",
    ).bind(originalId),
    testEnv.PROFILE_DB.prepare(
      `UPDATE profile_records_canonical SET profile_id = ${keySql} WHERE profile_id = ?`,
    ).bind(originalId),
    testEnv.PROFILE_DB.prepare(
      `INSERT INTO profile_auth_recovery_jobs_canonical (
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
     FROM profile_auth_recovery_jobs_canonical ORDER BY hex(profile_id)`,
  ).all();
  return result.results;
}

async function readRawQuarantines() {
  const result = await testEnv.PROFILE_DB.prepare(
    `SELECT typeof(profile_id) AS key_type, hex(profile_id) AS key_hex,
       hex(revision_token) AS revision_hex, reason, quarantined_at_ms
     FROM profile_auth_recovery_quarantine_canonical ORDER BY hex(profile_id)`,
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

type RecoveryReadStage = "scan" | "observation";

function checkValueSize(value: unknown): void {
  const maxBytes = 2_000_000;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > maxBytes)
      throw new Error("d1-value-size-limit");
  } else if (ArrayBuffer.isView(value)) {
    if (value.byteLength > maxBytes) throw new Error("d1-value-size-limit");
  } else if (value instanceof ArrayBuffer) {
    if (value.byteLength > maxBytes) throw new Error("d1-value-size-limit");
  } else if (Array.isArray(value)) {
    if (value.length && typeof value[0] === "number") {
      if (value.length > maxBytes) throw new Error("d1-value-size-limit");
    } else {
      value.forEach(checkValueSize);
    }
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(checkValueSize);
  }
}

function observedDatabase({
  queries = [],
  sessions = [],
  beforeRead,
  afterRead,
  checkSizes = false,
}: {
  queries?: string[];
  sessions?: Array<string | undefined>;
  beforeRead?: (stage: RecoveryReadStage) => Promise<void>;
  afterRead?: (stage: RecoveryReadStage) => Promise<void>;
  checkSizes?: boolean;
} = {}): D1Database {
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => {
            if (checkSizes) values.forEach(checkValueSize);
            return wrap(target.bind(...values), query);
          };
        }
        if (property === "all" || property === "first") {
          return async (column?: string) => {
            const stage = query.includes("profile_auth_recovery_jobs_canonical")
              ? /\bLIMIT\b/i.test(query)
                ? "scan"
                : query.includes("recovery_type_0")
                  ? "observation"
                  : null
              : null;
            if (stage) await beforeRead?.(stage);
            const result =
              property === "all"
                ? await target.all()
                : column === undefined
                  ? await target.first()
                  : await target.first(column);
            if (checkSizes) checkValueSize(result);
            if (stage) await afterRead?.(stage);
            return result;
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  const database = <T extends D1Database | D1DatabaseSession>(db: T): T =>
    new Proxy(db, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            queries.push(query);
            return wrap(target.prepare(query), query);
          };
        }
        if (property === "withSession" && "withSession" in target) {
          return (constraint?: string) => {
            sessions.push(constraint);
            return database(target.withSession(constraint));
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  return database(testEnv.PROFILE_DB);
}

function afterSweepRead(afterRead: () => Promise<void>): D1Database {
  let intercepted = false;
  return observedDatabase({
    async afterRead(stage) {
      if (stage !== "scan" || intercepted) return;
      intercepted = true;
      await afterRead();
    },
  });
}

async function observedInvalidJob(db = testEnv.PROFILE_DB) {
  const [row] = await listCanonicalAuthRecoverySweepRows(db, 1_000, 10);
  const inspected = inspectCanonicalAuthRecoverySweepRow(row!);
  expect(inspected.quarantineReason).not.toBeNull();
  const entry = await readCanonicalAuthRecoveryQuarantineEntry(
    db,
    inspected.key,
    1_000,
  );
  if (!entry) throw new Error("expected-invalid-auth-recovery-job");
  return entry;
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
      "DELETE FROM profile_auth_recovery_jobs_canonical",
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

  it("scans healthy jobs without building or rereading full observations", async () => {
    await seedJob({ lastEnqueuedAtMs: 0 });
    await seedJob({ lastEnqueuedAtMs: 1 });
    const queries: string[] = [];
    const sessions: Array<string | undefined> = [];

    await expect(sweep(observedDatabase({ queries, sessions }))).resolves.toBe(
      2,
    );
    expect(sessions).toEqual([]);
    const scans = queries.filter((query) => /\bLIMIT\b/i.test(query));
    expect(scans).toHaveLength(1);
    expect(scans[0]).toContain("AS recovery_key_bytes");
    expect(scans[0]).toContain("AS recovery_key_type");
    expect(scans[0]).not.toMatch(/hex\(|json_array\(|recovery_type_\d/i);
    expect(queries.some((query) => query.includes("recovery_type_0"))).toBe(
      false,
    );
  });

  it("rereads only malformed jobs on the primary before quarantine", async () => {
    const invalid = await seedJob({ loginUidsJson: "[false]" });
    const healthy = await seedJob({ lastEnqueuedAtMs: 1 });
    const queries: string[] = [];
    const sessions: Array<string | undefined> = [];

    await expect(sweep(observedDatabase({ queries, sessions }))).resolves.toBe(
      1,
    );
    expect(sessions).toEqual(["first-primary"]);
    expect(
      queries.filter((query) => query.includes("recovery_type_0")),
    ).toHaveLength(1);
    expect(await readQuarantine(invalid)).not.toBeNull();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { kind: "auth-profile-recovery", profileId: healthy },
      { delaySeconds: 60 },
    );
  });

  it.each(["deleted", "rescheduled", "quarantined"] as const)(
    "skips a malformed job %s before its primary reread",
    async (change) => {
      const invalid = await seedJob({ loginUidsJson: "[false]" });
      const healthy = await seedJob({ lastEnqueuedAtMs: 1 });
      const database = afterSweepRead(async () => {
        const statement = {
          deleted:
            "DELETE FROM profile_auth_recovery_jobs_canonical WHERE profile_id = ?",
          rescheduled: `UPDATE profile_auth_recovery_jobs_canonical
            SET last_enqueued_at_ms = ${nowMs} WHERE profile_id = ?`,
          quarantined: `INSERT INTO profile_auth_recovery_quarantine_canonical (
            profile_id, revision_token, reason, quarantined_at_ms
          ) VALUES (?, '1', 'invalid-record', 1000)`,
        }[change];
        await testEnv.PROFILE_DB.prepare(statement).bind(invalid).run();
      });

      await expect(sweep(database)).resolves.toBe(1);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        { kind: "auth-profile-recovery", profileId: healthy },
        { delaySeconds: 60 },
      );
      expect(logger.error).not.toHaveBeenCalled();
      expect(await readQuarantine(invalid)).toEqual(
        change === "quarantined"
          ? {
              profile_id: invalid,
              revision_token: "1",
              reason: "invalid-record",
              quarantined_at_ms: 1000,
            }
          : null,
      );
    },
  );

  it.each([
    "same-revision",
    "new-revision",
    "deleted",
    "rescheduled",
    "blob-to-text",
    "frozen",
  ] as const)(
    "preserves a %s change after the raw observation",
    async (change) => {
      const invalid = await seedJob({ loginUidsJson: "[false]" });
      if (change === "blob-to-text") {
        await expect(
          testEnv.PROFILE_DB.prepare(
            "UPDATE profile_auth_recovery_jobs_canonical SET prize_cursor = x'61' WHERE profile_id = ?",
          )
            .bind(invalid)
            .run(),
        ).rejects.toThrow("BLOB");
      }
      const entry = await observedInvalidJob();
      if (change === "frozen") {
        await testEnv.PROFILE_DB.prepare(
          "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
        ).run();
      } else {
        const statement = {
          "same-revision": `UPDATE profile_auth_recovery_jobs_canonical
            SET login_uids_json = '[]' WHERE profile_id = ?`,
          "new-revision": `UPDATE profile_auth_recovery_jobs_canonical
            SET login_uids_json = '[]', revision = revision + 1 WHERE profile_id = ?`,
          deleted:
            "DELETE FROM profile_auth_recovery_jobs_canonical WHERE profile_id = ?",
          rescheduled: `UPDATE profile_auth_recovery_jobs_canonical
            SET last_enqueued_at_ms = ${nowMs} WHERE profile_id = ?`,
          "blob-to-text": `UPDATE profile_auth_recovery_jobs_canonical
            SET prize_cursor = 'a' WHERE profile_id = ?`,
        }[change];
        await testEnv.PROFILE_DB.prepare(statement).bind(invalid).run();
      }
      const current = await readJob(invalid);

      await expect(
        quarantineCanonicalAuthRecoveryJob(testEnv.PROFILE_DB, entry, nowMs),
      ).resolves.toBeNull();
      expect(await readQuarantine(invalid)).toBeNull();
      expect(await readJob(invalid)).toEqual(current);
    },
  );

  it("isolates a primary observation failure while later healthy jobs dispatch", async () => {
    const invalid = await seedJob({ loginUidsJson: "[false]" });
    const healthy = await seedJob({ lastEnqueuedAtMs: 1 });
    const failure = new Error("auth-recovery-primary-read-unavailable");
    const database = observedDatabase({
      async beforeRead(stage) {
        if (stage === "observation") throw failure;
      },
    });

    await expect(sweep(database)).rejects.toBe(failure);
    expect(await readQuarantine(invalid)).toBeNull();
    expect(await readJob(invalid)).toMatchObject({ last_enqueued_at_ms: 0 });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { kind: "auth-profile-recovery", profileId: healthy },
      { delaySeconds: 60 },
    );
    expect(JSON.parse(logger.error.mock.calls[0]![0]!)).toMatchObject({
      event: "auth_recovery_quarantine_failure",
      phase: "inspect",
      profileId: invalid,
      itemIndex: 0,
    });
  });

  it("reads a large valid job without constructing an oversized snapshot value", async () => {
    const sources = JSON.stringify(["source".repeat(180_000)]);
    const large = await seedJob({ sourceProfileIdsJson: sources });
    const healthy = await seedJob({ lastEnqueuedAtMs: 1 });
    const queries: string[] = [];
    const sessions: Array<string | undefined> = [];
    const database = observedDatabase({ queries, sessions, checkSizes: true });

    const rows = await listCanonicalAuthRecoverySweepRows(database, 1_000, 10);
    expect(
      rows.map((row) => inspectCanonicalAuthRecoverySweepRow(row)),
    ).toMatchObject([
      { profileId: large, quarantineReason: null },
      { profileId: healthy, quarantineReason: null },
    ]);
    expect(queries).toHaveLength(1);
    expect(sessions).toEqual([]);
  });

  it.each(["json", "blob"] as const)(
    "quarantines a large malformed %s value without expansion or data changes",
    async (kind) => {
      const sources = JSON.stringify(["source".repeat(180_000), false]);
      const invalid = await seedJob({
        ...(kind === "json" ? { sourceProfileIdsJson: sources } : {}),
      });
      if (kind === "blob") {
        await expect(
          testEnv.PROFILE_DB.prepare(
            "UPDATE profile_auth_recovery_jobs_canonical SET prize_cursor = ? WHERE profile_id = ?",
          )
            .bind(new Uint8Array(550_000).fill(255), invalid)
            .run(),
        ).rejects.toThrow("BLOB");
        expect(await readQuarantine(invalid)).toBeNull();
        return;
      }
      const original = await readJob(invalid);
      const healthy = await seedJob({ lastEnqueuedAtMs: 1 });

      await expect(sweep(observedDatabase({ checkSizes: true }))).resolves.toBe(
        1,
      );
      expect(await readQuarantine(invalid)).toMatchObject({
        revision_token: "1",
        reason: "invalid-record",
      });
      expect(await readJob(invalid)).toEqual(original);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        { kind: "auth-profile-recovery", profileId: healthy },
        { delaySeconds: 60 },
      );
    },
  );

  it("rejects fractional recovery revisions before a stale observation can be stored", async () => {
    const profileId = await seedJob();
    const original = await readJob(profileId);
    for (const revision of [1.5, 1.5000000000000002])
      await expect(
        testEnv.PROFILE_DB.prepare(
          "UPDATE profile_auth_recovery_jobs_canonical SET revision = ? WHERE profile_id = ?",
        )
          .bind(revision, profileId)
          .run(),
      ).rejects.toThrow("INTEGER column");
    expect(await readJob(profileId)).toEqual(original);
    expect(await readQuarantine(profileId)).toBeNull();
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
        "SELECT COUNT(*) AS count FROM profile_auth_recovery_quarantine_canonical",
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
          await expect(seedRawProfileId("blob", index)).rejects.toThrow("BLOB");
          return;
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
          if (kind === "blob-revision") {
            await expect(
              testEnv.PROFILE_DB.prepare(
                `UPDATE profile_auth_recovery_jobs_canonical SET ${assignment} WHERE profile_id = ?`,
              )
                .bind(profileId)
                .run(),
            ).rejects.toThrow("BLOB");
            return;
          }
          await testEnv.PROFILE_DB.prepare(
            `UPDATE profile_auth_recovery_jobs_canonical SET ${assignment} WHERE profile_id = ?`,
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

  it("rejects invalid UTF-8 profile identity bytes before recovery can enqueue them", async () => {
    await expect(seedRawProfileId("text")).rejects.toThrow(
      /CHECK constraint failed|INTEGER column/,
    );
    expect(send).not.toHaveBeenCalled();
    expect(await readRawQuarantines()).toEqual([]);
  });

  it.each(["blob", "text"] as const)(
    "rejects raw %s profile identities without creating quarantine state",
    async (storage) => {
      await expect(seedRawProfileId(storage)).rejects.toThrow();
      expect(await readRawQuarantines()).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("honors previously persisted plain revision markers without rewriting them", async () => {
    const profileId = await seedJob({ loginUidsJson: "[false]" });
    await testEnv.PROFILE_DB.prepare(
      `INSERT INTO profile_auth_recovery_quarantine_canonical
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
      if (revision === "1.5") {
        await expect(
          testEnv.PROFILE_DB.prepare(
            `UPDATE profile_auth_recovery_jobs_canonical SET revision = ${revision} WHERE profile_id = ?`,
          )
            .bind(profileId)
            .run(),
        ).rejects.toThrow("INTEGER column");
        expect(await readQuarantine(profileId)).toBeNull();
        return;
      }
      await testEnv.PROFILE_DB.prepare(
        `UPDATE profile_auth_recovery_jobs_canonical SET revision = ${revision} WHERE profile_id = ?`,
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

  it("rejects a BLOB cursor without changing recovery bytes or blocking healthy work", async () => {
    const profileId = await seedJob();
    const original = await readJob(profileId);
    await expect(
      testEnv.PROFILE_DB.prepare(
        "UPDATE profile_auth_recovery_jobs_canonical SET prize_cursor = x'61' WHERE profile_id = ?",
      )
        .bind(profileId)
        .run(),
    ).rejects.toThrow("BLOB");
    expect(await readJob(profileId)).toEqual(original);
    expect(await readQuarantine(profileId)).toBeNull();
    await expect(sweep()).resolves.toBe(1);
  });

  it("accepts a text cursor after rejecting its BLOB representation", async () => {
    const profileId = await seedJob();
    await expect(
      testEnv.PROFILE_DB.prepare(
        "UPDATE profile_auth_recovery_jobs_canonical SET prize_cursor = x'61' WHERE profile_id = ?",
      )
        .bind(profileId)
        .run(),
    ).rejects.toThrow("BLOB");
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_auth_recovery_jobs_canonical SET prize_cursor = '61' WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();
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
      "UPDATE profile_auth_recovery_jobs_canonical SET login_uids_json = '[]' WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();

    await expect(sweep(testEnv.PROFILE_DB, nowMs + 1)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await readQuarantine(profileId)).toEqual(quarantine);

    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_auth_recovery_jobs_canonical SET revision = revision + 1 WHERE profile_id = ?",
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
              "DELETE FROM profile_auth_recovery_jobs_canonical WHERE profile_id = ?",
            ).bind(profileId),
            testEnv.PROFILE_DB.prepare(
              `INSERT INTO profile_auth_recovery_jobs_canonical (
                profile_id, login_uids_json, source_profile_ids_json, source_phase,
                prize_cursor, phase_started_at_ms, last_enqueued_at_ms, created_at_ms,
                updated_at_ms, revision
              ) VALUES (?, '[]', '[]', 'finalize', NULL, 1000, 0, 1000, 1000, 1)`,
            ).bind(profileId),
          ]);
        } else {
          await testEnv.PROFILE_DB.prepare(
            `UPDATE profile_auth_recovery_jobs_canonical SET login_uids_json = '[]',
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
      "DELETE FROM profile_auth_recovery_jobs_canonical WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();
    expect(await readQuarantine(profileId)).toBeNull();
  });

  it("replaces an older marker but retains same-revision reason and timestamp", async () => {
    const profileId = await seedJob({ loginUidsJson: "[false]" });
    const entry = await observedInvalidJob();
    await expect(
      quarantineCanonicalAuthRecoveryJob(
        testEnv.PROFILE_DB,
        { ...entry, reason: "invalid-profile-id" },
        nowMs,
      ),
    ).resolves.toMatchObject({
      revisionHex: "31",
      reason: "invalid-profile-id",
    });
    expect(await readQuarantine(profileId)).toEqual({
      profile_id: profileId,
      revision_token: "1",
      reason: "invalid-profile-id",
      quarantined_at_ms: nowMs,
    });
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_auth_recovery_jobs_canonical SET revision = revision + 1 WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();
    const current = await observedInvalidJob();
    const source = await readJob(profileId);

    await expect(
      quarantineCanonicalAuthRecoveryJob(
        testEnv.PROFILE_DB,
        current,
        nowMs + 1_000,
      ),
    ).resolves.toMatchObject({ revisionHex: "32", reason: "invalid-record" });
    const marker = await readQuarantine(profileId);
    expect(marker).toEqual({
      profile_id: profileId,
      revision_token: "2",
      reason: "invalid-record",
      quarantined_at_ms: nowMs + 1_000,
    });

    await expect(
      quarantineCanonicalAuthRecoveryJob(
        testEnv.PROFILE_DB,
        { ...current, reason: "invalid-profile-id" },
        nowMs + 2_000,
      ),
    ).resolves.toBeNull();
    expect(await readQuarantine(profileId)).toEqual(marker);
    expect(await readJob(profileId)).toEqual(source);
  });

  it.each(
    [-1, 0.5, Number.MAX_SAFE_INTEGER + 1].flatMap((timestamp) =>
      (["deleted", "frozen"] as const).map((state) => ({ timestamp, state })),
    ),
  )(
    "does not validate timestamp $timestamp when the source is $state",
    async ({ timestamp, state }) => {
      const profileId = await seedJob({ loginUidsJson: "[false]" });
      const entry = await observedInvalidJob();
      if (state === "deleted") {
        await testEnv.PROFILE_DB.prepare(
          "DELETE FROM profile_auth_recovery_jobs_canonical WHERE profile_id = ?",
        )
          .bind(profileId)
          .run();
      } else {
        await testEnv.PROFILE_DB.prepare(
          "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
        ).run();
      }
      const source = await readJob(profileId);

      await expect(
        quarantineCanonicalAuthRecoveryJob(
          testEnv.PROFILE_DB,
          entry,
          timestamp,
        ),
      ).resolves.toBeNull();
      expect(await readQuarantine(profileId)).toBeNull();
      expect(await readJob(profileId)).toEqual(source);
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "lets D1 reject timestamp %s for an eligible quarantine write",
    async (timestamp) => {
      const profileId = await seedJob({ loginUidsJson: "[false]" });
      const entry = await observedInvalidJob();
      const source = await readJob(profileId);

      await expect(
        quarantineCanonicalAuthRecoveryJob(
          testEnv.PROFILE_DB,
          entry,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint failed|INTEGER column/);
      expect(await readQuarantine(profileId)).toBeNull();
      expect(await readJob(profileId)).toEqual(source);
    },
  );

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
       BEFORE INSERT ON profile_auth_recovery_quarantine_canonical
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
    const entry = JSON.parse(logger.error.mock.calls[0]![0]!);
    expect(entry).toMatchObject({
      event: "auth_recovery_quarantine_failure",
      scope: "auth",
      phase: "quarantine",
      profileId: invalid,
      itemIndex: 0,
    });
    expect(JSON.stringify(entry.error)).toContain(
      "simulated-quarantine-failure",
    );
    expect(entry).not.toHaveProperty("stack");
    expect(entry).not.toHaveProperty("sweep_snapshot_token");
  });

  it("dispatches healthy work when successful quarantine logging throws", async () => {
    const invalid = await seedJob({
      loginUidsJson: "[false]",
      lastEnqueuedAtMs: 0,
    });
    const healthy = await seedJob({ lastEnqueuedAtMs: 1 });
    logger.error.mockImplementationOnce(() => {
      throw new Error("logger-unavailable");
    });

    await expect(sweep()).resolves.toBe(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { kind: "auth-profile-recovery", profileId: healthy },
      { delaySeconds: 60 },
    );
    expect(await readQuarantine(invalid)).not.toBeNull();
    expect(JSON.parse(logger.error.mock.calls[0]![0]!)).toMatchObject({
      event: "auth_recovery_job_quarantined",
      profileIdHex: Array.from(new TextEncoder().encode(invalid), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
      revisionHex: "31",
      reason: "invalid-record",
    });
  });

  it("reports all transport failures safely and continues dispatch when logging throws", async () => {
    const first = await seedJob({ lastEnqueuedAtMs: 0 });
    const second = await seedJob({ lastEnqueuedAtMs: 1 });
    const healthy = await seedJob({ lastEnqueuedAtMs: 2 });
    const original = await Promise.all([readJob(first), readJob(second)]);
    const firstFailure = Object.assign(
      new Error("queue-unavailable", {
        cause: new Error("provider-unavailable"),
      }),
      { request: { token: "private" } },
    );
    send.mockImplementation(async (task) => {
      if (task.profileId === first) throw firstFailure;
      if (task.profileId === second) throw { token: "private" };
    });
    logger.error.mockImplementationOnce(() => {
      throw new Error("logger-unavailable");
    });
    logger.error.mockImplementationOnce(() => {
      throw new Error("logger-unavailable");
    });

    await expect(sweep()).rejects.toBe(firstFailure);
    expect(send).toHaveBeenCalledTimes(3);
    expect(await Promise.all([readJob(first), readJob(second)])).toEqual(
      original,
    );
    expect(await readJob(healthy)).toMatchObject({
      last_enqueued_at_ms: nowMs,
    });
    const entries = logger.error.mock.calls.map(([entry]) => JSON.parse(entry));
    expect(entries).toMatchObject([
      {
        profileId: first,
        itemIndex: 0,
        phase: "enqueue",
        error: {
          message: "queue-unavailable",
          cause: { message: "provider-unavailable" },
        },
      },
      {
        profileId: second,
        itemIndex: 1,
        phase: "enqueue",
        error: { type: "object" },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("private");
    expect(JSON.stringify(entries)).not.toContain("stack");
    expect(JSON.stringify(entries)).not.toContain("login_uids_json");
  });

  it.each([undefined, null, 0, false, ""])(
    "retains the first falsy enqueue failure %s while later rows continue",
    async (firstFailure) => {
      const first = await seedJob({ lastEnqueuedAtMs: 0 });
      const second = await seedJob({ lastEnqueuedAtMs: 1 });
      const healthy = await seedJob({ lastEnqueuedAtMs: 2 });
      const originals = await Promise.all([readJob(first), readJob(second)]);
      send.mockImplementation(async (task) => {
        if (task.profileId === first) throw firstFailure;
        if (task.profileId === second) throw new Error("later-queue-failure");
      });

      await expect(sweep()).rejects.toBe(firstFailure);
      expect(send.mock.calls.map(([task]) => task.profileId)).toEqual([
        first,
        second,
        healthy,
      ]);
      expect(await Promise.all([readJob(first), readJob(second)])).toEqual(
        originals,
      );
      expect(
        await Promise.all([readQuarantine(first), readQuarantine(second)]),
      ).toEqual([null, null]);
      expect(await readJob(healthy)).toMatchObject({
        last_enqueued_at_ms: nowMs,
        updated_at_ms: nowMs,
        revision: 2,
      });
      expect(
        logger.error.mock.calls.map(([entry]) => JSON.parse(entry)),
      ).toMatchObject([
        { profileId: first, itemIndex: 0, phase: "enqueue" },
        { profileId: second, itemIndex: 1, phase: "enqueue" },
      ]);
    },
  );

  it("omits malformed profile identity from quarantine failure logs", async () => {
    const invalid = await seedJob({
      profileId: " profile#private ",
      lastEnqueuedAtMs: 0,
    });
    const healthy = await seedJob({ lastEnqueuedAtMs: 1 });
    await testEnv.PROFILE_DB.prepare(
      `CREATE TRIGGER reject_auth_recovery_quarantine
       BEFORE INSERT ON profile_auth_recovery_quarantine_canonical
       BEGIN SELECT RAISE(ABORT, 'simulated-quarantine-failure'); END`,
    ).run();

    await expect(sweep()).rejects.toThrow("simulated-quarantine-failure");
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { kind: "auth-profile-recovery", profileId: healthy },
      { delaySeconds: 60 },
    );
    const entry = JSON.parse(logger.error.mock.calls[0]![0]!);
    expect(entry).toMatchObject({ itemIndex: 0, phase: "quarantine" });
    expect(entry).not.toHaveProperty("profileId");
    expect(JSON.stringify(entry)).not.toContain(invalid);
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
