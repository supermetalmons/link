import assert from "node:assert/strict";
import test from "node:test";
import type { EventLockManager } from "../../../functions/events/lockManagerCore.js";
import { AuthApiFailure } from "../src/authErrors.ts";
import { LEGACY_CORE_PRIZES_EVENT_ID } from "@mons/shared/event-prizes";
import {
  joinEvent,
  removeEventParticipant,
  toggleEventPrizeSelection,
  type EventParticipationRepository,
} from "../src/eventParticipation.ts";
import type { GameplayProfile } from "../src/gameplayRepository.ts";
import type { ProfileOwnershipSnapshot } from "../src/profileOwnership.ts";

const profileId = "creator-profile";
const identity = { uid: "creator-login" };

type TestEventParticipationRepository = EventParticipationRepository & {
  getGameplayProfile(
    uid: string,
    signal?: AbortSignal,
  ): Promise<GameplayProfile | null>;
  getGameplayProfileOwnership(
    uid: string,
    signal?: AbortSignal,
  ): Promise<{ loginUids: string[]; profile: GameplayProfile } | null>;
  listProfileLoginUids(profileId: string): Promise<string[]>;
  resolveCanonicalProfileId(profileId: string): Promise<string | null>;
  resolveCanonicalProfileIds(
    profileIds: string[],
  ): Promise<Array<string | null>>;
};

const creatorProfile: GameplayProfile = {
  profileId,
  username: "creator",
  eth: "",
  sol: "",
  rating: 1500,
  emoji: 7,
  aura: "rainbow",
};

const participant = (
  profileId: string,
  loginUid: string,
  joinedAtMs: number,
) => ({
  profileId,
  loginUid,
  username: profileId,
  displayName: profileId,
  emojiId: 1,
  aura: "",
  joinedAtMs,
  state: "active",
  eliminatedRoundIndex: null,
  eliminatedByProfileId: null,
});

const creatorParticipant = (joinedAtMs: number) => ({
  ...participant(profileId, identity.uid, joinedAtMs),
  username: creatorProfile.username,
  displayName: creatorProfile.username,
  emojiId: creatorProfile.emoji,
  aura: creatorProfile.aura,
});

function scheduledEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 10_000,
    updatedAtMs: 1,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
    participants: {
      [profileId]: participant(profileId, identity.uid, 1),
    },
    ...overrides,
  };
}

