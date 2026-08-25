"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildEventProjectionOwnerPlan,
  projectEvent,
  reconcileLiveEventProjection,
  resolveProfilePaths,
} = require("../functions/eventProjector");
const {
  buildInviteProjectionOwnerPlan,
  buildResolvedProfile,
  onProfileDeleted,
  processProfileLinkCatchup,
  processWithConcurrency,
  readInviteExists,
  readExistingProjectionDocuments,
  recomputeInviteProjection,
  resolveProfileLinkCatchupState,
  withInviteProjectionLock,
} = require("../functions/profileGamesProjector");
const firebaseAdmin = require("../functions/firebaseAdmin");

const runWithoutProjectionLock = async (_inviteId, work) => work();

const runEventProjection = async ({
  afterData,
  beforeData = null,
  mergeTargets = {},
  options = {},
  profileIds = [],
  retiredProfileIds = [],
}) => {
  const originalFirestore = firebaseAdmin.firestore;
  const existingProfileIds = new Set(profileIds);
  const retiredIds = new Set(retiredProfileIds);
  const commits = [];
  const operations = [];
  const firestore = {
    batch: () => {
      const batchOperations = [];
      return {
        commit: async () => commits.push([...batchOperations]),
        delete: (ref) => {
          const operation = { path: ref.path, type: "delete" };
          batchOperations.push(operation);
          operations.push(operation);
        },
        set: (ref) => {
          const operation = { path: ref.path, type: "set" };
          batchOperations.push(operation);
          operations.push(operation);
        },
      };
    },
    collection: (collectionName) => ({
      doc: (profileId) => {
        if (collectionName === "profileMergeTargets") {
          const data = mergeTargets[profileId];
          return {
            get: async () => ({
              data: () => data,
              exists: data !== null && data !== undefined,
            }),
          };
        }
        assert.equal(collectionName, "users");
        return {
          collection: (subcollectionName) => {
            assert.equal(subcollectionName, "games");
            return {
              doc: (id) => ({ path: `users/${profileId}/games/${id}` }),
            };
          },
          get: async () => ({
            data: () =>
              retiredIds.has(profileId)
                ? { mergedIntoProfileId: "canonical-profile" }
                : {},
            exists:
              existingProfileIds.has(profileId) || retiredIds.has(profileId),
          }),
        };
      },
    }),
  };
  const firestoreFactory = () => firestore;
  firestoreFactory.Timestamp = originalFirestore.Timestamp;
  firebaseAdmin.firestore = firestoreFactory;
  try {
    await projectEvent("event-1", beforeData, afterData, options);
    return { commits, operations };
  } catch (error) {
    error.projectionOperations = operations;
    throw error;
  } finally {
    firebaseAdmin.firestore = originalFirestore;
  }
};

