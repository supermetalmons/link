import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthRecoveryService,
  ensureFirebaseProfileClaim,
  MERGE_PRIZE_RECOVERY_PAGE_SIZE,
} from "../src/authRecovery.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import type { EventRtdbClient } from "../src/eventRepository.ts";
import type { ProfileLinkCatchupJob } from "../src/profileLinkCatchupD1.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function catchupJob(): ProfileLinkCatchupJob {
  return {
    loginUid: "firebase-uid",
    requestId: "repair-request",
    profileId: "current-profile",
    cleanupProfileIds: ["older-profile", "previous-profile"],
    matchCursor: null,
    sourceUpdatedAtMs: 500,
    lastQueuedAtMs: 0,
    revision: 1,
  };
}

test("claim repair durably records stale-owner cleanup before updating Firebase", async () => {
  const operations: string[] = [];
  const queued: unknown[] = [];
  const job = catchupJob();
  await ensureFirebaseProfileClaim("firebase-uid", "current-profile", {
    authClient: {
      getUser: async () => ({
        uid: "firebase-uid",
        customClaims: { profileId: "current-profile" },
      }),
      setCustomUserClaims: async () => undefined,
    },
    catchupStore: {
      mergeCleanup: async () => {
        throw new Error("expected-missing-link-scheduling");
      },
      schedule: async (input) => {
        assert.deepEqual(input, {
          loginUid: "firebase-uid",
          profileId: "current-profile",
          cleanupProfileIds: ["previous-profile"],
          requestId: "repair-request",
          nowMs: 500,
        });
        operations.push("persist-job");
        return job;
      },
    },
    createRequestId: () => "repair-request",
    enqueueProfileLinkProjection: async (task) => {
      operations.push("enqueue");
      queued.push(task);
    },
    now: () => 500,
    rtdb: {
      getPath: async (path) => {
        assert.equal(path, "players/firebase-uid/profile");
        return "previous-profile";
      },
      patchRoot: async (updates) => {
        assert.deepEqual(updates, {
          "players/firebase-uid/profile": "current-profile",
        });
        operations.push("repair-shadow");
      },
    },
  });
  assert.deepEqual(operations, ["persist-job", "repair-shadow", "enqueue"]);
  assert.deepEqual(queued, [
    {
      kind: "profile-link-profile-game-projection",
      loginUid: "firebase-uid",
      requestId: "repair-request",
    },
  ]);
});

test("claim repair does not overwrite Firebase when catch-up persistence fails", async () => {
  const failure = new Error("d1-unavailable");
  let firebaseWrites = 0;
  await assert.rejects(
    ensureFirebaseProfileClaim("firebase-uid", "current-profile", {
      authClient: {
        getUser: async () => ({ uid: "firebase-uid", customClaims: {} }),
        setCustomUserClaims: async () => {
          firebaseWrites++;
        },
      },
      catchupStore: {
        schedule: async () => {
          throw failure;
        },
        mergeCleanup: async () => {
          throw failure;
        },
      },
      rtdb: {
        getPath: async () => "previous-profile",
        patchRoot: async () => {
          firebaseWrites++;
        },
      },
    }),
    failure,
  );
  assert.equal(firebaseWrites, 0);
});

test("claim retry dispatches persisted catch-up after the Firebase shadow was already repaired", async () => {
  const job = { ...catchupJob(), matchCursor: "match-20" };
  let shadow = "previous-profile";
  let failClaims = true;
  const queued: unknown[] = [];
  const cleanupInputs: string[][] = [];
  const dependencies: Parameters<typeof ensureFirebaseProfileClaim>[2] = {
    authClient: {
      getUser: async () => ({ uid: "firebase-uid", customClaims: {} }),
      setCustomUserClaims: async () => {
        if (failClaims) throw new Error("firebase-auth-unavailable");
      },
    },
    catchupStore: {
      schedule: async (input) => {
        cleanupInputs.push([...input.cleanupProfileIds]);
        return job;
      },
      mergeCleanup: async (input) => {
        cleanupInputs.push([...input.cleanupProfileIds]);
        return job;
      },
    },
    enqueueProfileLinkProjection: async (task) => {
      queued.push(task);
    },
    rtdb: {
      getPath: async () => shadow,
      patchRoot: async () => {
        shadow = "current-profile";
      },
    },
  };
  await assert.rejects(
    ensureFirebaseProfileClaim("firebase-uid", "current-profile", dependencies),
  );
  assert.equal(shadow, "current-profile");
  assert.deepEqual(queued, []);
  failClaims = false;
  await ensureFirebaseProfileClaim(
    "firebase-uid",
    "current-profile",
    dependencies,
  );
  assert.deepEqual(cleanupInputs, [["previous-profile"], []]);
  assert.equal(job.matchCursor, "match-20");
  assert.deepEqual(queued, [
    {
      kind: "profile-link-profile-game-projection",
      loginUid: "firebase-uid",
      requestId: job.requestId,
    },
  ]);
});

