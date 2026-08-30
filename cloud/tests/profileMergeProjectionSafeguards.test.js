"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createEventProfileGameProjectionCore,
} = require("../functions/eventProfileGameProjectionCore");
const {
  buildInviteProjectionOwnerPlan,
  buildResolvedProfile,
  createProfileGamesProjectionCore,
  readExistingProjectionDocuments,
} = require("../functions/profileGamesProjectionCore");
const {
  createProfileLinkProjectionCore,
  processWithConcurrency,
} = require("../functions/profileLinkProjectionCore");

const runWithoutProjectionLock = async (_inviteId, work) => work();

const projectionOwnership = (entries, profiles = {}) => ({
  profileIdByLoginUid: new Map(entries),
  profileDataById: new Map(Object.entries(profiles)),
});

const eventOwnership = (
  { loginUids, profileIds },
  { canonicalProfileIds = {}, loginProfileIds = {} } = {},
) => ({
  canonicalProfileIdByProfileId: new Map(
    profileIds.map((profileId) => [
      profileId,
      Object.hasOwn(canonicalProfileIds, profileId)
        ? canonicalProfileIds[profileId]
        : profileId,
    ]),
  ),
  loginOwnerByUid: new Map(
    loginUids.map((loginUid) => {
      const profileId = loginProfileIds[loginUid] || null;
      return [loginUid, profileId ? { profileId, revision: 1 } : null];
    }),
  ),
});

const processProfileLinkCatchup = async (input, dependencies) => {
  const core = createProfileLinkProjectionCore({
    logger: { error: () => undefined, info: () => undefined },
    recomputeInviteProjection: dependencies.recomputeInviteProjection,
    resolveInviteIdFromMatchId: dependencies.resolveInviteIdFromMatchId,
    repository: {
      async getMatches(loginUid) {
        const snapshot = await dependencies.readMatches(loginUid);
        return snapshot.exists() ? snapshot.val() || {} : null;
      },
      inviteExists: async () => false,
      async readProfileOwnershipSnapshot({ loginUids }) {
        const entries = await Promise.all(
          loginUids.map(async (loginUid) => [
            loginUid,
            await dependencies.readCurrentProfileLink(loginUid),
          ]),
        );
        return projectionOwnership(entries);
      },
    },
    withInviteProjectionLock: dependencies.withInviteProjectionLock,
  });
  return core.processProfileLinkCatchup({
    cleanupProfileIds:
      input.cleanupProfileIds || [input.staleProfileId].filter(Boolean),
    loginUid: input.loginUid,
    profileId: input.profileId,
    sourceUpdatedAtMs: 100,
  });
};

