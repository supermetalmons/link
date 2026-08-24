"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseArgs,
  reconcileProfileMergeProjectionPage,
} = require("../admin/reconcileProfileMergeProjections");
const {
  buildEventProjectionOwnerPlan,
  reconcileLiveEventProjection,
  resolveProfilePaths,
} = require("../functions/eventProjector");
const {
  buildInviteProjectionOwnerPlan,
  buildResolvedProfile,
  classifyProfileGameProjection,
  processProfileLinkCatchup,
  processWithConcurrency,
  readInviteExists,
  readExistingProjectionDocuments,
  reconcileProfileMergeProjections,
  recomputeInviteProjection,
  resolveProfileLinkCatchupState,
  syncAutomatchInviteMarkerFromQueue,
} = require("../functions/profileGamesProjector");
const firebaseAdmin = require("../functions/firebaseAdmin");

const snapshot = (documents) => ({
  docs: documents,
  empty: documents.length === 0,
  size: documents.length,
});

const gameDocument = (id, data) => ({ id, data: () => data });

const runInviteProjection = async ({
  cleanupProfileIds,
  dryRun = false,
  eventTimestampMs,
  invite,
  inviteId,
  mergeTargets,
  profileLinks,
  profiles,
  projections,
}) => {
  const originalDatabase = firebaseAdmin.database;
  const originalFirestore = firebaseAdmin.firestore;
  const deletes = [];
  const sets = [];
  const valueSnapshot = (value) => ({
    exists: () => value !== null && value !== undefined,
    val: () => value ?? null,
  });
  const gameRef = (profileId) => {
    const ref = {
      path: `users/${profileId}/games/${inviteId}`,
      get: async () => {
        const data = projections[profileId];
        return {
          data: () => data,
          exists: data !== null && data !== undefined,
          ref,
        };
      },
    };
    return ref;
  };
  const firestore = {
    batch: () => ({
      commit: async () => undefined,
      delete: (ref) => deletes.push(ref.path),
      set: (ref, data, options) => sets.push({ data, options, path: ref.path }),
    }),
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
      "profile-merge-reconciliation",
      {
        cleanupProfileIds,
        dryRun,
        eventTimestampMs,
        preserveNewerListSortAt: true,
      },
    );
    return { deletes, result, sets };
  } finally {
    firebaseAdmin.database = originalDatabase;
    firebaseAdmin.firestore = originalFirestore;
  }
};

