import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthRecoveryService,
  dispatchProfileLinkCatchupForOwner,
  MERGE_PRIZE_RECOVERY_PAGE_SIZE,
} from "../src/authRecovery.ts";
import type { AuthRecoveryPrizeStore } from "../src/eventRepository.ts";
import type { ProfileLinkCatchupJob } from "../src/profileLinkCatchupD1.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function catchupJob(): ProfileLinkCatchupJob {
  return {
    loginUid: "login-uid",
    requestId: "repair-request",
    profileId: "current-profile",
    cleanupProfileIds: ["older-profile", "previous-profile"],
    matchCursor: null,
    sourceUpdatedAtMs: 500,
    lastQueuedAtMs: 0,
    revision: 1,
  };
}

test("profile-link catchup validates ownership before dispatching persisted work", async () => {
  const operations: string[] = [];
  const queued: unknown[] = [];
  const job = catchupJob();
  const originalJob = structuredClone(job);
  await dispatchProfileLinkCatchupForOwner("login-uid", "current-profile", {
    catchupStore: {
      readForOwner: async (uid, profileId) => {
        assert.equal(uid, "login-uid");
        assert.equal(profileId, "current-profile");
        operations.push("read-owner-job");
        return job;
      },
    },
    enqueueProfileLinkProjection: async (task) => {
      operations.push("enqueue");
      queued.push(task);
    },
  });
  assert.deepEqual(operations, ["read-owner-job", "enqueue"]);
  assert.deepEqual(queued, [
    {
      kind: "profile-link-profile-game-projection",
      loginUid: "login-uid",
      requestId: "repair-request",
    },
  ]);
  assert.deepEqual(job, originalJob);
});

test("profile-link catchup does not dispatch when canonical ownership validation fails", async () => {
  const failure = new Error("canonical-profile-conflict");
  const queued: unknown[] = [];
  await assert.rejects(
    dispatchProfileLinkCatchupForOwner("login-uid", "current-profile", {
      catchupStore: {
        readForOwner: async () => {
          throw failure;
        },
      },
      enqueueProfileLinkProjection: async (task) => {
        queued.push(task);
      },
    }),
    failure,
  );
  assert.deepEqual(queued, []);
});

test("profile-link catchup retries preserve persisted progress through D1 failure", async () => {
  const job = { ...catchupJob(), matchCursor: "match-20", revision: 5 };
  const originalJob = structuredClone(job);
  let failOwnerRead = true;
  let ownerReads = 0;
  const queued: unknown[] = [];
  const dependencies: Parameters<typeof dispatchProfileLinkCatchupForOwner>[2] =
    {
      catchupStore: {
        readForOwner: async () => {
          ownerReads++;
          if (failOwnerRead) throw new Error("canonical-profile-unavailable");
          return job;
        },
      },
      enqueueProfileLinkProjection: async (task) => {
        queued.push(task);
      },
    };
  await assert.rejects(
    dispatchProfileLinkCatchupForOwner(
      "login-uid",
      "current-profile",
      dependencies,
    ),
    /canonical-profile-unavailable/,
  );
  assert.deepEqual(queued, []);
  failOwnerRead = false;
  await dispatchProfileLinkCatchupForOwner(
    "login-uid",
    "current-profile",
    dependencies,
  );
  assert.equal(ownerReads, 2);
  assert.deepEqual(job, originalJob);
  assert.deepEqual(queued, [
    {
      kind: "profile-link-profile-game-projection",
      loginUid: "login-uid",
      requestId: job.requestId,
    },
  ]);
});

test("profile-link catchup leaves durable work recoverable when Queue dispatch fails", async () => {
  const job = catchupJob();
  const originalJob = structuredClone(job);
  const logs: string[] = [];
  await dispatchProfileLinkCatchupForOwner("login-uid", "current-profile", {
    catchupStore: { readForOwner: async () => job },
    enqueueProfileLinkProjection: async () => {
      throw new Error("private-provider-detail");
    },
    logger: {
      error: (message) => {
        logs.push(String(message));
      },
    },
  });
  assert.deepEqual(
    logs.map((value) => JSON.parse(value)),
    [
      {
        event: "profile_link_profile_game_projection_enqueue_failed",
        loginUid: "login-uid",
      },
    ],
  );
  assert.deepEqual(job, originalJob);
});