function createRepository({
  event = scheduledEvent(),
  profile = creatorProfile,
  profilesByUid = {},
  canonicalProfileIds = {},
  pathValues = {},
  patchError,
}: {
  event?: Record<string, unknown> | null;
  profile?: GameplayProfile | null;
  profilesByUid?: Record<string, GameplayProfile | null>;
  canonicalProfileIds?: Record<string, string | null>;
  pathValues?: Record<string, unknown>;
  patchError?: Error;
} = {}) {
  const patches: Record<string, unknown>[] = [];
  let repository: TestEventParticipationRepository;
  repository = {
    getGameplayProfile: async (uid) =>
      Object.hasOwn(profilesByUid, uid)
        ? profilesByUid[uid] || null
        : uid === identity.uid
          ? profile
          : null,
    getGameplayProfileOwnership: async (uid, signal) => {
      const ownedProfile = await repository.getGameplayProfile(uid, signal);
      if (!ownedProfile) {
        return null;
      }
      return {
        loginUids: await repository.listProfileLoginUids(
          ownedProfile.profileId,
        ),
        profile: ownedProfile,
      };
    },
    listProfileLoginUids: async (profileId) => [
      ...(profile?.profileId === profileId ? [identity.uid] : []),
      ...Object.entries(profilesByUid)
        .filter(([, value]) => value?.profileId === profileId)
        .map(([uid]) => uid),
    ],
    resolveCanonicalProfileId: async (candidateProfileId) =>
      Object.hasOwn(canonicalProfileIds, candidateProfileId)
        ? canonicalProfileIds[candidateProfileId] || null
        : candidateProfileId,
    resolveCanonicalProfileIds: async (candidateProfileIds) =>
      Promise.all(
        candidateProfileIds.map((candidateProfileId) =>
          repository.resolveCanonicalProfileId!(candidateProfileId),
        ),
      ),
    async readProfileOwnershipSnapshot(query) {
      const loginOwnerByUid = new Map<
        string,
        { profileId: string; revision: number } | null
      >();
      const profileById = new Map<
        string,
        { profile: GameplayProfile; revision: number }
      >();
      const loginUidsByProfileId = new Map<string, string[]>();
      const eventParticipants =
        event?.participants && typeof event.participants === "object"
          ? (event.participants as Record<string, unknown>)
          : {};
      for (const uid of query.loginUids) {
        let ownership = await repository.getGameplayProfileOwnership(uid);
        if (!ownership && !Object.hasOwn(profilesByUid, uid)) {
          const entry = Object.entries(eventParticipants).find(([, value]) => {
            const record = value as Record<string, unknown> | null;
            return record?.loginUid === uid;
          });
          if (entry) {
            const record = entry[1] as Record<string, unknown>;
            const storedProfileId =
              typeof record.profileId === "string"
                ? record.profileId
                : entry[0];
            const ownerProfileId = Object.hasOwn(
              canonicalProfileIds,
              storedProfileId,
            )
              ? canonicalProfileIds[storedProfileId] || storedProfileId
              : storedProfileId;
            ownership = {
              loginUids: [uid],
              profile: {
                aura: "",
                emoji: 0,
                eth: "",
                profileId: ownerProfileId,
                rating: 1500,
                sol: "",
                username: ownerProfileId,
              },
            };
          }
        }
        if (!ownership) {
          loginOwnerByUid.set(uid, null);
          continue;
        }
        const ownerProfileId = ownership.profile.profileId;
        loginOwnerByUid.set(uid, { profileId: ownerProfileId, revision: 1 });
        profileById.set(ownerProfileId, {
          profile: ownership.profile,
          revision: 1,
        });
        loginUidsByProfileId.set(
          ownerProfileId,
          [
            ...new Set([
              ...(loginUidsByProfileId.get(ownerProfileId) || []),
              ...ownership.loginUids,
              uid,
            ]),
          ].sort(),
        );
      }
      const canonicalProfileIdByProfileId = new Map<string, string | null>();
      const resolved = await repository.resolveCanonicalProfileIds([
        ...query.profileIds,
      ]);
      for (let index = 0; index < query.profileIds.length; index += 1) {
        const sourceProfileId = query.profileIds[index];
        const canonicalProfileId = resolved[index] || null;
        canonicalProfileIdByProfileId.set(sourceProfileId, canonicalProfileId);
        if (!canonicalProfileId) continue;
        if (!profileById.has(canonicalProfileId)) {
          profileById.set(canonicalProfileId, {
            profile: {
              aura: "",
              emoji: 0,
              eth: "",
              profileId: canonicalProfileId,
              rating: 1500,
              sol: "",
              username: canonicalProfileId,
            },
            revision: 1,
          });
        }
        if (!loginUidsByProfileId.has(canonicalProfileId)) {
          loginUidsByProfileId.set(
            canonicalProfileId,
            [
              ...new Set(
                await repository.listProfileLoginUids(canonicalProfileId),
              ),
            ].sort(),
          );
        }
      }
      return {
        canonicalProfileIdByProfileId,
        loginOwnerByUid,
        loginUidsByProfileId,
        profileById,
      } as ProfileOwnershipSnapshot;
    },
    getRtdbPath: async (path) =>
      path in pathValues
        ? structuredClone(pathValues[path])
        : path === `events/${event?.eventId || "event-1"}`
          ? structuredClone(event)
          : null,
    patchRtdbRoot: async (updates) => {
      patches.push(structuredClone(updates));
      if (patchError) {
        throw patchError;
      }
    },
    transactRtdbPath: async () => ({ committed: false, value: null }),
  };
  return { patches, repository };
}

function createLockManager({
  owned = true,
  acquired = true,
  onAcquire,
  onCheck,
}: {
  owned?: boolean;
  acquired?: boolean;
  onAcquire?: () => void;
  onCheck?: () => void;
} = {}) {
  let released = 0;
  let stopped = 0;
  const handle = {
    eventId: "event-1",
    path: "eventLocks/event-1",
    lockId: "lock-1",
    ownerUid: identity.uid,
    lockRoot: "eventLocks",
  };
  const manager: EventLockManager = {
    acquireEventLock: async () => {
      onAcquire?.();
      return acquired ? handle : null;
    },
    acquireEventLockWithRetry: async () => {
      onAcquire?.();
      return acquired ? handle : null;
    },
    getEventLockGuard: () => ({
      lockRoot: "eventLocks",
      eventId: "event-1",
      lockId: "lock-1",
      ownerUid: identity.uid,
    }),
    isEventLockStillOwned: async () => {
      onCheck?.();
      return owned;
    },
    refreshEventLock: async () => owned,
    releaseEventLock: async () => {
      released += 1;
      return true;
    },
    startEventLockHeartbeat: () => () => {
      stopped += 1;
    },
  };
  return {
    manager,
    released: () => released,
    stopped: () => stopped,
  };
}

const noDueTransition = async () => ({ didChange: false, updates: {} });

async function expectFailure(
  promise: Promise<unknown>,
  status: number,
  message: string,
) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AuthApiFailure);
    assert.equal(error.status, status);
    assert.equal(error.message, message);
    return true;
  });
}

test("rejoins by exact participant UID without reading D1", async () => {
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        [profileId]: participant(profileId, identity.uid, 50),
      },
    }),
  });
  let ownershipReads = 0;
  repository.getGameplayProfile = async () => {
    ownershipReads += 1;
    throw new Error("d1-must-not-run");
  };
  repository.getGameplayProfileOwnership = async () => {
    ownershipReads += 1;
    throw new Error("d1-must-not-run");
  };
  repository.resolveCanonicalProfileIds = async () => {
    ownershipReads += 1;
    throw new Error("d1-must-not-run");
  };
  const lock = createLockManager();
  const response = await joinEvent(
    identity,
    { eventId: "event-1" },
    repository,
    {
      lockManager: lock.manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    },
  );
  assert.equal(response.participant.joinedAtMs, 50);
  assert.equal(response.participant.displayName, profileId);
  assert.deepEqual(patches, [
    {
      "events/event-1/participants/creator-profile": response.participant,
      "events/event-1/updatedAtMs": 100,
    },
  ]);
  assert.equal(lock.stopped(), 1);
  assert.equal(lock.released(), 1);
  assert.equal(ownershipReads, 0);
});