const runInviteProjection = async ({
  beforeCommit,
  cleanupProfileIds,
  eventTimestampMs,
  invite,
  inviteId,
  mergeTargets,
  profileLinks,
  profiles,
  projections,
  projectionUpdateTimes = {},
}) => {
  const originalDatabase = firebaseAdmin.database;
  const originalFirestore = firebaseAdmin.firestore;
  const deletes = [];
  const sets = [];
  const currentUpdateTimes = { ...projectionUpdateTimes };
  const valueSnapshot = (value) => ({
    exists: () => value !== null && value !== undefined,
    val: () => value ?? null,
  });
  const gameRef = (profileId) => {
    const ref = {
      path: `users/${profileId}/games/${inviteId}`,
      get: async () => {
        const data = projections[profileId];
        if (
          data !== null &&
          data !== undefined &&
          !currentUpdateTimes[profileId]
        ) {
          currentUpdateTimes[profileId] =
            originalFirestore.Timestamp.fromMillis(1);
        }
        return {
          data: () => data,
          exists: data !== null && data !== undefined,
          ref,
          updateTime: currentUpdateTimes[profileId],
        };
      },
    };
    return ref;
  };
  const firestore = {
    batch: () => {
      const conditionalUpdates = [];
      return {
        commit: async () => {
          beforeCommit?.({ currentUpdateTimes, projections });
          for (const update of conditionalUpdates) {
            const profileId = update.path.split("/")[1];
            if (
              update.precondition.lastUpdateTime !==
              currentUpdateTimes[profileId]
            ) {
              throw new Error("firestore-precondition-failed");
            }
          }
        },
        create: (ref, data) =>
          sets.push({ data, method: "create", path: ref.path }),
        delete: (ref) => deletes.push(ref.path),
        set: (ref, data, options) =>
          sets.push({ data, method: "set", options, path: ref.path }),
        update: (ref, data, precondition) => {
          const operation = {
            data,
            method: "update",
            path: ref.path,
            precondition,
          };
          conditionalUpdates.push(operation);
          sets.push(operation);
        },
      };
    },
    collection: (collectionName) => ({
      doc: (profileId) => {
        if (collectionName === "profileMergeTargets") {
          const data = mergeTargets[profileId];
          return {
            get: async () => ({
              data: () => data,
              exists: data !== null && data !== undefined,
            }),
          };
        }
        assert.equal(collectionName, "users");
        const data = profiles[profileId];
        return {
          collection: (subcollectionName) => {
            assert.equal(subcollectionName, "games");
            return { doc: () => gameRef(profileId) };
          },
          get: async () => ({
            data: () => data,
            exists: data !== null && data !== undefined,
          }),
        };
      },
      where: () => ({
        limit: () => ({
          get: async () => ({ docs: [], empty: true }),
        }),
      }),
    }),
  };
  const firestoreFactory = () => firestore;
  firestoreFactory.Timestamp = originalFirestore.Timestamp;
  firebaseAdmin.firestore = firestoreFactory;
  firebaseAdmin.database = () => ({
    ref: (path) => ({
      once: async () => {
        if (path === `invites/${inviteId}`) {
          return valueSnapshot(invite);
        }
        if (path === `automatch/${inviteId}`) {
          return valueSnapshot(null);
        }
        const profileMatch = path.match(/^players\/(.+)\/profile$/);
        if (profileMatch) {
          return valueSnapshot(profileLinks[profileMatch[1]]);
        }
        if (path.startsWith("players/")) {
          return valueSnapshot(null);
        }
        throw new Error(`unexpected-path:${path}`);
      },
    }),
  });
  try {
    const result = await recomputeInviteProjection(
      inviteId,
      "profile-link-catchup",
      {
        cleanupProfileIds,
        eventTimestampMs,
        preserveListSortAt: true,
      },
    );
    return { deletes, result, sets };
  } finally {
    firebaseAdmin.database = originalDatabase;
    firebaseAdmin.firestore = originalFirestore;
  }
};

test("event cleanup orders canonical writes ahead of raw merge paths", () => {
  assert.deepEqual(
    buildEventProjectionOwnerPlan({
      afterOwnerPaths: [["source", "middle", "target"]],
      beforeOwnerPaths: [["source", "middle", "target"]],
      rawAfterOwnerProfileIds: ["source"],
      rawBeforeOwnerProfileIds: ["source"],
    }),
    {
      afterOwnerProfileIds: ["target"],
      allOwnerProfileIds: ["target", "source", "middle"],
    },
  );
});

test("event projection writes every canonical owner before stale cleanup", async () => {
  const ownerProfileIds = Array.from(
    { length: 451 },
    (_, index) => `owner-${String(index).padStart(3, "0")}`,
  );
  const { commits, operations } = await runEventProjection({
    afterData: {
      participants: Object.fromEntries(
        ownerProfileIds.map((profileId) => [profileId, { profileId }]),
      ),
      status: "active",
    },
    beforeData: {
      participants: { stale: { profileId: "stale-owner" } },
    },
    profileIds: ownerProfileIds,
  });

  assert.deepEqual(
    operations.map(({ type }) => type),
    [...ownerProfileIds.map(() => "set"), "delete"],
  );
  assert.deepEqual(
    commits.map((commit) => commit.length),
    [450, 2],
  );
  assert.equal(operations.at(-1).path, "users/stale-owner/games/event_event-1");
});