const runEventProjection = async ({
  afterData,
  beforeData = null,
  canonicalProfileIds = {},
  loginProfileIds = {},
  options = {},
  profileIds = [],
}) => {
  const existingProfileIds = new Set(profileIds);
  const commits = [];
  const operations = [];
  const eventData = {
    ...afterData,
    participants: Object.fromEntries(
      Object.entries(afterData?.participants || {}).map(
        ([key, participant]) => {
          const profileId = participant.profileId || key;
          return [
            key,
            {
              ...participant,
              loginUid: participant.loginUid || `login-${profileId}`,
            },
          ];
        },
      ),
    ),
  };
  const participantLoginProfileIds = Object.fromEntries(
    Object.values(eventData.participants).map((participant) => {
      const profileId = participant.profileId;
      const canonicalProfileId = Object.hasOwn(canonicalProfileIds, profileId)
        ? canonicalProfileIds[profileId]
        : existingProfileIds.has(profileId)
          ? profileId
          : null;
      return [participant.loginUid, canonicalProfileId];
    }),
  );
  const core = createEventProfileGameProjectionCore({
    repository: {
      commitProjectionWrites: async (writes) => {
        for (const write of writes) {
          operations.push({
            path: `${write.profileId}/event_${write.eventId}`,
            type: write.type === "delete" ? "delete" : "set",
          });
        }
        for (let index = 0; index < operations.length; index += 450) {
          commits.push(operations.slice(index, index + 450));
        }
      },
      getEvent: async () => eventData,
      readProfileOwnershipSnapshot: async (query) =>
        eventOwnership(query, {
          canonicalProfileIds: Object.fromEntries(
            query.profileIds.map((profileId) => [
              profileId,
              Object.hasOwn(canonicalProfileIds, profileId)
                ? canonicalProfileIds[profileId]
                : existingProfileIds.has(profileId)
                  ? profileId
                  : null,
            ]),
          ),
          loginProfileIds: {
            ...participantLoginProfileIds,
            ...loginProfileIds,
          },
        }),
    },
  });
  try {
    const beforeOwnerProfileIds = Object.values(
      beforeData?.participants || {},
    ).flatMap((participant) =>
      participant?.profileId ? [participant.profileId] : [],
    );
    await core.projectEvent("event-1", eventData, [
      ...beforeOwnerProfileIds,
      ...(options.cleanupOwnerProfileIds || []),
    ]);
    return { commits, operations };
  } catch (error) {
    error.projectionOperations = operations;
    throw error;
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
  const deletes = [];
  const sets = [];
  const currentUpdateTimes = { ...projectionUpdateTimes };
  const core = createProfileGamesProjectionCore({
    repository: {
      async commitProjectionWrites(writes) {
        beforeCommit?.({ currentUpdateTimes, projections });
        for (const write of writes) {
          const path = `${write.profileId}/${inviteId}`;
          if (write.type === "delete") {
            deletes.push(path);
            continue;
          }
          if (
            write.type === "update" &&
            write.updateTime !== currentUpdateTimes[write.profileId]
          ) {
            throw new Error("projection-precondition-failed");
          }
          sets.push({
            data: write.data,
            method: write.type === "merge" ? "set" : write.type,
            ...(write.type === "merge" ? { options: { merge: true } } : {}),
            ...(write.type === "update"
              ? {
                  precondition: {
                    lastUpdateTime: write.updateTime,
                  },
                }
              : {}),
            path,
          });
        }
      },
      async getProjection(profileId) {
        const data = projections[profileId];
        if (data === null || data === undefined) {
          return null;
        }
        currentUpdateTimes[profileId] ||= "revision-1";
        return { data, updateTime: currentUpdateTimes[profileId] };
      },
      async getRtdbPath(path) {
        if (path === `invites/${inviteId}`) return invite;
        if (path === `automatch/${inviteId}`) return null;
        if (/^players\/.+\/profile$/.test(path)) {
          throw new Error("unexpected-rtdb-profile-owner-read");
        }
        if (path.startsWith("players/")) return null;
        throw new Error(`unexpected-path:${path}`);
      },
      async readProfileOwnershipSnapshot({ loginUids }) {
        const resolveProfileId = (loginUid) => {
          let profileId = profileLinks[loginUid] || null;
          const visited = new Set();
          while (profileId && !visited.has(profileId)) {
            visited.add(profileId);
            const target = mergeTargets[profileId]?.targetProfileId;
            if (!target) break;
            profileId = target;
          }
          return profileId &&
            profiles[profileId] &&
            !profiles[profileId].mergedIntoProfileId
            ? profileId
            : null;
        };
        const entries = loginUids.map((loginUid) => [
          loginUid,
          resolveProfileId(loginUid),
        ]);
        return projectionOwnership(
          entries,
          Object.fromEntries(
            Object.entries(profiles).filter(
              ([, data]) => !data.mergedIntoProfileId,
            ),
          ),
        );
      },
    },
  });
  const result = await core.recomputeInviteProjection(
    inviteId,
    "profile-link-catchup",
    {
      cleanupProfileIds,
      eventTimestampMs,
      preserveListSortAt: true,
    },
  );
  return { deletes, result, sets };
};

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
  assert.equal(operations.at(-1).path, "stale-owner/event_event-1");
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
      assert.match(error.message, /profile-ownership-unavailable/);
      assert.deepEqual(error.projectionOperations, []);
      return true;
    },
  );
});

test("event projection does not write for contradictory ownership", async () => {
  await assert.rejects(
    runEventProjection({
      afterData: {
        participants: { current: { profileId: "retired-owner" } },
      },
      beforeData: {
        participants: { stale: { profileId: "stale-owner" } },
      },
      canonicalProfileIds: { "retired-owner": "canonical-profile" },
      loginProfileIds: {
        "login-retired-owner": "different-profile",
      },
      profileIds: ["retired-owner"],
    }),
    (error) => {
      assert.match(error.message, /profile-ownership-unavailable/);
      assert.deepEqual(error.projectionOperations, []);
      return true;
    },
  );
});

