"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { event: eventFixture } = require("./fixtures/canonicalEvents");
const { createSeededRandom } = require("../runtime/shared/ids");
const {
  LEGACY_CORE_PRIZES_EVENT_ID,
} = require("../runtime/shared/event-prizes");
const {
  buildScheduledEventDueUpdatesCore: buildTypedScheduledEventDueUpdatesCore,
} = require("../runtime/events/startTransitionCore");

const {
  encodeEventUpdates,
} = require("../workers/api/test/eventLegacyFixtureCodec.ts");
/** @param {Parameters<typeof buildTypedScheduledEventDueUpdatesCore>[0]} input */
const buildScheduledEventDueUpdatesCore = async (input) => {
  const result = await buildTypedScheduledEventDueUpdatesCore(input);
  return { ...result, updates: encodeEventUpdates(result.updates) };
};

/** @param {number} index @returns {import("../runtime/shared/events").EventParticipantRecord} */
const createParticipant = (index) => ({
  profileId: `profile-${index}`,
  loginUid: `login-${index}`,
  username: `player-${index}`,
  displayName: `player-${index}`,
  emojiId: index + 1,
  aura: "none",
  joinedAtMs: index,
  state: "active",
  eliminatedRoundIndex: null,
  eliminatedByProfileId: null,
});