test("event projection does not write when a canonical owner is missing", async () => {
  await assert.rejects(
    runEventProjection({
      afterData: {
        participants: { current: { profileId: "missing-owner" } },
      },
      beforeData: {
        participants: { stale: { profileId: "stale-owner" } },
      },
    }),
    (error) => {
      assert.match(error.message, /projector:event-owner-missing/);
      assert.deepEqual(error.projectionOperations, []);
      return true;
    },
  );
});

test("event projection does not write to a retired owner", async () => {
  await assert.rejects(
    runEventProjection({
      afterData: {
        participants: { current: { profileId: "retired-owner" } },
      },
      beforeData: {
        participants: { stale: { profileId: "stale-owner" } },
      },
      retiredProfileIds: ["retired-owner"],
    }),
    (error) => {
      assert.match(error.message, /projector:event-owner-retired/);
      assert.deepEqual(error.projectionOperations, []);
      return true;
    },
  );
});

test("event owner paths are deduplicated and concurrency bounded", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `profile-${index}`);
  const reads = new Map();
  let active = 0;
  let maxActive = 0;
  const firestore = {
    collection: () => ({
      doc: (profileId) => ({
        get: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          reads.set(profileId, (reads.get(profileId) || 0) + 1);
          await new Promise((resolve) => setImmediate(resolve));
          active -= 1;
          return { exists: false };
        },
      }),
    }),
  };
  const paths = await resolveProfilePaths(firestore, [...ids, ...ids]);
  assert.equal(paths.size, ids.length);
  assert.equal(maxActive, 10);
  assert.deepEqual(
    Array.from(reads.values()),
    ids.map(() => 1),
  );
});

test("invite cleanup follows the resolved merge-target path", () => {
  const hostProfile = buildResolvedProfile(["older-source", "target"]);
  const guestProfile = buildResolvedProfile([]);
  assert.deepEqual(buildInviteProjectionOwnerPlan(hostProfile, guestProfile), {
    cleanupProfileIds: ["older-source", "target"],
    ownerProfileIds: ["target"],
  });
});

test("event retries project live state while retaining stale owners for cleanup", async () => {
  const beforeData = {
    participants: { before: { profileId: "before-profile" } },
  };
  const afterData = {
    participants: { after: { profileId: "stale-after-profile" } },
  };
  const liveData = {
    participants: { live: { profileId: "live-profile" } },
  };
  const calls = [];
  await reconcileLiveEventProjection("event-1", beforeData, afterData, {
    readLiveEvent: async () => liveData,
    projectEvent: async (...args) => calls.push(args),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], beforeData);
  assert.equal(calls[0][2], liveData);
  assert.deepEqual(calls[0][3].cleanupOwnerProfileIds, [
    "before-profile",
    "stale-after-profile",
    "live-profile",
  ]);
});

test("event retries converge when the live event changes during projection", async () => {
  const staleData = {
    participants: { stale: { profileId: "stale-profile" } },
  };
  const intermediateData = {
    participants: { intermediate: { profileId: "intermediate-profile" } },
  };
  const projectedStates = [];
  const cleanupOwnerSets = [];
  const liveStates = [intermediateData, null, null];
  await reconcileLiveEventProjection("event-1", null, staleData, {
    readLiveEvent: async () => liveStates.shift() ?? null,
    projectEvent: async (_eventId, _beforeData, liveData, options) => {
      projectedStates.push(liveData);
      cleanupOwnerSets.push(options.cleanupOwnerProfileIds);
    },
  });
  assert.deepEqual(projectedStates, [intermediateData, null]);
  assert.deepEqual(cleanupOwnerSets[1], [
    "stale-profile",
    "intermediate-profile",
  ]);
});

test("profile-link retries use the live owner and retain event owners for cleanup", async () => {
  const state = await resolveProfileLinkCatchupState(
    {
      eventProfileId: "stale-after-profile",
      loginUid: "login-1",
      staleProfileId: "before-profile",
    },
    { readCurrentProfileLink: async () => "live-profile" },
  );
  assert.deepEqual(state, {
    cleanupProfileIds: [
      "before-profile",
      "stale-after-profile",
      "live-profile",
    ],
    profileId: "live-profile",
  });
  assert.equal(
    await resolveProfileLinkCatchupState(
      {
        eventProfileId: "stale-after-profile",
        loginUid: "login-1",
        staleProfileId: "before-profile",
      },
      { readCurrentProfileLink: async () => "" },
    ),
    null,
  );
});