test("event owners use one deduplicated ownership snapshot", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `profile-${index}`);
  let ownershipReads = 0;
  const core = createEventProfileGameProjectionCore({
    repository: {
      commitProjectionWrites: async () => undefined,
      getEvent: async () => null,
      readProfileOwnershipSnapshot: async (query) => {
        ownershipReads += 1;
        assert.deepEqual(query.profileIds, ids);
        assert.deepEqual(
          query.loginUids,
          ids.map((profileId) => `login-${profileId}`),
        );
        return eventOwnership(query, {
          loginProfileIds: Object.fromEntries(
            ids.map((profileId) => [`login-${profileId}`, profileId]),
          ),
        });
      },
    },
  });
  await core.projectEvent("event-1", {
    participants: Object.fromEntries(
      ids.map((profileId) => [
        profileId,
        { profileId, loginUid: `login-${profileId}` },
      ]),
    ),
  });
  assert.equal(ownershipReads, 1);
});

test("invite cleanup follows the resolved merge-target path", () => {
  const hostProfile = buildResolvedProfile(["older-source", "target"]);
  const guestProfile = buildResolvedProfile([]);
  assert.deepEqual(buildInviteProjectionOwnerPlan(hostProfile, guestProfile), {
    cleanupProfileIds: ["older-source", "target"],
    ownerProfileIds: ["target"],
  });
});

test("invite projection ignores an RTDB profile shadow when D1 has no owner", async () => {
  const inviteId = "d1-owner-missing-invite";
  let rtdbProfileReads = 0;
  const core = createProfileGamesProjectionCore({
    repository: {
      commitProjectionWrites: async () => undefined,
      getProjection: async () => null,
      async getRtdbPath(path) {
        if (path === `invites/${inviteId}`) {
          return { hostId: "host-login" };
        }
        if (path === `automatch/${inviteId}`) return null;
        if (path === "players/host-login/profile") {
          rtdbProfileReads += 1;
          return "shadow-profile";
        }
        return null;
      },
      readProfileOwnershipSnapshot: async ({ loginUids }) =>
        projectionOwnership(loginUids.map((loginUid) => [loginUid, null])),
    },
  });

  const result = await core.recomputeInviteProjection(inviteId, "test", {
    eventTimestampMs: 100,
  });

  assert.equal(rtdbProfileReads, 0);
  assert.deepEqual(result.ownerProfileIds, []);
  assert.equal(result.blockedReason, "unresolved-owner-profile");
});

test("invite projection retries D1 ownership failures without writing", async () => {
  const inviteId = "d1-owner-failure-invite";
  let ownerReads = 0;
  let commits = 0;
  const core = createProfileGamesProjectionCore({
    logger: { error: () => undefined },
    repository: {
      commitProjectionWrites: async () => {
        commits += 1;
      },
      readProfileOwnershipSnapshot: async () => {
        ownerReads += 1;
        throw new Error("d1-owner-unavailable");
      },
      getProjection: async () => null,
      async getRtdbPath(path) {
        if (path === `invites/${inviteId}`) {
          return { hostId: "host-login" };
        }
        if (path === `automatch/${inviteId}`) return null;
        if (/^players\/.+\/profile$/.test(path)) {
          throw new Error("unexpected-rtdb-profile-owner-read");
        }
        return null;
      },
    },
    wait: async () => undefined,
  });

  await assert.rejects(
    core.recomputeInviteProjection(inviteId, "test", {
      eventTimestampMs: 100,
    }),
    /d1-owner-unavailable/,
  );
  assert.equal(ownerReads, 1);
  assert.equal(commits, 0);
});

test("event projection retains stale owners for cleanup", async () => {
  const beforeData = {
    participants: {
      before: { loginUid: "before-login", profileId: "before-profile" },
    },
  };
  const afterData = {
    participants: {
      after: {
        loginUid: "stale-after-login",
        profileId: "stale-after-profile",
      },
    },
  };
  const liveData = {
    participants: {
      live: { loginUid: "live-login", profileId: "live-profile" },
    },
  };
  const commits = [];
  const core = createEventProfileGameProjectionCore({
    repository: {
      commitProjectionWrites: async (writes) => commits.push(writes),
      getEvent: async () => liveData,
      readProfileOwnershipSnapshot: async (query) =>
        eventOwnership(query, {
          loginProfileIds: { "live-login": "live-profile" },
        }),
    },
  });
  await core.reconcileEventProjection("event-1", [
    ...Object.values(beforeData.participants).map(({ profileId }) => profileId),
    ...Object.values(afterData.participants).map(({ profileId }) => profileId),
  ]);
  assert.equal(commits.length, 1);
  assert.deepEqual(
    commits[0].map(({ type, profileId }) => ({ type, profileId })),
    [
      { type: "merge", profileId: "live-profile" },
      { type: "delete", profileId: "live" },
      { type: "delete", profileId: "before-profile" },
      { type: "delete", profileId: "stale-after-profile" },
    ],
  );
});

