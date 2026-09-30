// Generated from src/events/bracket.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setMatchSlotParticipant =
  exports.setMatchSlotBlocked =
  exports.recomputeRoundStatuses =
  exports.isMatchWinnerDisqualified =
  exports.isMatchSlotBlocked =
  exports.isMatchResolved =
  exports.hasThirdPlaceMatchField =
  exports.getSortedRoundIndexes =
  exports.getSortedMatchKeys =
  exports.createEmptyEventMatch =
  exports.buildSeedToProfileId =
  exports.assignWinnerToNextRound =
  exports.applyMatchResolution =
  exports.createEventBracketRuntime =
  exports.resolveRoundMatchesWithConcurrency =
  exports.resolveRoundMatchState =
  exports.resolveEventPrizeAssignments =
  exports.removeCompletedEventPrizeProjections =
  exports.reconcileThirdPlaceMatchReadiness =
  exports.reconcileProfileEventPrizeAssignments =
  exports.reconcileBracketMatchReadiness =
  exports.rebuildParticipantStatesFromRounds =
  exports.getEventPrizePlacements =
  exports.buildScheduledEventDueUpdates =
  exports.buildFixedBracketState =
  exports.addEventPrizeAssignmentUpdates =
    void 0;
const eventCommands_js_1 = require("../eventCommands.js");
const matchOutcome_js_1 = require("../matchOutcome.js");
const eventPrizeAwards_js_1 = require("../eventPrizeAwards.js");
const event_prizes_1 = require("@mons/shared/event-prizes");
const eventPrizeProjectionState_js_1 = require("../eventPrizeProjectionState.js");
const gameVariants_js_1 = require("../gameVariants.js");
const startTransitionCore_js_1 = require("./startTransitionCore.js");
Object.defineProperty(exports, "applyMatchResolution", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.applyMatchResolution;
  },
});
Object.defineProperty(exports, "assignWinnerToNextRound", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.assignWinnerToNextRound;
  },
});
Object.defineProperty(exports, "buildSeedToProfileId", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.buildSeedToProfileId;
  },
});
Object.defineProperty(exports, "createEmptyEventMatch", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.createEmptyEventMatch;
  },
});
Object.defineProperty(exports, "getSortedMatchKeys", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.getSortedMatchKeys;
  },
});
Object.defineProperty(exports, "getSortedRoundIndexes", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.getSortedRoundIndexes;
  },
});
Object.defineProperty(exports, "hasThirdPlaceMatchField", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.hasThirdPlaceMatchField;
  },
});
Object.defineProperty(exports, "isMatchResolved", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.isMatchResolved;
  },
});
Object.defineProperty(exports, "isMatchSlotBlocked", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.isMatchSlotBlocked;
  },
});
Object.defineProperty(exports, "isMatchWinnerDisqualified", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.isMatchWinnerDisqualified;
  },
});
Object.defineProperty(exports, "recomputeRoundStatuses", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.recomputeRoundStatuses;
  },
});
Object.defineProperty(exports, "setMatchSlotBlocked", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.setMatchSlotBlocked;
  },
});
Object.defineProperty(exports, "setMatchSlotParticipant", {
  enumerable: true,
  get: function () {
    return startTransitionCore_js_1.setMatchSlotParticipant;
  },
});
const ownership_js_1 = require("./ownership.js");
const createEventBracketRuntime = (dependencies = {}) => {
  const state = dependencies.state;
  const resolveMatchWinner =
    dependencies.resolveMatchWinner || matchOutcome_js_1.resolveMatchWinner;
  const buildRandomGameSeed =
    dependencies.buildRandomGameSeed || gameVariants_js_1.buildRandomGameSeed;
  const readEventPrizeWithdrawals =
    dependencies.readEventPrizeWithdrawals ||
    (async () => {
      throw new Error("readEventPrizeWithdrawals dependency is required");
    });
  const EVENT_MATCH_RESOLVE_CONCURRENCY = 4;
  const normalizeString = (value) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : "";
  const normalizeStringOrNull = (value) => normalizeString(value) || null;
  const canonicalizePrizePlacementsAndSelections = (
    placements,
    value,
    participantsById,
    ownershipSnapshot,
  ) => {
    const selections =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const placementEntries = Array.isArray(placements) ? placements : [];
    const placementProfileIds = placementEntries.map((placement) =>
      normalizeString(placement?.profileId),
    );
    if (placementEntries.length === 0) {
      return { placements: [], selections: {} };
    }
    if (!ownershipSnapshot)
      throw (0, ownership_js_1.profileOwnershipUnavailable)();
    const placementReferences = placementProfileIds.map((profileId) => {
      const participant =
        participantsById?.[profileId] ||
        Object.values(participantsById || {}).find(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            normalizeString(candidate.profileId) === profileId,
        );
      return {
        profileId,
        loginUid: normalizeString(participant && participant.loginUid),
      };
    });
    const canonicalPlacementProfileIds = (0,
    ownership_js_1.resolveOwnedProfileReferences)(
      ownershipSnapshot,
      placementReferences,
    );
    const canonicalPlacements = placementEntries.map((placement, index) => ({
      ...placement,
      profileId: canonicalPlacementProfileIds[index],
    }));
    const placementProfileIdSet = new Set(placementProfileIds);
    const participantEntries = Object.entries(participantsById || {});
    const participantProfileIds = ([profileId, participant]) =>
      [
        normalizeString(profileId),
        normalizeString(participant && participant.profileId),
      ].filter(Boolean);
    const isPlacementParticipant = ([profileId, participant]) =>
      placementProfileIdSet.has(normalizeString(profileId)) ||
      placementProfileIdSet.has(
        normalizeString(participant && participant.profileId),
      );
    const placementParticipantEntries = participantEntries.filter(
      isPlacementParticipant,
    );
    const placementParticipantProfileIds = new Set(
      placementParticipantEntries.flatMap(participantProfileIds),
    );
    const unplacedParticipantProfileIds = new Set(
      participantEntries
        .filter((entry) => !isPlacementParticipant(entry))
        .flatMap((entry) =>
          participantProfileIds(entry).filter(
            (candidateProfileId) =>
              !placementParticipantProfileIds.has(candidateProfileId),
          ),
        ),
    );
    const placementSelections = Object.fromEntries(
      Object.entries(selections).filter(
        ([profileId]) =>
          !unplacedParticipantProfileIds.has(normalizeString(profileId)),
      ),
    );
    const canonicalSelections = (0,
    ownership_js_1.canonicalizeEventPrizeSelections)(
      { participants: Object.fromEntries(placementParticipantEntries) },
      placementSelections,
      ownershipSnapshot,
    ).selectionsByProfileId;
    return {
      placements: canonicalPlacements,
      selections: canonicalSelections,
    };
  };
  const toFiniteInteger = (value, fallback = 0) => {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.floor(numeric);
  };
  const reconcileBracketMatchReadiness = (input) =>
    (0, startTransitionCore_js_1.reconcileBracketMatchReadiness)({
      ...input,
      buildRandomGameSeed,
    });
  const reconcileThirdPlaceMatchReadiness = (input) =>
    (0, startTransitionCore_js_1.reconcileThirdPlaceMatchReadiness)({
      ...input,
      buildRandomGameSeed,
    });
  const rebuildParticipantStatesFromRounds = ({
    participantsById,
    rounds,
    winnerProfileId,
    eventEnded,
  }) => {
    const eliminationsByProfileId = {};
    const sortedRoundIndexes = (0,
    startTransitionCore_js_1.getSortedRoundIndexes)(rounds);
    for (const roundIndex of sortedRoundIndexes) {
      const round = rounds[String(roundIndex)];
      if (!round || !round.matches || typeof round.matches !== "object") {
        continue;
      }
      const matchKeys = (0, startTransitionCore_js_1.getSortedMatchKeys)(
        round.matches,
      );
      for (const matchKey of matchKeys) {
        const match = round.matches[matchKey];
        if (!match || typeof match !== "object") {
          continue;
        }
        if (!(0, startTransitionCore_js_1.isMatchResolved)(match)) {
          continue;
        }
        const loserProfileId = normalizeString(match && match.loserProfileId);
        if (!loserProfileId || eliminationsByProfileId[loserProfileId]) {
          continue;
        }
        eliminationsByProfileId[loserProfileId] = {
          eliminatedRoundIndex: roundIndex,
          eliminatedByProfileId:
            normalizeString(match && match.winnerProfileId) || null,
        };
      }
    }
    const normalizedWinnerProfileId = normalizeStringOrNull(winnerProfileId);
    const nextParticipants = {};
    let didChange = false;
    for (const [profileId, participant] of Object.entries(
      participantsById || {},
    )) {
      if (!participant || typeof participant !== "object") {
        nextParticipants[profileId] = participant;
        continue;
      }
      const elimination = eliminationsByProfileId[profileId] || null;
      let state = "active";
      let eliminatedRoundIndex = null;
      let eliminatedByProfileId = null;
      if (
        eventEnded &&
        normalizedWinnerProfileId &&
        profileId === normalizedWinnerProfileId
      ) {
        state = "winner";
      } else if (elimination) {
        state = "eliminated";
        eliminatedRoundIndex = elimination.eliminatedRoundIndex;
        eliminatedByProfileId = elimination.eliminatedByProfileId;
      }
      const normalizedCurrentEliminatedRoundIndex =
        typeof participant.eliminatedRoundIndex === "number"
          ? Math.floor(participant.eliminatedRoundIndex)
          : null;
      const normalizedCurrentEliminatedByProfileId = normalizeStringOrNull(
        participant.eliminatedByProfileId,
      );
      if (
        participant.state !== state ||
        normalizedCurrentEliminatedRoundIndex !== eliminatedRoundIndex ||
        normalizedCurrentEliminatedByProfileId !== eliminatedByProfileId
      ) {
        didChange = true;
      }
      nextParticipants[profileId] = {
        ...participant,
        state,
        eliminatedRoundIndex,
        eliminatedByProfileId,
      };
    }
    return {
      didChange,
      participantsById: nextParticipants,
    };
  };
  const getEventPrizeDisqualifiedIdentityKeys = ({
    rounds,
    thirdPlaceMatch,
  }) => {
    const identityKeys = new Set();
    const addMatchIdentities = (match) => {
      if (!match || match.winnerDisqualified !== true) {
        return;
      }
      for (const value of [
        match.hostProfileId,
        match.hostLoginUid,
        match.guestProfileId,
        match.guestLoginUid,
      ]) {
        const identityKey = normalizeString(value);
        if (identityKey) {
          identityKeys.add(identityKey);
        }
      }
    };
    for (const roundIndex of (0,
    startTransitionCore_js_1.getSortedRoundIndexes)(rounds)) {
      const matches = rounds[String(roundIndex)]?.matches;
      for (const matchKey of (0, startTransitionCore_js_1.getSortedMatchKeys)(
        matches,
      )) {
        addMatchIdentities(matches[matchKey]);
      }
    }
    addMatchIdentities(thirdPlaceMatch);
    return identityKeys;
  };
  const isEventPrizeParticipantDisqualified = (participant, identityKeys) => {
    if (!participant) {
      return false;
    }
    const profileId = normalizeString(participant.profileId);
    const loginUid = normalizeString(participant.loginUid);
    return (
      (profileId && identityKeys.has(profileId)) ||
      (loginUid && identityKeys.has(loginUid))
    );
  };
  const getResolvedMatchProfileId = (match, result) => {
    const directProfileId = normalizeString(
      result === "winner" ? match?.winnerProfileId : match?.loserProfileId,
    );
    if (directProfileId) {
      return directProfileId;
    }
    const status = normalizeString(match?.status);
    const winnerSide =
      status === "host" ? "host" : status === "guest" ? "guest" : null;
    if (!winnerSide) {
      return "";
    }
    const side =
      result === "winner"
        ? winnerSide
        : winnerSide === "host"
          ? "guest"
          : "host";
    return normalizeString(match?.[`${side}ProfileId`]);
  };
  const getEventPrizePlacements = ({
    event,
    rounds,
    participantsById,
    thirdPlaceMatch,
  }) => {
    const sortedRoundIndexes = (0,
    startTransitionCore_js_1.getSortedRoundIndexes)(rounds);
    const finalRoundIndex = sortedRoundIndexes[sortedRoundIndexes.length - 1];
    const finalRound = rounds[String(finalRoundIndex)];
    const finalMatchKey = (0, startTransitionCore_js_1.getSortedMatchKeys)(
      finalRound?.matches,
    )[0];
    const finalMatch = finalRound?.matches?.[finalMatchKey];
    if (!finalMatch) {
      return [];
    }
    const disqualifiedIdentityKeys = getEventPrizeDisqualifiedIdentityKeys({
      rounds,
      thirdPlaceMatch,
    });
    const winnerProfileId =
      normalizeString(event?.winnerProfileId) ||
      getResolvedMatchProfileId(finalMatch, "winner");
    const winner = participantsById[winnerProfileId];
    if (
      !winner ||
      isEventPrizeParticipantDisqualified(winner, disqualifiedIdentityKeys)
    ) {
      return [];
    }
    const placements = [{ place: 1, profileId: winnerProfileId }];
    const reservedProfileIds = new Set([winnerProfileId]);
    const placementCandidates = [];
    const pushCandidate = (profileId) => {
      const normalizedProfileId = normalizeString(profileId);
      const participant = participantsById[normalizedProfileId];
      if (
        !normalizedProfileId ||
        !participant ||
        reservedProfileIds.has(normalizedProfileId) ||
        isEventPrizeParticipantDisqualified(
          participant,
          disqualifiedIdentityKeys,
        )
      ) {
        return;
      }
      reservedProfileIds.add(normalizedProfileId);
      placementCandidates.push(normalizedProfileId);
    };
    pushCandidate(getResolvedMatchProfileId(finalMatch, "loser"));
    if (Object.keys(participantsById).length >= 3 && thirdPlaceMatch) {
      pushCandidate(getResolvedMatchProfileId(thirdPlaceMatch, "winner"));
    }
    Object.values(participantsById)
      .filter(
        (participant) =>
          !isEventPrizeParticipantDisqualified(
            participant,
            disqualifiedIdentityKeys,
          ),
      )
      .sort((left, right) => {
        const leftRound = Number.isFinite(left.eliminatedRoundIndex)
          ? Math.floor(left.eliminatedRoundIndex)
          : -1;
        const rightRound = Number.isFinite(right.eliminatedRoundIndex)
          ? Math.floor(right.eliminatedRoundIndex)
          : -1;
        if (leftRound !== rightRound) {
          return rightRound - leftRound;
        }
        const joinedDifference =
          toFiniteInteger(left.joinedAtMs, 0) -
          toFiniteInteger(right.joinedAtMs, 0);
        if (joinedDifference !== 0) {
          return joinedDifference;
        }
        return normalizeString(left.profileId).localeCompare(
          normalizeString(right.profileId),
        );
      })
      .forEach((participant) => pushCandidate(participant.profileId));
    if (placementCandidates[0]) {
      placements.push({ place: 2, profileId: placementCandidates[0] });
    }
    if (placementCandidates[1] && Object.keys(participantsById).length >= 3) {
      placements.push({ place: 3, profileId: placementCandidates[1] });
    }
    return placements;
  };
  const hasCompleteEventPrizeAssignments = (
    assignments,
    placementCount,
    eventId,
  ) => {
    const expectedCount = Math.min(
      (0, event_prizes_1.getEventPrizeDefinitions)(eventId).length,
      placementCount,
    );
    if (expectedCount <= 0) {
      return false;
    }
    for (let place = 1; place <= expectedCount; place += 1) {
      if (!assignments[String(place)]) {
        return false;
      }
    }
    return Object.keys(assignments).length === expectedCount;
  };
  const getProjectableEventPrizeAssignments = async ({
    event,
    eventId,
    assignments,
    ownershipSnapshot,
  }) => {
    const projectableAssignments = (0,
    eventPrizeProjectionState_js_1.filterProjectableEventPrizeAssignments)({
      eventId,
      assignments,
      withdrawals: await readEventPrizeWithdrawals(eventId),
    });
    const canonicalAssignments = {};
    const canonicalProfileIds = new Set();
    for (const [place, assignment] of Object.entries(projectableAssignments)) {
      if (!ownershipSnapshot)
        throw (0, ownership_js_1.profileOwnershipUnavailable)();
      const sourceProfileId = normalizeString(assignment?.profileId);
      const canonicalProfileId = normalizeString(
        (0, ownership_js_1.resolvePrizeProjectionOwnerId)({
          event,
          profileId: sourceProfileId,
          snapshot: ownershipSnapshot,
        }),
      );
      if (!canonicalProfileId) {
        continue;
      }
      if (canonicalProfileIds.has(canonicalProfileId)) {
        throw new Error("profile-event-prize-conflict");
      }
      canonicalProfileIds.add(canonicalProfileId);
      canonicalAssignments[place] =
        canonicalProfileId === sourceProfileId
          ? assignment
          : { ...assignment, profileId: canonicalProfileId };
    }
    return canonicalAssignments;
  };
  const assignmentsMatch = (current, assignment) =>
    current?.eventId === assignment?.eventId &&
    current?.profileId === assignment?.profileId &&
    Number(current?.place) === Number(assignment?.place) &&
    current?.prizeId === assignment?.prizeId &&
    Number(current?.assignedAtMs) === Number(assignment?.assignedAtMs);
  const addEventPrizeAssignmentUpdates = async ({
    updates,
    eventId,
    assignments,
    includeEventAssignments,
  }) => {
    if (includeEventAssignments) {
      updates.push(
        (0, eventCommands_js_1.eventField)(
          eventId,
          "prizeAssignments",
          assignments,
        ),
      );
    }
  };
  const reconcileProfileEventPrizeAssignments = async ({
    event,
    eventId,
    assignments,
    ownershipSnapshot,
  }) => {
    const projectableAssignments = await getProjectableEventPrizeAssignments({
      event,
      eventId,
      assignments,
      ownershipSnapshot,
    });
    const transactions = await Promise.all(
      Object.values(projectableAssignments).map(async (assignment) => {
        return state.transactProfileEventPrize(
          assignment.profileId,
          eventId,
          (current) => {
            if (current === null || current === undefined) {
              return { value: assignment };
            }
            if (assignmentsMatch(current, assignment)) {
              return { commit: false };
            }
            throw new Error("profile-event-prize-conflict");
          },
        );
      }),
    );
    return {
      didChange: transactions.some((transaction) => transaction.committed),
    };
  };
  const removeCompletedEventPrizeProjections = async ({
    event,
    eventId,
    assignments,
    ownershipSnapshot,
  }) => {
    const withdrawals = await readEventPrizeWithdrawals(eventId);
    await Promise.all(
      Object.values(assignments || {}).map(async (assignment) => {
        if (
          !(0, eventPrizeProjectionState_js_1.isCompletedEventPrizeWithdrawal)(
            withdrawals[assignment.prizeId],
            eventId,
            assignment.prizeId,
          )
        ) {
          return;
        }
        if (!ownershipSnapshot)
          throw (0, ownership_js_1.profileOwnershipUnavailable)();
        const canonicalProfileId = normalizeString(
          (0, ownership_js_1.resolvePrizeProjectionOwnerId)({
            event,
            profileId: normalizeString(assignment.profileId),
            snapshot: ownershipSnapshot,
          }),
        );
        const profileIds = Array.from(
          new Set(
            [normalizeString(assignment.profileId), canonicalProfileId].filter(
              Boolean,
            ),
          ),
        );
        await Promise.all(
          profileIds.map((profileId) =>
            state.transactProfileEventPrize(
              profileId,
              eventId,
              (currentAssignment) =>
                (0,
                eventPrizeProjectionState_js_1.isMatchingProfileEventPrizeAssignment)(
                  currentAssignment,
                  eventId,
                  assignment.prizeId,
                )
                  ? { value: null }
                  : { commit: false },
            ),
          ),
        );
      }),
    );
  };
  const resolveEventPrizeAssignments = async ({
    eventId,
    event,
    rounds,
    participantsById,
    thirdPlaceMatch,
    assignedAtMs,
    ownershipSnapshot,
    prizeSelections,
  }) => {
    const placements = getEventPrizePlacements({
      event,
      rounds,
      participantsById,
      thirdPlaceMatch,
    });
    const storedAssignments = (0,
    eventPrizeAwards_js_1.normalizeEventPrizeAssignments)(
      event?.prizeAssignments,
      eventId,
    );
    if (
      hasCompleteEventPrizeAssignments(
        storedAssignments,
        placements.length,
        eventId,
      )
    ) {
      return { assignments: storedAssignments, didCreate: false };
    }
    const canonical = canonicalizePrizePlacementsAndSelections(
      placements,
      prizeSelections,
      participantsById,
      ownershipSnapshot,
    );
    return {
      assignments: (0, eventPrizeAwards_js_1.buildEventPrizeAssignments)({
        eventId,
        placements: canonical.placements,
        selections: canonical.selections,
        assignedAtMs,
      }),
      didCreate: true,
    };
  };
  const getRoundMatchRead = (matchRecord) => {
    if (!matchRecord || typeof matchRecord !== "object") return null;
    if (
      ["bye", "host", "guest"].includes(normalizeString(matchRecord.status))
    ) {
      return null;
    }
    const playerId = normalizeString(matchRecord.hostLoginUid);
    const opponentId = normalizeString(matchRecord.guestLoginUid);
    const inviteId = normalizeString(matchRecord.inviteId);
    return playerId && opponentId && inviteId
      ? { inviteId, matchId: inviteId, playerId, opponentId }
      : null;
  };
  const resolveRoundMatchState = async (matchRecord, matchPair) => {
    if (!matchRecord || typeof matchRecord !== "object") {
      return null;
    }
    const existingStatus = normalizeString(matchRecord.status);
    if (existingStatus === "bye") {
      const winnerProfileId = normalizeString(matchRecord.winnerProfileId);
      if (!winnerProfileId) {
        return null;
      }
      return {
        status: "bye",
        winnerProfileId,
        loserProfileId: null,
      };
    }
    if (existingStatus === "host" || existingStatus === "guest") {
      const winnerProfileId =
        normalizeString(matchRecord.winnerProfileId) ||
        (existingStatus === "host"
          ? normalizeString(matchRecord.hostProfileId)
          : normalizeString(matchRecord.guestProfileId));
      const loserProfileId =
        normalizeString(matchRecord.loserProfileId) ||
        (existingStatus === "host"
          ? normalizeString(matchRecord.guestProfileId)
          : normalizeString(matchRecord.hostProfileId));
      if (!winnerProfileId) {
        return null;
      }
      return {
        status: existingStatus,
        winnerProfileId,
        loserProfileId: loserProfileId || null,
      };
    }
    const input = getRoundMatchRead(matchRecord);
    if (!input) {
      return null;
    }
    const [hostMatch, guestMatch] =
      matchPair || (await dependencies.readMatchPair(input));
    const outcome = await resolveMatchWinner(hostMatch, guestMatch);
    if (outcome.winner === "player") {
      return {
        status: "host",
        winnerProfileId: normalizeString(matchRecord.hostProfileId),
        loserProfileId: normalizeStringOrNull(matchRecord.guestProfileId),
      };
    }
    if (outcome.winner === "opponent") {
      return {
        status: "guest",
        winnerProfileId: normalizeString(matchRecord.guestProfileId),
        loserProfileId: normalizeStringOrNull(matchRecord.hostProfileId),
      };
    }
    return null;
  };
  const resolveRoundMatchesWithConcurrency = async (matchesByKey) => {
    const entries = Object.entries(matchesByKey || {});
    if (entries.length <= 0) {
      return [];
    }
    const reads = entries.flatMap(([, matchRecord], index) => {
      const input = getRoundMatchRead(matchRecord);
      return input ? [{ index, input }] : [];
    });
    const pairsByIndex = new Map();
    if (reads.length) {
      const pairs = await dependencies.readMatchPairs(
        reads.map(({ input }) => input),
      );
      if (
        !Array.isArray(pairs) ||
        pairs.length !== reads.length ||
        reads.some(
          (_, index) =>
            !Array.isArray(pairs[index]) || pairs[index].length !== 2,
        )
      ) {
        throw new Error("event-match-batch-invalid");
      }
      reads.forEach(({ index }, offset) =>
        pairsByIndex.set(index, pairs[offset]),
      );
    }
    const results = new Array(entries.length);
    const concurrency = Math.max(
      1,
      Math.min(EVENT_MATCH_RESOLVE_CONCURRENCY, entries.length),
    );
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= entries.length) {
          return;
        }
        const [matchKey, matchRecord] = entries[index];
        const resolved = await resolveRoundMatchState(
          matchRecord,
          pairsByIndex.get(index),
        );
        results[index] = {
          matchKey,
          matchRecord,
          resolved,
        };
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  };
  return {
    addEventPrizeAssignmentUpdates,
    applyMatchResolution: startTransitionCore_js_1.applyMatchResolution,
    assignWinnerToNextRound: startTransitionCore_js_1.assignWinnerToNextRound,
    buildFixedBracketState: (input) =>
      (0, startTransitionCore_js_1.buildFixedBracketState)({
        ...input,
        buildRandomGameSeed,
      }),
    buildScheduledEventDueUpdates: (input) =>
      (0, startTransitionCore_js_1.buildScheduledEventDueUpdatesCore)({
        ...input,
        buildRandomGameSeed,
      }),
    buildSeedToProfileId: startTransitionCore_js_1.buildSeedToProfileId,
    createEmptyEventMatch: startTransitionCore_js_1.createEmptyEventMatch,
    getEventPrizePlacements,
    getSortedMatchKeys: startTransitionCore_js_1.getSortedMatchKeys,
    getSortedRoundIndexes: startTransitionCore_js_1.getSortedRoundIndexes,
    hasThirdPlaceMatchField: startTransitionCore_js_1.hasThirdPlaceMatchField,
    isMatchResolved: startTransitionCore_js_1.isMatchResolved,
    isMatchSlotBlocked: startTransitionCore_js_1.isMatchSlotBlocked,
    isMatchWinnerDisqualified:
      startTransitionCore_js_1.isMatchWinnerDisqualified,
    rebuildParticipantStatesFromRounds,
    recomputeRoundStatuses: startTransitionCore_js_1.recomputeRoundStatuses,
    reconcileBracketMatchReadiness,
    reconcileProfileEventPrizeAssignments,
    reconcileThirdPlaceMatchReadiness,
    removeCompletedEventPrizeProjections,
    resolveEventPrizeAssignments,
    resolveRoundMatchState,
    resolveRoundMatchesWithConcurrency,
    setMatchSlotBlocked: startTransitionCore_js_1.setMatchSlotBlocked,
    setMatchSlotParticipant: startTransitionCore_js_1.setMatchSlotParticipant,
  };
};
exports.createEventBracketRuntime = createEventBracketRuntime;
const defaultRuntime = createEventBracketRuntime();
((exports.addEventPrizeAssignmentUpdates =
  defaultRuntime.addEventPrizeAssignmentUpdates),
  (exports.buildFixedBracketState = defaultRuntime.buildFixedBracketState),
  (exports.buildScheduledEventDueUpdates =
    defaultRuntime.buildScheduledEventDueUpdates),
  (exports.getEventPrizePlacements = defaultRuntime.getEventPrizePlacements),
  (exports.rebuildParticipantStatesFromRounds =
    defaultRuntime.rebuildParticipantStatesFromRounds),
  (exports.reconcileBracketMatchReadiness =
    defaultRuntime.reconcileBracketMatchReadiness),
  (exports.reconcileProfileEventPrizeAssignments =
    defaultRuntime.reconcileProfileEventPrizeAssignments),
  (exports.reconcileThirdPlaceMatchReadiness =
    defaultRuntime.reconcileThirdPlaceMatchReadiness),
  (exports.removeCompletedEventPrizeProjections =
    defaultRuntime.removeCompletedEventPrizeProjections),
  (exports.resolveEventPrizeAssignments =
    defaultRuntime.resolveEventPrizeAssignments),
  (exports.resolveRoundMatchState = defaultRuntime.resolveRoundMatchState),
  (exports.resolveRoundMatchesWithConcurrency =
    defaultRuntime.resolveRoundMatchesWithConcurrency));