test("rejoins a retired participant without creating a canonical duplicate", async () => {
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-profile",
  };
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        "retired-profile": participant("retired-profile", "original-login", 50),
      },
    }),
    profilesByUid: {
      "alternate-login": canonicalProfile,
      "original-login": canonicalProfile,
    },
    canonicalProfileIds: { "retired-profile": "canonical-profile" },
  });
  const response = await joinEvent(
    { uid: "alternate-login" },
    { eventId: "event-1" },
    repository,
    {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    },
  );
  assert.equal(response.participant.profileId, "retired-profile");
  assert.equal(response.participant.loginUid, "alternate-login");
  assert.equal(response.participant.joinedAtMs, 50);
  assert.ok(patches[0]["events/event-1/participants/retired-profile"]);
  assert.equal(
    patches[0]["events/event-1/participants/canonical-profile"],
    undefined,
  );
});

test("does not reuse a participant when its stored login now owns another profile", async () => {
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-profile",
  };
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        "retired-profile": participant("retired-profile", "original-login", 50),
      },
    }),
    profilesByUid: {
      "alternate-login": canonicalProfile,
      "original-login": canonicalProfile,
    },
  });
  const response = await joinEvent(
    { uid: "alternate-login" },
    { eventId: "event-1" },
    repository,
    {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    },
  );
  assert.equal(response.participant.profileId, "canonical-profile");
  assert.ok(patches[0]["events/event-1/participants/canonical-profile"]);
  assert.equal(
    patches[0]["events/event-1/participants/retired-profile"],
    undefined,
  );
});

test("reads one join ownership snapshot under the event lock", async () => {
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-profile",
  };
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        "retired-profile": {
          ...participant("retired-profile", "", 50),
          loginUid: "",
        },
      },
    }),
    canonicalProfileIds: { "retired-profile": "canonical-profile" },
  });
  let lockAcquired = false;
  const ownershipReadLockStates: boolean[] = [];
  repository.getGameplayProfileOwnership = async (uid) => {
    ownershipReadLockStates.push(lockAcquired);
    return uid === "alternate-login"
      ? { loginUids: ["alternate-login"], profile: canonicalProfile }
      : { loginUids: [identity.uid], profile: creatorProfile };
  };
  const response = await joinEvent(
    { uid: "alternate-login" },
    { eventId: "event-1" },
    repository,
    {
      lockManager: createLockManager({
        onAcquire: () => {
          lockAcquired = true;
        },
      }).manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    },
  );
  assert.equal(response.participant.profileId, "retired-profile");
  assert.ok(patches[0]["events/event-1/participants/retired-profile"]);
  assert.equal(
    patches[0]["events/event-1/participants/canonical-profile"],
    undefined,
  );
  assert.deepEqual(ownershipReadLockStates, [true, true]);
});

test("does not re-read ownership after the locked join snapshot", async () => {
  const firstProfile = { ...creatorProfile, profileId: "first-profile" };
  const { patches, repository } = createRepository({
    event: scheduledEvent({ participants: {} }),
  });
  let ownershipReads = 0;
  repository.getGameplayProfileOwnership = async (uid) => {
    ownershipReads += 1;
    return uid === "alternate-login"
      ? { loginUids: ["alternate-login"], profile: firstProfile }
      : { loginUids: [identity.uid], profile: creatorProfile };
  };
  const response = await joinEvent(
    { uid: "alternate-login" },
    { eventId: "event-1" },
    repository,
    {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    },
  );
  assert.equal(response.participant.profileId, firstProfile.profileId);
  assert.equal(ownershipReads, 2);
  assert.equal(patches.length, 1);
});

test("bulk-resolves ownership once for a full participant set", async () => {
  const fullParticipants = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `profile-${index}`,
      participant(`profile-${index}`, `login-${index}`, index),
    ]),
  );
  const { repository } = createRepository({
    event: scheduledEvent({ participants: fullParticipants }),
  });
  const batches: string[][] = [];
  repository.resolveCanonicalProfileId = async () => {
    throw new Error("single-profile-resolution-must-not-run");
  };
  repository.resolveCanonicalProfileIds = async (profileIds) => {
    batches.push(profileIds);
    return profileIds;
  };
  await expectFailure(
    joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    }),
    409,
    "This event is full (32 players max).",
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 33);
});

test("rejects duplicate retired and canonical participant ownership", async () => {
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-profile",
  };
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        "retired-profile": participant("retired-profile", "original-login", 50),
        "canonical-profile": participant(
          "canonical-profile",
          "alternate-login",
          60,
        ),
      },
    }),
    profilesByUid: {
      "alternate-login": canonicalProfile,
      "original-login": canonicalProfile,
      "third-login": canonicalProfile,
    },
    canonicalProfileIds: { "retired-profile": "canonical-profile" },
  });
  await expectFailure(
    joinEvent({ uid: "third-login" }, { eventId: "event-1" }, repository, {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    }),
    503,
    "profile-ownership-unavailable",
  );
  assert.deepEqual(patches, []);
});

