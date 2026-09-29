import {
  attachEventTestPorts,
  type EventTestSource,
} from "./eventTestPorts.ts";
import { decodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { EventSnapshot } from "../../../runtime/eventReads.js";
import type { EventLeaseRecord } from "../../../runtime/eventLeases.js";
import type { EventLockManager } from "../../../runtime/events/lockManagerCore.js";
import { AuthApiFailure } from "../src/authErrors.ts";
import { EventNotUpcoming } from "../src/eventD1.ts";
import type { EventCommitOptions } from "../src/eventStoreContracts.ts";
import { LEGACY_CORE_PRIZES_EVENT_ID } from "@mons/shared/event-prizes";
import {
  joinEvent,
  leaveEvent,
  removeEventParticipant,
  toggleEventPrizeSelection,
  type EventParticipationDependencies,
  type EventParticipationRepository,
} from "../src/eventParticipation.ts";
import type { GameplayProfile } from "../src/gameplayRepository.ts";
import type { ProfileOwnershipSnapshot } from "../src/profileOwnership.ts";

const profileId = "creator-profile";
const identity = { uid: "creator-login" };

type TestEventParticipationRepository = EventParticipationRepository &
  Required<
    Pick<
      EventTestSource,
      "getStatePath" | "patchStateRoot" | "transactStatePath"
    >
  > & {
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
  const readEventValue = (eventId: string): Record<string, unknown> | null => {
    const value = structuredClone(
      pathValues[`events/${eventId}`] ??
        (eventId === (event?.eventId || "event-1") ? event : null),
    ) as Record<string, unknown> | null;
    if (value && patches.length) {
      const prefix = `events/${eventId}/`;
      for (const [path, fieldValue] of Object.entries(pathValues)) {
        if (!path.startsWith(prefix)) continue;
        const parts = path.slice(prefix.length).split("/");
        let parent = value;
        for (const part of parts.slice(0, -1)) {
          parent[part] ??= {};
          parent = parent[part] as Record<string, unknown>;
        }
        const key = parts.at(-1)!;
        if (fieldValue === null) delete parent[key];
        else parent[key] = structuredClone(fieldValue);
      }
    }
    return value;
  };
  const readSelections = (eventId: string): Record<string, string> => {
    const prefix = `eventPrizeSelections/${eventId}`;
    const selections = structuredClone(pathValues[prefix] || {}) as Record<
      string,
      string
    >;
    if (patches.length) {
      for (const [path, value] of Object.entries(pathValues)) {
        if (!path.startsWith(`${prefix}/`)) continue;
        const key = path.slice(prefix.length + 1);
        if (value === null) delete selections[key];
        else selections[key] = value as string;
      }
    }
    return selections;
  };
  let repository: TestEventParticipationRepository;
  repository = attachEventTestPorts<TestEventParticipationRepository>({
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
    readEvent: async (eventId) => readEventValue(eventId),
    readEventPrizeSelections: async (eventId) => readSelections(eventId),
    readEventSnapshot: async (eventId) => ({
      event: readEventValue(eventId),
      eventId,
      prizeSelections: readSelections(eventId),
      revision: 1,
    }),
    patchStateRoot: async (updates) => {
      patches.push(structuredClone(updates));
      if (patchError) {
        throw patchError;
      }
    },
    transactStatePath: async () => ({ committed: false, value: null }),
  });
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
    key: { kind: "event" as const, id: "event-1" },
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

const noDueTransition = async () => ({
  didChange: false,
  updates: decodeEventUpdates({}),
});

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
      {
        lockManager: lock.manager,
        now: () => 100,
        buildDueUpdates: noDueTransition,
      },
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
        updates: decodeEventUpdates({
          "events/event-1/status": "active",
          "events/event-1/updatedAtMs": 100,
        }),
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

test("late join migrates prize selections in the due transition update", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const event = scheduledEvent({
    eventId,
    startAtMs: 100,
    participants: {
      "retired-profile": participant("retired-profile", identity.uid, 1),
      opponent: participant("opponent", "opponent-login", 2),
    },
  });
  const state = createRepository({
    event,
    canonicalProfileIds: {
      "retired-profile": profileId,
      "legacy-selection-profile": profileId,
    },
    pathValues: {
      [`eventPrizeSelections/${eventId}`]: {
        "legacy-selection-profile": "1092",
      },
    },
  });
  let ownershipReads = 0;
  let queriedProfileIds: readonly string[] = [];
  const readOwnership = state.repository.readProfileOwnershipSnapshot;
  state.repository.readProfileOwnershipSnapshot = async (query) => {
    ownershipReads += 1;
    queriedProfileIds = query.profileIds;
    return readOwnership(query);
  };

  await expectFailure(
    joinEvent(identity, { eventId }, state.repository, {
      lockManager: createLockManager().manager,
      now: () => 100,
      random: () => 0,
    }),
    409,
    "This event is no longer accepting participants.",
  );
  const transition = state.patches.find(
    (patch) => patch[`events/${eventId}/status`] === "active",
  );
  assert.ok(transition);
  assert.deepEqual(transition[`eventPrizeSelections/${eventId}`], {
    [profileId]: "1092",
  });
  assert.ok(transition[`events/${eventId}/participants`]);
  assert.equal(ownershipReads, 1);
  assert.ok(queriedProfileIds.includes("legacy-selection-profile"));
});

test("late join dismisses a one-player prize event before profile ownership", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const state = createRepository({
    event: scheduledEvent({
      eventId,
      startAtMs: 100,
      participants: { [profileId]: creatorParticipant(1) },
    }),
    pathValues: {
      [`eventPrizeSelections/${eventId}`]: { [profileId]: "1092" },
    },
  });
  let ownershipReads = 0;
  state.repository.readProfileOwnershipSnapshot = async () => {
    ownershipReads += 1;
    throw new Error("d1-unavailable");
  };

  await expectFailure(
    joinEvent({ uid: "late-login" }, { eventId }, state.repository, {
      lockManager: createLockManager().manager,
      now: () => 100,
      random: () => 0,
    }),
    409,
    "This event is no longer accepting participants.",
  );
  const transition = state.patches.find(
    (patch) => patch[`events/${eventId}/status`] === "dismissed",
  );
  assert.ok(transition);
  assert.equal(transition[`eventPrizeSelections/${eventId}`], null);
  assert.equal(ownershipReads, 0);
});