test("repeated profile-link catchup dispatch does not recreate completed work", async () => {
  let ownerReads = 0;
  const dependencies: Parameters<typeof dispatchProfileLinkCatchupForOwner>[2] =
    {
      catchupStore: {
        readForOwner: async () => {
          ownerReads++;
          return null;
        },
      },
      enqueueProfileLinkProjection: async () => {
        throw new Error("completed-work-must-not-be-enqueued");
      },
      logger: {
        error: () => {
          throw new Error("unexpected-enqueue-failure");
        },
      },
    };
  await dispatchProfileLinkCatchupForOwner(
    "login-uid",
    "current-profile",
    dependencies,
  );
  await dispatchProfileLinkCatchupForOwner(
    "login-uid",
    "current-profile",
    dependencies,
  );
  assert.equal(ownerReads, 2);
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
    d1: profileDb,
    logger: { error() {}, info() {} },
    now: () => 1_000,
    profileDb,
    prizeStore: {
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
      async transactStoredProfileEventPrizeWithEventLease() {
        throw new Error("busy-lease-must-not-write-prizes");
      },
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

function recoveryPrizeStore(input: {
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
  const transactPath: AuthRecoveryPrizeStore["transactPath"] = async (
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
  const client: AuthRecoveryPrizeStore = {
    async getPath(path: string) {
      readPaths.push(path);
      if (path === "profileEventPrizes/source-profile") {
        return { [eventId]: prizeAssignment("1092", 100) };
      }
      if (path === sourcePath) return input.liveAssignment;
      return values.get(path) ?? null;
    },
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
  prizeStore: ReturnType<typeof recoveryPrizeStore>["client"],
  profileGamesDb: D1Database = profileDb,
) {
  return createAuthRecoveryService(TELEGRAM_TEST_ENV, {
    d1: profileGamesDb,
    logger: { error() {}, info() {} },
    now: () => 1_000,
    profileDb,
    prizeStore,
    withdrawalStore: { get: async () => null },
  });
}

test("event prize recovery rereads the source entitlement under its lease", async () => {
  const profile = recoveryProfileDb();
  const prizeStore = recoveryPrizeStore({
    liveAssignment: {
      ...prizeAssignment("1111", 200),
      delivery: { channel: "wallet", revision: 2 },
    },
    targetAssignment: {
      ...prizeAssignment("1111", 200),
      profileId: "target-profile",
    },
  });
  const service = prizeRecoveryService(profile.db, prizeStore.client);

  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.deepEqual(prizeStore.value(prizeStore.targetPath), {
    eventId: "NN3eRzoZo80",
    profileId: "target-profile",
    place: 1,
    prizeId: "1111",
    assignedAtMs: 200,
    delivery: { channel: "wallet", revision: 2 },
  });
  assert.deepEqual(prizeStore.guardedPaths, [prizeStore.targetPath]);
  assert.deepEqual(prizeStore.readPaths.slice(0, 2), [
    "profileEventPrizes/source-profile",
    "profileEventPrizes/source-profile/NN3eRzoZo80",
  ]);
  assert.equal(profile.mutationBatches(), 1);
});

test("event prize recovery does not mutate or advance after lease loss", async () => {
  const profile = recoveryProfileDb();
  const prizeStore = recoveryPrizeStore({
    liveAssignment: prizeAssignment("1092", 100),
    takeOverOnRefresh: true,
  });
  const service = prizeRecoveryService(profile.db, prizeStore.client);

  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.equal(prizeStore.value(prizeStore.targetPath), null);
  assert.equal(
    prizeStore.transactionPaths.filter((path) => path === prizeStore.targetPath)
      .length,
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
  const prizeStore = recoveryPrizeStore({ liveAssignment: assignment });
  const service = prizeRecoveryService(profile.db, prizeStore.client);

  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.deepEqual(prizeStore.value(prizeStore.targetPath), {
    ...assignment,
    profileId: "target-profile",
  });
  assert.deepEqual(prizeStore.guardedPaths, [prizeStore.targetPath]);
  assert.equal(profile.mutationBatches(), 1);
});

test("event prize recovery rescans late assignments before finalizing", async () => {
  const profile = recoveryProfileDb({ source_phase: "finalize" });
  const prizeStore = recoveryPrizeStore({
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
  const service = prizeRecoveryService(
    profile.db,
    prizeStore.client,
    profileGamesDb,
  );

  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.deepEqual(prizeStore.value(prizeStore.targetPath), {
    eventId: "NN3eRzoZo80",
    profileId: "target-profile",
    place: 1,
    prizeId: "1092",
    assignedAtMs: 200,
  });
  assert.deepEqual(prizeStore.readPaths.slice(0, 2), [
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
  const prizeStore: AuthRecoveryPrizeStore = {
    transactStoredProfileEventPrizeWithEventLease(
      path,
      updater,
      _guard,
      signal,
    ) {
      return prizeStore.transactPath(path, updater, signal);
    },
    async getPath(path, query) {
      if (path === "profileEventPrizes/source-profile") {
        listQueries.push(query);
        return Object.fromEntries(eventIds.map((eventId) => [eventId, {}]));
      }
      sourceReads.push(path);
      return {};
    },
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
    prizeStore,
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
  const prizeStore: AuthRecoveryPrizeStore = {
    transactStoredProfileEventPrizeWithEventLease(
      path,
      updater,
      _guard,
      signal,
    ) {
      return prizeStore.transactPath(path, updater, signal);
    },
    async getPath(path) {
      if (path === "profileEventPrizes/source-profile") {
        return { [eventId]: prizeAssignment("1092", 100) };
      }
      return prizeAssignment("1092", 100);
    },
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
    d1: profile.db,
    logger: { error() {}, info() {} },
    now: () => 1_000,
    prizeOperationTimeoutMs: 10,
    profileDb: profile.db,
    prizeStore,
    withdrawalStore: { get: async () => null },
  });

  const startedAt = Date.now();
  assert.equal(await service.recoverProfile("target-profile"), false);
  assert.equal(targetSignal?.aborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(profile.mutationBatches(), 0);
});
