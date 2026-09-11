import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { getEventPrizeDefinition } from "@mons/shared/event-prizes";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createAuthIdentityService } from "../src/authIdentity.ts";
import { createAuthRecoveryService } from "../src/authRecovery.ts";
import { createD1AuthRecoveryPrizeStore } from "../src/eventRepository.ts";
import { createD1EventPrizeWithdrawalStore } from "../src/eventPrizeWithdrawalD1.ts";
import { readEventRuntimeControl } from "../src/eventD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";

const testEnv = env as Env & {
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS: D1Migration[];
};
const eventId = "NN3eRzoZo80";
const sourceProfileId = "recovery-source-profile";
const credentialReads: string[] = [];
const queueTransport = { async send() {} };
const outboundFetch = vi.fn<typeof fetch>(async () => {
  throw new Error("auth-recovery-must-not-use-network");
});
const d1Env = new Proxy(testEnv, {
  get(target, property, receiver) {
    if (
      property === "PROFILE_GAME_PROJECTION_QUEUE" ||
      property === "AUTH_RECOVERY_QUEUE"
    ) {
      return queueTransport;
    }
    if (
      typeof property === "string" &&
      (property.includes("FIREBASE") || property.includes("SERVICE_ACCOUNT"))
    ) {
      credentialReads.push(property);
      throw new Error("auth-recovery-must-not-read-firebase-configuration");
    }
    return Reflect.get(target, property, receiver);
  },
});
const logger = { error() {}, info() {} };
let fixtureSequence = 0;

async function fixture(prizeId = "retired-prize") {
  fixtureSequence++;
  const uid = `recovery-target-login-${fixtureSequence}`;
  const wallet = `0x${fixtureSequence.toString(16).padStart(40, "0")}`;
  const target = await createAuthIdentityService(d1Env, {
    randomInteger: () => 0,
  }).linkVerifiedMethod({
    uid,
    method: "eth",
    methodValueRaw: wallet,
    normalizedMethodValue: wallet,
    opId: `recovery-target-operation-${fixtureSequence}`,
    requestEmoji: 1,
    requestAura: null,
  });
  const nowMs = Date.now();
  await testEnv.PROFILE_DB.prepare(
    `INSERT INTO profile_auth_recovery_jobs (
      profile_id, login_uids_json, source_profile_ids_json, source_phase,
      prize_cursor, phase_started_at_ms, last_enqueued_at_ms, created_at_ms,
      updated_at_ms, revision
    ) VALUES (?, '[]', ?, 'prizes', NULL, ?, ?, ?, ?, 1)
    ON CONFLICT(profile_id) DO UPDATE SET login_uids_json = '[]',
      source_profile_ids_json = excluded.source_profile_ids_json,
      source_phase = 'prizes', prize_cursor = NULL`,
  )
    .bind(
      target.profileId,
      JSON.stringify([sourceProfileId]),
      nowMs,
      nowMs,
      nowMs,
      nowMs,
    )
    .run();
  const record = {
    schemaVersion: 2,
    eventId,
    status: "scheduled",
    createdAtMs: 100,
    updatedAtMs: 100,
    startAtMs: 1_000,
    createdByProfileId: sourceProfileId,
    createdByLoginUid: "recovery-source-login",
    createdByUsername: "Source",
    participants: {},
    rounds: {},
  };
  const assignment = {
    eventId,
    profileId: sourceProfileId,
    place: 1,
    prizeId,
    assignedAtMs: 100,
    archivedMetadata: { edition: 2 },
  };
  await testEnv.EVENT_DB.batch([
    testEnv.EVENT_DB.prepare(
      `INSERT INTO event_records (event_id, status, start_at_ms, updated_at_ms, record_json)
       VALUES (?, 'scheduled', 1000, 100, ?)`,
    ).bind(eventId, JSON.stringify(record)),
    testEnv.EVENT_DB.prepare(
      `INSERT INTO profile_event_prizes (profile_id, event_id, assignment_json, updated_at_ms)
       VALUES (?, ?, ?, 100)`,
    ).bind(sourceProfileId, eventId, JSON.stringify(assignment)),
  ]);
  return {
    targetProfileId: target.profileId,
    assignment,
    targetPath: `profileEventPrizes/${target.profileId}/${eventId}`,
    readJob: () =>
      testEnv.PROFILE_DB.prepare(
        "SELECT * FROM profile_auth_recovery_jobs WHERE profile_id = ?",
      )
        .bind(target.profileId)
        .first(),
    resetPrizePhase: () =>
      testEnv.PROFILE_DB.prepare(
        "UPDATE profile_auth_recovery_jobs SET source_phase = 'prizes', prize_cursor = NULL WHERE profile_id = ?",
      )
        .bind(target.profileId)
        .run(),
  };
}