test("Firebase projectors serialize each invite with the shared lock", async () => {
  let current = null;
  const lockRef = () => ({
    transaction: async (updater) => {
      const next = updater(current);
      if (next === undefined) {
        return { committed: false, snapshot: { val: () => current } };
      }
      current = next;
      return { committed: true, snapshot: { val: () => current } };
    },
  });
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const first = withInviteProjectionLock(
    "invite-1",
    async () => {
      firstStarted();
      await firstBlocked;
    },
    { createOwnerId: () => "owner-a", lockRef, now: () => 100 },
  );
  await started;
  await assert.rejects(
    () =>
      withInviteProjectionLock("invite-1", async () => undefined, {
        createOwnerId: () => "owner-b",
        lockRef,
        now: () => 200,
      }),
    /lock-busy/,
  );
  releaseFirst();
  await first;
  assert.equal(current, null);
  await withInviteProjectionLock("invite-1", async () => undefined, {
    createOwnerId: () => "owner-b",
    lockRef,
    now: () => 300,
  });
  assert.equal(current, null);
});

test("profile-link catchup converges and cleans an intermediate live owner", async () => {
  let liveProfileId = "initial-live-profile";
  const cleanupRounds = [];
  await processProfileLinkCatchup(
    {
      eventLabel: "test",
      loginUid: "login-1",
      profileId: "event-profile",
    },
    {
      readCurrentProfileLink: async () => liveProfileId,
      readMatches: async () => ({
        exists: () => true,
        val: () => ({ "match-1": {} }),
      }),
      recomputeInviteProjection: async (_inviteId, _reason, options) => {
        cleanupRounds.push(options.cleanupProfileIds);
        if (cleanupRounds.length === 1) {
          liveProfileId = "final-live-profile";
        }
      },
      resolveInviteIdFromMatchId: async () => "invite-1",
      withInviteProjectionLock: runWithoutProjectionLock,
    },
  );
  assert.deepEqual(cleanupRounds, [
    ["event-profile", "initial-live-profile"],
    ["event-profile", "initial-live-profile", "final-live-profile"],
  ]);
});

test("profile-link catchup ignores failures from a superseded owner", async () => {
  let liveProfileId = "initial-live-profile";
  let attempts = 0;
  await processProfileLinkCatchup(
    {
      eventLabel: "test",
      loginUid: "login-1",
      profileId: "event-profile",
    },
    {
      readCurrentProfileLink: async () => liveProfileId,
      readMatches: async () => ({
        exists: () => true,
        val: () => ({ "match-1": {} }),
      }),
      recomputeInviteProjection: async () => {
        attempts += 1;
        if (attempts === 1) {
          liveProfileId = "final-live-profile";
          throw new Error("superseded-owner-failure");
        }
      },
      resolveInviteIdFromMatchId: async () => "invite-1",
      withInviteProjectionLock: runWithoutProjectionLock,
    },
  );
  assert.equal(attempts, 2);
});

test("profile-link catchup retries blocked projections without stale cleanup", async () => {
  const originalFirestore = firebaseAdmin.firestore;
  let deletes = 0;
  const firestore = {
    batch: () => ({
      commit: async () => undefined,
      delete: () => {
        deletes += 1;
      },
    }),
    collection: () => ({
      doc: (profileId) => ({
        collection: () => ({ doc: () => ({ profileId }) }),
        get: async () => ({ data: () => null, exists: false }),
      }),
    }),
  };
  firebaseAdmin.firestore = () => firestore;
  try {
    await assert.rejects(
      processProfileLinkCatchup(
        {
          eventLabel: "test",
          loginUid: "login-1",
          profileId: "target-profile",
          staleProfileId: "stale-profile",
        },
        {
          readCurrentProfileLink: async () => "target-profile",
          readMatches: async () => ({
            exists: () => true,
            val: () => ({ "match-1": {} }),
          }),
          recomputeInviteProjection: async () => ({
            blockedReason: "unresolved-owner-profile",
            sourceCleanupSafe: false,
          }),
          resolveInviteIdFromMatchId: async () => "invite-1",
          withInviteProjectionLock: runWithoutProjectionLock,
        },
      ),
      /profile-link-catchup-incomplete/,
    );
    assert.equal(deletes, 0);
  } finally {
    firebaseAdmin.firestore = originalFirestore;
  }
});

