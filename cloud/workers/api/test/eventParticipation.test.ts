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

const identity = {
  uid: "creator-login",
  idToken: "firebase-token",
  profileId: "creator-profile",
};

const creatorProfile: GameplayProfile = {
  profileId: "creator-profile",
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
  ...participant(identity.profileId, identity.uid, joinedAtMs),
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
    createdByProfileId: identity.profileId,
    participants: {
      [identity.profileId]: participant(identity.profileId, identity.uid, 1),
    },
    ...overrides,
  };
}

function createRepository({
  event = scheduledEvent(),
  profile = creatorProfile,
  pathValues = {},
  patchError,
}: {
  event?: Record<string, unknown> | null;
  profile?: GameplayProfile | null;
  pathValues?: Record<string, unknown>;
  patchError?: Error;
} = {}) {
  const patches: Record<string, unknown>[] = [];
  const repository: EventParticipationRepository = {
    getGameplayProfile: async () => profile,
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

function createLockManager({ owned = true, acquired = true } = {}) {
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
    acquireEventLock: async () => (acquired ? handle : null),
    acquireEventLockWithRetry: async () => (acquired ? handle : null),
    getEventLockGuard: () => ({
      lockRoot: "eventLocks",
      eventId: "event-1",
      lockId: "lock-1",
      ownerUid: identity.uid,
    }),
    isEventLockStillOwned: async () => owned,
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

test("joins a scheduled event and preserves an existing joined timestamp", async () => {
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        [identity.profileId]: participant(identity.profileId, identity.uid, 50),
      },
    }),
  });
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
  assert.equal(response.participant.displayName, "creator");
  assert.deepEqual(patches, [
    {
      "events/event-1/participants/creator-profile": response.participant,
      "events/event-1/updatedAtMs": 100,
    },
  ]);
  assert.equal(lock.stopped(), 1);
  assert.equal(lock.released(), 1);
});

test("normalizes non-finite emoji metadata before writing", async () => {
  const { patches, repository } = createRepository({
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
      createRepository({ profile: null }).repository,
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
  const stored = creatorParticipant(1);
  const { repository } = createRepository({
    patchError: new Error("ambiguous"),
    pathValues: {
      [`events/event-1/participants/${identity.profileId}`]: stored,
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
    patchError,
    pathValues: {
      [`events/event-1/participants/${identity.profileId}`]:
        creatorParticipant(1),
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
    patchError,
    pathValues: {
      [`events/event-1/participants/${identity.profileId}`]: participant(
        identity.profileId,
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
  const stored = creatorParticipant(1);
  const patchError = new Error("ambiguous");
  const { repository } = createRepository({
    patchError,
    pathValues: {
      [`events/event-1/participants/${identity.profileId}`]: stored,
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
  const stored = creatorParticipant(1);
  const { repository } = createRepository({
    patchError: new Error("ambiguous"),
    pathValues: {
      [`events/event-1/participants/${identity.profileId}`]: stored,
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

test("threads one operation signal through profile, event, and commit calls", async () => {
  const signal = AbortSignal.timeout(1_000);
  const seen: AbortSignal[] = [];
  const repository = createRepository().repository;
  repository.getGameplayProfile = async (_uid, _token, receivedSignal) => {
    assert.ok(receivedSignal);
    seen.push(receivedSignal);
    return creatorProfile;
  };
  repository.getRtdbPath = async (_path, _query, receivedSignal) => {
    assert.ok(receivedSignal);
    seen.push(receivedSignal);
    return scheduledEvent();
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
  assert.deepEqual(seen, [signal, signal, signal]);
});

test("removes a non-creator participant and its prize selection", async () => {
  const target = participant("target-profile", "target-login", 2);
  const { patches, repository } = createRepository({
    event: scheduledEvent({
      participants: {
        [identity.profileId]: participant(identity.profileId, identity.uid, 1),
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

test("reconciles an ambiguous committed removal", async () => {
  const target = participant("target-profile", "target-login", 2);
  const operationController = new AbortController();
  const patchError = new Error("ambiguous");
  const { repository } = createRepository({
    event: scheduledEvent({
      participants: {
        [identity.profileId]: participant(identity.profileId, identity.uid, 1),
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
      [identity.profileId]: participant(identity.profileId, identity.uid, 1),
      "target-profile": target,
    },
  });
  const lock = createLockManager();
  await expectFailure(
    removeEventParticipant(
      { ...identity, uid: "other-login", profileId: "other-profile" },
      { eventId: "event-1", participantProfileId: "target-profile" },
      createRepository({
        event,
        profile: { ...creatorProfile, profileId: "other-profile" },
      }).repository,
      { lockManager: lock.manager, buildDueUpdates: noDueTransition },
    ),
    403,
    "Only the event creator can remove participants.",
  );
  await expectFailure(
    removeEventParticipant(
      identity,
      { eventId: "event-1", participantProfileId: identity.profileId },
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
        [identity.profileId]: participant(identity.profileId, identity.uid, 1),
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
    `eventPrizeSelections/${eventId}/${identity.profileId}`,
    `eventPrizeSelections/${eventId}/${identity.profileId}`,
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