test("normalizes non-finite emoji metadata before writing", async () => {
  const { patches, repository } = createRepository({
    event: scheduledEvent({ participants: {} }),
    profile: { ...creatorProfile, emoji: "Infinity" },
  });
  const response = await joinEvent(
    identity,
    { eventId: "event-1" },
    repository,
    {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    },
  );
  assert.equal(response.participant.emojiId, 0);
  assert.equal(
    (
      patches[0]["events/event-1/participants/creator-profile"] as {
        emojiId: number;
      }
    ).emojiId,
    0,
  );
});

test("rejects oversized participant metadata before writing", async () => {
  const { patches, repository } = createRepository({
    event: scheduledEvent({ participants: {} }),
    profile: { ...creatorProfile, username: "x".repeat(257) },
  });
  await expectFailure(
    joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    }),
    503,
    "event-participation-service-unavailable",
  );
  assert.deepEqual(patches, []);
});

test("rejects missing profiles, missing events, full events, and active events", async () => {
  const lock = createLockManager();
  await expectFailure(
    joinEvent(
      identity,
      { eventId: "event-1" },
      createRepository({
        event: scheduledEvent({ participants: {} }),
        profile: null,
      }).repository,
      { lockManager: lock.manager, buildDueUpdates: noDueTransition },
    ),
    409,
    "Please sign in to join this event.",
  );
  await expectFailure(
    joinEvent(
      identity,
      { eventId: "event-1" },
      createRepository({ event: null }).repository,
      { lockManager: lock.manager, buildDueUpdates: noDueTransition },
    ),
    404,
    "Event not found.",
  );
  const fullParticipants = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `profile-${index}`,
      participant(`profile-${index}`, `login-${index}`, index),
    ]),
  );
  await expectFailure(
    joinEvent(
      identity,
      { eventId: "event-1" },
      createRepository({
        event: scheduledEvent({ participants: fullParticipants }),
      }).repository,
      {
        lockManager: lock.manager,
        now: () => 100,
        buildDueUpdates: noDueTransition,
      },
    ),
    409,
    "This event is full (32 players max).",
  );
  await expectFailure(
    joinEvent(
      identity,
      { eventId: "event-1" },
      createRepository({ event: scheduledEvent({ status: "active" }) })
        .repository,
      { lockManager: lock.manager, buildDueUpdates: noDueTransition },
    ),
    409,
    "This event has already started.",
  );
});

test("persists an overdue transition before rejecting a late join", async () => {
  const { patches, repository } = createRepository({
    event: scheduledEvent({ startAtMs: 100 }),
  });
  const lock = createLockManager();
  await expectFailure(
    joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: lock.manager,
      now: () => 100,
      buildDueUpdates: async () => ({
        didChange: true,
        updates: {
          "events/event-1/status": "active",
          "events/event-1/updatedAtMs": 100,
        },
      }),
    }),
    409,
    "This event is no longer accepting participants.",
  );
  assert.deepEqual(patches, [
    {
      "events/event-1/status": "active",
      "events/event-1/updatedAtMs": 100,
    },
  ]);
  assert.equal(lock.released(), 1);
});

test("does not persist an overdue transition after losing the lock", async () => {
  const { patches, repository } = createRepository({
    event: scheduledEvent({ startAtMs: 100 }),
  });
  const lock = createLockManager({ owned: false });
  await expectFailure(
    joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: lock.manager,
      now: () => 100,
      buildDueUpdates: async () => ({
        didChange: true,
        updates: {
          "events/event-1/status": "active",
          "events/event-1/updatedAtMs": 100,
        },
      }),
    }),
    503,
    "Event is busy. Please try joining again.",
  );
  assert.deepEqual(patches, []);
});

test("reconciles an ambiguous committed join", async () => {
  const stored = creatorParticipant(100);
  const { repository } = createRepository({
    event: scheduledEvent({ participants: {} }),
    patchError: new Error("ambiguous"),
    pathValues: {
      [`events/event-1/participants/${profileId}`]: stored,
      "events/event-1/updatedAtMs": 100,
    },
  });
  const lock = createLockManager();
  assert.deepEqual(
    await joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: lock.manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    }),
    { ok: true, eventId: "event-1", participant: stored },
  );
});

test("requires an ambiguous join to include its update timestamp", async () => {
  const patchError = new Error("ambiguous");
  const { repository } = createRepository({
    event: scheduledEvent({ participants: {} }),
    patchError,
    pathValues: {
      [`events/event-1/participants/${profileId}`]: creatorParticipant(100),
      "events/event-1/updatedAtMs": 99,
    },
  });
  await assert.rejects(
    joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    }),
    (error) => error === patchError,
  );
});