const runProfileLinkStaleCleanup = async ({
  sourceExists,
  targetProfileId,
}) => {
  const deletes = [];
  const firestore = {
    batch: () => ({
      commit: async () => undefined,
      delete: (ref) => deletes.push(ref.path),
    }),
    collection: (collectionName) => ({
      doc: (profileId) => {
        if (collectionName === "profileMergeTargets") {
          const data =
            profileId === "stale-profile" && targetProfileId
              ? { targetProfileId }
              : null;
          return {
            get: async () => ({ data: () => data, exists: !!data }),
          };
        }
        assert.equal(collectionName, "users");
        return {
          collection: (subcollectionName) => {
            assert.equal(subcollectionName, "games");
            return {
              doc: (inviteId) => ({
                path: `users/${profileId}/games/${inviteId}`,
              }),
            };
          },
          get: async () => ({
            exists: profileId === "stale-profile" && sourceExists,
          }),
        };
      },
    }),
  };
  await processProfileLinkCatchup(
    {
      eventLabel: "test",
      loginUid: "login-1",
      profileId: "target-profile",
      staleProfileId: "stale-profile",
    },
    {
      firestore,
      readCurrentProfileLink: async () => "target-profile",
      readMatches: async () => ({
        exists: () => true,
        val: () => ({ "match-1": {} }),
      }),
      recomputeInviteProjection: async () => ({ sourceCleanupSafe: true }),
      resolveInviteIdFromMatchId: async () => "invite-1",
      withInviteProjectionLock: runWithoutProjectionLock,
    },
  );
  return deletes;
};

test("profile-link catchup cleans a deleted merge source", async () => {
  assert.deepEqual(
    await runProfileLinkStaleCleanup({
      sourceExists: false,
      targetProfileId: "target-profile",
    }),
    ["users/stale-profile/games/invite-1"],
  );
});

test("profile-link catchup retains projections until the merge source is deleted", async () => {
  assert.deepEqual(
    await runProfileLinkStaleCleanup({
      sourceExists: true,
      targetProfileId: "target-profile",
    }),
    [],
  );
  assert.deepEqual(
    await runProfileLinkStaleCleanup({
      sourceExists: false,
      targetProfileId: "different-profile",
    }),
    [],
  );
});

test("merge-source deletion leaves game cleanup to recovery", async () => {
  const originalFirestore = firebaseAdmin.firestore;
  let firestoreReads = 0;
  firebaseAdmin.firestore = () => {
    firestoreReads += 1;
    throw new Error("unexpected-firestore-read");
  };
  try {
    await onProfileDeleted.run({
      data: {
        data: () => ({ mergedIntoProfileId: "target-profile" }),
      },
      params: { profileId: "source-profile" },
    });
    assert.equal(firestoreReads, 0);
  } finally {
    firebaseAdmin.firestore = originalFirestore;
  }
});

