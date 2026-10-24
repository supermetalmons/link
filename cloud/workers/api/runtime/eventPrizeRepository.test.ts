import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EventPrizeAssignmentRecord } from "../../../runtime/eventReads.js";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createEventPrizeRepository } from "../src/eventPrizeRepository.ts";
import { createD1ProfileOwnershipReader } from "../src/profileOwnershipD1.ts";
import { createEventPrizeContext } from "../src/eventPrizeWithdrawal/context.ts";
import { handleEventPrizeWithdrawalRoute } from "../src/eventPrizeWithdrawal/route.ts";
import { createD1EventPrizeWithdrawalStore } from "../src/eventPrizeWithdrawalD1.ts";
import { executeEventPrizeWithdrawal } from "../src/eventPrizeWithdrawal/runtime.ts";
import { buildEventPrizeWithdrawalOperationId } from "../src/eventPrizeWithdrawal/contracts.ts";
import { handleEventReadRoute } from "../src/eventReadRoute.ts";
import { commitCanonicalPlan } from "../src/profileCanonical/commit.ts";
import { materializeCanonicalProfile } from "../src/profileCanonical/profiles.ts";
import { GameplayRepositoryFailure } from "../src/gameplayRepositoryPolicy.ts";
import {
  acquireEventWriteAdmission,
  releaseEventWriteAdmission,
} from "../src/eventD1/coordination.ts";
import {
  EventWritesDisabled,
  type EventD1Connection,
} from "../src/eventD1/types.ts";
import { patchEventOwnedPaths } from "./eventD1Fixture.ts";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS: D1Migration[];
};
const eventId = "NN3eRzoZo80";
const prizeId = "1092";

function restrictedEnv(additional: string[] = []): Env {
  const forbidden = new Set([
    "PROFILE_GAMES_DB",
    "INVITE_REACTIONS",
    "TELEGRAM_DB",
    "TELEGRAM_PROJECTION_QUEUE",
    "PROFILE_GAME_PROJECTION_QUEUE",
    "EVENT_PROGRESS_WORKFLOW",
    "EVENT_PRIZE_ADMIN_PRIVATE_KEY",
    "HELIUS_RPC_API_KEY",
    ...additional,
  ]);
  return new Proxy(testEnv, {
    get(target, property) {
      if (typeof property === "string" && forbidden.has(property))
        throw new Error(`unexpected-binding:${property}`);
      return Reflect.get(target, property, target);
    },
  });
}

function assignment(
  profileId: string,
  assignedAtMs = 100,
): EventPrizeAssignmentRecord {
  return { eventId, profileId, prizeId, place: 1, assignedAtMs };
}

async function owner() {
  const profileId = `prize-owner-${crypto.randomUUID()}`;
  const loginUid = `prize-login-${crypto.randomUUID()}`;
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [
      { kind: "profile-absent", profileId },
      { kind: "login-owner-absent", loginUid },
    ],
    mutations: [
      {
        kind: "insert-active-profile",
        value: materializeCanonicalProfile({
          createdAtMs: 100,
          updatedAtMs: 100,
          profile: {
            id: profileId,
            nonce: 1,
            rating: 1600,
            totalManaPoints: 5,
            win: true,
            emoji: 2,
            username: null,
            eth: null,
            sol: null,
            mining: {
              lastRockDate: "2026-08-28",
              materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
            },
          },
        }),
      },
      {
        kind: "insert-login-owner",
        value: { profileId, loginUid, createdAtMs: 100, updatedAtMs: 100 },
      },
    ],
  });
  return { profileId, loginUid };
}

async function admissionCount() {
  return testEnv.EVENT_DB.prepare(
    "SELECT COUNT(*) AS count FROM event_write_admissions",
  ).first<number>("count");
}