test("profile-link catchup bounds cleanup work to one ownership snapshot", async () => {
  let ownerRead = 0;
  let recomputed = 0;
  const matches = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`match-${index}`, {}]),
  );
  const core = createProfileLinkProjectionCore({
    logger: { error: () => undefined, info: () => undefined },
    recomputeInviteProjection: async () => {
      recomputed += 1;
      return { sourceCleanupSafe: true };
    },
    repository: {
      getMatches: async () => matches,
      inviteExists: async () => true,
      readProfileOwnershipSnapshot: async ({ loginUids }) => {
        ownerRead += 1;
        return projectionOwnership(
          loginUids.map((loginUid) => [loginUid, "profile-1"]),
        );
      },
    },
    resolveInviteIdFromMatchId: async (matchId) => matchId,
    withInviteProjectionLock: runWithoutProjectionLock,
  });

  const result = await core.processProfileLinkCatchup({
    cleanupProfileIds: ["stale-profile"],
    loginUid: "login-1",
    profileId: "event-profile",
    sourceUpdatedAtMs: 100,
  });
  assert.equal(ownerRead, 1);
  assert.equal(recomputed, 1);
  assert.equal(result.matchIdsScanned, 1);
  assert.equal(result.inviteIdsResolved, 1);
  assert.equal(result.didHitInviteCap, true);
  assert.equal(result.nextMatchCursor, "match-0");
});

test("profile-link catchup accepts an unprofiled opponent without stale cleanup", async () => {
  const result = await processProfileLinkCatchup(
    {
      eventLabel: "test",
      loginUid: "login-1",
      profileId: "target-profile",
    },
    {
      readCurrentProfileLink: async () => "target-profile",
      readMatches: async () => ({
        exists: () => true,
        val: () => ({ "match-1": {} }),
      }),
      recomputeInviteProjection: async () => ({
        blockedReason: "unresolved-owner-profile",
        ownerProfileIds: ["target-profile"],
        sourceCleanupSafe: false,
      }),
      resolveInviteIdFromMatchId: async () => "invite-1",
      withInviteProjectionLock: runWithoutProjectionLock,
    },
  );
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
});

test("profile-link catchup retries when the current owner is unresolved", async () => {
  await assert.rejects(
    processProfileLinkCatchup(
      {
        eventLabel: "test",
        loginUid: "login-1",
        profileId: "target-profile",
      },
      {
        readCurrentProfileLink: async () => "target-profile",
        readMatches: async () => ({
          exists: () => true,
          val: () => ({ "match-1": {} }),
        }),
        recomputeInviteProjection: async () => ({
          blockedReason: "unresolved-owner-profile",
          ownerProfileIds: ["different-profile"],
          sourceCleanupSafe: false,
        }),
        resolveInviteIdFromMatchId: async () => "invite-1",
        withInviteProjectionLock: runWithoutProjectionLock,
      },
    ),
    /profile-link-catchup-incomplete/,
  );
});

test("profile-link catchup retries blocked projections with stale cleanup", async () => {
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
          ownerProfileIds: ["target-profile"],
          sourceCleanupSafe: false,
        }),
        resolveInviteIdFromMatchId: async () => "invite-1",
        withInviteProjectionLock: runWithoutProjectionLock,
      },
    ),
    /profile-link-catchup-incomplete/,
  );
});