describe("canonical auth recovery with D1 prize storage", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "c".repeat(64),
    );
    await applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    );
    await applyD1Migrations(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      testEnv.TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    credentialReads.length = 0;
    outboundFetch.mockClear();
    vi.stubGlobal("fetch", outboundFetch);
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare("DELETE FROM event_leases"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
      testEnv.EVENT_DB.prepare("DELETE FROM profile_event_prize_revisions"),
    ]);
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      "DELETE FROM event_prize_withdrawals",
    ).run();
  });

  afterEach(async () => {
    await testEnv.EVENT_DB.prepare(
      "DROP TRIGGER IF EXISTS reject_recovery_prize_write",
    ).run();
    if (
      (await readEventRuntimeControl(testEnv.EVENT_DB)).storageMode === "frozen"
    ) {
      await transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "frozen" },
        next: { storageMode: "d1" },
        nowMs: Date.now(),
      });
    }
    vi.unstubAllGlobals();
    expect(outboundFetch).not.toHaveBeenCalled();
    expect(credentialReads).toEqual([]);
  });

  it("copies retired assignments and replays through the default D1 construction", async () => {
    const f = await fixture();
    const service = createAuthRecoveryService(d1Env, { logger });
    const store = createD1AuthRecoveryPrizeStore(testEnv.EVENT_DB);
    await expect(service.recoverProfile(f.targetProfileId)).resolves.toBe(
      false,
    );
    expect(await store.getPath(f.targetPath)).toEqual({
      ...f.assignment,
      profileId: f.targetProfileId,
    });
    expect(await f.readJob()).toMatchObject({
      source_phase: "games",
      prize_cursor: eventId,
    });
    const revision = await testEnv.EVENT_DB.prepare(
      "SELECT revision FROM profile_event_prize_revisions WHERE profile_id = ?",
    )
      .bind(f.targetProfileId)
      .first<number>("revision");
    await f.resetPrizePhase();
    await expect(service.recoverProfile(f.targetProfileId)).resolves.toBe(
      false,
    );
    expect(
      await testEnv.EVENT_DB.prepare(
        "SELECT revision FROM profile_event_prize_revisions WHERE profile_id = ?",
      )
        .bind(f.targetProfileId)
        .first<number>("revision"),
    ).toBe(revision);
    expect(
      await store.getPath(`profileEventPrizes/${sourceProfileId}/${eventId}`),
    ).toEqual(f.assignment);
    expect(
      await testEnv.EVENT_DB.prepare(
        "SELECT COUNT(*) AS count FROM event_leases",
      ).first<number>("count"),
    ).toBe(0);
  });

  it.each(["busy", "frozen", "write-failure"])(
    "retains the recovery cursor when event storage is %s",
    async (failure) => {
      const f = await fixture();
      const before = await f.readJob();
      const store = createD1AuthRecoveryPrizeStore(testEnv.EVENT_DB);
      if (failure === "busy") {
        const nowMs = Date.now();
        await store.transactPath(`eventLocks/${eventId}`, () => ({
          value: {
            lockId: "other-lock",
            ownerUid: "other-owner",
            acquiredAtMs: nowMs,
            refreshedAtMs: nowMs,
            expiresAtMs: nowMs + 30_000,
          },
        }));
      } else if (failure === "frozen") {
        await transitionEventStorageMode(testEnv.EVENT_DB, {
          expected: { storageMode: "d1" },
          next: { storageMode: "frozen" },
          nowMs: Date.now(),
        });
      } else {
        await testEnv.EVENT_DB.prepare(
          `CREATE TRIGGER reject_recovery_prize_write BEFORE INSERT ON profile_event_prizes
         WHEN NEW.profile_id != 'recovery-source-profile'
         BEGIN SELECT RAISE(ABORT, 'simulated-d1-prize-write-failure'); END`,
        ).run();
      }
      await expect(
        createAuthRecoveryService(d1Env, { logger }).recoverProfile(
          f.targetProfileId,
        ),
      ).resolves.toBe(false);
      expect(await f.readJob()).toEqual(before);
      expect(await store.getPath(f.targetPath)).toBeNull();
    },
  );

  it("does not advance after the event lease changes before the guarded prize commit", async () => {
    const f = await fixture();
    const before = await f.readJob();
    const store = createD1AuthRecoveryPrizeStore(testEnv.EVENT_DB);
    const service = createAuthRecoveryService(d1Env, {
      logger,
      prizeStore: {
        ...store,
        async transactStoredProfileEventPrizeWithEventLease(
          path,
          updater,
          guard,
          signal,
        ) {
          await testEnv.EVENT_DB.prepare(
            "UPDATE event_leases SET lease_id = 'successor-lock' WHERE event_id = ?",
          )
            .bind(eventId)
            .run();
          return store.transactStoredProfileEventPrizeWithEventLease(
            path,
            updater,
            guard,
            signal,
          );
        },
      },
    });
    await expect(service.recoverProfile(f.targetProfileId)).resolves.toBe(
      false,
    );
    expect(await f.readJob()).toEqual(before);
    expect(await store.getPath(f.targetPath)).toBeNull();
  });

  it.each(["before", "during"])(
    "does not restore a prize whose withdrawal completes %s recovery",
    async (timing) => {
      const prizeId = "1092";
      const definition = getEventPrizeDefinition(eventId, prizeId);
      if (!definition) throw new Error("missing-test-prize-definition");
      const f = await fixture(prizeId);
      const withdrawals = createD1EventPrizeWithdrawalStore(
        testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      );
      const complete = () =>
        withdrawals.record(eventId, prizeId).transaction(() => ({
          eventId,
          prizeId,
          status: "completed",
          assetAddress: definition.assetAddress,
          assetStandard: definition.standard,
          updatedAtMs: Date.now(),
        }));
      if (timing === "before") await complete();
      let reads = 0;
      const service = createAuthRecoveryService(d1Env, {
        logger,
        ...(timing === "during"
          ? {
              withdrawalStore: {
                async get(readEventId: string, readPrizeId: string) {
                  reads++;
                  if (reads === 2) await complete();
                  return withdrawals.get(readEventId, readPrizeId);
                },
              },
            }
          : {}),
      });
      await expect(service.recoverProfile(f.targetProfileId)).resolves.toBe(
        false,
      );
      expect(
        await createD1AuthRecoveryPrizeStore(testEnv.EVENT_DB).getPath(
          f.targetPath,
        ),
      ).toBeNull();
      expect(await f.readJob()).toMatchObject({
        source_phase: "games",
        prize_cursor: eventId,
      });
      if (timing === "during") expect(reads).toBe(2);
    },
  );
});