test("uses one locked prize snapshot when a join crosses the start deadline", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const alternateProfile = {
    ...creatorProfile,
    profileId: "alternate-profile",
  };
  const selections = { [profileId]: "1092" };
  const state = createRepository({
    event: scheduledEvent({
      eventId,
      startAtMs: 101,
      participants: {
        [profileId]: creatorParticipant(1),
        opponent: participant("opponent", "opponent-login", 2),
      },
    }),
    profilesByUid: { "alternate-login": alternateProfile },
    pathValues: { [`eventPrizeSelections/${eventId}`]: selections },
  });
  const readSnapshot = state.repository.readEventSnapshot;
  let snapshotReads = 0;
  let lockAcquired = false;
  state.repository.readEventSnapshot = async (...args) => {
    assert.equal(lockAcquired, true);
    snapshotReads += 1;
    return readSnapshot(...args);
  };
  state.repository.readEventPrizeSelections = async () => {
    throw new Error("unexpected-separate-prize-read");
  };
  const times = [100, 101];

  const response = await joinEvent(
    { uid: "alternate-login" },
    { eventId },
    state.repository,
    {
      lockManager: createLockManager({
        onAcquire: () => {
          lockAcquired = true;
        },
      }).manager,
      now: () => times.shift() ?? 101,
      buildDueUpdates: async (input) => {
        assert.deepEqual(input.prizeSelections, selections);
        return {
          didChange: true,
          updates: decodeEventUpdates({
            [`events/${eventId}/status`]: "active",
            [`events/${eventId}/updatedAtMs`]: 101,
          }),
        };
      },
    },
  );

  assert.equal(response.participant.profileId, alternateProfile.profileId);
  assert.equal(snapshotReads, 1);
});

test("refreshes event and prize selections together after the participation lock", async () => {
  for (const operation of ["join", "remove"] as const) {
    const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
    const event = scheduledEvent({
      eventId,
      participants: {
        [profileId]: creatorParticipant(1),
        opponent: participant("opponent", "opponent-login", 2),
      },
    });
    const pathValues = {
      [`eventPrizeSelections/${eventId}`]: { [profileId]: "1092" },
    };
    const { repository, patches } = createRepository({ event, pathValues });
    const reads: string[] = [];
    const readEvent = repository.readEvent;
    const readSnapshot = repository.readEventSnapshot;
    repository.readEvent = async (...args) => {
      reads.push("event");
      return readEvent(...args);
    };
    repository.readEventSnapshot = async (...args) => {
      reads.push("snapshot");
      return readSnapshot(...args);
    };
    repository.readEventPrizeSelections = async () => {
      throw new Error("unexpected-separate-prize-read");
    };
    let dueBuilds = 0;
    const dependencies = {
      lockManager: createLockManager({
        onAcquire: () => {
          reads.push("lock");
          event.startAtMs = 100;
          pathValues[`eventPrizeSelections/${eventId}`] = {
            [profileId]: "1111",
          };
        },
      }).manager,
      now: () => 100,
      buildDueUpdates: async (input: {
        event: Record<string, unknown>;
        prizeSelections?: unknown;
      }) => {
        dueBuilds += 1;
        assert.equal(input.event.startAtMs, 100);
        assert.deepEqual(input.prizeSelections, { [profileId]: "1111" });
        return noDueTransition();
      },
    };
    await expectFailure(
      operation === "join"
        ? joinEvent(identity, { eventId }, repository, dependencies)
        : removeEventParticipant(
            identity,
            { eventId, participantProfileId: "opponent" },
            repository,
            dependencies,
          ),
      409,
      operation === "join"
        ? "This event is no longer accepting participants."
        : "This event can no longer remove participants.",
    );
    assert.deepEqual(reads, ["event", "lock", "snapshot"]);
    assert.equal(dueBuilds, 1);
    assert.deepEqual(patches, []);
  }
});