test("profile-link catchup advances one bounded 20-match page", async () => {
  const matches = Object.fromEntries(
    Array.from({ length: 301 }, (_, index) => [
      `invite-${String(index).padStart(3, "0")}`,
      {},
    ]),
  );
  let recomputed = 0;
  let active = 0;
  let maxActive = 0;
  const core = createProfileLinkProjectionCore({
    logger: { error: () => undefined, info: () => undefined },
    recomputeInviteProjection: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      recomputed += 1;
      return { sourceCleanupSafe: true };
    },
    repository: {
      getMatches: async () => matches,
      inviteExists: async () => true,
      readProfileOwnershipSnapshot: async ({ loginUids }) =>
        projectionOwnership(
          loginUids.map((loginUid) => [loginUid, "profile-1"]),
        ),
    },
    withInviteProjectionLock: runWithoutProjectionLock,
  });
  const result = await core.processProfileLinkCatchup({
    loginUid: "login-1",
    profileId: "profile-1",
    sourceUpdatedAtMs: 100,
  });
  assert.equal(result.didHitInviteCap, true);
  assert.equal(result.matchIdsScanned, 20);
  assert.equal(result.inviteIdsResolved, 20);
  assert.equal(recomputed, 20);
  assert.equal(maxActive, 3);
  assert.equal(result.nextMatchCursor, "invite-019");
  const secondPage = await core.processProfileLinkCatchup({
    loginUid: "login-1",
    matchCursor: result.nextMatchCursor,
    profileId: "profile-1",
    sourceUpdatedAtMs: 100,
  });
  assert.equal(secondPage.didHitInviteCap, true);
  assert.equal(secondPage.matchIdsScanned, 20);
  assert.equal(secondPage.nextMatchCursor, "invite-039");
  assert.equal(recomputed, 40);
});

test("profile-link catchup bounds scans with unresolved and duplicate invites", async () => {
  const matches = Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [
      `match-${String(index).padStart(2, "0")}`,
      {},
    ]),
  );
  const inspectedMatchIds = [];
  const recomputedInviteIds = [];
  const core = createProfileLinkProjectionCore({
    logger: { error: () => undefined, info: () => undefined },
    recomputeInviteProjection: async (inviteId) => {
      recomputedInviteIds.push(inviteId);
      return { sourceCleanupSafe: true };
    },
    resolveInviteIdFromMatchId: async (matchId) => {
      inspectedMatchIds.push(matchId);
      return Number(matchId.slice(-2)) % 2 === 0 ? null : "shared-invite";
    },
    repository: {
      getMatches: async () => matches,
      inviteExists: async () => true,
      readProfileOwnershipSnapshot: async ({ loginUids }) =>
        projectionOwnership(
          loginUids.map((loginUid) => [loginUid, "profile-1"]),
        ),
    },
    withInviteProjectionLock: runWithoutProjectionLock,
  });

  const result = await core.processProfileLinkCatchup({
    loginUid: "login-1",
    profileId: "profile-1",
    sourceUpdatedAtMs: 100,
  });

  assert.deepEqual(inspectedMatchIds, Object.keys(matches).slice(0, 20));
  assert.equal(result.matchIdsScanned, 20);
  assert.equal(result.inviteIdsResolved, 1);
  assert.equal(result.didHitInviteCap, true);
  assert.equal(result.nextMatchCursor, "match-19");
  assert.deepEqual(recomputedInviteIds, ["shared-invite"]);
});

test("profile-link catchup returns missing when the live link is gone", async () => {
  let matchReads = 0;
  const core = createProfileLinkProjectionCore({
    logger: { error: () => undefined, info: () => undefined },
    recomputeInviteProjection: async () => ({ sourceCleanupSafe: true }),
    repository: {
      getMatches: async () => {
        matchReads += 1;
        return {};
      },
      inviteExists: async () => true,
      readProfileOwnershipSnapshot: async ({ loginUids }) =>
        projectionOwnership(loginUids.map((loginUid) => [loginUid, null])),
    },
    withInviteProjectionLock: runWithoutProjectionLock,
  });
  assert.equal(
    await core.processProfileLinkCatchup({
      loginUid: "login-1",
      profileId: "profile-1",
      sourceUpdatedAtMs: 100,
    }),
    null,
  );
  assert.equal(matchReads, 0);
});