test("rejects an ambiguous join with a stale participant snapshot", async () => {
  const patchError = new Error("ambiguous");
  const { repository } = createRepository({
    event: scheduledEvent({ participants: {} }),
    patchError,
    pathValues: {
      [`events/event-1/participants/${profileId}`]: participant(
        profileId,
        identity.uid,
        1,
      ),
      "events/event-1/updatedAtMs": 100,
    },
  });
  await assert.rejects(
    joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    }),
    (error) => error === patchError,
  );
});

test("requires an ambiguous join to include its due transition", async () => {
  const stored = creatorParticipant(100);
  const patchError = new Error("ambiguous");
  const { repository } = createRepository({
    event: scheduledEvent({ participants: {} }),
    patchError,
    pathValues: {
      [`events/event-1/participants/${profileId}`]: stored,
      "events/event-1/updatedAtMs": 100,
      "events/event-1/status": "scheduled",
    },
  });
  await assert.rejects(
    joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: async () => ({
        didChange: true,
        updates: { "events/event-1/status": "active" },
      }),
    }),
    (error) => error === patchError,
  );
});

test("reconciles an ambiguous join with its committed due transition", async () => {
  const stored = creatorParticipant(100);
  const { repository } = createRepository({
    event: scheduledEvent({ participants: {} }),
    patchError: new Error("ambiguous"),
    pathValues: {
      [`events/event-1/participants/${profileId}`]: stored,
      "events/event-1/updatedAtMs": 100,
      "events/event-1/status": "active",
    },
  });
  assert.deepEqual(
    await joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: async () => ({
        didChange: true,
        updates: { "events/event-1/status": "active" },
      }),
    }),
    { ok: true, eventId: "event-1", participant: stored },
  );
});

test("does not commit a join after losing the event lock", async () => {
  const { patches, repository } = createRepository();
  const lock = createLockManager({ owned: false });
  await expectFailure(
    joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: lock.manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    }),
    503,
    "Event is busy. Please try joining again.",
  );
  assert.deepEqual(patches, []);
  assert.equal(lock.released(), 1);
});

test("threads one operation signal through event reads and commit calls", async () => {
  const signal = AbortSignal.timeout(1_000);
  const seen: AbortSignal[] = [];
  const repository = createRepository().repository;
  repository.getRtdbPath = async (_path, _query, receivedSignal) => {
    assert.ok(receivedSignal);
    seen.push(receivedSignal);
    return scheduledEvent({ participants: {} });
  };
  repository.patchRtdbRoot = async (_updates, receivedSignal) => {
    assert.ok(receivedSignal);
    seen.push(receivedSignal);
  };
  await joinEvent(identity, { eventId: "event-1" }, repository, {
    lockManager: createLockManager().manager,
    now: () => 100,
    signal,
    buildDueUpdates: noDueTransition,
  });
  assert.equal(seen.length, 3);
  assert.equal(
    seen.every((receivedSignal) => receivedSignal === signal),
    true,
  );
});

test("removes a non-creator participant and its prize selection", async () => {
  const target = participant("target-profile", "target-login", 2);
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        [profileId]: participant(profileId, identity.uid, 1),
        "target-profile": target,
      },
    }),
  });
  const lock = createLockManager();
  const response = await removeEventParticipant(
    identity,
    { eventId: "event-1", participantProfileId: "target-profile" },
    repository,
    {
      lockManager: lock.manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    },
  );
  assert.deepEqual(response, {
    ok: true,
    eventId: "event-1",
    removedProfileId: "target-profile",
  });
  assert.deepEqual(patches, [
    {
      "events/event-1/participants/target-profile": null,
      "eventPrizeSelections/event-1/target-profile": null,
      "events/event-1/updatedAtMs": 100,
    },
  ]);
  assert.equal(lock.released(), 1);
});

test("direct creator UID removal does not read D1 ownership", async () => {
  const target = participant("target-profile", "target-login", 2);
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        [profileId]: participant(profileId, identity.uid, 1),
        "target-profile": target,
      },
    }),
  });
  repository.getGameplayProfile = async () => {
    throw new Error("d1-unavailable");
  };
  repository.getGameplayProfileOwnership = async () => {
    throw new Error("d1-unavailable");
  };
  repository.resolveCanonicalProfileId = async () => {
    throw new Error("d1-unavailable");
  };
  const response = await removeEventParticipant(
    identity,
    { eventId: "event-1", participantProfileId: "target-profile" },
    repository,
    {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    },
  );
  assert.equal(response.removedProfileId, "target-profile");
  assert.equal(patches.length, 1);
});

