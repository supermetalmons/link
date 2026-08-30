"use strict";

const {
  batchReadWithRetry: defaultBatchReadWithRetry,
} = require("../batchRead");
const {
  resolveMatchWinner: defaultResolveMatchWinner,
} = require("../matchOutcome");
const {
  buildEventPrizeAssignments,
  normalizeEventPrizeAssignments,
} = require("../eventPrizeAwards");
const { getEventPrizeDefinitions } = require("@mons/shared/event-prizes");
const {
  filterProjectableEventPrizeAssignments,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
} = require("../eventPrizeProjectionState");
const {
  buildRandomGameSeed: defaultBuildRandomGameSeed,
} = require("../gameVariants");
const {
  applyMatchResolution,
  assignWinnerToNextRound,
  buildSeedToProfileId,
  buildFixedBracketState: buildFixedBracketStateCore,
  buildScheduledEventDueUpdatesCore,
  createEmptyEventMatch,
  getSortedMatchKeys,
  getSortedRoundIndexes,
  hasThirdPlaceMatchField,
  isMatchResolved,
  isMatchSlotBlocked,
  isMatchWinnerDisqualified,
  recomputeRoundStatuses,
  reconcileBracketMatchReadiness: reconcileBracketMatchReadinessCore,
  reconcileThirdPlaceMatchReadiness: reconcileThirdPlaceMatchReadinessCore,
  setMatchSlotBlocked,
  setMatchSlotParticipant,
} = require("./startTransitionCore");
const {
  getCanonicalProfileId,
  profileOwnershipUnavailable,
  resolveOwnedProfileReferences,
  resolvePrizeProjectionOwnerId,
} = require("./ownership");