test("claim repair leaves durable work recoverable when Queue dispatch fails", async () => {
  const job = catchupJob();
  const logs: string[] = [];
  await ensureFirebaseProfileClaim("firebase-uid", "current-profile", {
    authClient: {
      getUser: async () => ({
        uid: "firebase-uid",
        customClaims: { profileId: "current-profile" },
      }),
      setCustomUserClaims: async () => undefined,
    },
    catchupStore: {
      mergeCleanup: async () => job,
      schedule: async () => {
        throw new Error("unexpected-new-job");
      },
    },
    enqueueProfileLinkProjection: async () => {
      throw new Error("private-provider-detail");
    },
    logger: {
      error: (message) => {
        logs.push(String(message));
      },
    },
    rtdb: {
      getPath: async () => "current-profile",
      patchRoot: async () => {
        throw new Error("unexpected-shadow-write");
      },
    },
  });
  assert.deepEqual(
    logs.map((value) => JSON.parse(value)),
    [
      {
        event: "profile_link_profile_game_projection_enqueue_failed",
        loginUid: "firebase-uid",
      },
    ],
  );
  assert.equal(job.requestId, "repair-request");
});

test("repair schedules legacy ownership recovery with a missing Firebase link and no outbox", async () => {
  const operations: string[] = [];
  const job = catchupJob();
  await ensureFirebaseProfileClaim("firebase-uid", "current-profile", {
    authClient: {
      getUser: async () => ({ uid: "firebase-uid", customClaims: {} }),
      setCustomUserClaims: async () => {
        operations.push("repair-claims");
      },
    },
    catchupStore: {
      mergeCleanup: async () => {
        throw new Error("missing-link-requires-durable-job");
      },
      schedule: async (input) => {
        assert.deepEqual(input.cleanupProfileIds, []);
        operations.push("persist-catchup");
        return job;
      },
    },
    rtdb: {
      getPath: async (path) => {
        assert.equal(path, "players/firebase-uid/profile");
        return null;
      },
      patchRoot: async (updates) => {
        assert.equal(operations[0], "persist-catchup");
        assert.deepEqual(updates, {
          "players/firebase-uid/profile": "current-profile",
        });
        operations.push("repair-link");
      },
    },
    enqueueProfileLinkProjection: async (task) => {
      assert.equal(task.requestId, job.requestId);
      operations.push("dispatch");
    },
  });
  assert.deepEqual(operations, [
    "persist-catchup",
    "repair-link",
    "repair-claims",
    "dispatch",
  ]);
});

test("event prize recovery leaves copying pending while the event lease is busy", async () => {
  const eventId = "NN3eRzoZo80";
  const recoveryRow = {
    profile_id: "target-profile",
    login_uids_json: "[]",
    source_profile_ids_json: '["source-profile"]',
    source_phase: "prizes",
    prize_cursor: null,
    phase_started_at_ms: 100,
    last_enqueued_at_ms: 100,
    created_at_ms: 100,
    updated_at_ms: 100,
    revision: 1,
  };
  const statement = {
    bind() {
      return statement;
    },
  };
  const profileDb = {
    prepare: () => statement,
    batch: async () => [
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [recoveryRow] },
    ],
  } as unknown as D1Database;
  const transactionPaths: string[] = [];
  const readPaths: string[] = [];
  const service = createAuthRecoveryService(TELEGRAM_TEST_ENV, {
    authClient: {
      getUser: async (uid) => ({ uid, customClaims: {} }),
      setCustomUserClaims: async () => undefined,
    },
    d1: profileDb,
    logger: { error() {}, info() {} },
    now: () => 1_000,
    profileDb,
    rtdb: {
      async getPath(path) {
        readPaths.push(path);
        return {
          [eventId]: {
            eventId,
            profileId: "source-profile",
            place: 1,
            prizeId: "1092",
            assignedAtMs: 100,
          },
        };
      },
      patchRoot: async () => undefined,
      async transactPath(path) {
        transactionPaths.push(path);
        return {
          committed: false,
          decision: "locked",
          value: {
            lockId: "other-lock",
            ownerUid: "other-owner",
            expiresAtMs: 31_000,
          },
        };
      },
    },
    withdrawalStore: { get: async () => null },
  });

  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.deepEqual(readPaths, ["profileEventPrizes/source-profile"]);
  assert.deepEqual(transactionPaths, [`eventLocks/${eventId}`]);
});