test("reconciles an ambiguous committed removal", async () => {
  const target = participant("target-profile", "target-login", 2);
  const operationController = new AbortController();
  const patchError = new Error("ambiguous");
  const { repository } = createRepository({
    event: scheduledEvent({
      participants: {
        [profileId]: participant(profileId, identity.uid, 1),
        "target-profile": target,
      },
    }),
    pathValues: {
      "events/event-1/participants/target-profile": null,
      "eventPrizeSelections/event-1/target-profile": null,
      "events/event-1/updatedAtMs": 100,
    },
  });
  const patch = repository.patchRtdbRoot;
  repository.patchRtdbRoot = async (updates, signal) => {
    await patch(updates, signal);
    operationController.abort();
    throw patchError;
  };
  const getPath = repository.getRtdbPath;
  repository.getRtdbPath = async (path, query, signal) => {
    if (path !== "events/event-1") {
      assert.notEqual(signal, operationController.signal);
      assert.equal(signal?.aborted, false);
    }
    return getPath(path, query, signal);
  };
  const lock = createLockManager();
  assert.deepEqual(
    await removeEventParticipant(
      identity,
      { eventId: "event-1", participantProfileId: "target-profile" },
      repository,
      {
        lockManager: lock.manager,
        now: () => 100,
        signal: operationController.signal,
        buildDueUpdates: noDueTransition,
      },
    ),
    { ok: true, eventId: "event-1", removedProfileId: "target-profile" },
  );
});

test("enforces removal ownership and protects the creator", async () => {
  const target = participant("target-profile", "target-login", 2);
  const event = scheduledEvent({
    participants: {
      [profileId]: participant(profileId, identity.uid, 1),
      "target-profile": target,
    },
  });
  const lock = createLockManager();
  await expectFailure(
    removeEventParticipant(
      { uid: "other-login" },
      { eventId: "event-1", participantProfileId: "target-profile" },
      createRepository({
        event,
        profilesByUid: {
          [identity.uid]: creatorProfile,
          "other-login": { ...creatorProfile, profileId: "other-profile" },
        },
      }).repository,
      { lockManager: lock.manager, buildDueUpdates: noDueTransition },
    ),
    403,
    "Only the event creator can remove participants.",
  );
  await expectFailure(
    removeEventParticipant(
      identity,
      { eventId: "event-1", participantProfileId: profileId },
      createRepository({ event }).repository,
      {
        lockManager: lock.manager,
        now: () => 100,
        buildDueUpdates: noDueTransition,
      },
    ),
    409,
    "Event creator cannot be removed.",
  );
});

test("authorizes an alternate login for a merged event creator through D1", async () => {
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-profile",
  };
  const target = participant("target-profile", "target-login", 2);
  const event = scheduledEvent({
    createdByLoginUid: "original-login",
    createdByProfileId: "retired-profile",
    participants: {
      "retired-profile": participant("retired-profile", "original-login", 1),
      "target-profile": target,
    },
  });
  const { patches, repository } = createRepository({
    event,
    profilesByUid: {
      "alternate-login": canonicalProfile,
      "original-login": canonicalProfile,
    },
    canonicalProfileIds: { "retired-profile": "canonical-profile" },
  });
  const staleClaimIdentity = {
    uid: "alternate-login",
    profileId: "forged-profile",
  };
  const response = await removeEventParticipant(
    staleClaimIdentity,
    { eventId: "event-1", participantProfileId: "target-profile" },
    repository,
    {
      lockManager: createLockManager().manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    },
  );
  assert.equal(response.removedProfileId, "target-profile");
  assert.equal(patches[0]["events/event-1/participants/target-profile"], null);
});

test("checks alternate ownership before the final lock and write", async () => {
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-profile",
  };
  const event = scheduledEvent({
    createdByLoginUid: "original-login",
    createdByProfileId: "retired-profile",
    participants: {
      "retired-profile": participant("retired-profile", "original-login", 1),
      "target-profile": participant("target-profile", "target-login", 2),
    },
  });
  const { patches, repository } = createRepository({
    event,
    canonicalProfileIds: { "retired-profile": "canonical-profile" },
  });
  const order: string[] = [];
  repository.getGameplayProfileOwnership = async (uid) => {
    order.push("ownership");
    return uid === "target-login"
      ? {
          loginUids: ["target-login"],
          profile: { ...creatorProfile, profileId: "target-profile" },
        }
      : {
          loginUids: ["alternate-login", "original-login"],
          profile: canonicalProfile,
        };
  };
  const patch = repository.patchRtdbRoot;
  repository.patchRtdbRoot = async (...args) => {
    order.push("write");
    return patch(...args);
  };
  const response = await removeEventParticipant(
    { uid: "alternate-login" },
    { eventId: "event-1", participantProfileId: "target-profile" },
    repository,
    {
      lockManager: createLockManager({
        onCheck: () => {
          order.push("lock");
        },
      }).manager,
      now: () => 100,
      buildDueUpdates: noDueTransition,
    },
  );
  assert.equal(response.removedProfileId, "target-profile");
  assert.deepEqual(order.slice(-3), ["ownership", "lock", "write"]);
  assert.deepEqual(patches, [
    {
      "eventPrizeSelections/event-1/target-profile": null,
      "events/event-1/participants/target-profile": null,
      "events/event-1/updatedAtMs": 100,
    },
  ]);
});

test("rejects alternate creator access when the stored login owns another profile", async () => {
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-profile",
  };
  const event = scheduledEvent({
    createdByLoginUid: "original-login",
    createdByProfileId: "retired-profile",
    participants: {
      "retired-profile": participant("retired-profile", "original-login", 1),
      "target-profile": participant("target-profile", "target-login", 2),
    },
  });
  const { patches, repository } = createRepository({
    event,
    profilesByUid: {
      "alternate-login": canonicalProfile,
      "original-login": canonicalProfile,
    },
  });
  await expectFailure(
    removeEventParticipant(
      { uid: "alternate-login" },
      { eventId: "event-1", participantProfileId: "target-profile" },
      repository,
      {
        lockManager: createLockManager().manager,
        now: () => 100,
        buildDueUpdates: noDueTransition,
      },
    ),
    403,
    "Only the event creator can remove participants.",
  );
  assert.deepEqual(patches, []);
});