const createEventBracketRuntime = (dependencies = {}) => {
  const admin = dependencies.admin;
  const batchReadWithRetry =
    dependencies.batchReadWithRetry || defaultBatchReadWithRetry;
  const resolveMatchWinner =
    dependencies.resolveMatchWinner || defaultResolveMatchWinner;
  const buildRandomGameSeed =
    dependencies.buildRandomGameSeed || defaultBuildRandomGameSeed;
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
    const selectionEntries = Object.entries(selections);
    const placementProfileIds = placementEntries.map((placement) =>
      normalizeString(placement?.profileId),
    );
    const profileIds = placementProfileIds.concat(
      selectionEntries.map(([profileId]) => profileId),
    );
    if (profileIds.length === 0) {
      return { placements: [], selections: {} };
    }
    if (!ownershipSnapshot) throw profileOwnershipUnavailable();
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
    const canonicalPlacementProfileIds = resolveOwnedProfileReferences(
      ownershipSnapshot,
      placementReferences,
    );
    const canonicalPlacements = [];
    for (let index = 0; index < placementEntries.length; index += 1) {
      const canonicalProfileId = canonicalPlacementProfileIds[index];
      canonicalPlacements.push({
        ...placementEntries[index],
        profileId: canonicalProfileId,
      });
    }
    const canonicalSelections = {};
    for (let index = 0; index < selectionEntries.length; index += 1) {
      const canonicalProfileId = getCanonicalProfileId(
        ownershipSnapshot,
        selectionEntries[index][0],
      );
      if (!canonicalProfileId) throw profileOwnershipUnavailable();
      const selection = selectionEntries[index][1];
      if (
        Object.hasOwn(canonicalSelections, canonicalProfileId) &&
        canonicalSelections[canonicalProfileId] !== selection
      ) {
        throw profileOwnershipUnavailable();
      }
      canonicalSelections[canonicalProfileId] = selection;
    }
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
    reconcileBracketMatchReadinessCore({
      ...input,
      buildRandomGameSeed,
    });

  const reconcileThirdPlaceMatchReadiness = (input) =>
    reconcileThirdPlaceMatchReadinessCore({
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
    const sortedRoundIndexes = getSortedRoundIndexes(rounds);
    for (const roundIndex of sortedRoundIndexes) {
      const round = rounds[String(roundIndex)];
      if (!round || !round.matches || typeof round.matches !== "object") {
        continue;
      }
      const matchKeys = getSortedMatchKeys(round.matches);
      for (const matchKey of matchKeys) {
        const match = round.matches[matchKey];
        if (!match || typeof match !== "object") {
          continue;
        }

        if (!isMatchResolved(match)) {
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

    for (const roundIndex of getSortedRoundIndexes(rounds)) {
      const matches = rounds[String(roundIndex)]?.matches;
      for (const matchKey of getSortedMatchKeys(matches)) {
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
    const sortedRoundIndexes = getSortedRoundIndexes(rounds);
    const finalRoundIndex = sortedRoundIndexes[sortedRoundIndexes.length - 1];
    const finalRound = rounds[String(finalRoundIndex)];
    const finalMatchKey = getSortedMatchKeys(finalRound?.matches)[0];
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
      getEventPrizeDefinitions(eventId).length,
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
    const projectableAssignments = filterProjectableEventPrizeAssignments({
      eventId,
      assignments,
      withdrawals: await readEventPrizeWithdrawals(eventId),
    });
    const canonicalAssignments = {};
    const canonicalProfileIds = new Set();
    for (const [place, assignment] of Object.entries(projectableAssignments)) {
      if (!ownershipSnapshot) throw profileOwnershipUnavailable();
      const sourceProfileId = normalizeString(assignment?.profileId);
      const canonicalProfileId = normalizeString(
        resolvePrizeProjectionOwnerId({
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
      updates[`events/${eventId}/prizeAssignments`] = assignments;
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
        return admin
          .database()
          .ref(`profileEventPrizes/${assignment.profileId}/${eventId}`)
          .transaction(
            (current) => {
              if (current === null || current === undefined) {
                return assignment;
              }
              if (assignmentsMatch(current, assignment)) {
                return undefined;
              }
              throw new Error("profile-event-prize-conflict");
            },
            undefined,
            false,
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
          !isCompletedEventPrizeWithdrawal(
            withdrawals[assignment.prizeId],
            eventId,
            assignment.prizeId,
          )
        ) {
          return;
        }
        if (!ownershipSnapshot) throw profileOwnershipUnavailable();
        const canonicalProfileId = normalizeString(
          resolvePrizeProjectionOwnerId({
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
            admin
              .database()
              .ref(`profileEventPrizes/${profileId}/${eventId}`)
              .transaction(
                (currentAssignment) =>
                  isMatchingProfileEventPrizeAssignment(
                    currentAssignment,
                    eventId,
                    assignment.prizeId,
                  )
                    ? null
                    : undefined,
                undefined,
                false,
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
    const storedAssignments = normalizeEventPrizeAssignments(
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
      assignments: buildEventPrizeAssignments({
        eventId,
        placements: canonical.placements,
        selections: canonical.selections,
        assignedAtMs,
      }),
      didCreate: true,
    };
  };

  const resolveRoundMatchState = async (matchRecord) => {
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

    const hostLoginUid = normalizeString(matchRecord.hostLoginUid);
    const guestLoginUid = normalizeString(matchRecord.guestLoginUid);
    const inviteId = normalizeString(matchRecord.inviteId);
    if (!hostLoginUid || !guestLoginUid || !inviteId) {
      return null;
    }

    const [hostSnapshot, guestSnapshot] = await batchReadWithRetry([
      admin.database().ref(`players/${hostLoginUid}/matches/${inviteId}`),
      admin.database().ref(`players/${guestLoginUid}/matches/${inviteId}`),
    ]);
    const hostMatch = hostSnapshot.val();
    const guestMatch = guestSnapshot.val();
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
        const resolved = await resolveRoundMatchState(matchRecord);
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
    applyMatchResolution,
    assignWinnerToNextRound,
    buildFixedBracketState: (input) =>
      buildFixedBracketStateCore({ ...input, buildRandomGameSeed }),
    buildScheduledEventDueUpdates: (input) =>
      buildScheduledEventDueUpdatesCore({
        ...input,
        buildRandomGameSeed,
      }),
    buildSeedToProfileId,
    createEmptyEventMatch,
    getEventPrizePlacements,
    getSortedMatchKeys,
    getSortedRoundIndexes,
    hasThirdPlaceMatchField,
    isMatchResolved,
    isMatchSlotBlocked,
    isMatchWinnerDisqualified,
    rebuildParticipantStatesFromRounds,
    recomputeRoundStatuses,
    reconcileBracketMatchReadiness,
    reconcileProfileEventPrizeAssignments,
    reconcileThirdPlaceMatchReadiness,
    removeCompletedEventPrizeProjections,
    resolveEventPrizeAssignments,
    resolveRoundMatchState,
    resolveRoundMatchesWithConcurrency,
    setMatchSlotBlocked,
    setMatchSlotParticipant,
  };
};

const defaultRuntime = createEventBracketRuntime();

module.exports = {
  ...defaultRuntime,
  createEventBracketRuntime,
};