function recoveryProfileDb(
  overrides: Partial<{
    phase_started_at_ms: number;
    prize_cursor: string | null;
    source_phase: "finalize" | "games" | "prizes";
  }> = {},
) {
  const recoveryRow = {
    profile_id: "target-profile",
    login_uids_json: "[]",
    source_profile_ids_json: '["source-profile"]',
    source_phase: "prizes",
    prize_cursor: null,
    phase_started_at_ms: 100,
    last_enqueued_at_ms: 100,
    created_at_ms: 100,
    updated_at_ms: 100,
    revision: 1,
    ...overrides,
  };
  const statement = {
    bind() {
      return statement;
    },
  };
  let mutationBatches = 0;
  const db = {
    prepare: () => statement,
    batch: async (statements: unknown[]) => {
      if (statements.length !== 6) mutationBatches += 1;
      return [
        { results: [] },
        { results: [] },
        { results: [] },
        { results: [] },
        { results: [] },
        { results: [recoveryRow] },
      ];
    },
  } as unknown as D1Database;
  return { db, mutationBatches: () => mutationBatches };
}

function prizeAssignment(prizeId: string, assignedAtMs: number) {
  return {
    eventId: "NN3eRzoZo80",
    profileId: "source-profile",
    place: 1,
    prizeId,
    assignedAtMs,
  };
}

function recoveryRtdb(input: {
  liveAssignment: unknown;
  takeOverOnRefresh?: boolean;
  targetAssignment?: unknown;
}) {
  const eventId = "NN3eRzoZo80";
  const lockPath = `eventLocks/${eventId}`;
  const sourcePath = `profileEventPrizes/source-profile/${eventId}`;
  const targetPath = `profileEventPrizes/target-profile/${eventId}`;
  const values = new Map<string, unknown>();
  const guardedPaths: string[] = [];
  const readPaths: string[] = [];
  const transactionPaths: string[] = [];
  let lockTransactions = 0;
  if (input.targetAssignment !== undefined) {
    values.set(targetPath, input.targetAssignment);
  }
  const transactPath: FirebaseRtdbClient["transactPath"] = async (
    path,
    updater,
  ) => {
    transactionPaths.push(path);
    if (path === lockPath) {
      lockTransactions += 1;
      if (input.takeOverOnRefresh && lockTransactions === 2) {
        values.set(lockPath, {
          lockId: "successor-lock",
          ownerUid: "successor-owner",
          acquiredAtMs: 1_000,
          refreshedAtMs: 1_000,
          expiresAtMs: 31_000,
        });
      }
    }
    const current = values.get(path) ?? null;
    const decision = updater(current) as
      | { commit: false; decision?: string }
      | { value: unknown; decision?: string };
    if ("commit" in decision) {
      return {
        committed: false,
        decision: decision.decision,
        value: current,
      };
    }
    if (decision.value === null) values.delete(path);
    else values.set(path, decision.value);
    return {
      committed: true,
      decision: decision.decision,
      value: decision.value,
    };
  };
  const client: FirebaseRtdbClient &
    Pick<EventRtdbClient, "transactStoredProfileEventPrizeWithEventLease"> = {
    async getPath(path: string) {
      readPaths.push(path);
      if (path === "profileEventPrizes/source-profile") {
        return { [eventId]: prizeAssignment("1092", 100) };
      }
      if (path === sourcePath) return input.liveAssignment;
      return values.get(path) ?? null;
    },
    patchRoot: async () => undefined,
    transactPath,
    transactStoredProfileEventPrizeWithEventLease(
      path,
      updater,
      guard,
      signal,
    ) {
      assert.deepEqual(guard, {
        eventId,
        lockId: (values.get(lockPath) as { lockId: string }).lockId,
        lockRoot: "eventLocks",
        ownerUid: "auth-recovery-worker",
      });
      assert.ok(signal instanceof AbortSignal);
      guardedPaths.push(path);
      return transactPath(path, updater, signal);
    },
  };
  return {
    guardedPaths,
    readPaths,
    targetPath,
    transactionPaths,
    value: (path: string) => values.get(path) ?? null,
    client,
  };
}