test("protects a merged creator participant from removal", async () => {
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-profile",
  };
  const event = scheduledEvent({
    createdByProfileId: "retired-profile",
    participants: {
      "canonical-profile": participant(
        "canonical-profile",
        "alternate-login",
        1,
      ),
    },
  });
  await expectFailure(
    removeEventParticipant(
      identity,
      {
        eventId: "event-1",
        participantProfileId: "canonical-profile",
      },
      createRepository({
        event,
        profilesByUid: {
          [identity.uid]: canonicalProfile,
          "alternate-login": canonicalProfile,
        },
      }).repository,
      {
        lockManager: createLockManager().manager,
        now: () => 100,
        buildDueUpdates: noDueTransition,
      },
    ),
    409,
    "Event creator cannot be removed.",
  );
});

test("fails from the ownership snapshot after acquiring an event lock", async () => {
  const { patches, repository } = createRepository({
    event: scheduledEvent({ participants: {} }),
  });
  repository.getGameplayProfile = async () => {
    throw new Error("d1-unavailable");
  };
  let lockAttempts = 0;
  const lock = createLockManager();
  const acquire = lock.manager.acquireEventLockWithRetry;
  lock.manager.acquireEventLockWithRetry = async (...args) => {
    lockAttempts += 1;
    return acquire(...args);
  };
  await expectFailure(
    joinEvent(identity, { eventId: "event-1" }, repository, {
      lockManager: lock.manager,
      buildDueUpdates: noDueTransition,
    }),
    503,
    "profile-ownership-unavailable",
  );
  assert.equal(lockAttempts, 1);
  assert.deepEqual(patches, []);
});

test("rejects missing participants and rechecks the start boundary", async () => {
  const lock = createLockManager();
  await expectFailure(
    removeEventParticipant(
      identity,
      { eventId: "event-1", participantProfileId: "missing-profile" },
      createRepository().repository,
      {
        lockManager: lock.manager,
        now: () => 100,
        buildDueUpdates: noDueTransition,
      },
    ),
    409,
    "Selected participant was not found.",
  );
  const target = participant("target-profile", "target-login", 2);
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      startAtMs: 101,
      participants: {
        [profileId]: participant(profileId, identity.uid, 1),
        "target-profile": target,
      },
    }),
  });
  const times = [100, 101];
  await expectFailure(
    removeEventParticipant(
      identity,
      { eventId: "event-1", participantProfileId: "target-profile" },
      repository,
      {
        lockManager: lock.manager,
        now: () => times.shift() || 101,
        buildDueUpdates: async () => ({
          didChange: true,
          updates: {
            "events/event-1/status": "active",
            "events/event-1/updatedAtMs": 101,
          },
        }),
      },
    ),
    409,
    "This event can no longer remove participants.",
  );
  assert.deepEqual(patches, [
    {
      "events/event-1/status": "active",
      "events/event-1/updatedAtMs": 101,
    },
  ]);
});

test("toggles an event prize selection with the canonical participant", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const { repository } = createRepository({
    event: scheduledEvent({ eventId }),
  });
  const paths: string[] = [];
  let stored: unknown = null;
  repository.transactRtdbPath = async (path, updater) => {
    paths.push(path);
    const decision = updater(stored);
    if (
      !decision ||
      typeof decision !== "object" ||
      !("value" in decision) ||
      ("commit" in decision && decision.commit === false)
    ) {
      return { committed: false, value: stored };
    }
    stored = decision.value;
    return { committed: true, value: stored };
  };
  const lock = createLockManager();
  assert.deepEqual(
    await toggleEventPrizeSelection(
      identity,
      { eventId, prizeId: "1092" },
      repository,
      { lockManager: lock.manager },
    ),
    { ok: true, eventId, selectedPrizeId: "1092" },
  );
  assert.deepEqual(
    await toggleEventPrizeSelection(
      identity,
      { eventId, prizeId: "1092" },
      repository,
      { lockManager: lock.manager },
    ),
    { ok: true, eventId, selectedPrizeId: null },
  );
  assert.deepEqual(paths, [
    `eventPrizeSelections/${eventId}/${profileId}`,
    `eventPrizeSelections/${eventId}/${profileId}`,
  ]);
  assert.equal(lock.stopped(), 2);
  assert.equal(lock.released(), 2);
});