describe("focused event prize repositories", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "0".repeat(64),
    );
    await applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    );
    await applyD1Migrations(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      testEnv.TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS,
    );
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      "UPDATE event_prize_withdrawal_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
    ).run();
  });

  beforeEach(async () => {
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare("DELETE FROM profile_event_prizes"),
      testEnv.EVENT_DB.prepare("DELETE FROM profile_event_prize_revisions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
    ]);
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    try {
      await patchEventOwnedPaths(
        testEnv.EVENT_DB,
        {
          [`events/${eventId}`]: {
            schemaVersion: 2,
            eventId,
            status: "scheduled",
            createdAtMs: 100,
            updatedAtMs: 100,
            startAtMs: 1_000,
            createdByProfileId: "event-owner",
            createdByLoginUid: "event-login",
            createdByUsername: "owner",
            participants: {},
            rounds: {},
          },
        },
        { admission },
      );
    } finally {
      await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it("serves default event snapshots without profile or gameplay bindings", async () => {
    const response = await handleEventReadRoute(
      new Request(`https://api.mons.link/events/snapshot?eventId=${eventId}`),
      restrictedEnv(["PROFILE_DB"]),
      { waitUntil() {} },
      { verifyIdentity: async () => ({ uid: "login" }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, eventId });
  });

  it("maps ownership and serves default prize reads using only their databases", async () => {
    const { profileId, loginUid } = await owner();
    const repository = createEventPrizeRepository(
      testEnv.PROFILE_DB,
      testEnv.EVENT_DB,
    );
    await repository.transactProfileEventPrize(profileId, eventId, () => ({
      value: assignment(profileId),
    }));
    const ownership = await createD1ProfileOwnershipReader(
      testEnv.PROFILE_DB,
    ).readProfileOwnershipSnapshot({
      loginUids: [loginUid, "absent-login"],
      profileIds: [profileId, "absent-profile"],
    });
    expect(ownership.loginOwnerByUid.get(loginUid)).toEqual({
      profileId,
      revision: 1,
    });
    expect(ownership.loginOwnerByUid.get("absent-login")).toBeNull();
    expect(
      ownership.canonicalProfileIdByProfileId.get("absent-profile"),
    ).toBeNull();
    expect(ownership.loginUidsByProfileId.get(profileId)).toEqual([loginUid]);
    expect(ownership.profileById.get(profileId)?.profile).toEqual({
      profileId,
      aura: "",
      emoji: 2,
      eth: "",
      sol: "",
      username: "",
      rating: 1600,
    });
    const response = await handleEventReadRoute(
      new Request("https://api.mons.link/events/prizes"),
      restrictedEnv(),
      { waitUntil() {} },
      { verifyIdentity: async () => ({ uid: loginUid }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      profileId,
      revision: 1,
      prizes: { [eventId]: assignment(profileId) },
    });
    const context = await createEventPrizeContext(restrictedEnv());
    expect(await context.readProfileByLoginUid(loginUid)).toEqual({
      id: profileId,
    });
    expect(
      await context.readProfileEventPrizeAssignment(profileId, eventId),
    ).toEqual(assignment(profileId));
    expect(
      await context.removeMatchingProfileEventPrizeAssignment({
        profileId,
        eventId,
        prizeId,
      }),
    ).toBe(true);
    expect(
      await context.readProfileEventPrizeAssignment(profileId, eventId),
    ).toBeNull();
    expect(await admissionCount()).toBe(0);
  });

  it("uses focused default withdrawal routes and leaves repeated cleanup revisions unchanged", async () => {
    const { profileId, loginUid } = await owner();
    const repository = createEventPrizeRepository(
      testEnv.PROFILE_DB,
      testEnv.EVENT_DB,
    );
    await repository.transactProfileEventPrize(profileId, eventId, () => ({
      value: assignment(profileId),
    }));
    const withdrawals = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
    );
    const recipientAddress = "11111111111111111111111111111111";
    const completed = {
      assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
      eventId,
      place: 1,
      prizeId,
      profileId,
      recipientAddress,
      requesterUid: loginUid,
      status: "completed",
      transactionSignature: "signature",
    };
    await withdrawals.replaceRecords([{ eventId, prizeId, value: completed }]);
    const invoke = (path: string, body: unknown) =>
      handleEventPrizeWithdrawalRoute(
        new Request(`https://api.mons.link${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://mons.link",
          },
          body: JSON.stringify(body),
        }),
        restrictedEnv(),
        { waitUntil() {} },
        { verifyIdentity: async () => ({ uid: loginUid }) },
      );
    const readRevision = () =>
      testEnv.EVENT_DB.prepare(
        "SELECT revision, updated_at_ms FROM profile_event_prize_revisions WHERE profile_id = ?",
      )
        .bind(profileId)
        .first<{ revision: number; updated_at_ms: number }>();
    try {
      const status = await invoke("/events/prizes/withdrawals/status", {
        eventId,
        prizeId,
        operationId: await buildEventPrizeWithdrawalOperationId(
          eventId,
          prizeId,
        ),
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ status: "completed" });
      expect(
        await repository.readProfileEventPrizeAssignment(profileId, eventId),
      ).toEqual(assignment(profileId));
      expect((await readRevision())?.revision).toBe(1);

      const first = await invoke("/events/prizes/withdrawals", {
        eventId,
        prizeId,
        solanaAddress: recipientAddress,
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ status: "completed" });
      expect(
        await repository.readProfileEventPrizeAssignment(profileId, eventId),
      ).toBeNull();
      const revision = await readRevision();
      expect(revision?.revision).toBe(2);

      const repeated = await invoke("/events/prizes/withdrawals", {
        eventId,
        prizeId,
        solanaAddress: recipientAddress,
      });
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({ status: "completed" });
      expect(await readRevision()).toEqual(revision);
      expect(await withdrawals.get(eventId, prizeId)).toEqual(completed);
      expect(await admissionCount()).toBe(0);
    } finally {
      await withdrawals.replaceRecords([{ eventId, prizeId, value: null }]);
    }
  });

  it("keeps profileDb overrides scoped to merge paths and narrows the execution default", async () => {
    const { profileId, loginUid } = await owner();
    let mergeReads = 0;
    const profileDb = new Proxy(testEnv.PROFILE_DB, {
      get(target, property) {
        if (property === "prepare")
          return () => {
            mergeReads++;
            throw new Error("merge-path-unavailable");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const context = await createEventPrizeContext(restrictedEnv(), {
      profileDb,
    });
    expect(await context.readProfileByLoginUid(loginUid)).toEqual({
      id: profileId,
    });
    expect(mergeReads).toBe(0);
    await expect(
      context.resolveCanonicalProfilePath(profileId),
    ).rejects.toMatchObject({
      message: "profile-ownership-unavailable",
    });
    expect(mergeReads).toBe(1);
    await expect(
      executeEventPrizeWithdrawal(restrictedEnv(), {
        schemaVersion: 1,
        kind: "withdrawal",
        eventId,
        prizeId,
        operationId: await buildEventPrizeWithdrawalOperationId(
          eventId,
          prizeId,
        ),
        profileId,
        requesterUid: loginUid,
        recipientAddress: "11111111111111111111111111111111",
      }),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("preserves ownership failure causes and the injected failure factory", async () => {
    const cause = new Error("private-database-failure");
    const db = new Proxy(testEnv.PROFILE_DB, {
      get(target, property) {
        if (property === "prepare")
          return () => {
            throw cause;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const query = { loginUids: ["owner"], profileIds: [] };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = await createD1ProfileOwnershipReader(db)
      .readProfileOwnershipSnapshot(query)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GameplayRepositoryFailure);
    expect(failure).toMatchObject({
      operation: "readProfileOwnershipSnapshot",
      cause,
    });
    expect((failure as Error).cause).toBe(cause);
    expect(log.mock.calls).toEqual([
      [
        JSON.stringify({
          event: "gameplay_repository_failure",
          operation: "readProfileOwnershipSnapshot",
          failureKind: "unknown",
        }),
      ],
    ]);
    const customFailure = new Error("custom-failure");
    const options = { createFailure: vi.fn(() => customFailure) };
    await expect(
      createD1ProfileOwnershipReader(db, options).readProfileOwnershipSnapshot(
        query,
      ),
    ).rejects.toBe(customFailure);
    expect(options.createFailure).toHaveBeenCalledExactlyOnceWith(
      "readProfileOwnershipSnapshot",
      { cause },
    );
  });

  it("keeps read cancellation behavior and acquires then releases admission for aborted writes", async () => {
    const profileId = "cancel-owner";
    const repository = createEventPrizeRepository(
      testEnv.PROFILE_DB,
      testEnv.EVENT_DB,
    );
    await repository.transactProfileEventPrize(profileId, eventId, () => ({
      value: assignment(profileId),
    }));
    const failure = new Error("cancelled");
    const signal = AbortSignal.abort(failure);
    expect(
      await repository.readProfileEventPrizeAssignment(
        profileId,
        eventId,
        signal,
      ),
    ).toEqual(assignment(profileId));
    const queries: string[] = [];
    const observed: EventD1Connection = {
      prepare(sql) {
        queries.push(sql);
        return testEnv.EVENT_DB.prepare(sql);
      },
      batch: (statements) => testEnv.EVENT_DB.batch(statements),
    };
    const updater = vi.fn(() => ({ value: null }));
    await expect(
      createEventPrizeRepository(
        testEnv.PROFILE_DB,
        observed,
      ).transactProfileEventPrize(profileId, eventId, updater, signal),
    ).rejects.toBe(failure);
    expect(updater).not.toHaveBeenCalled();
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("INSERT INTO event_write_admissions");
    expect(queries[1]).toBe(
      "DELETE FROM event_write_admissions WHERE admission_id = ?",
    );
    expect(await admissionCount()).toBe(0);
    expect(
      await repository.readProfileEventPrizeAssignment(profileId, eventId),
    ).toEqual(assignment(profileId));
  });

  it("rejects frozen and expired admissions without changing prizes", async () => {
    const profileId = "guard-owner";
    const repository = createEventPrizeRepository(
      testEnv.PROFILE_DB,
      testEnv.EVENT_DB,
    );
    await repository.transactProfileEventPrize(profileId, eventId, () => ({
      value: assignment(profileId),
    }));
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "d1" },
      next: { storageMode: "frozen" },
      nowMs: 100,
    });
    try {
      const updater = vi.fn(() => ({ value: null }));
      await expect(
        repository.transactProfileEventPrize(profileId, eventId, updater),
      ).rejects.toBeInstanceOf(EventWritesDisabled);
      expect(updater).not.toHaveBeenCalled();
      expect(
        await repository.readProfileEventPrizeAssignment(profileId, eventId),
      ).toEqual(assignment(profileId));
    } finally {
      await transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "frozen" },
        next: { storageMode: "d1" },
        nowMs: 101,
      });
    }
    const expired: EventD1Connection = {
      prepare: (sql) => testEnv.EVENT_DB.prepare(sql),
      async batch(statements) {
        await testEnv.EVENT_DB.prepare(
          "UPDATE event_write_admissions SET created_at_ms = 0, expires_at_ms = 1",
        ).run();
        return testEnv.EVENT_DB.batch(statements);
      },
    };
    await expect(
      createEventPrizeRepository(
        testEnv.PROFILE_DB,
        expired,
      ).transactProfileEventPrize(profileId, eventId, () => ({ value: null })),
    ).rejects.toThrow("event-write-admission-invalid");
    expect(
      await repository.readProfileEventPrizeAssignment(profileId, eventId),
    ).toEqual(assignment(profileId));
    expect(await admissionCount()).toBe(0);
  });

  it("retries concurrent prize revisions without overwriting newer assignments", async () => {
    const profileId = "concurrent-owner";
    const repository = createEventPrizeRepository(
      testEnv.PROFILE_DB,
      testEnv.EVENT_DB,
    );
    await repository.transactProfileEventPrize(profileId, eventId, () => ({
      value: assignment(profileId),
    }));
    let concurrent = true;
    const db: EventD1Connection = {
      prepare: (sql) => testEnv.EVENT_DB.prepare(sql),
      async batch(statements) {
        if (concurrent) {
          concurrent = false;
          await repository.transactProfileEventPrize(
            profileId,
            eventId,
            () => ({ value: assignment(profileId, 200) }),
          );
        }
        return testEnv.EVENT_DB.batch(statements);
      },
    };
    const observed: number[] = [];
    const result = await createEventPrizeRepository(
      testEnv.PROFILE_DB,
      db,
    ).transactProfileEventPrize(profileId, eventId, (current) => {
      observed.push(current!.assignedAtMs);
      return { value: assignment(profileId, current!.assignedAtMs + 1) };
    });
    expect(observed).toEqual([100, 200]);
    expect(result).toMatchObject({
      committed: true,
      value: assignment(profileId, 201),
    });
    expect(await admissionCount()).toBe(0);
  });

  it("preserves work outcomes when admission release fails", async () => {
    const repository = createEventPrizeRepository(
      testEnv.PROFILE_DB,
      testEnv.EVENT_DB,
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await testEnv.EVENT_DB.prepare(
      "CREATE TRIGGER prize_release_failure BEFORE DELETE ON event_write_admissions BEGIN SELECT RAISE(ABORT, 'release-failed'); END",
    ).run();
    try {
      await expect(
        repository.transactProfileEventPrize("release-owner", eventId, () => ({
          value: assignment("release-owner"),
        })),
      ).resolves.toMatchObject({ committed: true });
      const failure = new Error("updater-failed");
      await expect(
        repository.transactProfileEventPrize("release-owner", eventId, () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(
        await repository.readProfileEventPrizeAssignment(
          "release-owner",
          eventId,
        ),
      ).toEqual(assignment("release-owner"));
      expect(log.mock.calls).toHaveLength(2);
      for (const [message] of log.mock.calls)
        expect(JSON.parse(String(message))).toMatchObject({
          event: "event_write_admission_release_failed",
          context: "event-path-transaction",
          attempts: 1,
        });
    } finally {
      await testEnv.EVENT_DB.prepare(
        "DROP TRIGGER prize_release_failure",
      ).run();
      await testEnv.EVENT_DB.prepare(
        "DELETE FROM event_write_admissions",
      ).run();
    }
  });
});