test("projection cleanup reads settle together and fail before returning data", async () => {
  let siblingSettled = false;
  await assert.rejects(
    readExistingProjectionDocuments({
      inviteId: "invite-1",
      profileIds: ["source", "target"],
      readDocument: async (profileId) => {
        if (profileId === "source") {
          throw new Error("source-read-failed");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        siblingSettled = true;
        return { exists: true };
      },
      reason: "test",
      logger: { error: () => undefined },
    }),
    /source-read-failed/,
  );
  assert.equal(siblingSettled, true);
});

test("projection cleanup retries transient reads before returning", async () => {
  let sourceReads = 0;
  const documents = await readExistingProjectionDocuments({
    inviteId: "invite-1",
    profileIds: ["source", "target"],
    readDocument: async (profileId) => {
      if (profileId === "source" && sourceReads++ === 0) {
        throw new Error("transient-read");
      }
      return { exists: true, ref: profileId };
    },
    reason: "test",
    wait: async () => undefined,
  });
  assert.equal(sourceReads, 2);
  assert.deepEqual(
    documents.map(({ profileId }) => profileId),
    ["source", "target"],
  );
});

test("profile-link catchup uses the freshest matching source projection", async () => {
  const inviteId = "merge-fallback-invite";
  const { deletes, result, sets } = await runInviteProjection({
    eventTimestampMs: 3000,
    invite: {
      guestId: "merge-fallback-guest-login",
      hostId: "merge-fallback-host-login",
    },
    inviteId,
    mergeTargets: {
      "merge-fallback-source-old": {
        targetProfileId: "merge-fallback-source-new",
      },
      "merge-fallback-source-new": {
        targetProfileId: "merge-fallback-target",
      },
    },
    profileLinks: {
      "merge-fallback-guest-login": "merge-fallback-guest",
      "merge-fallback-host-login": "merge-fallback-source-old",
    },
    profiles: {
      "merge-fallback-guest": {
        custom: { emoji: 9 },
        username: "Fresh guest",
      },
      "merge-fallback-target": {
        custom: { emoji: 11 },
        username: "Current host",
      },
    },
    projections: {
      "merge-fallback-source-old": {
        createdAt: 100,
        listSortAt: 1000,
        opponentEmoji: 4,
        opponentName: "Old guest",
        ownerLoginId: "merge-fallback-host-login",
        ownerRole: "host",
        updatedAt: 1000,
      },
      "merge-fallback-source-new": {
        createdAt: 200,
        listSortAt: 1500,
        opponentEmojiId: 9,
        opponentDisplayName: "Fresh guest",
        ownerLoginId: "merge-fallback-host-login",
        ownerRole: "host",
        updatedAt: 2000,
      },
    },
  });
  const targetWrite = sets.find(
    ({ path }) => path === `users/merge-fallback-target/games/${inviteId}`,
  );
  assert.ok(targetWrite);
  assert.equal(targetWrite.data.opponentEmoji, 9);
  assert.equal(targetWrite.data.opponentName, "Fresh guest");
  assert.equal(targetWrite.data.listSortAt.toMillis(), 1500);
  assert.equal(targetWrite.data.createdAt, 200);
  assert.equal(targetWrite.method, "create");
  assert.deepEqual(deletes.sort(), [
    `users/merge-fallback-source-new/games/${inviteId}`,
    `users/merge-fallback-source-old/games/${inviteId}`,
  ]);
  assert.equal(result.writes, 2);
  assert.equal(result.deletes, 2);
  assert.equal(result.sourceCleanupSafe, true);
});

test("profile-link catchup preserves an existing canonical list timestamp", async () => {
  const inviteId = "merge-existing-canonical-invite";
  const { sets } = await runInviteProjection({
    eventTimestampMs: 5000,
    invite: { hostId: "merge-existing-canonical-login" },
    inviteId,
    mergeTargets: {
      "merge-existing-canonical-source": {
        targetProfileId: "merge-existing-canonical-target",
      },
    },
    profileLinks: {
      "merge-existing-canonical-login": "merge-existing-canonical-source",
    },
    profiles: {
      "merge-existing-canonical-target": { username: "Host" },
    },
    projections: {
      "merge-existing-canonical-source": {
        listSortAt: 1500,
        ownerLoginId: "merge-existing-canonical-login",
        ownerRole: "host",
        updatedAt: 2000,
      },
      "merge-existing-canonical-target": {
        lastEventFingerprint: "stale",
        listSortAt: 1000,
        ownerLoginId: "merge-existing-canonical-login",
        ownerRole: "host",
        updatedAt: 1000,
      },
    },
  });
  const targetWrite = sets.find(
    ({ path }) =>
      path === `users/merge-existing-canonical-target/games/${inviteId}`,
  );
  assert.equal(targetWrite.data.listSortAt.toMillis(), 1000);
  assert.equal(targetWrite.method, "update");
  assert.ok(targetWrite.precondition.lastUpdateTime);
});

test("profile-link catchup cannot overwrite a concurrent live sort update", async () => {
  const inviteId = "merge-concurrent-sort-invite";
  const firstVersion = firebaseAdmin.firestore.Timestamp.fromMillis(1);
  const liveVersion = firebaseAdmin.firestore.Timestamp.fromMillis(2);
  const projections = {
    "merge-concurrent-sort-target": {
      lastEventFingerprint: "stale",
      listSortAt: 1000,
      ownerLoginId: "merge-concurrent-sort-login",
      ownerRole: "host",
    },
  };

  await assert.rejects(
    runInviteProjection({
      beforeCommit: ({ currentUpdateTimes }) => {
        projections["merge-concurrent-sort-target"].listSortAt = 9000;
        currentUpdateTimes["merge-concurrent-sort-target"] = liveVersion;
      },
      eventTimestampMs: 5000,
      invite: { hostId: "merge-concurrent-sort-login" },
      inviteId,
      mergeTargets: {},
      profileLinks: {
        "merge-concurrent-sort-login": "merge-concurrent-sort-target",
      },
      profiles: {
        "merge-concurrent-sort-target": { username: "Host" },
      },
      projections,
      projectionUpdateTimes: {
        "merge-concurrent-sort-target": firstVersion,
      },
    }),
    /firestore-precondition-failed/,
  );
  assert.equal(projections["merge-concurrent-sort-target"].listSortAt, 9000);
});

test("missing canonical profile keeps the source projection", async () => {
  const inviteId = "merge-missing-target-invite";
  const { deletes, result, sets } = await runInviteProjection({
    cleanupProfileIds: ["merge-missing-target-source"],
    eventTimestampMs: 3000,
    invite: { hostId: "merge-missing-target-login" },
    inviteId,
    mergeTargets: {
      "merge-missing-target-source": {
        targetProfileId: "merge-missing-target",
      },
    },
    profileLinks: {
      "merge-missing-target-login": "merge-missing-target-source",
    },
    profiles: {},
    projections: {
      "merge-missing-target-source": {
        ownerLoginId: "merge-missing-target-login",
        ownerRole: "host",
      },
    },
  });
  assert.deepEqual(deletes, []);
  assert.deepEqual(sets, []);
  assert.equal(result.sourceCleanupSafe, false);
  assert.equal(result.blockedReason, "unresolved-owner-profile");
});

test("retired profile owners cannot receive invite projections", async () => {
  const inviteId = "retired-owner-invite";
  const { deletes, result, sets } = await runInviteProjection({
    cleanupProfileIds: ["retired-owner"],
    eventTimestampMs: 3000,
    invite: { hostId: "retired-login" },
    inviteId,
    mergeTargets: {},
    profileLinks: { "retired-login": "retired-owner" },
    profiles: {
      "retired-owner": { mergedIntoProfileId: "canonical-owner" },
    },
    projections: {
      "retired-owner": {
        ownerLoginId: "retired-login",
        ownerRole: "host",
      },
    },
  });

  assert.deepEqual(deletes, []);
  assert.deepEqual(sets, []);
  assert.equal(result.sourceCleanupSafe, false);
  assert.equal(result.blockedReason, "unresolved-owner-profile");
});

for (const [status, inviteState] of [
  ["active", {}],
  ["ended", { hostRematches: "x" }],
]) {
  test(`${status} profile-link catchup keeps its source when canonical metadata is unresolved`, async () => {
    const inviteId = `merge-blocked-${status}-invite`;
    const { deletes, result, sets } = await runInviteProjection({
      eventTimestampMs: 3000,
      invite: {
        guestId: `merge-blocked-${status}-guest-login`,
        hostId: `merge-blocked-${status}-host-login`,
        ...inviteState,
      },
      inviteId,
      mergeTargets: {
        [`merge-blocked-${status}-source`]: {
          targetProfileId: `merge-blocked-${status}-target`,
        },
      },
      profileLinks: {
        [`merge-blocked-${status}-guest-login`]: `merge-blocked-${status}-guest`,
        [`merge-blocked-${status}-host-login`]: `merge-blocked-${status}-source`,
      },
      profiles: {
        [`merge-blocked-${status}-guest`]: {
          username: "Guest",
        },
        [`merge-blocked-${status}-target`]: {
          custom: { emoji: 11 },
          username: "Current host",
        },
      },
      projections: {
        [`merge-blocked-${status}-source`]: {
          opponentName: "Guest",
          ownerLoginId: `merge-blocked-${status}-host-login`,
          ownerRole: "host",
          updatedAt: 2000,
        },
      },
    });
    assert.deepEqual(deletes, []);
    assert.equal(
      sets.some(
        ({ path }) =>
          path === `users/merge-blocked-${status}-target/games/${inviteId}`,
      ),
      false,
    );
    assert.equal(result.deletes, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.sourceCleanupSafe, false);
    assert.equal(result.blockedReason, "unresolved-opponent-emoji");
  });
}

test("a repaired opponent profile unblocks a warm retry", async () => {
  const input = {
    eventTimestampMs: 3000,
    invite: {
      guestId: "merge-retry-guest-login",
      hostId: "merge-retry-host-login",
    },
    inviteId: "merge-retry-invite",
    mergeTargets: {
      "merge-retry-source": { targetProfileId: "merge-retry-target" },
    },
    profileLinks: {
      "merge-retry-guest-login": "merge-retry-guest",
      "merge-retry-host-login": "merge-retry-source",
    },
    projections: {
      "merge-retry-source": {
        ownerLoginId: "merge-retry-host-login",
        ownerRole: "host",
      },
    },
  };
  const blocked = await runInviteProjection({
    ...input,
    profiles: {
      "merge-retry-guest": { username: "Guest" },
      "merge-retry-target": { custom: { emoji: 11 }, username: "Host" },
    },
  });
  const repaired = await runInviteProjection({
    ...input,
    profiles: {
      "merge-retry-guest": {
        custom: { emoji: 9 },
        username: "Guest",
      },
      "merge-retry-target": { custom: { emoji: 11 }, username: "Host" },
    },
  });

  assert.equal(blocked.result.sourceCleanupSafe, false);
  assert.equal(repaired.result.sourceCleanupSafe, true);
});

test("projecting invite keeps its source when no owner can resolve", async () => {
  const inviteId = "merge-blocked-owner-invite";
  const { deletes, result, sets } = await runInviteProjection({
    cleanupProfileIds: ["merge-blocked-owner-source"],
    eventTimestampMs: 3000,
    invite: { hostId: "merge-blocked-owner-login" },
    inviteId,
    mergeTargets: {},
    profileLinks: {},
    profiles: {},
    projections: {
      "merge-blocked-owner-source": { ownerRole: "host" },
    },
  });
  assert.deepEqual(deletes, []);
  assert.deepEqual(sets, []);
  assert.equal(result.sourceCleanupSafe, false);
  assert.equal(result.blockedReason, "unresolved-owner-profile");
});

test("deleted invite cleanup is safe without resolved owners", async () => {
  const inviteId = "merge-deleted-owner-invite";
  const { deletes, result, sets } = await runInviteProjection({
    cleanupProfileIds: ["merge-deleted-owner-source"],
    eventTimestampMs: 3000,
    invite: null,
    inviteId,
    mergeTargets: {},
    profileLinks: {},
    profiles: {},
    projections: {
      "merge-deleted-owner-source": { ownerRole: "host" },
    },
  });
  assert.deepEqual(deletes, [
    `users/merge-deleted-owner-source/games/${inviteId}`,
  ]);
  assert.deepEqual(sets, []);
  assert.equal(result.sourceCleanupSafe, true);
});

test("invite existence reads propagate after bounded retries", async () => {
  let reads = 0;
  await assert.rejects(
    readInviteExists("invite-1", null, {
      readInvite: async () => {
        reads += 1;
        throw new Error("invite-read-failed");
      },
    }),
    /invite-read-failed/,
  );
  assert.equal(reads, 2);
});

test("concurrency pools await active siblings before rethrowing", async () => {
  let siblingSettled = false;
  await assert.rejects(
    processWithConcurrency(["fail", "slow", "unstarted"], 2, async (item) => {
      if (item === "fail") {
        throw new Error("worker-failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      siblingSettled = true;
    }),
    /worker-failed/,
  );
  assert.equal(siblingSettled, true);
});
