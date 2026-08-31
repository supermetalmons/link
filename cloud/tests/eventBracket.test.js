"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyMatchResolution,
  buildFixedBracketState,
  buildSeedToProfileId,
  createEventBracketRuntime,
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

const ownershipSnapshot = (
  participantsById,
  { canonicalProfileIds = {}, loginOwners = {} } = {},
) => {
  const canonicalProfileIdByProfileId = new Map();
  const loginOwnerByUid = new Map();
  const loginUidsByProfileId = new Map();
  const profileById = new Map();
  for (const [key, value] of Object.entries(participantsById)) {
    const storedProfileId = value.profileId || key;
    for (const profileId of [key, storedProfileId]) {
      const canonicalProfileId = Object.hasOwn(canonicalProfileIds, profileId)
        ? canonicalProfileIds[profileId]
        : profileId;
      canonicalProfileIdByProfileId.set(profileId, canonicalProfileId);
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
    const ownerProfileId = Object.hasOwn(loginOwners, value.loginUid)
      ? loginOwners[value.loginUid]
      : canonicalProfileIdByProfileId.get(storedProfileId);
    loginOwnerByUid.set(
      value.loginUid,
      ownerProfileId ? { profileId: ownerProfileId, revision: 1 } : null,
    );
    if (ownerProfileId) {
      loginUidsByProfileId.set(ownerProfileId, [
        ...(loginUidsByProfileId.get(ownerProfileId) || []),
        value.loginUid,
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
    ownershipSnapshot: ownershipSnapshot(participantsById),
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

test("rejects a later-round invite when its participants have merged", async () => {
  const participantsById = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
  };
  const final = createEmptyEventMatch("1_0");
  setMatchSlotParticipant(final, "host", participantsById.p1);
  setMatchSlotParticipant(final, "guest", participantsById.p2);
  const inviteUpdates = {};
  const runtime = createEventBracketRuntime({
    buildRandomGameSeed: async () => ({
      gameVariant: "Classic",
      fen: "start-fen",
    }),
  });

  await assert.rejects(
    runtime.reconcileBracketMatchReadiness({
      eventId: "event-test",
      rounds: { 1: { matches: { "1_0": final } } },
      nowMs: 1_800_000_000_000,
      participantsById,
      inviteUpdates,
      ownershipSnapshot: ownershipSnapshot(participantsById, {
        canonicalProfileIds: { p1: "merged-profile", p2: "merged-profile" },
        loginOwners: {
          "p1-login": "merged-profile",
          "p2-login": "merged-profile",
        },
      }),
    }),
    /profile-ownership-unavailable/,
  );
  assert.equal(final.inviteId, null);
  assert.deepEqual(inviteUpdates, {});
});

test("rejects a later-round invite when a stored login owns another profile", async () => {
  const participantsById = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
  };
  const final = createEmptyEventMatch("1_0");
  setMatchSlotParticipant(final, "host", participantsById.p1);
  setMatchSlotParticipant(final, "guest", participantsById.p2);
  const inviteUpdates = {};
  const runtime = createEventBracketRuntime({
    buildRandomGameSeed: async () => ({
      gameVariant: "Classic",
      fen: "start-fen",
    }),
  });

  await assert.rejects(
    runtime.reconcileBracketMatchReadiness({
      eventId: "event-test",
      rounds: { 1: { matches: { "1_0": final } } },
      nowMs: 1_800_000_000_000,
      participantsById,
      inviteUpdates,
      ownershipSnapshot: ownershipSnapshot(participantsById, {
        loginOwners: { "p1-login": "p2" },
      }),
    }),
    /profile-ownership-unavailable/,
  );
  assert.equal(final.inviteId, null);
  assert.deepEqual(inviteUpdates, {});
});

test("creates a later-round invite from one ownership snapshot", async () => {
  const participantsById = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
  };
  const final = createEmptyEventMatch("1_0");
  setMatchSlotParticipant(final, "host", participantsById.p1);
  setMatchSlotParticipant(final, "guest", participantsById.p2);
  const runtime = createEventBracketRuntime({
    buildRandomGameSeed: async () => ({
      gameVariant: "Classic",
      fen: "start-fen",
    }),
  });

  assert.equal(
    await runtime.reconcileBracketMatchReadiness({
      eventId: "event-test",
      rounds: { 1: { matches: { "1_0": final } } },
      nowMs: 1_800_000_000_000,
      participantsById,
      inviteUpdates: {},
      ownershipSnapshot: ownershipSnapshot(participantsById),
    }),
    true,
  );
  assert.ok(final.inviteId);
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

test("prize assignment preserves a winner selection after a post-start merge", async () => {
  const eventId = "NN3eRzoZo80";
  const selections = { "legacy-selection-profile": "1514" };
  const runtime = createEventBracketRuntime();
  const participantsById = {
    "source-profile": participant("source-profile", 1),
    "second-profile": participant("second-profile", 2),
  };
  const snapshot = ownershipSnapshot(participantsById, {
    canonicalProfileIds: { "source-profile": "winner-profile" },
    loginOwners: { "source-profile-login": "winner-profile" },
  });
  snapshot.canonicalProfileIdByProfileId.set(
    "legacy-selection-profile",
    "winner-profile",
  );
  const input = {
    eventId,
    event: { winnerProfileId: "source-profile" },
    rounds: {
      0: {
        matches: {
          "0_0": {
            status: "host",
            hostProfileId: "source-profile",
            guestProfileId: "second-profile",
            winnerProfileId: "source-profile",
            loserProfileId: "second-profile",
          },
        },
      },
    },
    participantsById,
    thirdPlaceMatch: null,
    assignedAtMs: 100,
    ownershipSnapshot: snapshot,
    prizeSelections: selections,
  };
  const result = await runtime.resolveEventPrizeAssignments(input);

  assert.equal(result.assignments["1"].profileId, "winner-profile");
  assert.equal(result.assignments["1"].prizeId, "1514");

  selections["source-profile"] = "1514";
  const collapsed = await runtime.resolveEventPrizeAssignments(input);
  assert.equal(collapsed.assignments["1"].prizeId, "1514");

  selections["winner-profile"] = "1092";
  await assert.rejects(
    runtime.resolveEventPrizeAssignments(input),
    /profile-ownership-unavailable/,
  );
});

test("prize assignment ignores unrelated participants merged after start", async () => {
  const runtime = createEventBracketRuntime();
  const participantsById = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
    p3: participant("p3", 3),
    p4: participant("p4", 4),
    p5: participant("p5", 5),
  };

  const result = await runtime.resolveEventPrizeAssignments({
    eventId: "NN3eRzoZo80",
    event: { winnerProfileId: "p1" },
    rounds: {
      0: {
        matches: {
          "0_0": {
            status: "host",
            hostProfileId: "p1",
            guestProfileId: "p2",
            winnerProfileId: "p1",
            loserProfileId: "p2",
          },
        },
      },
    },
    participantsById,
    thirdPlaceMatch: null,
    assignedAtMs: 100,
    ownershipSnapshot: ownershipSnapshot(participantsById, {
      canonicalProfileIds: { p4: "merged-profile", p5: "merged-profile" },
      loginOwners: {
        "p4-login": "merged-profile",
        "p5-login": "merged-profile",
      },
    }),
    prizeSelections: { p1: "1514" },
  });

  assert.equal(result.assignments["1"].profileId, "p1");
  assert.equal(result.assignments["1"].prizeId, "1514");
});

test("prize assignment ignores an unplaced participant merged into the winner", async () => {
  const runtime = createEventBracketRuntime();
  const participantsById = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
    p3: participant("p3", 3),
    p4: participant("p4", 4),
  };
  const input = {
    eventId: "NN3eRzoZo80",
    event: { winnerProfileId: "p1" },
    rounds: {
      0: {
        matches: {
          "0_0": {
            status: "host",
            hostProfileId: "p1",
            guestProfileId: "p2",
            winnerProfileId: "p1",
            loserProfileId: "p2",
          },
        },
      },
    },
    participantsById,
    thirdPlaceMatch: null,
    assignedAtMs: 100,
    ownershipSnapshot: ownershipSnapshot(participantsById, {
      canonicalProfileIds: {
        p1: "winner-profile",
        p4: "winner-profile",
      },
      loginOwners: {
        "p1-login": "winner-profile",
        "p4-login": "winner-profile",
      },
    }),
    prizeSelections: { p4: "1514" },
  };

  const unplacedOnly = await runtime.resolveEventPrizeAssignments(input);
  assert.equal(unplacedOnly.assignments["1"].profileId, "winner-profile");
  assert.equal(unplacedOnly.assignments["1"].prizeId, "1092");

  input.prizeSelections = { p1: "1514", p4: "1092" };
  const conflicting = await runtime.resolveEventPrizeAssignments(input);
  assert.equal(conflicting.assignments["1"].prizeId, "1514");
});

test("prize projection accepts an unplaced participant merged into the winner", async () => {
  const eventId = "NN3eRzoZo80";
  const projected = [];
  const runtime = createEventBracketRuntime({
    admin: {
      database: () => ({
        ref: (path) => ({
          transaction: async (updater) => {
            const value = updater(null);
            projected.push({ path, value });
            return { committed: value !== undefined };
          },
        }),
      }),
    },
    readEventPrizeWithdrawals: async () => ({}),
  });
  const participantsById = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
    p3: participant("p3", 3),
    p4: participant("p4", 4),
  };
  const event = {
    winnerProfileId: "p1",
    participants: participantsById,
  };
  const rounds = {
    0: {
      matches: {
        "0_0": {
          status: "host",
          hostProfileId: "p1",
          guestProfileId: "p2",
          winnerProfileId: "p1",
          loserProfileId: "p2",
        },
      },
    },
  };
  const snapshot = ownershipSnapshot(participantsById, {
    canonicalProfileIds: {
      p1: "winner-profile",
      p4: "winner-profile",
    },
    loginOwners: {
      "p1-login": "winner-profile",
      "p4-login": "winner-profile",
    },
  });
  const assignmentResult = await runtime.resolveEventPrizeAssignments({
    eventId,
    event,
    rounds,
    participantsById,
    thirdPlaceMatch: null,
    assignedAtMs: 100,
    ownershipSnapshot: snapshot,
    prizeSelections: { p1: "1514", p4: "1092" },
  });

  const projectionResult = await runtime.reconcileProfileEventPrizeAssignments({
    event,
    eventId,
    assignments: assignmentResult.assignments,
    ownershipSnapshot: snapshot,
  });

  assert.equal(projectionResult.didChange, true);
  assert.deepEqual(
    projected.find(
      ({ path }) => path === `profileEventPrizes/winner-profile/${eventId}`,
    ),
    {
      path: `profileEventPrizes/winner-profile/${eventId}`,
      value: assignmentResult.assignments["1"],
    },
  );
});

test("prize assignment ignores an unplaced selection after its login is unlinked", async () => {
  const runtime = createEventBracketRuntime();
  const participantsById = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
    p3: participant("p3", 3),
    p4: participant("p4", 4),
  };

  const result = await runtime.resolveEventPrizeAssignments({
    eventId: "NN3eRzoZo80",
    event: { winnerProfileId: "p1" },
    rounds: {
      0: {
        matches: {
          "0_0": {
            status: "host",
            hostProfileId: "p1",
            guestProfileId: "p2",
            winnerProfileId: "p1",
            loserProfileId: "p2",
          },
        },
      },
    },
    participantsById,
    thirdPlaceMatch: null,
    assignedAtMs: 100,
    ownershipSnapshot: ownershipSnapshot(participantsById, {
      loginOwners: { "p4-login": null },
    }),
    prizeSelections: { p4: "1514" },
  });

  assert.deepEqual(
    Object.values(result.assignments).map(({ profileId }) => profileId),
    ["p1", "p2", "p3"],
  );
});

test("prize assignment ignores selections when there are no placements", async () => {
  const result = await createEventBracketRuntime().resolveEventPrizeAssignments(
    {
      eventId: "NN3eRzoZo80",
      event: {},
      rounds: {},
      participantsById: { p1: participant("p1", 1) },
      thirdPlaceMatch: null,
      assignedAtMs: 100,
      ownershipSnapshot: null,
      prizeSelections: { p1: "1514" },
    },
  );

  assert.deepEqual(result.assignments, {});
  assert.equal(result.didCreate, true);
});

test("prize assignment rejects duplicate canonical placements", async () => {
  const runtime = createEventBracketRuntime();
  const participantsById = {
    "source-profile": participant("source-profile", 1),
    "target-profile": participant("target-profile", 2),
  };

  await assert.rejects(
    runtime.resolveEventPrizeAssignments({
      eventId: "NN3eRzoZo80",
      event: { winnerProfileId: "source-profile" },
      rounds: {
        0: {
          matches: {
            "0_0": {
              status: "host",
              hostProfileId: "source-profile",
              guestProfileId: "target-profile",
              winnerProfileId: "source-profile",
              loserProfileId: "target-profile",
            },
          },
        },
      },
      participantsById,
      thirdPlaceMatch: null,
      assignedAtMs: 100,
      ownershipSnapshot: ownershipSnapshot(participantsById, {
        canonicalProfileIds: {
          "source-profile": "merged-profile",
          "target-profile": "merged-profile",
        },
        loginOwners: {
          "source-profile-login": "merged-profile",
          "target-profile-login": "merged-profile",
        },
      }),
      prizeSelections: {},
    }),
    /profile-ownership-unavailable/,
  );
});
