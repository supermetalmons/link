"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyMatchResolution,
  buildFixedBracketState,
  buildSeedToProfileId,
  createEmptyEventMatch,
  getEventPrizePlacements,
  rebuildParticipantStatesFromRounds,
  recomputeRoundStatuses,
  setMatchSlotBlocked,
  setMatchSlotParticipant,
} = require("../functions/events/bracket");

const participant = (profileId, joinedAtMs) => ({
  profileId,
  loginUid: `${profileId}-login`,
  displayName: profileId.toUpperCase(),
  emojiId: joinedAtMs,
  aura: null,
  joinedAtMs,
});

test("seed assignment shuffles the full participant pool without username priority", () => {
  const seedToProfileId = buildSeedToProfileId({
    participantIds: ["listed-player", "player-2", "player-3"],
    random: () => 0,
  });

  assert.deepEqual(Array.from(seedToProfileId.entries()), [
    [1, "player-2"],
    [2, "player-3"],
    [3, "listed-player"],
  ]);
});

test("empty matches preserve their persisted schema and slot mutations", () => {
  const match = createEmptyEventMatch("0_0");

  assert.deepEqual(match, {
    matchKey: "0_0",
    inviteId: null,
    status: "upcoming",
    resolvedAtMs: null,
    winnerDisqualified: false,
    winnerProfileId: null,
    loserProfileId: null,
    hostSlotBlocked: false,
    hostProfileId: null,
    hostLoginUid: null,
    hostDisplayName: null,
    hostEmojiId: null,
    hostAura: null,
    guestSlotBlocked: false,
    guestProfileId: null,
    guestLoginUid: null,
    guestDisplayName: null,
    guestEmojiId: null,
    guestAura: null,
  });
  assert.equal(setMatchSlotBlocked(match, "host", true), true);
  assert.equal(setMatchSlotBlocked(match, "host", true), false);
  assert.equal(
    setMatchSlotParticipant(match, "host", participant("p1", 1)),
    true,
  );
  assert.equal(match.hostSlotBlocked, false);
  assert.deepEqual(
    {
      profileId: match.hostProfileId,
      loginUid: match.hostLoginUid,
      displayName: match.hostDisplayName,
      emojiId: match.hostEmojiId,
      aura: match.hostAura,
    },
    {
      profileId: "p1",
      loginUid: "p1-login",
      displayName: "P1",
      emojiId: 1,
      aura: null,
    },
  );
});

test("round status and participant state derivation preserve elimination order", () => {
  const nowMs = 1_800_000_000_000;
  const participantsById = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
    p3: participant("p3", 3),
    p4: participant("p4", 4),
  };
  const first = createEmptyEventMatch("0_0");
  const second = createEmptyEventMatch("0_1");
  const final = createEmptyEventMatch("1_0");
  setMatchSlotParticipant(first, "host", participantsById.p1);
  setMatchSlotParticipant(first, "guest", participantsById.p2);
  setMatchSlotParticipant(second, "host", participantsById.p3);
  setMatchSlotParticipant(second, "guest", participantsById.p4);
  setMatchSlotParticipant(final, "host", participantsById.p1);
  setMatchSlotParticipant(final, "guest", participantsById.p3);
  applyMatchResolution(
    first,
    { status: "host", winnerProfileId: "p1", loserProfileId: "p2" },
    nowMs - 2,
  );
  applyMatchResolution(
    second,
    { status: "host", winnerProfileId: "p3", loserProfileId: "p4" },
    nowMs - 1,
  );
  const rounds = {
    0: {
      status: "active",
      completedAtMs: null,
      matches: { "0_0": first, "0_1": second },
    },
    1: {
      status: "upcoming",
      completedAtMs: nowMs - 10,
      matches: { "1_0": final },
    },
  };

  assert.deepEqual(recomputeRoundStatuses({ rounds, nowMs }), {
    didChange: true,
    finalRoundIndex: 1,
    earliestUnresolvedRoundIndex: 1,
    finalRoundWinnerProfileId: null,
  });
  assert.equal(rounds["0"].status, "completed");
  assert.equal(rounds["0"].completedAtMs, nowMs);
  assert.equal(rounds["1"].status, "active");
  assert.equal(rounds["1"].completedAtMs, null);

  applyMatchResolution(
    final,
    { status: "host", winnerProfileId: "p1", loserProfileId: "p3" },
    nowMs,
  );
  assert.equal(
    recomputeRoundStatuses({ rounds, nowMs }).finalRoundWinnerProfileId,
    "p1",
  );
  const rebuilt = rebuildParticipantStatesFromRounds({
    participantsById,
    rounds,
    winnerProfileId: "p1",
    eventEnded: true,
  });
  assert.equal(rebuilt.didChange, true);
  assert.equal(rebuilt.participantsById.p1.state, "winner");
  assert.deepEqual(
    {
      state: rebuilt.participantsById.p3.state,
      eliminatedRoundIndex: rebuilt.participantsById.p3.eliminatedRoundIndex,
      eliminatedByProfileId: rebuilt.participantsById.p3.eliminatedByProfileId,
    },
    {
      state: "eliminated",
      eliminatedRoundIndex: 1,
      eliminatedByProfileId: "p1",
    },
  );
});

test("fixed brackets represent byes without changing invite or round shapes", async () => {
  const participantsById = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
    p3: participant("p3", 3),
  };
  const bracket = await buildFixedBracketState({
    eventId: "event-test",
    participantIds: Object.keys(participantsById),
    participantsById,
    nowMs: 1_800_000_000_000,
    enableThirdPlace: false,
  });
  const firstRoundMatches = Object.values(bracket.rounds["0"].matches);

  assert.equal(bracket.bracketSize, 4);
  assert.equal(bracket.roundCount, 2);
  assert.equal(bracket.thirdPlaceMatch, null);
  assert.equal(
    firstRoundMatches.filter((match) => match.status === "bye").length,
    1,
  );
  assert.equal(
    firstRoundMatches.filter((match) => match.status === "pending").length,
    1,
  );
  assert.equal(Object.keys(bracket.inviteUpdates).length, 3);
});

test("prize placement follows final and third-place results and rejects a disqualified winner", () => {
  const participantsById = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
    p3: participant("p3", 3),
    p4: participant("p4", 4),
  };
  const final = {
    status: "host",
    hostProfileId: "p1",
    hostLoginUid: "p1-login",
    guestProfileId: "p2",
    guestLoginUid: "p2-login",
    winnerProfileId: "p1",
    loserProfileId: "p2",
  };
  const thirdPlaceMatch = {
    status: "guest",
    hostProfileId: "p3",
    hostLoginUid: "p3-login",
    guestProfileId: "p4",
    guestLoginUid: "p4-login",
    winnerProfileId: "p4",
    loserProfileId: "p3",
  };
  const rounds = {
    1: { matches: { "1_0": final } },
  };

  assert.deepEqual(
    getEventPrizePlacements({
      event: { winnerProfileId: "p1" },
      rounds,
      participantsById,
      thirdPlaceMatch,
    }),
    [
      { place: 1, profileId: "p1" },
      { place: 2, profileId: "p2" },
      { place: 3, profileId: "p4" },
    ],
  );
  final.winnerDisqualified = true;
  assert.deepEqual(
    getEventPrizePlacements({
      event: { winnerProfileId: "p1" },
      rounds,
      participantsById,
      thirdPlaceMatch,
    }),
    [],
  );
});