test("deadline-crossing join persists and reconciles its canonical participant", async () => {
  const canonicalProfileId = "canonical-profile";
  const retiredProfileId = "retired-profile";
  const retiredParticipant = participant(retiredProfileId, identity.uid, 1);
  const canonicalParticipant = {
    ...retiredParticipant,
    profileId: canonicalProfileId,
  };
  const state = createRepository({
    event: scheduledEvent({
      startAtMs: 101,
      createdByProfileId: retiredProfileId,
      participants: {
        [retiredProfileId]: retiredParticipant,
        opponent: participant("opponent", "opponent-login", 2),
      },
    }),
    profile: { ...creatorProfile, profileId: canonicalProfileId },
    canonicalProfileIds: { [retiredProfileId]: canonicalProfileId },
    pathValues: {
      [`events/event-1/participants/${canonicalProfileId}`]:
        canonicalParticipant,
      "events/event-1/status": "active",
      "events/event-1/updatedAtMs": 101,
    },
    patchError: new Error("ambiguous-join"),
  });
  const patchStateRoot = state.repository.patchStateRoot;
  const readSnapshot = state.repository.readEventSnapshot;
  const reconciliationSnapshots: EventSnapshot[] = [];
  let patchAttempted = false;
  state.repository.patchStateRoot = async (updates, signal) => {
    const paths = Object.keys(updates);
    assert.equal(
      paths.some((parent, index) =>
        paths.some(
          (child, childIndex) =>
            index !== childIndex && child.startsWith(`${parent}/`),
        ),
      ),
      false,
    );
    patchAttempted = true;
    return patchStateRoot(updates, signal);
  };
  state.repository.readEventSnapshot = async (eventId, signal) => {
    assert.equal(patchAttempted, true);
    const snapshot = await readSnapshot(eventId, signal);
    reconciliationSnapshots.push(snapshot);
    return snapshot;
  };
  const times = [100, 101];

  const response = await joinEvent(
    identity,
    { eventId: "event-1" },
    state.repository,
    {
      lockManager: createLockManager().manager,
      now: () => times.shift() ?? 101,
      random: () => 0,
    },
  );

  assert.deepEqual(response.participant, canonicalParticipant);
  assert.equal(state.patches.length, 1);
  const update = state.patches[0];
  assert.equal(
    Object.hasOwn(update, `events/event-1/participants/${retiredProfileId}`),
    false,
  );
  assert.deepEqual(
    (update["events/event-1/participants"] as Record<string, unknown>)[
      canonicalProfileId
    ],
    canonicalParticipant,
  );
  assert.equal(reconciliationSnapshots.length, 1);
  assert.deepEqual(
    (reconciliationSnapshots[0].event?.participants as Record<string, unknown>)[
      canonicalProfileId
    ],
    canonicalParticipant,
  );
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
        updates: decodeEventUpdates({
          "events/event-1/status": "active",
          "events/event-1/updatedAtMs": 100,
        }),
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
        updates: decodeEventUpdates({ "events/event-1/status": "active" }),
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
        updates: decodeEventUpdates({ "events/event-1/status": "active" }),
      }),
    }),
    { ok: true, eventId: "event-1", participant: stored },
  );
});

test("preserves the join write error when reconciliation cannot read an event", async () => {
  for (const unavailable of ["missing", "failed"] as const) {
    const patchError = new Error("ambiguous-join");
    const { repository } = createRepository({
      event: scheduledEvent({ participants: {} }),
      patchError,
    });
    let snapshotReads = 0;
    repository.readEventSnapshot = async (eventId) => {
      snapshotReads += 1;
      if (unavailable === "failed") throw new Error("snapshot-unavailable");
      return { eventId, event: null, prizeSelections: {}, revision: 1 };
    };
    await assert.rejects(
      joinEvent(identity, { eventId: "event-1" }, repository, {
        lockManager: createLockManager().manager,
        now: () => 100,
        buildDueUpdates: noDueTransition,
      }),
      (error) => error === patchError,
    );
    assert.equal(snapshotReads, 1);
  }
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
  repository.readEvent = async (_eventId, receivedSignal) => {
    assert.ok(receivedSignal);
    seen.push(receivedSignal);
    return scheduledEvent({ participants: {} });
  };
  repository.patchStateRoot = async (_updates, receivedSignal) => {
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

test("leaves an upcoming prize event and can rejoin with a fresh entry", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const pathValues: Record<string, unknown> = {
    [`eventPrizeSelections/${eventId}`]: { "target-profile": "1092" },
  };
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      eventId,
      participants: {
        [profileId]: creatorParticipant(1),
        "target-profile": participant("target-profile", "target-login", 2),
      },
    }),
    profilesByUid: {
      "target-login": { ...creatorProfile, profileId: "target-profile" },
    },
    pathValues,
  });
  const patch = repository.patchStateRoot;
  repository.patchStateRoot = async (updates, signal) => {
    await patch(updates, signal);
    Object.assign(pathValues, updates);
  };
  let locked = false;
  let ownershipReads = 0;
  const readOwnership = repository.readProfileOwnershipSnapshot;
  repository.readProfileOwnershipSnapshot = async (query) => {
    assert.equal(locked, true);
    ownershipReads++;
    return readOwnership(query);
  };
  const lock = createLockManager({ onAcquire: () => (locked = true) });
  const staleClaimIdentity = {
    uid: "target-login",
    profileId: "forged-profile",
  };
  assert.deepEqual(
    await leaveEvent(staleClaimIdentity, { eventId }, repository, {
      lockManager: lock.manager,
      now: () => 100,
    }),
    { ok: true, eventId, removedProfileId: "target-profile" },
  );
  assert.deepEqual(patches, [
    {
      [`events/${eventId}/participants/target-profile`]: null,
      [`eventPrizeSelections/${eventId}/target-profile`]: null,
      [`events/${eventId}/updatedAtMs`]: 100,
    },
  ]);
  assert.equal(ownershipReads, 1);
  assert.equal(lock.stopped(), 1);
  assert.equal(lock.released(), 1);
  const leftSnapshot = await repository.readEventSnapshot(eventId);
  assert.equal(leftSnapshot.event?.status, "scheduled");
  assert.deepEqual(Object.keys(leftSnapshot.event?.participants || {}), [
    profileId,
  ]);
  assert.deepEqual(leftSnapshot.prizeSelections, {});
  await expectFailure(
    leaveEvent({ uid: "target-login" }, { eventId }, repository, {
      lockManager: lock.manager,
      now: () => 101,
    }),
    409,
    "You are not participating in this event.",
  );
  assert.equal(patches.length, 1);
  const joined = await joinEvent(
    { uid: "target-login" },
    { eventId },
    repository,
    { lockManager: lock.manager, now: () => 200 },
  );
  assert.equal(joined.participant.profileId, "target-profile");
  assert.equal(joined.participant.joinedAtMs, 200);
  assert.deepEqual(
    (await repository.readEventSnapshot(eventId)).prizeSelections,
    {},
  );
});