test("event cleanup keeps raw merge paths ahead of canonical writes", () => {
  assert.deepEqual(
    buildEventProjectionOwnerPlan({
      afterOwnerPaths: [["source", "middle", "target"]],
      beforeOwnerPaths: [["source", "middle", "target"]],
      rawAfterOwnerProfileIds: ["source"],
      rawBeforeOwnerProfileIds: ["source"],
    }),
    {
      afterOwnerProfileIds: ["target"],
      allOwnerProfileIds: ["source", "middle", "target"],
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

test("invite cleanup includes an active pending merge source", () => {
  const hostProfile = buildResolvedProfile(
    ["older-source", "target"],
    ["active-source", "target"],
  );
  const guestProfile = buildResolvedProfile([], []);
  assert.deepEqual(buildInviteProjectionOwnerPlan(hostProfile, guestProfile), {
    cleanupProfileIds: ["active-source", "older-source", "target"],
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
  await reconcileLiveEventProjection(
    "event-1",
    beforeData,
    afterData,
    {},
    {
      readLiveEvent: async () => liveData,
      projectEvent: async (...args) => calls.push(args),
    },
  );
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
  await reconcileLiveEventProjection(
    "event-1",
    null,
    staleData,
    {},
    {
      readLiveEvent: async () => liveStates.shift() ?? null,
      projectEvent: async (_eventId, _beforeData, liveData, options) => {
        projectedStates.push(liveData);
        cleanupOwnerSets.push(options.cleanupOwnerProfileIds);
      },
    },
  );
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
        get: async () => ({
          data: () => ({
            mergedAtMs: Date.now(),
            mergedSourceProfileId: "stale-profile",
          }),
          exists: profileId === "target-profile",
        }),
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
        },
      ),
      /profile-link-catchup-incomplete/,
    );
    assert.equal(deletes, 0);
  } finally {
    firebaseAdmin.firestore = originalFirestore;
  }
});

const createProjectionFirestore = ({ games, targets }) => {
  const queryLimits = [];
  const buildGamesQuery = (
    profileId,
    { after = "", direction = "asc", end = null, queryLimit = Infinity } = {},
  ) => ({
    get: async () => {
      const documents = (games[profileId] || [])
        .filter((doc) => doc.id > after && (end === null || doc.id <= end))
        .sort((left, right) => left.id.localeCompare(right.id));
      if (direction === "desc") {
        documents.reverse();
      }
      return snapshot(documents.slice(0, queryLimit));
    },
    endAt(cursor) {
      return buildGamesQuery(profileId, {
        after,
        direction,
        end: cursor,
        queryLimit,
      });
    },
    limit(limit) {
      queryLimits.push(limit);
      return buildGamesQuery(profileId, {
        after,
        direction,
        end,
        queryLimit: limit,
      });
    },
    orderBy(_field, nextDirection = "asc") {
      return buildGamesQuery(profileId, {
        after,
        direction: nextDirection,
        end,
        queryLimit,
      });
    },
    startAfter(cursor) {
      return buildGamesQuery(profileId, {
        after: cursor,
        direction,
        end,
        queryLimit,
      });
    },
  });
  return {
    queryLimits,
    collection(collectionName) {
      assert.ok(
        collectionName === "users" || collectionName === "profileMergeTargets",
      );
      return {
        doc(profileId) {
          if (collectionName === "profileMergeTargets") {
            const data = targets[profileId] || null;
            return {
              get: async () => ({ data: () => data, exists: !!data }),
            };
          }
          return {
            collection(subcollectionName) {
              assert.equal(subcollectionName, "games");
              return buildGamesQuery(profileId);
            },
          };
        },
      };
    },
  };
};

const safeRecomputeInviteProjection = async () => ({
  sourceCleanupSafe: true,
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

test("canonical rebuild uses the freshest matching source projection", async () => {
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
  assert.deepEqual(deletes.sort(), [
    `users/merge-fallback-source-new/games/${inviteId}`,
    `users/merge-fallback-source-old/games/${inviteId}`,
  ]);
  assert.equal(result.writes, 2);
  assert.equal(result.deletes, 2);
  assert.equal(result.sourceCleanupSafe, true);
});

for (const [status, inviteState] of [
  ["active", {}],
  ["ended", { hostRematches: "x" }],
]) {
  test(`${status} rebuild keeps its source when canonical metadata is unresolved`, async () => {
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

test("automatch marker retries converge after a concurrent queue change", async () => {
  const originalDatabase = firebaseAdmin.database;
  const updates = [];
  const inviteData = {
    automatchStateHint: "canceled",
    automatchCanceledAt: 1,
  };
  let queueExists = true;
  firebaseAdmin.database = () => ({
    ref(path) {
      if (path === "invites/invite-1") {
        return {
          once: async () => ({
            exists: () => true,
            val: () => ({ ...inviteData }),
          }),
          update: async (value) => {
            Object.assign(inviteData, value);
            updates.push(value);
            if (updates.length === 1) {
              queueExists = false;
            }
          },
        };
      }
      if (path === "automatch/invite-1") {
        return {
          once: async () => ({ exists: () => queueExists }),
        };
      }
      throw new Error(`unexpected-path:${path}`);
    },
  });
  try {
    const result = await syncAutomatchInviteMarkerFromQueue("invite-1");
    assert.equal(result.automatchStateHint, "canceled");
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0], {
      automatchStateHint: "pending",
      automatchCanceledAt: null,
    });
    assert.equal(updates[1].automatchStateHint, "canceled");
    assert.equal(typeof updates[1].automatchCanceledAt, "number");
  } finally {
    firebaseAdmin.database = originalDatabase;
  }
});

test("classifies current and legacy profile game projection documents", () => {
  assert.deepEqual(
    classifyProfileGameProjection("event_event-1", { entityType: "event" }),
    { entityType: "event", id: "event-1" },
  );
  assert.deepEqual(classifyProfileGameProjection("invite-1", {}), {
    entityType: "game",
    id: "invite-1",
  });
  assert.equal(classifyProfileGameProjection("event_", {}), null);
});

test("reconciles canonical projections before historical sources", async () => {
  const firestore = createProjectionFirestore({
    games: {
      source: [
        gameDocument("invite-1", { entityType: "game" }),
        gameDocument("event_event-1", { entityType: "event" }),
      ],
      target: [
        gameDocument("invite-1", { entityType: "game" }),
        gameDocument("invite-2", { entityType: "game" }),
      ],
    },
    targets: { source: { targetProfileId: "target" } },
  });
  const calls = [];
  const result = await reconcileProfileMergeProjections(
    {
      sourceProfileId: "source",
      targetProfileId: "target",
    },
    {
      database: {
        ref: () => ({
          once: async () => ({ exists: () => false, val: () => null }),
        }),
      },
      firestore,
      projectEvent: async (eventId, before, after, options) => {
        calls.push({ eventId, options, type: "event" });
      },
      recomputeInviteProjection: async (inviteId, reason, options) => {
        calls.push({ inviteId, options, reason, type: "game" });
      },
    },
  );
  assert.deepEqual(result, {
    complete: true,
    blockedProjections: [],
    dryRun: false,
    pagesScanned: 2,
    profileIds: ["source", "target"],
    projectionCount: 4,
    scannedGameDocuments: 4,
  });
  assert.deepEqual(
    calls.map((call) => `${call.type}:${call.eventId || call.inviteId}`),
    ["game:invite-1", "game:invite-2", "game:invite-1", "event:event-1"],
  );
  calls.forEach((call) => {
    assert.deepEqual(call.options.cleanupProfileIds, ["source", "target"]);
  });
});

test("dry-run and execute report the same blockers and finish safe siblings", async () => {
  const firestore = createProjectionFirestore({
    games: {
      target: [
        gameDocument("invite-blocked", {}),
        gameDocument("invite-safe", {}),
      ],
    },
    targets: { source: { targetProfileId: "target" } },
  });
  const modes = [];
  const recomputeInviteProjection = async (inviteId, _reason, options) => {
    modes.push({ dryRun: options.dryRun, inviteId });
    return inviteId === "invite-blocked"
      ? {
          blockedReason: "unresolved-owner-profile",
          sourceCleanupSafe: false,
        }
      : { sourceCleanupSafe: true };
  };
  const dryScannedProfileIds = new Set();
  const executeScannedProfileIds = new Set();
  const dryResult = await reconcileProfileMergeProjections(
    {
      dryRun: true,
      sourceProfileId: "source",
      targetProfileId: "target",
    },
    {
      firestore,
      recomputeInviteProjection,
      scannedProfileIds: dryScannedProfileIds,
    },
  );
  const executeResult = await reconcileProfileMergeProjections(
    {
      dryRun: false,
      sourceProfileId: "source",
      targetProfileId: "target",
    },
    {
      firestore,
      recomputeInviteProjection,
      scannedProfileIds: executeScannedProfileIds,
    },
  );
  assert.equal(dryResult.complete, false);
  assert.deepEqual(dryResult.blockedProjections, [
    {
      entityType: "game",
      id: "invite-blocked",
      reason: "unresolved-owner-profile",
    },
  ]);
  assert.deepEqual(
    executeResult.blockedProjections,
    dryResult.blockedProjections,
  );
  assert.deepEqual(Array.from(dryScannedProfileIds), ["source"]);
  assert.deepEqual(Array.from(executeScannedProfileIds), ["source"]);
  assert.deepEqual(modes, [
    { dryRun: true, inviteId: "invite-blocked" },
    { dryRun: true, inviteId: "invite-safe" },
    { dryRun: false, inviteId: "invite-blocked" },
    { dryRun: false, inviteId: "invite-safe" },
  ]);
});

test("dry-run reads and plans authoritative event state without writes", async () => {
  const firestore = createProjectionFirestore({
    games: {
      target: [gameDocument("event_event-1", { entityType: "event" })],
    },
    targets: { source: { targetProfileId: "target" } },
  });
  let reads = 0;
  let plans = 0;
  const result = await reconcileProfileMergeProjections(
    {
      dryRun: true,
      sourceProfileId: "source",
      targetProfileId: "target",
    },
    {
      database: {
        ref: () => ({
          once: async () => {
            reads += 1;
            return { exists: () => false, val: () => null };
          },
        }),
      },
      firestore,
      projectEvent: async (_eventId, _before, _after, options) => {
        plans += 1;
        assert.equal(options.dryRun, true);
      },
    },
  );
  assert.equal(result.complete, true);
  assert.equal(reads, 2);
  assert.equal(plans, 1);
});

test("event backfill converges on a concurrent live change", async () => {
  const firestore = createProjectionFirestore({
    games: {
      target: [
        gameDocument("event_event-1", {
          entityType: "event",
          eventId: "event-1",
        }),
      ],
    },
    targets: { source: { targetProfileId: "target" } },
  });
  const firstLiveData = {
    participants: { first: { profileId: "first-profile" } },
  };
  const finalLiveData = {
    participants: { final: { profileId: "final-profile" } },
  };
  const liveStates = [firstLiveData, finalLiveData, finalLiveData];
  const calls = [];
  await reconcileProfileMergeProjections(
    {
      sourceProfileId: "source",
      targetProfileId: "target",
    },
    {
      database: {
        ref: () => ({
          once: async () => {
            const value = liveStates.shift() ?? finalLiveData;
            return { exists: () => true, val: () => value };
          },
        }),
      },
      firestore,
      projectEvent: async (_eventId, _before, after, options) => {
        calls.push({ after, options });
      },
    },
  );
  assert.deepEqual(
    calls.map((call) => call.after),
    [firstLiveData, finalLiveData],
  );
  assert.deepEqual(calls[1].options.cleanupOwnerProfileIds, [
    "first-profile",
    "final-profile",
  ]);
  calls.forEach((call) => {
    assert.deepEqual(call.options.cleanupProfileIds, ["source", "target"]);
  });
});

test("paginates histories beyond the former total cap with bounded reads", async () => {
  const games = Array.from({ length: 10005 }, (_, index) =>
    gameDocument(`invite-${String(index).padStart(5, "0")}`, {}),
  );
  const firestore = createProjectionFirestore({
    games: { source: games },
    targets: { source: { targetProfileId: "target" } },
  });
  const result = await reconcileProfileMergeProjections(
    {
      dryRun: true,
      sourceProfileId: "source",
      targetProfileId: "target",
    },
    { firestore, recomputeInviteProjection: safeRecomputeInviteProjection },
  );
  assert.equal(result.scannedGameDocuments, 10005);
  assert.equal(result.projectionCount, 10005);
  assert.equal(result.pagesScanned, 51);
  assert.ok(
    firestore.queryLimits.every((limit) => limit === 1 || limit === 200),
  );
});

test("reuses completed profile scans across merge candidates", async () => {
  const firestore = createProjectionFirestore({
    games: {
      "source-a": [gameDocument("invite-a", {})],
      "source-b": [gameDocument("invite-b", {})],
      target: [gameDocument("invite-target", {})],
    },
    targets: {
      "source-a": { targetProfileId: "target" },
      "source-b": { targetProfileId: "target" },
    },
  });
  const scannedProfileIds = new Set();
  const first = await reconcileProfileMergeProjections(
    {
      dryRun: true,
      sourceProfileId: "source-a",
      targetProfileId: "target",
    },
    {
      firestore,
      recomputeInviteProjection: safeRecomputeInviteProjection,
      scannedProfileIds,
    },
  );
  const second = await reconcileProfileMergeProjections(
    {
      dryRun: true,
      sourceProfileId: "source-b",
      targetProfileId: "target",
    },
    {
      firestore,
      recomputeInviteProjection: safeRecomputeInviteProjection,
      scannedProfileIds,
    },
  );
  assert.equal(first.scannedGameDocuments, 2);
  assert.equal(second.scannedGameDocuments, 1);
  assert.deepEqual(Array.from(scannedProfileIds).sort(), [
    "source-a",
    "source-b",
    "target",
  ]);
});

test("blocked profile scans remain available to a repairing merge sibling", async () => {
  const firestore = createProjectionFirestore({
    games: {
      "source-a": [gameDocument("invite-shared", {})],
      "source-b": [gameDocument("invite-shared", {})],
      target: [gameDocument("invite-shared", {})],
    },
    targets: {
      "source-a": { targetProfileId: "target" },
      "source-b": { targetProfileId: "target" },
    },
  });
  const scannedProfileIds = new Set();
  const recomputeInviteProjection = async (_inviteId, _reason, options) =>
    options.cleanupProfileIds.includes("source-a")
      ? {
          blockedReason: "unresolved-opponent-emoji",
          sourceCleanupSafe: false,
        }
      : { sourceCleanupSafe: true };
  const blocked = await reconcileProfileMergeProjections(
    {
      dryRun: true,
      sourceProfileId: "source-a",
      targetProfileId: "target",
    },
    { firestore, recomputeInviteProjection, scannedProfileIds },
  );
  const repaired = await reconcileProfileMergeProjections(
    {
      dryRun: true,
      sourceProfileId: "source-b",
      targetProfileId: "target",
    },
    { firestore, recomputeInviteProjection, scannedProfileIds },
  );
  assert.equal(blocked.complete, false);
  assert.equal(repaired.complete, true);
  assert.equal(repaired.scannedGameDocuments, 2);
  assert.deepEqual(Array.from(scannedProfileIds).sort(), [
    "source-b",
    "target",
  ]);
});

test("reuses every completed collection in a merge chain", async () => {
  const firestore = createProjectionFirestore({
    games: {
      source: [gameDocument("invite-source", {})],
      middle: [gameDocument("invite-middle", {})],
      target: [gameDocument("invite-target", {})],
    },
    targets: {
      source: { targetProfileId: "middle" },
      middle: { targetProfileId: "target" },
    },
  });
  const scannedProfileIds = new Set();
  const sourceResult = await reconcileProfileMergeProjections(
    {
      dryRun: true,
      sourceProfileId: "source",
      targetProfileId: "middle",
    },
    {
      firestore,
      recomputeInviteProjection: safeRecomputeInviteProjection,
      scannedProfileIds,
    },
  );
  const middleResult = await reconcileProfileMergeProjections(
    {
      dryRun: true,
      sourceProfileId: "middle",
      targetProfileId: "target",
    },
    {
      firestore,
      recomputeInviteProjection: safeRecomputeInviteProjection,
      scannedProfileIds,
    },
  );
  assert.equal(sourceResult.scannedGameDocuments, 3);
  assert.equal(middleResult.scannedGameDocuments, 0);
});

test("parses bounded merge reconciliation command options", () => {
  assert.deepEqual(
    parseArgs([
      "--project",
      "mons-link",
      "--after",
      "source-a",
      "--limit",
      "10",
      "--execute",
    ]),
    {
      adminArgs: ["--project", "mons-link"],
      after: "source-a",
      dryRun: false,
      limit: 10,
    },
  );
  assert.throws(() => parseArgs(["--limit", "101"]), /Usage:/);
});

test("returns an explicit cursor for the next bounded merge page", async () => {
  const candidates = ["source-a", "source-b", "source-c"].map((id) => ({
    id,
    data: () => ({ targetProfileId: "target" }),
  }));
  const query = {
    get: async () => snapshot(candidates),
    limit() {
      return this;
    },
    orderBy() {
      return this;
    },
    startAfter() {
      return this;
    },
  };
  const scannedSets = [];
  const result = await reconcileProfileMergeProjectionPage(
    {
      after: "",
      dryRun: true,
      limit: 2,
    },
    {
      firestore: { collection: () => query },
      reconcileProfileMergeProjections: async (_request, dependencies) => {
        scannedSets.push(dependencies.scannedProfileIds);
        return { projectionCount: 0 };
      },
    },
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.blockedProjections, []);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, "source-b");
  assert.equal(result.results.length, 2);
  assert.equal(scannedSets.length, 2);
  assert.equal(scannedSets[0], scannedSets[1]);
});

const createMergeCandidateFirestore = (ids) => ({
  collection: () => {
    let after = "";
    let queryLimit = Infinity;
    return {
      get: async () =>
        snapshot(
          ids
            .filter((id) => id > after)
            .slice(0, queryLimit)
            .map((id) => ({
              id,
              data: () => ({ targetProfileId: "target" }),
            })),
        ),
      limit(value) {
        queryLimit = value;
        return this;
      },
      orderBy() {
        return this;
      },
      startAfter(value) {
        after = value;
        return this;
      },
    };
  },
});

const blockedPageResult = {
  complete: false,
  blockedProjections: [
    {
      entityType: "game",
      id: "invite-shared",
      reason: "unresolved-opponent-emoji",
    },
  ],
};

test("blocked page advances to a later repair and supports a clean rescan", async () => {
  let repaired = false;
  const reconcileProfileMergeProjections = async ({ sourceProfileId }) => {
    if (sourceProfileId === "source-b") {
      repaired = true;
      return { complete: true, blockedProjections: [] };
    }
    return repaired
      ? { complete: true, blockedProjections: [] }
      : blockedPageResult;
  };
  const firestore = createMergeCandidateFirestore(["source-a", "source-b"]);
  const first = await reconcileProfileMergeProjectionPage(
    { after: "", dryRun: true, limit: 1 },
    { firestore, reconcileProfileMergeProjections },
  );
  assert.equal(first.complete, false);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, "source-a");

  const second = await reconcileProfileMergeProjectionPage(
    { after: first.nextCursor, dryRun: true, limit: 1 },
    { firestore, reconcileProfileMergeProjections },
  );
  assert.equal(second.complete, true);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);

  const clean = await reconcileProfileMergeProjectionPage(
    { after: "", dryRun: true, limit: 2 },
    { firestore, reconcileProfileMergeProjections },
  );
  assert.equal(clean.complete, true);
  assert.deepEqual(clean.blockedProjections, []);
});