function prizeRecoveryService(
  profileDb: D1Database,
  rtdb: ReturnType<typeof recoveryRtdb>["client"],
  profileGamesDb: D1Database = profileDb,
) {
  return createAuthRecoveryService(TELEGRAM_TEST_ENV, {
    authClient: {
      getUser: async (uid) => ({ uid, customClaims: {} }),
      setCustomUserClaims: async () => undefined,
    },
    d1: profileGamesDb,
    logger: { error() {}, info() {} },
    now: () => 1_000,
    profileDb,
    rtdb,
    withdrawalStore: { get: async () => null },
  });
}

test("event prize recovery rereads the source entitlement under its lease", async () => {
  const profile = recoveryProfileDb();
  const rtdb = recoveryRtdb({
    liveAssignment: {
      ...prizeAssignment("1111", 200),
      delivery: { channel: "wallet", revision: 2 },
    },
    targetAssignment: {
      ...prizeAssignment("1111", 200),
      profileId: "target-profile",
    },
  });
  const service = prizeRecoveryService(profile.db, rtdb.client);

  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.deepEqual(rtdb.value(rtdb.targetPath), {
    eventId: "NN3eRzoZo80",
    profileId: "target-profile",
    place: 1,
    prizeId: "1111",
    assignedAtMs: 200,
    delivery: { channel: "wallet", revision: 2 },
  });
  assert.deepEqual(rtdb.guardedPaths, [rtdb.targetPath]);
  assert.deepEqual(rtdb.readPaths.slice(0, 2), [
    "profileEventPrizes/source-profile",
    "profileEventPrizes/source-profile/NN3eRzoZo80",
  ]);
  assert.equal(profile.mutationBatches(), 1);
});

test("event prize recovery does not mutate or advance after lease loss", async () => {
  const profile = recoveryProfileDb();
  const rtdb = recoveryRtdb({
    liveAssignment: prizeAssignment("1092", 100),
    takeOverOnRefresh: true,
  });
  const service = prizeRecoveryService(profile.db, rtdb.client);

  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.equal(rtdb.value(rtdb.targetPath), null);
  assert.equal(
    rtdb.transactionPaths.filter((path) => path === rtdb.targetPath).length,
    0,
  );
  assert.equal(profile.mutationBatches(), 0);
});

test("event prize recovery preserves assignments removed from the current catalog", async () => {
  const profile = recoveryProfileDb();
  const assignment = {
    ...prizeAssignment("retired-prize", 200),
    delivery: { channel: "wallet", revision: 2 },
  };
  const rtdb = recoveryRtdb({ liveAssignment: assignment });
  const service = prizeRecoveryService(profile.db, rtdb.client);

  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.deepEqual(rtdb.value(rtdb.targetPath), {
    ...assignment,
    profileId: "target-profile",
  });
  assert.deepEqual(rtdb.guardedPaths, [rtdb.targetPath]);
  assert.equal(profile.mutationBatches(), 1);
});

test("event prize recovery rescans late assignments before finalizing", async () => {
  const profile = recoveryProfileDb({ source_phase: "finalize" });
  const rtdb = recoveryRtdb({
    liveAssignment: prizeAssignment("1092", 200),
  });
  const statement = {
    bind() {
      return statement;
    },
    async all() {
      return { results: [] };
    },
  };
  const profileGamesDb = {
    prepare: () => statement,
  } as unknown as D1Database;
  const service = prizeRecoveryService(profile.db, rtdb.client, profileGamesDb);

  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.deepEqual(rtdb.value(rtdb.targetPath), {
    eventId: "NN3eRzoZo80",
    profileId: "target-profile",
    place: 1,
    prizeId: "1092",
    assignedAtMs: 200,
  });
  assert.deepEqual(rtdb.readPaths.slice(0, 2), [
    "profileEventPrizes/source-profile",
    "profileEventPrizes/source-profile/NN3eRzoZo80",
  ]);
});