test("leaves through an alternate login using the stored participant key", async () => {
  const canonicalProfile = { ...creatorProfile, profileId: "canonical-target" };
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        [profileId]: creatorParticipant(1),
        "retired-target": participant("retired-target", "original-login", 2),
      },
    }),
    profilesByUid: {
      "original-login": canonicalProfile,
      "alternate-login": canonicalProfile,
    },
    canonicalProfileIds: { "retired-target": "canonical-target" },
  });
  const result = await leaveEvent(
    { uid: "alternate-login" },
    { eventId: "event-1" },
    repository,
    { lockManager: createLockManager().manager, now: () => 100 },
  );
  assert.equal(result.removedProfileId, "retired-target");
  assert.equal(patches[0]["events/event-1/participants/retired-target"], null);
  assert.equal(patches[0]["eventPrizeSelections/event-1/retired-target"], null);
  assert.equal(
    Object.hasOwn(patches[0], "events/event-1/participants/canonical-target"),
    false,
  );
});

test("keeps the creator enrolled for direct, alternate, and merged identities", async () => {
  const canonicalProfile = {
    ...creatorProfile,
    profileId: "canonical-creator",
  };
  for (const uid of [identity.uid, "alternate-login", "stored-login"]) {
    const { patches, repository } = createRepository({
      event: scheduledEvent({
        createdByProfileId: "retired-creator",
        participants: {
          "canonical-creator": participant(
            "canonical-creator",
            "stored-login",
            1,
          ),
        },
      }),
      profile: canonicalProfile,
      profilesByUid: {
        "alternate-login": canonicalProfile,
        "stored-login": canonicalProfile,
      },
      canonicalProfileIds: { "retired-creator": "canonical-creator" },
    });
    await expectFailure(
      leaveEvent({ uid }, { eventId: "event-1" }, repository, {
        lockManager: createLockManager().manager,
        now: () => 100,
      }),
      409,
      "Event creator cannot leave.",
    );
    assert.deepEqual(patches, []);
  }
});

test("rejects leaving events that are not upcoming or have an invalid deadline", async () => {
  for (const overrides of [
    { status: "active" },
    { status: "ended" },
    { status: "dismissed" },
    { startAtMs: null },
    { startAtMs: NaN },
  ]) {
    const { patches, repository } = createRepository({
      event: scheduledEvent({
        participants: {
          [profileId]: creatorParticipant(1),
          "target-profile": participant("target-profile", "target-login", 2),
        },
        ...overrides,
      }),
    });
    await expectFailure(
      leaveEvent({ uid: "target-login" }, { eventId: "event-1" }, repository, {
        lockManager: createLockManager().manager,
        now: () => 100,
      }),
      409,
      "status" in overrides
        ? "This event can no longer be left."
        : "This event cannot be updated right now.",
    );
    assert.deepEqual(patches, []);
  }
});

test("retains the original roster at the leave deadline and when crossing it", async () => {
  for (const firstNow of [100, 99]) {
    const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
    const event = scheduledEvent({
      eventId,
      startAtMs: 100,
      participants: {
        [profileId]: creatorParticipant(1),
        "target-profile": participant("target-profile", "target-login", 2),
      },
    });
    const { patches, repository } = createRepository({
      event,
      pathValues: {
        [`eventPrizeSelections/${eventId}`]: { "target-profile": "1092" },
      },
    });
    const times = [firstNow, 100];
    let dueCalls = 0;
    await expectFailure(
      leaveEvent({ uid: "target-login" }, { eventId }, repository, {
        lockManager: createLockManager().manager,
        now: () => times.shift() || 100,
        buildDueUpdates: async (input) => {
          dueCalls++;
          assert.deepEqual(input.event.participants, event.participants);
          assert.deepEqual(input.prizeSelections, { "target-profile": "1092" });
          assert.ok(input.ownershipSnapshot);
          return {
            didChange: true,
            updates: decodeEventUpdates({
              [`events/${eventId}/status`]: "active",
              [`events/${eventId}/updatedAtMs`]: 100,
            }),
          };
        },
      }),
      409,
      "This event can no longer be left.",
    );
    assert.equal(dueCalls, 1);
    assert.deepEqual(patches, [
      {
        [`events/${eventId}/status`]: "active",
        [`events/${eventId}/updatedAtMs`]: 100,
      },
    ]);
  }
});