test("falls back to the unique participant owned by the verified login", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const { repository } = createRepository({
    event: scheduledEvent({
      eventId,
      participants: {
        "merged-profile": participant("merged-profile", identity.uid, 1),
      },
    }),
  });
  let path = "";
  repository.transactRtdbPath = async (receivedPath, updater) => {
    path = receivedPath;
    const decision = updater(null);
    assert.ok(decision && typeof decision === "object" && "value" in decision);
    return { committed: true, value: decision.value };
  };
  const response = await toggleEventPrizeSelection(
    identity,
    { eventId, prizeId: "1111" },
    repository,
    { lockManager: createLockManager().manager },
  );
  assert.equal(response.selectedPrizeId, "1111");
  assert.equal(path, `eventPrizeSelections/${eventId}/merged-profile`);
});

test("direct participant UID prize selection does not read D1 ownership", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const { repository } = createRepository({
    event: scheduledEvent({ eventId }),
  });
  repository.getGameplayProfile = async () => {
    throw new Error("d1-unavailable");
  };
  repository.getGameplayProfileOwnership = async () => {
    throw new Error("d1-unavailable");
  };
  repository.resolveCanonicalProfileId = async () => {
    throw new Error("d1-unavailable");
  };
  repository.transactRtdbPath = async (_path, updater) => {
    const decision = updater(null);
    assert.ok(decision && typeof decision === "object" && "value" in decision);
    return { committed: true, value: decision.value };
  };
  const response = await toggleEventPrizeSelection(
    identity,
    { eventId, prizeId: "1092" },
    repository,
    { lockManager: createLockManager().manager },
  );
  assert.equal(response.selectedPrizeId, "1092");
});

test("selects prizes through canonical ownership of a retired participant", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-profile",
  };
  const { repository } = createRepository({
    event: scheduledEvent({
      eventId,
      participants: {
        "retired-profile": participant("retired-profile", "original-login", 1),
      },
    }),
    profilesByUid: {
      "alternate-login": canonicalProfile,
      "original-login": canonicalProfile,
    },
    canonicalProfileIds: { "retired-profile": "canonical-profile" },
  });
  let path = "";
  repository.transactRtdbPath = async (receivedPath, updater) => {
    path = receivedPath;
    const decision = updater(null);
    assert.ok(decision && typeof decision === "object" && "value" in decision);
    return { committed: true, value: decision.value };
  };
  const response = await toggleEventPrizeSelection(
    { uid: "alternate-login" },
    { eventId, prizeId: "1111" },
    repository,
    { lockManager: createLockManager().manager },
  );
  assert.equal(response.selectedPrizeId, "1111");
  assert.equal(path, `eventPrizeSelections/${eventId}/retired-profile`);
});

test("selects prizes through a canonical source ID without a stored login", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-profile",
  };
  const { repository } = createRepository({
    event: scheduledEvent({
      eventId,
      participants: {
        "retired-profile": {
          ...participant("retired-profile", "", 1),
          loginUid: "",
        },
      },
    }),
    profilesByUid: { "alternate-login": canonicalProfile },
    canonicalProfileIds: { "retired-profile": "canonical-profile" },
  });
  let path = "";
  repository.transactRtdbPath = async (receivedPath, updater) => {
    path = receivedPath;
    const decision = updater(null);
    assert.ok(decision && typeof decision === "object" && "value" in decision);
    return { committed: true, value: decision.value };
  };
  const response = await toggleEventPrizeSelection(
    { uid: "alternate-login" },
    { eventId, prizeId: "1111" },
    repository,
    { lockManager: createLockManager().manager },
  );
  assert.equal(response.selectedPrizeId, "1111");
  assert.equal(path, `eventPrizeSelections/${eventId}/retired-profile`);
});

test("rejects closed, locked, foreign, and busy prize selections", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const cases = [
    {
      event: scheduledEvent({ eventId, status: "ended" }),
      lock: createLockManager(),
      status: 409,
      message: "Prize selection is closed for this event.",
    },
    {
      event: scheduledEvent({ eventId, prizeSelectionsLockedAtMs: 1 }),
      lock: createLockManager(),
      status: 409,
      message: "Prize selection is locked for this event.",
    },
    {
      event: scheduledEvent({
        eventId,
        participants: { other: participant("other", "other-login", 1) },
      }),
      lock: createLockManager(),
      status: 403,
      message: "Only event participants can select prizes.",
    },
    {
      event: scheduledEvent({ eventId }),
      lock: createLockManager({ acquired: false }),
      status: 503,
      message: "Event is busy. Please try selecting again.",
    },
  ];
  for (const scenario of cases) {
    await expectFailure(
      toggleEventPrizeSelection(
        identity,
        { eventId, prizeId: "1092" },
        createRepository({ event: scenario.event }).repository,
        { lockManager: scenario.lock.manager },
      ),
      scenario.status,
      scenario.message,
    );
  }
});

test("rejects a prize selection after losing its event lock", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const { repository } = createRepository({
    event: scheduledEvent({ eventId }),
  });
  let transactions = 0;
  repository.transactRtdbPath = async () => {
    transactions++;
    return { committed: true, value: "1092" };
  };
  const lock = createLockManager({ owned: false });
  await expectFailure(
    toggleEventPrizeSelection(
      identity,
      { eventId, prizeId: "1092" },
      repository,
      { lockManager: lock.manager },
    ),
    503,
    "Event is busy. Please try selecting again.",
  );
  assert.equal(transactions, 0);
  assert.equal(lock.released(), 1);
});