test("final prize recovery copies at most one page", async () => {
  const eventIds = Array.from(
    { length: MERGE_PRIZE_RECOVERY_PAGE_SIZE + 1 },
    (_, index) => `event-${String(index).padStart(2, "0")}`,
  );
  const profile = recoveryProfileDb({ source_phase: "finalize" });
  const values = new Map<string, unknown>();
  const sourceReads: string[] = [];
  const listQueries: unknown[] = [];
  const rtdb: FirebaseRtdbClient = {
    async getPath(path, query) {
      if (path === "profileEventPrizes/source-profile") {
        listQueries.push(query);
        return Object.fromEntries(eventIds.map((eventId) => [eventId, {}]));
      }
      sourceReads.push(path);
      return {};
    },
    patchRoot: async () => undefined,
    async transactPath(path, updater) {
      const current = values.get(path) ?? null;
      const decision = updater(current) as
        | { commit: false; decision?: string }
        | { value: unknown; decision?: string };
      if ("commit" in decision) {
        return {
          committed: false,
          decision: decision.decision,
          value: current,
        };
      }
      if (decision.value === null) values.delete(path);
      else values.set(path, decision.value);
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
  };
  const profileGamesDb = {
    prepare: () => ({
      bind() {
        return this;
      },
      async all() {
        return { results: [] };
      },
    }),
  } as unknown as D1Database;
  const service = createAuthRecoveryService(TELEGRAM_TEST_ENV, {
    authClient: {
      getUser: async (uid) => ({ uid, customClaims: {} }),
      setCustomUserClaims: async () => undefined,
    },
    buildPrizeCopy: (_sourceProfileId, targetProfileId, eventId) => ({
      eventId,
      profileId: targetProfileId,
      place: 1,
      prizeId: "1092",
      assignedAtMs: 100,
    }),
    d1: profileGamesDb,
    logger: { error() {}, info() {} },
    now: () => 1_000,
    profileDb: profile.db,
    rtdb,
    withdrawalStore: { get: async () => null },
  });

  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.deepEqual(listQueries, [
    {
      orderBy: "$key",
      limitToFirst: MERGE_PRIZE_RECOVERY_PAGE_SIZE + 1,
    },
  ]);
  assert.equal(sourceReads.length, MERGE_PRIZE_RECOVERY_PAGE_SIZE);
  assert.equal(profile.mutationBatches(), 1);
});

test("event prize recovery aborts a stalled mutation before lease expiry", async () => {
  const eventId = "NN3eRzoZo80";
  const lockPath = `eventLocks/${eventId}`;
  const targetPath = `profileEventPrizes/target-profile/${eventId}`;
  const profile = recoveryProfileDb();
  let lock: unknown = null;
  let targetSignal: AbortSignal | undefined;
  const rtdb: FirebaseRtdbClient = {
    async getPath(path) {
      if (path === "profileEventPrizes/source-profile") {
        return { [eventId]: prizeAssignment("1092", 100) };
      }
      return prizeAssignment("1092", 100);
    },
    patchRoot: async () => undefined,
    async transactPath(path, updater, signal) {
      if (path === targetPath) {
        targetSignal = signal;
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      assert.equal(path, lockPath);
      const decision = updater(lock) as
        | { commit: false; decision?: string }
        | { value: unknown; decision?: string };
      if ("commit" in decision) {
        return { committed: false, decision: decision.decision, value: lock };
      }
      lock = decision.value;
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
  };
  const service = createAuthRecoveryService(TELEGRAM_TEST_ENV, {
    authClient: {
      getUser: async (uid) => ({ uid, customClaims: {} }),
      setCustomUserClaims: async () => undefined,
    },
    d1: profile.db,
    logger: { error() {}, info() {} },
    now: () => 1_000,
    prizeOperationTimeoutMs: 10,
    profileDb: profile.db,
    rtdb,
    withdrawalStore: { get: async () => null },
  });

  const startedAt = Date.now();
  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.equal(targetSignal?.aborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(profile.mutationBatches(), 0);
});