test("does not leave after losing the event lock or when ownership is unavailable", async () => {
  for (const failOwnership of [false, true]) {
    const { patches, repository } = createRepository({
      event: scheduledEvent({
        participants: {
          [profileId]: creatorParticipant(1),
          "target-profile": participant("target-profile", "target-login", 2),
        },
      }),
    });
    if (failOwnership) {
      repository.readProfileOwnershipSnapshot = async () => {
        throw new Error("ownership-offline");
      };
    }
    const lock = createLockManager({ owned: failOwnership });
    await expectFailure(
      leaveEvent({ uid: "target-login" }, { eventId: "event-1" }, repository, {
        lockManager: lock.manager,
        now: () => 100,
      }),
      503,
      failOwnership
        ? "profile-ownership-unavailable"
        : "Event is busy. Please try leaving again.",
    );
    assert.deepEqual(patches, []);
    assert.equal(lock.stopped(), 1);
    assert.equal(lock.released(), 1);
  }
});

test("fails closed for ambiguous participant ownership when leaving", async () => {
  const canonicalProfile = { ...creatorProfile, profileId: "canonical-target" };
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        [profileId]: creatorParticipant(1),
        "retired-target": participant("retired-target", "original-login", 2),
        "canonical-target": participant("canonical-target", "second-login", 3),
      },
    }),
    profilesByUid: {
      "alternate-login": canonicalProfile,
      "original-login": canonicalProfile,
      "second-login": canonicalProfile,
    },
    canonicalProfileIds: { "retired-target": "canonical-target" },
  });
  for (const uid of ["alternate-login", "original-login", "second-login"]) {
    await expectFailure(
      leaveEvent({ uid }, { eventId: "event-1" }, repository, {
        lockManager: createLockManager().manager,
        now: () => 100,
      }),
      503,
      "profile-ownership-unavailable",
    );
  }
  assert.deepEqual(patches, []);
});

test("reconciles an ambiguous committed leave", async () => {
  const { repository } = createRepository({
    event: scheduledEvent({
      participants: {
        [profileId]: creatorParticipant(1),
        "target-profile": participant("target-profile", "target-login", 2),
      },
    }),
    pathValues: {
      "events/event-1/participants/target-profile": null,
      "eventPrizeSelections/event-1/target-profile": null,
      "events/event-1/updatedAtMs": 100,
    },
    patchError: new Error("ambiguous-leave"),
  });
  assert.deepEqual(
    await leaveEvent(
      { uid: "target-login" },
      { eventId: "event-1" },
      repository,
      { lockManager: createLockManager().manager, now: () => 100 },
    ),
    { ok: true, eventId: "event-1", removedProfileId: "target-profile" },
  );
});

test("guards only self-leave commits at the storage deadline", async () => {
  for (const isLeaving of [true, false]) {
    const { repository } = createRepository({
      event: scheduledEvent({
        participants: {
          [profileId]: creatorParticipant(1),
          "target-profile": participant("target-profile", "target-login", 2),
        },
      }),
    });
    const signal = new AbortController().signal;
    const commitOptions: Array<EventCommitOptions | undefined> = [];
    const commit = repository.commitEventPlan;
    repository.commitEventPlan = async (plan, receivedSignal, options) => {
      assert.equal(receivedSignal, signal);
      commitOptions.push(options);
      return commit(plan, receivedSignal, options);
    };
    const dependencies = {
      lockManager: createLockManager().manager,
      now: () => 100,
      signal,
    };
    if (isLeaving) {
      await leaveEvent(
        { uid: "target-login" },
        { eventId: "event-1" },
        repository,
        dependencies,
      );
    } else {
      await removeEventParticipant(
        identity,
        { eventId: "event-1", participantProfileId: "target-profile" },
        repository,
        dependencies,
      );
    }
    assert.deepEqual(commitOptions, [
      isLeaving ? { upcomingEventId: "event-1" } : undefined,
    ]);
  }
});

test("storage deadline rejection starts the unchanged roster without reconciling a leave", async () => {
  const event = scheduledEvent({
    startAtMs: 100,
    participants: {
      [profileId]: creatorParticipant(1),
      "target-profile": participant("target-profile", "target-login", 2),
    },
  });
  const { patches, repository } = createRepository({ event });
  const commit = repository.commitEventPlan;
  const commitOptions: Array<EventCommitOptions | undefined> = [];
  repository.commitEventPlan = async (plan, signal, options) => {
    commitOptions.push(options);
    if (options?.upcomingEventId) throw new EventNotUpcoming();
    return commit(plan, signal, options);
  };
  let reconciliationReads = 0;
  repository.readEventSnapshot = async () => {
    reconciliationReads++;
    return {
      eventId: "event-1",
      event: { updatedAtMs: 99, participants: {} },
      prizeSelections: {},
      revision: 1,
    };
  };
  let dueCalls = 0;
  await expectFailure(
    leaveEvent({ uid: "target-login" }, { eventId: "event-1" }, repository, {
      lockManager: createLockManager().manager,
      now: () => 99,
      buildDueUpdates: async (input) => {
        dueCalls++;
        assert.equal(input.nowMs, 100);
        assert.deepEqual(input.event.participants, event.participants);
        return {
          didChange: true,
          updates: decodeEventUpdates({
            "events/event-1/status": "active",
            "events/event-1/updatedAtMs": 100,
          }),
        };
      },
    }),
    409,
    "This event can no longer be left.",
  );
  assert.equal(dueCalls, 1);
  assert.equal(reconciliationReads, 0);
  assert.deepEqual(commitOptions, [{ upcomingEventId: "event-1" }, undefined]);
  assert.deepEqual(patches, [
    {
      "events/event-1/status": "active",
      "events/event-1/updatedAtMs": 100,
    },
  ]);
});

