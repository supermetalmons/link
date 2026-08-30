"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSeededRandom } = require("../functions/shared/ids");
const {
  buildScheduledEventDueUpdatesCore,
} = require("../functions/events/startTransitionCore");

const createParticipant = (index) => ({
  profileId: `profile-${index}`,
  loginUid: `login-${index}`,
  username: `player-${index}`,
  displayName: `player-${index}`,
  emojiId: index + 1,
  aura: "",
  joinedAtMs: index,
  state: "active",
  eliminatedRoundIndex: null,
  eliminatedByProfileId: null,
});

const createEvent = (count) => ({
  eventId: "event-1",
  status: "scheduled",
  startAtMs: 100,
  supportsThirdPlaceMatch: true,
  thirdPlaceMatch: null,
  participants: Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `profile-${index}`,
      createParticipant(index),
    ]),
  ),
});

const ownershipSnapshot = (
  event,
  { canonicalProfileIds = {}, loginOwners = {} } = {},
) => {
  const participants = Object.entries(event.participants || {});
  const canonicalProfileIdByProfileId = new Map();
  const loginOwnerByUid = new Map();
  const profileById = new Map();
  const loginUidsByProfileId = new Map();
  for (const [key, participant] of participants) {
    const storedProfileId = participant.profileId || key;
    for (const candidateProfileId of [key, storedProfileId]) {
      const canonicalProfileId = Object.hasOwn(
        canonicalProfileIds,
        candidateProfileId,
      )
        ? canonicalProfileIds[candidateProfileId]
        : candidateProfileId;
      canonicalProfileIdByProfileId.set(candidateProfileId, canonicalProfileId);
      if (canonicalProfileId && !profileById.has(canonicalProfileId)) {
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
        loginUidsByProfileId.set(canonicalProfileId, []);
      }
    }
    const ownerProfileId = Object.hasOwn(loginOwners, participant.loginUid)
      ? loginOwners[participant.loginUid]
      : canonicalProfileIdByProfileId.get(storedProfileId);
    loginOwnerByUid.set(
      participant.loginUid,
      ownerProfileId ? { profileId: ownerProfileId, revision: 1 } : null,
    );
    if (ownerProfileId) {
      loginUidsByProfileId.set(ownerProfileId, [
        ...(loginUidsByProfileId.get(ownerProfileId) || []),
        participant.loginUid,
      ]);
    }
  }
  return {
    canonicalProfileIdByProfileId,
    loginOwnerByUid,
    loginUidsByProfileId,
    profileById,
  };
};

const transition = (count) => {
  const event = createEvent(count);
  return buildScheduledEventDueUpdatesCore({
    eventId: "event-1",
    event,
    nowMs: 100,
    random: createSeededRandom(`participants:${count}`),
    buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
    ownershipSnapshot: ownershipSnapshot(event),
  });
};

test("dismisses overdue events with fewer than two participants", async () => {
  for (const count of [0, 1]) {
    const result = await transition(count);
    assert.equal(result.didChange, true);
    assert.equal(result.updates["events/event-1/status"], "dismissed");
    assert.equal(result.updates["events/event-1/endedAtMs"], 100);
    assert.equal(
      Object.keys(result.updates).some((path) => path.startsWith("invites/")),
      false,
    );
  }
});

test("builds complete overdue brackets for supported participant counts", async () => {
  for (const [count, bracketSize, firstRoundInvites] of [
    [2, 2, 1],
    [3, 4, 1],
    [4, 4, 2],
    [32, 32, 16],
  ]) {
    const result = await transition(count);
    assert.equal(result.didChange, true);
    assert.equal(result.updates["events/event-1/status"], "active");
    assert.equal(result.updates["events/event-1/bracketSize"], bracketSize);
    assert.equal(
      Object.keys(result.updates).filter((path) => path.startsWith("invites/"))
        .length,
      firstRoundInvites,
    );
    assert.ok(result.updates["events/event-1/rounds"]);
    if (count >= 4) {
      assert.ok("events/event-1/thirdPlaceMatch" in result.updates);
    }
  }
});

test("rejects duplicate canonical participants before creating a bracket", async () => {
  const event = createEvent(3);
  event.participants["profile-1"] = {
    ...event.participants["profile-1"],
    loginUid: "login-0",
  };
  await assert.rejects(
    buildScheduledEventDueUpdatesCore({
      eventId: "event-1",
      event,
      nowMs: 100,
      random: createSeededRandom("merged-participants"),
      buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
      ownershipSnapshot: ownershipSnapshot(event, {
        canonicalProfileIds: { "profile-1": "profile-0" },
      }),
    }),
    /profile-ownership-unavailable/,
  );
});

test("rejects contradictory participants with one canonical profile", async () => {
  const event = createEvent(2);
  await assert.rejects(
    buildScheduledEventDueUpdatesCore({
      eventId: "event-1",
      event,
      nowMs: 100,
      random: createSeededRandom("contradictory-participants"),
      buildRandomGameSeed: () => ({
        gameVariant: "Classic",
        fen: "start-fen",
      }),
      ownershipSnapshot: ownershipSnapshot(event, {
        canonicalProfileIds: { "profile-1": "profile-0" },
        loginOwners: { "login-1": "profile-0" },
      }),
    }),
    (error) =>
      error?.code === "unavailable" &&
      error.message === "profile-ownership-unavailable",
  );
  assert.equal(event.status, "scheduled");
  assert.equal(event.rounds, undefined);
});

test("uses one ownership snapshot for the complete bracket decision", async () => {
  const event = createEvent(2);
  const snapshot = ownershipSnapshot(event);
  const result = await buildScheduledEventDueUpdatesCore({
    eventId: "event-1",
    event,
    nowMs: 100,
    random: createSeededRandom("participant-race"),
    buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
    ownershipSnapshot: snapshot,
  });
  snapshot.canonicalProfileIdByProfileId.set("profile-1", "profile-0");
  assert.equal(result.updates["events/event-1/status"], "active");
  assert.equal("assertOwnershipUnchanged" in result, false);
});

test("leaves future and already-transitioned events unchanged", async () => {
  const future = createEvent(2);
  future.startAtMs = 101;
  assert.deepEqual(
    await buildScheduledEventDueUpdatesCore({
      eventId: "event-1",
      event: future,
      nowMs: 100,
      random: createSeededRandom("future"),
      buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
    }),
    { didChange: false, updates: {} },
  );
  const active = createEvent(2);
  active.status = "active";
  assert.deepEqual(
    await buildScheduledEventDueUpdatesCore({
      eventId: "event-1",
      event: active,
      nowMs: 100,
      random: createSeededRandom("active"),
      buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
    }),
    { didChange: false, updates: {} },
  );
});