test("profile-link catchup propagates D1 ownership failures before match reads", async () => {
  let matchReads = 0;
  const core = createProfileLinkProjectionCore({
    logger: { error: () => undefined, info: () => undefined },
    recomputeInviteProjection: async () => ({ sourceCleanupSafe: true }),
    repository: {
      readProfileOwnershipSnapshot: async () => {
        throw new Error("d1-owner-unavailable");
      },
      getMatches: async () => {
        matchReads += 1;
        return {};
      },
      inviteExists: async () => true,
    },
    withInviteProjectionLock: runWithoutProjectionLock,
  });

  await assert.rejects(
    core.processProfileLinkCatchup({
      loginUid: "login-1",
      profileId: "profile-1",
      sourceUpdatedAtMs: 100,
    }),
    /d1-owner-unavailable/,
  );
  assert.equal(matchReads, 0);
});

test("profile-link catchup starts its budget after initial reads", async () => {
  let initialReadsComplete = false;
  let nowCalls = 0;
  const core = createProfileLinkProjectionCore({
    logger: { error: () => undefined, info: () => undefined },
    now: () => {
      assert.equal(initialReadsComplete, true);
      nowCalls += 1;
      return nowCalls === 1 ? 0 : 50_000;
    },
    recomputeInviteProjection: async () => ({ sourceCleanupSafe: true }),
    repository: {
      getMatches: async () => {
        initialReadsComplete = true;
        return { "match-1": {} };
      },
      inviteExists: async () => true,
      readProfileOwnershipSnapshot: async ({ loginUids }) =>
        projectionOwnership(
          loginUids.map((loginUid) => [loginUid, "profile-1"]),
        ),
    },
    withInviteProjectionLock: runWithoutProjectionLock,
  });
  await assert.rejects(
    core.processProfileLinkCatchup({
      loginUid: "login-1",
      profileId: "profile-1",
      sourceUpdatedAtMs: 100,
    }),
    /no-progress/,
  );
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
    cleanupProfileIds: [
      "merge-fallback-source-old",
      "merge-fallback-source-new",
    ],
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
    ({ path }) => path === `merge-fallback-target/${inviteId}`,
  );
  assert.ok(targetWrite);
  assert.equal(targetWrite.data.opponentEmoji, 9);
  assert.equal(targetWrite.data.opponentName, "Fresh guest");
  assert.equal(targetWrite.data.listSortAt, 1500);
  assert.equal(targetWrite.data.createdAt, 200);
  assert.equal(targetWrite.method, "create");
  assert.deepEqual(deletes.sort(), [
    `merge-fallback-source-new/${inviteId}`,
    `merge-fallback-source-old/${inviteId}`,
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
    ({ path }) => path === `merge-existing-canonical-target/${inviteId}`,
  );
  assert.equal(targetWrite.data.listSortAt, 1000);
  assert.equal(targetWrite.method, "update");
  assert.ok(targetWrite.precondition.lastUpdateTime);
});

test("profile-link catchup cannot overwrite a concurrent live sort update", async () => {
  const inviteId = "merge-concurrent-sort-invite";
  const firstVersion = "revision-1";
  const liveVersion = "revision-2";
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
    /projection-precondition-failed/,
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
        ({ path }) => path === `merge-blocked-${status}-target/${inviteId}`,
      ),
      false,
    );
    assert.equal(result.deletes, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.sourceCleanupSafe, false);
    assert.equal(result.blockedReason, "unresolved-opponent-emoji");
  });
}

test("unresolved opponent emoji takes precedence over an unresolved owner", async () => {
  const inviteId = "merge-unprofiled-opponent-invite";
  const { deletes, result, sets } = await runInviteProjection({
    cleanupProfileIds: ["merge-unprofiled-host"],
    eventTimestampMs: 3000,
    invite: {
      guestId: "merge-unprofiled-guest-login",
      hostId: "merge-unprofiled-host-login",
    },
    inviteId,
    mergeTargets: {},
    profileLinks: {
      "merge-unprofiled-host-login": "merge-unprofiled-host",
    },
    profiles: {
      "merge-unprofiled-host": { custom: { emoji: 11 }, username: "Host" },
    },
    projections: {},
  });
  assert.deepEqual(deletes, []);
  assert.deepEqual(sets, []);
  assert.deepEqual(result.ownerProfileIds, ["merge-unprofiled-host"]);
  assert.equal(result.sourceCleanupSafe, false);
  assert.equal(result.blockedReason, "unresolved-opponent-emoji");
});

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
  assert.deepEqual(deletes, [`merge-deleted-owner-source/${inviteId}`]);
  assert.deepEqual(sets, []);
  assert.equal(result.sourceCleanupSafe, true);
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