/** @param {number} count */
const createEvent = (count) =>
  eventFixture({
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

/**
 * @typedef {import("../runtime/events/ownership").EventOwnershipSnapshot} OwnershipSnapshot
 * @typedef {{[Field in keyof OwnershipSnapshot]: OwnershipSnapshot[Field] extends ReadonlyMap<infer Key, infer Value> ? Map<Key, Value> : never}} MutableOwnership
 */
/** @param {import("../runtime/shared/events").EventRecord} event @param {{canonicalProfileIds?: Record<string, string | null>, loginOwners?: Record<string, string | null>}} [options] */
const ownershipSnapshot = (
  event,
  { canonicalProfileIds = {}, loginOwners = {} } = {},
) => {
  const participants = Object.entries(event.participants || {});
  /** @type {MutableOwnership["canonicalProfileIdByProfileId"]} */
  const canonicalProfileIdByProfileId = new Map();
  /** @type {MutableOwnership["loginOwnerByUid"]} */
  const loginOwnerByUid = new Map();
  /** @type {MutableOwnership["profileById"]} */
  const profileById = new Map();
  /** @type {MutableOwnership["loginUidsByProfileId"]} */
  const loginUidsByProfileId = new Map();
  for (const [key, participant] of participants) {
    const storedProfileId = participant.profileId || key;
    for (const candidateProfileId of [key, storedProfileId]) {
      const canonicalProfileId = Object.hasOwn(
        canonicalProfileIds,
        candidateProfileId,
      )
        ? (canonicalProfileIds[candidateProfileId] ?? null)
        : candidateProfileId;
      canonicalProfileIdByProfileId.set(candidateProfileId, canonicalProfileId);
      if (canonicalProfileId && !profileById.has(canonicalProfileId)) {
        profileById.set(canonicalProfileId, {
          profile: {
            aura: "none",
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
    if (participant.loginUid === null) continue;
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

/** @param {number} count */
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

/** @param {import("../runtime/shared/events").EventRecord} event @param {Record<string, string>} prizeSelections @param {OwnershipSnapshot | null} snapshot */
const prizeTransition = (event, prizeSelections, snapshot) =>
  buildScheduledEventDueUpdatesCore({
    eventId: LEGACY_CORE_PRIZES_EVENT_ID,
    event: { ...event, eventId: LEGACY_CORE_PRIZES_EVENT_ID },
    nowMs: 100,
    random: createSeededRandom("prize-selections"),
    buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
    ownershipSnapshot: snapshot,
    prizeSelections,
  });

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
  for (const [
    count,
    bracketSize,
    firstRoundInvites,
  ] of /** @type {[number, number, number][]} */ ([
    [2, 2, 1],
    [3, 4, 1],
    [4, 4, 2],
    [32, 32, 16],
  ])) {
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
  assert.ok(event.participants["profile-1"]);
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

test("profile-only participants remain stored but cannot start a match without login ownership", async () => {
  const event = createEvent(2);
  assert.ok(event.participants["profile-1"]);
  event.participants["profile-1"].loginUid = null;
  const original = structuredClone(event);
  const snapshot = ownershipSnapshot(event);
  snapshot.loginUidsByProfileId.set("profile-1", []);
  await assert.rejects(
    buildScheduledEventDueUpdatesCore({
      eventId: event.eventId,
      event,
      nowMs: 100,
      random: createSeededRandom("profile-only"),
      buildRandomGameSeed: () =>
        assert.fail("unowned participant cannot create a game"),
      ownershipSnapshot: snapshot,
    }),
    /profile-ownership-unavailable/,
  );
  assert.deepEqual(event, original);
  assert.equal(event.participants["profile-1"].loginUid, null);
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
      error instanceof Error &&
      "code" in error &&
      error.code === "unavailable" &&
      error.message === "profile-ownership-unavailable",
  );
  assert.equal(event.status, "scheduled");
  assert.deepEqual(event.rounds, {});
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

test("moves prize selections with canonical participant rekeying", async () => {
  const event = createEvent(2);
  assert.ok(event.participants["profile-0"]);
  event.participants["source-key"] = {
    ...event.participants["profile-0"],
    profileId: "source-key",
  };
  delete event.participants["profile-0"];
  const snapshot = ownershipSnapshot(event, {
    canonicalProfileIds: { "source-key": "canonical-profile" },
  });
  const result = await prizeTransition(
    event,
    { "source-key": "1092" },
    snapshot,
  );

  assert.deepEqual(
    result.updates[`eventPrizeSelections/${LEGACY_CORE_PRIZES_EVENT_ID}`],
    { "canonical-profile": "1092" },
  );
  const updatedParticipants =
    result.updates[`events/${LEGACY_CORE_PRIZES_EVENT_ID}/participants`];
  assert.ok(
    updatedParticipants &&
      typeof updatedParticipants === "object" &&
      "canonical-profile" in updatedParticipants,
  );
});

test("collapses equal participant selection aliases", async () => {
  const event = createEvent(2);
  assert.ok(event.participants["profile-0"]);
  event.participants["source-key"] = {
    ...event.participants["profile-0"],
    profileId: "source-key",
  };
  delete event.participants["profile-0"];
  const snapshot = ownershipSnapshot(event, {
    canonicalProfileIds: { "source-key": "canonical-profile" },
  });
  snapshot.canonicalProfileIdByProfileId.set(
    "embedded-profile",
    "canonical-profile",
  );
  const result = await prizeTransition(
    event,
    {
      "source-key": "1092",
      "embedded-profile": "1092",
      "canonical-profile": "1092",
    },
    snapshot,
  );

  assert.deepEqual(
    result.updates[`eventPrizeSelections/${LEGACY_CORE_PRIZES_EVENT_ID}`],
    { "canonical-profile": "1092" },
  );
});

test("rejects conflicting participant selection aliases without mutation", async () => {
  const event = createEvent(2);
  assert.ok(event.participants["profile-0"]);
  event.participants["source-key"] = {
    ...event.participants["profile-0"],
    profileId: "source-key",
  };
  delete event.participants["profile-0"];
  const originalEvent = structuredClone(event);
  const snapshot = ownershipSnapshot(event, {
    canonicalProfileIds: { "source-key": "canonical-profile" },
  });

  await assert.rejects(
    prizeTransition(
      event,
      { "source-key": "1092", "canonical-profile": "1111" },
      snapshot,
    ),
    /profile-ownership-unavailable/,
  );
  assert.deepEqual(event, originalEvent);
});

test("drops selections that do not belong to current participants", async () => {
  const event = createEvent(2);
  const result = await prizeTransition(
    event,
    { "removed-profile": "1092" },
    ownershipSnapshot(event),
  );

  assert.equal(
    result.updates[`eventPrizeSelections/${LEGACY_CORE_PRIZES_EVENT_ID}`],
    null,
  );
});

test("requires selections for configured prize events due to start", async () => {
  const event = createEvent(2);
  event.eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const originalEvent = structuredClone(event);

  await assert.rejects(
    buildScheduledEventDueUpdatesCore({
      eventId: LEGACY_CORE_PRIZES_EVENT_ID,
      event,
      nowMs: 100,
      random: createSeededRandom("missing-prize-selections"),
      buildRandomGameSeed: () => ({
        gameVariant: "Classic",
        fen: "start-fen",
      }),
      ownershipSnapshot: ownershipSnapshot(event),
    }),
    /profile-ownership-unavailable/,
  );
  assert.deepEqual(event, originalEvent);
});

test("dismisses one-participant prize events without ownership canonicalization", async () => {
  for (const [
    prizeSelections,
    snapshot,
  ] of /** @type {[Record<string, string>, null][]} */ ([
    [{ "legacy-selection": "1092" }, null],
    [{}, null],
  ])) {
    const event = createEvent(1);
    const result = await prizeTransition(event, prizeSelections, snapshot);

    assert.equal(
      result.updates[`events/${LEGACY_CORE_PRIZES_EVENT_ID}/status`],
      "dismissed",
    );
    assert.equal(
      result.updates[`eventPrizeSelections/${LEGACY_CORE_PRIZES_EVENT_ID}`],
      Object.keys(prizeSelections).length ? null : undefined,
    );
  }
});

test("leaves future and already-transitioned events unchanged", async () => {
  const future = createEvent(2);
  future.startAtMs = 101;
  assert.deepEqual(
    await buildScheduledEventDueUpdatesCore({
      eventId: "event-1",
      event: future,
      ownershipSnapshot: null,
      nowMs: 100,
      random: createSeededRandom("future"),
      buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
    }),
    { didChange: false, updates: {} },
  );
  const active = eventFixture({
    status: "active",
    participants: createEvent(2).participants,
  });
  assert.deepEqual(
    await buildScheduledEventDueUpdatesCore({
      eventId: "event-1",
      event: active,
      ownershipSnapshot: null,
      nowMs: 100,
      random: createSeededRandom("active"),
      buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
    }),
    { didChange: false, updates: {} },
  );
});