test("storage guard rejection honors an already started or newly postponed snapshot", async () => {
  for (const latest of [{ status: "active" }, { startAtMs: 1_000 }]) {
    const event = scheduledEvent({
      startAtMs: 100,
      participants: {
        [profileId]: creatorParticipant(1),
        "target-profile": participant("target-profile", "target-login", 2),
      },
    });
    const { patches, repository } = createRepository({ event });
    let eventReads = 0;
    repository.readEvent = async () => {
      eventReads++;
      return structuredClone(eventReads < 3 ? event : { ...event, ...latest });
    };
    repository.commitEventPlan = async () => {
      throw new EventNotUpcoming();
    };
    await expectFailure(
      leaveEvent({ uid: "target-login" }, { eventId: "event-1" }, repository, {
        lockManager: createLockManager().manager,
        now: () => 99,
        buildDueUpdates: async () => {
          assert.fail("must not transition the latest event snapshot");
        },
      }),
      409,
      "This event can no longer be left.",
    );
    assert.equal(eventReads, 3);
    assert.deepEqual(patches, []);
  }
});

test("does not leave when the stored login has lost ownership of its participant", async () => {
  for (const currentProfile of [
    null,
    { ...creatorProfile, profileId: "unrelated-profile" },
  ]) {
    const { patches, repository } = createRepository({
      event: scheduledEvent({
        participants: {
          [profileId]: creatorParticipant(1),
          "target-profile": participant("target-profile", "target-login", 2),
        },
      }),
      profilesByUid: { "target-login": currentProfile },
    });
    await expectFailure(
      leaveEvent({ uid: "target-login" }, { eventId: "event-1" }, repository, {
        lockManager: createLockManager().manager,
        now: () => 100,
      }),
      503,
      "profile-ownership-unavailable",
    );
    assert.deepEqual(patches, []);
  }
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

test("late removal migrates prize selections in the due transition update", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const event = scheduledEvent({
    eventId,
    startAtMs: 100,
    participants: {
      "retired-profile": participant("retired-profile", identity.uid, 1),
      opponent: participant("opponent", "opponent-login", 2),
    },
  });
  const state = createRepository({
    event,
    canonicalProfileIds: {
      "retired-profile": profileId,
      "legacy-selection-profile": profileId,
    },
    pathValues: {
      [`eventPrizeSelections/${eventId}`]: {
        "legacy-selection-profile": "1092",
      },
    },
  });
  let ownershipReads = 0;
  let queriedProfileIds: readonly string[] = [];
  const readOwnership = state.repository.readProfileOwnershipSnapshot;
  state.repository.readProfileOwnershipSnapshot = async (query) => {
    ownershipReads += 1;
    queriedProfileIds = query.profileIds;
    return readOwnership(query);
  };

  await expectFailure(
    removeEventParticipant(
      identity,
      { eventId, participantProfileId: "opponent" },
      state.repository,
      {
        lockManager: createLockManager().manager,
        now: () => 100,
        random: () => 0,
      },
    ),
    409,
    "This event can no longer remove participants.",
  );
  const transition = state.patches.find(
    (patch) => patch[`events/${eventId}/status`] === "active",
  );
  assert.ok(transition);
  assert.deepEqual(transition[`eventPrizeSelections/${eventId}`], {
    [profileId]: "1092",
  });
  assert.ok(transition[`events/${eventId}/participants`]);
  assert.equal(ownershipReads, 1);
  assert.ok(queriedProfileIds.includes("legacy-selection-profile"));
});

test("late removal dismisses a one-player prize event without D1", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const state = createRepository({
    event: scheduledEvent({
      eventId,
      startAtMs: 100,
      participants: { [profileId]: creatorParticipant(1) },
    }),
    pathValues: {
      [`eventPrizeSelections/${eventId}`]: { [profileId]: "1092" },
    },
  });
  let ownershipReads = 0;
  state.repository.readProfileOwnershipSnapshot = async () => {
    ownershipReads += 1;
    throw new Error("d1-unavailable");
  };

  await expectFailure(
    removeEventParticipant(
      identity,
      { eventId, participantProfileId: "missing-profile" },
      state.repository,
      {
        lockManager: createLockManager().manager,
        now: () => 100,
        random: () => 0,
      },
    ),
    409,
    "This event can no longer remove participants.",
  );
  const transition = state.patches.find(
    (patch) => patch[`events/${eventId}/status`] === "dismissed",
  );
  assert.ok(transition);
  assert.equal(transition[`eventPrizeSelections/${eventId}`], null);
  assert.equal(ownershipReads, 0);
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
  const patch = repository.patchStateRoot;
  repository.patchStateRoot = async (updates, signal) => {
    await patch(updates, signal);
    operationController.abort();
    throw patchError;
  };
  const readSnapshot = repository.readEventSnapshot;
  let snapshotReads = 0;
  repository.readEventSnapshot = async (eventId, signal) => {
    snapshotReads += 1;
    assert.notEqual(signal, operationController.signal);
    assert.equal(signal?.aborted, false);
    return readSnapshot(eventId, signal);
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
  assert.equal(snapshotReads, 1);
});

test("requires one removal snapshot to confirm participant, selection, and timestamp", async () => {
  for (const stale of ["participant", "selection", "timestamp"] as const) {
    const target = participant("target-profile", "target-login", 2);
    const patchError = new Error("ambiguous-removal");
    const { repository } = createRepository({
      event: scheduledEvent({
        participants: {
          [profileId]: creatorParticipant(1),
          "target-profile": target,
        },
      }),
      patchError,
    });
    let snapshotReads = 0;
    repository.readEventSnapshot = async (eventId): Promise<EventSnapshot> => {
      snapshotReads += 1;
      return {
        eventId,
        event: {
          updatedAtMs: stale === "timestamp" ? 99 : 100,
          ...(stale === "participant"
            ? { participants: { "target-profile": target } }
            : {}),
        },
        prizeSelections:
          stale === "selection" ? { "target-profile": "1092" } : {},
        revision: 1,
      };
    };
    await assert.rejects(
      removeEventParticipant(
        identity,
        { eventId: "event-1", participantProfileId: "target-profile" },
        repository,
        {
          lockManager: createLockManager().manager,
          now: () => 100,
          buildDueUpdates: noDueTransition,
        },
      ),
      (error) => error === patchError,
    );
    assert.equal(snapshotReads, 1);
  }
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
  const patch = repository.patchStateRoot;
  repository.patchStateRoot = async (...args) => {
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
      now: () => 100,
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
          updates: decodeEventUpdates({
            "events/event-1/status": "active",
            "events/event-1/updatedAtMs": 101,
          }),
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
  repository.transactStatePath = async (path, updater) => {
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

test("rejects early prize changes without saving or clearing a preference", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const nowMs = 10_000_000;
  for (const remainingMs of [3_600_001, 3_600_000]) {
    for (const initialSelection of [null, "1092"]) {
      const { repository } = createRepository({
        event: scheduledEvent({ eventId, startAtMs: nowMs + remainingMs }),
      });
      let stored: unknown = initialSelection;
      let transactions = 0;
      repository.transactStatePath = async (_path, updater) => {
        transactions++;
        const decision = updater(stored);
        assert.ok(
          decision && typeof decision === "object" && "value" in decision,
        );
        stored = decision.value;
        return { committed: true, value: stored };
      };
      const lock = createLockManager();
      await expectFailure(
        toggleEventPrizeSelection(
          identity,
          { eventId, prizeId: "1092" },
          repository,
          { lockManager: lock.manager, now: () => nowMs },
        ),
        409,
        "Prize selection opens less than one hour before the event starts.",
      );
      assert.equal(transactions, 0);
      assert.equal(stored, initialSelection);
      assert.equal(lock.stopped(), 1);
      assert.equal(lock.released(), 1);
    }
  }
});

test("accepts prize choices inside the final hour and after the event starts", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const nowMs = 10_000_000;
  for (const event of [
    scheduledEvent({ eventId, startAtMs: nowMs + 3_599_999 }),
    scheduledEvent({ eventId, startAtMs: nowMs }),
    scheduledEvent({ eventId, startAtMs: nowMs - 1 }),
    scheduledEvent({ eventId, status: "active", startAtMs: null }),
  ]) {
    const { repository } = createRepository({ event });
    let transactions = 0;
    repository.transactStatePath = async (_path, updater) => {
      transactions++;
      const decision = updater(null);
      assert.ok(
        decision && typeof decision === "object" && "value" in decision,
      );
      return { committed: true, value: decision.value };
    };
    const response = await toggleEventPrizeSelection(
      identity,
      { eventId, prizeId: "1092" },
      repository,
      { lockManager: createLockManager().manager, now: () => nowMs },
    );
    assert.equal(response.selectedPrizeId, "1092");
    assert.equal(transactions, 1);
  }
});

test("uses the postponed start from the locked event read for prize selection", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const nowMs = 10_000_000;
  const event = scheduledEvent({ eventId, startAtMs: nowMs + 3_599_999 });
  const { repository } = createRepository({ event });
  let transactions = 0;
  repository.transactStatePath = async () => {
    transactions++;
    return { committed: true, value: "1092" };
  };
  const lock = createLockManager({
    onAcquire: () => {
      event.startAtMs = nowMs + 3_600_000;
    },
  });
  await expectFailure(
    toggleEventPrizeSelection(
      identity,
      { eventId, prizeId: "1092" },
      repository,
      { lockManager: lock.manager, now: () => nowMs },
    ),
    409,
    "Prize selection opens less than one hour before the event starts.",
  );
  assert.equal(transactions, 0);
  assert.equal(lock.released(), 1);
});

test("rejects invalid scheduled prize timestamps before saving", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  for (const startAtMs of [null, undefined, "1000", NaN, Infinity, -1, 0.5]) {
    const { repository } = createRepository({
      event: scheduledEvent({ eventId, startAtMs }),
    });
    let transactions = 0;
    repository.transactStatePath = async () => {
      transactions++;
      return { committed: true, value: "1092" };
    };
    await expectFailure(
      toggleEventPrizeSelection(
        identity,
        { eventId, prizeId: "1092" },
        repository,
        { lockManager: createLockManager().manager, now: () => 0 },
      ),
      503,
      "event-participation-service-unavailable",
    );
    assert.equal(transactions, 0);
  }
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
  repository.transactStatePath = async (receivedPath, updater) => {
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
  repository.transactStatePath = async (_path, updater) => {
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
  repository.transactStatePath = async (receivedPath, updater) => {
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
  repository.transactStatePath = async (receivedPath, updater) => {
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
  repository.transactStatePath = async () => {
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

const participationLockCases: Array<{
  name: string;
  run: (
    repository: EventParticipationRepository,
    dependencies: EventParticipationDependencies,
  ) => Promise<unknown>;
}> = [
  {
    name: "join",
    run: (repository, dependencies) =>
      joinEvent(
        identity,
        { eventId: LEGACY_CORE_PRIZES_EVENT_ID },
        repository,
        dependencies,
      ),
  },
  {
    name: "leave",
    run: (repository, dependencies) =>
      leaveEvent(
        { uid: "target-login" },
        { eventId: LEGACY_CORE_PRIZES_EVENT_ID },
        repository,
        dependencies,
      ),
  },
  {
    name: "remove",
    run: (repository, dependencies) =>
      removeEventParticipant(
        identity,
        {
          eventId: LEGACY_CORE_PRIZES_EVENT_ID,
          participantProfileId: "target-profile",
        },
        repository,
        dependencies,
      ),
  },
  {
    name: "prize selection",
    run: (repository, dependencies) =>
      toggleEventPrizeSelection(
        identity,
        { eventId: LEGACY_CORE_PRIZES_EVENT_ID, prizeId: "1092" },
        repository,
        dependencies,
      ),
  },
];

function createParticipationLockRepository() {
  return createRepository({
    event: scheduledEvent({
      eventId: LEGACY_CORE_PRIZES_EVENT_ID,
      participants: {
        [profileId]: creatorParticipant(1),
        "target-profile": participant("target-profile", "target-login", 2),
      },
    }),
  });
}

for (const operation of participationLockCases) {
  test(`${operation.name} cleans up only an acquired participation lock`, async (t) => {
    for (const outcome of [
      "success",
      "read failure",
      "write failure",
      "busy",
      "acquisition failure",
      "lost ownership",
    ]) {
      await t.test(outcome, async () => {
        const { repository } = createParticipationLockRepository();
        const failure = new Error(outcome);
        const lifecycle: string[] = [];
        let acquired = false;
        let lockedReads = 0;
        let writes = 0;
        const lock = createLockManager({
          acquired: outcome !== "busy",
          owned: outcome !== "lost ownership",
          onAcquire: () => {
            lifecycle.push("acquire");
            if (outcome === "acquisition failure") throw failure;
            acquired = outcome !== "busy";
          },
        });
        const startHeartbeat = lock.manager.startEventLockHeartbeat;
        lock.manager.startEventLockHeartbeat = (handle) => {
          lifecycle.push("start");
          const stop = startHeartbeat(handle);
          return () => {
            lifecycle.push("stop");
            stop();
          };
        };
        const release = lock.manager.releaseEventLock;
        lock.manager.releaseEventLock = async (handle) => {
          lifecycle.push("release");
          return release(handle);
        };
        const checkRead = () => {
          if (!acquired) return;
          lockedReads++;
          if (outcome === "read failure") throw failure;
        };
        const read = repository.readEvent;
        repository.readEvent = async (...args) => {
          checkRead();
          return read(...args);
        };
        const readSnapshot = repository.readEventSnapshot;
        repository.readEventSnapshot = async (...args) => {
          checkRead();
          return readSnapshot(...args);
        };
        const checkWrite = () => {
          writes++;
          if (outcome === "write failure") throw failure;
        };
        const commit = repository.commitEventPlan;
        repository.commitEventPlan = async (...args) => {
          checkWrite();
          return commit(...args);
        };
        repository.transactEventPrizeSelection = async () => {
          checkWrite();
          return { committed: true, value: "1092" };
        };

        const pending = operation.run(repository, {
          lockManager: lock.manager,
          now: () => 100,
          buildDueUpdates: noDueTransition,
        });
        if (outcome === "success") await pending;
        else
          await assert.rejects(pending, (error) => {
            if (outcome === "busy" || outcome === "lost ownership") {
              assert.ok(error instanceof AuthApiFailure);
              assert.equal(error.status, 503);
            } else assert.equal(error, failure);
            return true;
          });

        assert.deepEqual(
          lifecycle,
          acquired ? ["acquire", "start", "stop", "release"] : ["acquire"],
        );
        assert.equal(lock.stopped(), acquired ? 1 : 0);
        assert.equal(lock.released(), acquired ? 1 : 0);
        assert.equal(lockedReads > 0, acquired);
        assert.equal(
          writes,
          outcome === "success" || outcome === "write failure" ? 1 : 0,
        );
      });
    }
  });

  test(`${operation.name} releases its default lock after cancellation without the aborted signal`, async () => {
    const { patches, repository } = createParticipationLockRepository();
    const controller = new AbortController();
    const failure = new Error("participation-cancelled");
    const signals: Array<AbortSignal | undefined> = [];
    let lease: EventLeaseRecord | null = null;
    repository.transactEventLease = async (_key, updater, signal) => {
      signals.push(signal);
      signal?.throwIfAborted();
      const decision = updater(lease);
      if ("commit" in decision)
        return { committed: false, value: lease, decision: decision.decision };
      lease = decision.value;
      return { committed: true, value: lease, decision: decision.decision };
    };
    const read = repository.readEvent;
    repository.readEvent = async (...args) => {
      const result = await read(...args);
      if (lease) controller.abort(failure);
      return result;
    };
    const readSnapshot = repository.readEventSnapshot;
    repository.readEventSnapshot = async (...args) => {
      const result = await readSnapshot(...args);
      controller.abort(failure);
      return result;
    };
    repository.transactEventPrizeSelection = async () => {
      assert.fail("cancelled participation wrote a prize selection");
    };

    await assert.rejects(
      operation.run(repository, {
        signal: controller.signal,
        now: () => 100,
        buildDueUpdates: noDueTransition,
      }),
      (error) => error === failure,
    );

    assert.deepEqual(signals, [
      controller.signal,
      controller.signal,
      undefined,
    ]);
    assert.equal(lease, null);
    assert.deepEqual(patches, []);
  });
}
