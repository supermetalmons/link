"use strict";

const {
  buildAutoInviteId,
  pickHostColor,
  shuffle,
} = require("@mons/shared/ids");
const {
  CONTROLLER_VERSION,
  buildFreshMatchRecord,
} = require("@mons/shared/match-protocol");
const {
  THIRD_PLACE_MATCH_KEY,
  buildEventMatchKey,
  buildEventSeedOrder,
  getEventBracketSize,
  parseEventMatchKey,
} = require("@mons/shared/events");
const { isEventPrizeEvent } = require("@mons/shared/event-prizes");
const { getEventParticipantIds } = require("./participants");
const {
  canonicalizeEventParticipants,
  canonicalizeEventPrizeSelections,
  profileOwnershipUnavailable,
  resolveOwnedProfileReferences,
} = require("./ownership");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const normalizeStringOrNull = (value) => normalizeString(value) || null;

const toFiniteInteger = (value, fallback = 0) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
};

const getMatchIndexFromKey = (matchKey) =>
  parseEventMatchKey(matchKey)?.matchIndex ?? 0;

const getSortedMatchKeys = (matchesByKey) =>
  Object.keys(matchesByKey || {}).sort(
    (left, right) => getMatchIndexFromKey(left) - getMatchIndexFromKey(right),
  );

const getSortedRoundIndexes = (roundsByKey) =>
  Array.from(
    new Set(
      Object.keys(roundsByKey || {})
        .map((roundKey) => toFiniteInteger(roundKey, NaN))
        .filter(
          (roundIndex) =>
            Number.isFinite(roundIndex) && Math.floor(roundIndex) >= 0,
        )
        .map((roundIndex) => Math.floor(roundIndex)),
    ),
  ).sort((left, right) => left - right);

const isResolvedMatchStatus = (status) =>
  status === "host" || status === "guest" || status === "bye";

const isMatchWinnerDisqualified = (match) =>
  !!(match && match.winnerDisqualified === true);

const isMatchResolved = (match) => {
  if (isMatchWinnerDisqualified(match)) {
    return true;
  }
  const status = normalizeString(match && match.status);
  if (status === "bye") {
    return true;
  }
  return (
    (status === "host" || status === "guest") &&
    normalizeString(match && match.winnerProfileId) !== ""
  );
};

const isMatchSlotBlocked = (match, slot) => {
  if (!match) {
    return false;
  }
  return slot === "guest"
    ? match.guestSlotBlocked === true
    : match.hostSlotBlocked === true;
};

const buildSeedToProfileId = ({ participantIds, random }) => {
  const shuffledParticipantIds = shuffle(participantIds, random);
  const seedToProfileId = new Map();
  for (let seed = 1; seed <= shuffledParticipantIds.length; seed += 1) {
    const profileId = shuffledParticipantIds[seed - 1];
    if (!profileId) {
      break;
    }
    seedToProfileId.set(seed, profileId);
  }
  return seedToProfileId;
};

const createEmptyEventMatch = (matchKey) => ({
  matchKey,
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

const hasThirdPlaceMatchField = (event) =>
  !!(
    event &&
    typeof event === "object" &&
    (event.supportsThirdPlaceMatch === true ||
      (event.thirdPlaceMatch && typeof event.thirdPlaceMatch === "object"))
  );

const setMatchSlotBlocked = (match, slot, blocked) => {
  const field = slot === "guest" ? "guestSlotBlocked" : "hostSlotBlocked";
  const nextValue = blocked === true;
  if (match[field] === nextValue) {
    return false;
  }
  match[field] = nextValue;
  return true;
};

const setMatchSlotParticipant = (match, slot, participant) => {
  const prefix = slot === "guest" ? "guest" : "host";
  const values = {
    ProfileId: participant ? participant.profileId : null,
    LoginUid: participant ? participant.loginUid : null,
    DisplayName: participant ? participant.displayName : null,
    EmojiId: participant ? participant.emojiId : null,
    Aura: participant ? participant.aura || null : null,
  };
  let didChange = false;
  for (const [suffix, value] of Object.entries(values)) {
    const field = `${prefix}${suffix}`;
    if (match[field] !== value) {
      match[field] = value;
      didChange = true;
    }
  }
  if (participant && setMatchSlotBlocked(match, slot, false)) {
    didChange = true;
  }
  return didChange;
};

const applyMatchResolution = (match, resolved, nowMs) => {
  if (!match || !resolved) {
    return false;
  }
  let didChange = false;
  if (match.status !== resolved.status) {
    match.status = resolved.status;
    didChange = true;
  }
  if (
    normalizeStringOrNull(match.winnerProfileId) !== resolved.winnerProfileId
  ) {
    match.winnerProfileId = resolved.winnerProfileId;
    didChange = true;
  }
  if (normalizeStringOrNull(match.loserProfileId) !== resolved.loserProfileId) {
    match.loserProfileId = resolved.loserProfileId;
    didChange = true;
  }
  if (typeof match.resolvedAtMs !== "number") {
    match.resolvedAtMs = nowMs;
    didChange = true;
  }
  return didChange;
};

const assignWinnerToNextRound = ({
  rounds,
  roundIndex,
  matchIndex,
  winnerProfileId,
  participantsById,
  winnerDisqualified = false,
}) => {
  const nextRound = rounds[String(roundIndex + 1)];
  if (
    !nextRound ||
    !nextRound.matches ||
    typeof nextRound.matches !== "object"
  ) {
    return false;
  }
  const nextMatchIndex = Math.floor(matchIndex / 2);
  const nextMatch =
    nextRound.matches[buildEventMatchKey(roundIndex + 1, nextMatchIndex)];
  if (!nextMatch) {
    return false;
  }
  const slot = matchIndex % 2 === 0 ? "host" : "guest";
  if (winnerDisqualified) {
    const didClearParticipant = setMatchSlotParticipant(nextMatch, slot, null);
    const didSetBlocked = setMatchSlotBlocked(nextMatch, slot, true);
    return didClearParticipant || didSetBlocked;
  }
  const normalizedWinnerProfileId = normalizeString(winnerProfileId);
  if (!normalizedWinnerProfileId) {
    const didClearParticipant = setMatchSlotParticipant(nextMatch, slot, null);
    const didClearBlocked = setMatchSlotBlocked(nextMatch, slot, false);
    return didClearParticipant || didClearBlocked;
  }
  const didSetParticipant = setMatchSlotParticipant(
    nextMatch,
    slot,
    participantsById[normalizedWinnerProfileId] || null,
  );
  const didClearBlocked = setMatchSlotBlocked(nextMatch, slot, false);
  return didSetParticipant || didClearBlocked;
};

const createInviteForMatch = async ({
  eventId,
  roundIndex,
  matchKey,
  match,
  inviteUpdates,
  random,
  buildRandomGameSeed,
  ownershipSnapshot,
}) => {
  if (isMatchSlotBlocked(match, "host") || isMatchSlotBlocked(match, "guest")) {
    return false;
  }
  const hostLoginUid = normalizeString(match.hostLoginUid);
  const guestLoginUid = normalizeString(match.guestLoginUid);
  if (!hostLoginUid || !guestLoginUid || normalizeString(match.inviteId)) {
    return false;
  }
  if (!ownershipSnapshot) throw profileOwnershipUnavailable();
  resolveOwnedProfileReferences(ownershipSnapshot, [
    {
      loginUid: hostLoginUid,
      profileId: normalizeString(match.hostProfileId),
    },
    {
      loginUid: guestLoginUid,
      profileId: normalizeString(match.guestProfileId),
    },
  ]);
  const inviteId = buildAutoInviteId(random);
  const hostColor = pickHostColor(random);
  const guestColor = hostColor === "white" ? "black" : "white";
  const gameSeed = await buildRandomGameSeed(random);
  match.inviteId = inviteId;
  match.status = "pending";
  inviteUpdates[`invites/${inviteId}`] = {
    version: CONTROLLER_VERSION,
    hostId: hostLoginUid,
    hostColor,
    guestId: guestLoginUid,
    eventId,
    eventRoundIndex: roundIndex,
    eventMatchKey: matchKey,
    eventOwned: true,
  };
  const createMatchRecord = (color, emojiId, aura) =>
    buildFreshMatchRecord({
      color,
      emojiId: typeof emojiId === "number" ? Math.floor(emojiId) : 0,
      aura: normalizeString(aura) || null,
      seed: gameSeed,
    });
  inviteUpdates[`players/${hostLoginUid}/matches/${inviteId}`] =
    createMatchRecord(hostColor, match.hostEmojiId, match.hostAura);
  inviteUpdates[`players/${guestLoginUid}/matches/${inviteId}`] =
    createMatchRecord(guestColor, match.guestEmojiId, match.guestAura);
  return true;
};

const reconcileThirdPlaceMatchReadiness = async ({
  eventId,
  rounds,
  nowMs,
  participantsById,
  inviteUpdates,
  thirdPlaceMatch,
  random,
  buildRandomGameSeed,
  allowInviteCreation = true,
  ownershipSnapshot,
}) => {
  if (!thirdPlaceMatch || typeof thirdPlaceMatch !== "object") {
    return { didChange: false, thirdPlaceMatch: null };
  }
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  if (sortedRoundIndexes.length < 2) {
    return { didChange: false, thirdPlaceMatch };
  }
  const semifinalRound =
    rounds[String(sortedRoundIndexes[sortedRoundIndexes.length - 2])];
  if (!semifinalRound?.matches || typeof semifinalRound.matches !== "object") {
    return { didChange: false, thirdPlaceMatch };
  }
  const semifinalMatchKeys = getSortedMatchKeys(semifinalRound.matches);
  const semifinalMatches = [
    semifinalRound.matches[semifinalMatchKeys[0]],
    semifinalRound.matches[semifinalMatchKeys[1]],
  ];
  let didChange = false;
  for (const [index, semifinalMatch] of semifinalMatches.entries()) {
    let participant = null;
    let blocked = false;
    if (semifinalMatch && typeof semifinalMatch === "object") {
      if (isMatchWinnerDisqualified(semifinalMatch)) {
        blocked = true;
      } else if (isMatchResolved(semifinalMatch)) {
        const loserProfileId = normalizeString(semifinalMatch.loserProfileId);
        participant = participantsById[loserProfileId] || null;
        blocked = !loserProfileId;
      }
    }
    const slot = index === 0 ? "host" : "guest";
    if (setMatchSlotParticipant(thirdPlaceMatch, slot, participant)) {
      didChange = true;
    }
    if (setMatchSlotBlocked(thirdPlaceMatch, slot, blocked)) {
      didChange = true;
    }
  }
  const status = normalizeString(thirdPlaceMatch.status);
  const hostProfileId = normalizeString(thirdPlaceMatch.hostProfileId);
  const guestProfileId = normalizeString(thirdPlaceMatch.guestProfileId);
  const hostSlotBlocked = isMatchSlotBlocked(thirdPlaceMatch, "host");
  const guestSlotBlocked = isMatchSlotBlocked(thirdPlaceMatch, "guest");
  if (
    isMatchWinnerDisqualified(thirdPlaceMatch) &&
    !isResolvedMatchStatus(status)
  ) {
    didChange =
      applyMatchResolution(
        thirdPlaceMatch,
        { status: "bye", winnerProfileId: null, loserProfileId: null },
        nowMs,
      ) || didChange;
    return { didChange, thirdPlaceMatch };
  }
  if (isMatchResolved(thirdPlaceMatch)) {
    return { didChange, thirdPlaceMatch };
  }
  if (hostProfileId && guestProfileId) {
    if (!allowInviteCreation) {
      return { didChange, thirdPlaceMatch };
    }
    didChange =
      (await createInviteForMatch({
        eventId,
        roundIndex: null,
        matchKey: thirdPlaceMatch.matchKey || THIRD_PLACE_MATCH_KEY,
        match: thirdPlaceMatch,
        inviteUpdates,
        random,
        buildRandomGameSeed,
        ownershipSnapshot,
      })) || didChange;
    return { didChange, thirdPlaceMatch };
  }
  const hasSingleParticipant = !!hostProfileId !== !!guestProfileId;
  if (hasSingleParticipant && (hostSlotBlocked || guestSlotBlocked)) {
    didChange =
      applyMatchResolution(
        thirdPlaceMatch,
        {
          status: "bye",
          winnerProfileId: hostProfileId || guestProfileId,
          loserProfileId: null,
        },
        nowMs,
      ) || didChange;
    return { didChange, thirdPlaceMatch };
  }
  if (
    !hostProfileId &&
    !guestProfileId &&
    hostSlotBlocked &&
    guestSlotBlocked
  ) {
    didChange =
      applyMatchResolution(
        thirdPlaceMatch,
        { status: "bye", winnerProfileId: null, loserProfileId: null },
        nowMs,
      ) || didChange;
    return { didChange, thirdPlaceMatch };
  }
  if (status !== "upcoming") {
    thirdPlaceMatch.status = "upcoming";
    didChange = true;
  }
  return { didChange, thirdPlaceMatch };
};

const reconcileBracketMatchReadiness = async ({
  eventId,
  rounds,
  nowMs,
  participantsById,
  inviteUpdates,
  random,
  buildRandomGameSeed,
  ownershipSnapshot,
}) => {
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  let didChange = false;
  let passChanged = true;
  let passCount = 0;
  while (passChanged && passCount < 32) {
    passChanged = false;
    passCount += 1;
    for (const roundIndex of sortedRoundIndexes) {
      const round = rounds[String(roundIndex)];
      if (!round?.matches || typeof round.matches !== "object") {
        continue;
      }
      for (const matchKey of getSortedMatchKeys(round.matches)) {
        const match = round.matches[matchKey];
        if (!match || typeof match !== "object") {
          continue;
        }
        const status = normalizeString(match.status);
        const hostProfileId = normalizeString(match.hostProfileId);
        const guestProfileId = normalizeString(match.guestProfileId);
        const winnerDisqualified = isMatchWinnerDisqualified(match);
        const hostSlotBlocked = isMatchSlotBlocked(match, "host");
        const guestSlotBlocked = isMatchSlotBlocked(match, "guest");
        const matchIndex = getMatchIndexFromKey(matchKey);
        if (winnerDisqualified && !isResolvedMatchStatus(status)) {
          if (
            assignWinnerToNextRound({
              rounds,
              roundIndex,
              matchIndex,
              winnerProfileId: null,
              participantsById,
              winnerDisqualified: true,
            })
          ) {
            didChange = true;
            passChanged = true;
          }
          continue;
        }
        if (isResolvedMatchStatus(status)) {
          const winnerProfileId = normalizeString(match.winnerProfileId);
          if (
            assignWinnerToNextRound({
              rounds,
              roundIndex,
              matchIndex,
              winnerProfileId,
              participantsById,
              winnerDisqualified: winnerDisqualified || !winnerProfileId,
            })
          ) {
            didChange = true;
            passChanged = true;
          }
          continue;
        }
        if (hostProfileId && guestProfileId) {
          if (
            await createInviteForMatch({
              eventId,
              roundIndex,
              matchKey,
              match,
              inviteUpdates,
              random,
              buildRandomGameSeed,
              ownershipSnapshot,
            })
          ) {
            didChange = true;
            passChanged = true;
          }
          continue;
        }
        const hasSingleParticipant = !!hostProfileId !== !!guestProfileId;
        if (
          hasSingleParticipant &&
          (roundIndex === 0 || hostSlotBlocked || guestSlotBlocked)
        ) {
          const winnerProfileId = hostProfileId || guestProfileId;
          if (
            applyMatchResolution(
              match,
              { status: "bye", winnerProfileId, loserProfileId: null },
              nowMs,
            )
          ) {
            didChange = true;
            passChanged = true;
          }
          if (
            assignWinnerToNextRound({
              rounds,
              roundIndex,
              matchIndex,
              winnerProfileId,
              participantsById,
              winnerDisqualified,
            })
          ) {
            didChange = true;
            passChanged = true;
          }
          continue;
        }
        if (
          !hostProfileId &&
          !guestProfileId &&
          hostSlotBlocked &&
          guestSlotBlocked
        ) {
          if (
            applyMatchResolution(
              match,
              { status: "bye", winnerProfileId: null, loserProfileId: null },
              nowMs,
            )
          ) {
            didChange = true;
            passChanged = true;
          }
          if (
            assignWinnerToNextRound({
              rounds,
              roundIndex,
              matchIndex,
              winnerProfileId: null,
              participantsById,
              winnerDisqualified: true,
            })
          ) {
            didChange = true;
            passChanged = true;
          }
          continue;
        }
        if (status !== "upcoming") {
          match.status = "upcoming";
          didChange = true;
          passChanged = true;
        }
      }
    }
  }
  return didChange;
};

const recomputeRoundStatuses = ({ rounds, nowMs }) => {
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  const finalRoundIndex = sortedRoundIndexes.at(-1) ?? null;
  let earliestUnresolvedRoundIndex = null;
  let finalRoundWinnerProfileId = null;
  let didChange = false;
  for (const roundIndex of sortedRoundIndexes) {
    const round = rounds[String(roundIndex)];
    if (!round?.matches || typeof round.matches !== "object") {
      continue;
    }
    const matchKeys = getSortedMatchKeys(round.matches);
    const winnerProfileIds = new Set();
    let allResolved = matchKeys.length > 0;
    let hasStarted = false;
    for (const matchKey of matchKeys) {
      const match = round.matches[matchKey];
      if (!match || typeof match !== "object") {
        allResolved = false;
        continue;
      }
      if (
        normalizeString(match.status) !== "upcoming" ||
        normalizeString(match.hostProfileId) ||
        normalizeString(match.guestProfileId) ||
        isMatchSlotBlocked(match, "host") ||
        isMatchSlotBlocked(match, "guest")
      ) {
        hasStarted = true;
      }
      if (!isMatchResolved(match)) {
        allResolved = false;
        continue;
      }
      const winnerProfileId = normalizeString(match.winnerProfileId);
      if (winnerProfileId && !isMatchWinnerDisqualified(match)) {
        winnerProfileIds.add(winnerProfileId);
      }
    }
    const nextStatus = allResolved
      ? "completed"
      : hasStarted
        ? "active"
        : "upcoming";
    if (round.status !== nextStatus) {
      round.status = nextStatus;
      didChange = true;
    }
    if (nextStatus === "completed") {
      if (typeof round.completedAtMs !== "number") {
        round.completedAtMs = nowMs;
        didChange = true;
      }
    } else if (round.completedAtMs !== null) {
      round.completedAtMs = null;
      didChange = true;
    }
    if (!allResolved && earliestUnresolvedRoundIndex === null) {
      earliestUnresolvedRoundIndex = roundIndex;
    }
    if (roundIndex === finalRoundIndex && allResolved) {
      const winners = Array.from(winnerProfileIds);
      if (winners.length === 1) {
        finalRoundWinnerProfileId = winners[0];
      }
    }
  }
  return {
    didChange,
    finalRoundIndex,
    earliestUnresolvedRoundIndex,
    finalRoundWinnerProfileId,
  };
};

const buildFixedBracketState = async ({
  eventId,
  participantIds,
  participantsById,
  nowMs,
  enableThirdPlace = false,
  random,
  buildRandomGameSeed,
  ownershipSnapshot,
}) => {
  const bracketSize = getEventBracketSize(participantIds.length);
  const roundCount = Math.max(1, Math.round(Math.log2(bracketSize)));
  const seedOrder = buildEventSeedOrder(bracketSize);
  const inviteUpdates = {};
  const rounds = {};
  let thirdPlaceMatch = null;
  const seedToProfileId = buildSeedToProfileId({ participantIds, random });
  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const round = {
      roundIndex,
      status: roundIndex === 0 ? "active" : "upcoming",
      createdAtMs: nowMs,
      completedAtMs: null,
      matches: {},
    };
    const matchCount = bracketSize / Math.pow(2, roundIndex + 1);
    for (let matchIndex = 0; matchIndex < matchCount; matchIndex += 1) {
      const matchKey = buildEventMatchKey(roundIndex, matchIndex);
      const match = createEmptyEventMatch(matchKey);
      if (roundIndex === 0) {
        const hostProfileId =
          seedToProfileId.get(seedOrder[matchIndex * 2]) || null;
        const guestProfileId =
          seedToProfileId.get(seedOrder[matchIndex * 2 + 1]) || null;
        setMatchSlotParticipant(
          match,
          "host",
          participantsById[hostProfileId] || null,
        );
        setMatchSlotParticipant(
          match,
          "guest",
          participantsById[guestProfileId] || null,
        );
        if (hostProfileId && guestProfileId) {
          await createInviteForMatch({
            eventId,
            roundIndex,
            matchKey,
            match,
            inviteUpdates,
            random,
            buildRandomGameSeed,
            ownershipSnapshot,
          });
        } else if (hostProfileId || guestProfileId) {
          applyMatchResolution(
            match,
            {
              status: "bye",
              winnerProfileId: hostProfileId || guestProfileId,
              loserProfileId: null,
            },
            nowMs,
          );
        }
      }
      round.matches[matchKey] = match;
    }
    rounds[String(roundIndex)] = round;
  }
  await reconcileBracketMatchReadiness({
    eventId,
    rounds,
    nowMs,
    participantsById,
    inviteUpdates,
    random,
    buildRandomGameSeed,
    ownershipSnapshot,
  });
  if (enableThirdPlace && participantIds.length >= 4 && roundCount >= 2) {
    thirdPlaceMatch = createEmptyEventMatch(THIRD_PLACE_MATCH_KEY);
    await reconcileThirdPlaceMatchReadiness({
      eventId,
      rounds,
      nowMs,
      participantsById,
      inviteUpdates,
      thirdPlaceMatch,
      random,
      buildRandomGameSeed,
      ownershipSnapshot,
    });
  }
  const { earliestUnresolvedRoundIndex } = recomputeRoundStatuses({
    rounds,
    nowMs,
  });
  return {
    bracketSize,
    roundCount,
    currentRoundIndex:
      earliestUnresolvedRoundIndex === null ? 0 : earliestUnresolvedRoundIndex,
    rounds,
    thirdPlaceMatch,
    inviteUpdates,
  };
};

const buildScheduledEventDueUpdatesCore = async ({
  eventId,
  event,
  nowMs,
  random = Math.random,
  buildRandomGameSeed,
  ownershipSnapshot,
  prizeSelections,
}) => {
  if (typeof buildRandomGameSeed !== "function") {
    throw new TypeError("buildRandomGameSeed is required");
  }
  if (!event || event.status !== "scheduled") {
    return { didChange: false, updates: {} };
  }
  if (typeof event.startAtMs !== "number" || nowMs < event.startAtMs) {
    return { didChange: false, updates: {} };
  }
  const storedParticipantIds = getEventParticipantIds(event);
  if (storedParticipantIds.length < 2) {
    const shouldClearPrizeSelections =
      isEventPrizeEvent(eventId) &&
      prizeSelections !== undefined &&
      prizeSelections !== null &&
      (!prizeSelections ||
        typeof prizeSelections !== "object" ||
        Array.isArray(prizeSelections) ||
        Object.keys(prizeSelections).length > 0);
    Object.assign(event, {
      status: "dismissed",
      endedAtMs: nowMs,
      updatedAtMs: nowMs,
      winnerProfileId: null,
      winnerDisplayName: null,
    });
    return {
      didChange: true,
      updates: {
        ...(shouldClearPrizeSelections
          ? { [`eventPrizeSelections/${eventId}`]: null }
          : {}),
        [`events/${eventId}/status`]: event.status,
        [`events/${eventId}/endedAtMs`]: event.endedAtMs,
        [`events/${eventId}/updatedAtMs`]: event.updatedAtMs,
        [`events/${eventId}/winnerProfileId`]: null,
        [`events/${eventId}/winnerDisplayName`]: null,
      },
    };
  }
  const prizeSelectionResult = isEventPrizeEvent(eventId)
    ? (() => {
        if (prizeSelections === undefined) {
          throw profileOwnershipUnavailable();
        }
        return canonicalizeEventPrizeSelections(
          event,
          prizeSelections,
          ownershipSnapshot,
        );
      })()
    : { didChange: false, selectionsByProfileId: {} };
  const prizeSelectionUpdates = prizeSelectionResult.didChange
    ? {
        [`eventPrizeSelections/${eventId}`]:
          Object.keys(prizeSelectionResult.selectionsByProfileId).length > 0
            ? prizeSelectionResult.selectionsByProfileId
            : null,
      }
    : {};
  if (!ownershipSnapshot) throw profileOwnershipUnavailable();
  const canonicalParticipants = canonicalizeEventParticipants(
    event,
    ownershipSnapshot,
  );
  const participantsById = canonicalParticipants.participantsById;
  const participantIds = getEventParticipantIds({
    participants: participantsById,
  });
  event.participants = participantsById;
  if (participantIds.length >= 2) {
    const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
    const bracket = await buildFixedBracketState({
      eventId,
      participantIds,
      participantsById,
      nowMs,
      enableThirdPlace: supportsThirdPlaceMatch,
      random,
      buildRandomGameSeed,
      ownershipSnapshot,
    });
    Object.assign(event, {
      status: "active",
      startedAtMs: nowMs,
      updatedAtMs: nowMs,
      currentRoundIndex: bracket.currentRoundIndex,
      bracketSize: bracket.bracketSize,
      roundCount: bracket.roundCount,
    });
    if (supportsThirdPlaceMatch) {
      event.thirdPlaceMatch = bracket.thirdPlaceMatch;
    }
    return {
      didChange: true,
      updates: {
        ...bracket.inviteUpdates,
        ...prizeSelectionUpdates,
        [`events/${eventId}/status`]: event.status,
        [`events/${eventId}/startedAtMs`]: event.startedAtMs,
        [`events/${eventId}/updatedAtMs`]: event.updatedAtMs,
        [`events/${eventId}/currentRoundIndex`]: event.currentRoundIndex,
        [`events/${eventId}/bracketSize`]: event.bracketSize,
        [`events/${eventId}/roundCount`]: event.roundCount,
        [`events/${eventId}/rounds`]: bracket.rounds,
        ...(canonicalParticipants.didChange
          ? { [`events/${eventId}/participants`]: participantsById }
          : {}),
        ...(supportsThirdPlaceMatch
          ? { [`events/${eventId}/thirdPlaceMatch`]: bracket.thirdPlaceMatch }
          : {}),
      },
    };
  }
  throw profileOwnershipUnavailable();
};

module.exports = {
  applyMatchResolution,
  assignWinnerToNextRound,
  buildSeedToProfileId,
  buildFixedBracketState,
  buildScheduledEventDueUpdatesCore,
  createEmptyEventMatch,
  createInviteForMatch,
  getSortedMatchKeys,
  getSortedRoundIndexes,
  hasThirdPlaceMatchField,
  isMatchResolved,
  isMatchSlotBlocked,
  isMatchWinnerDisqualified,
  recomputeRoundStatuses,
  reconcileBracketMatchReadiness,
  reconcileThirdPlaceMatchReadiness,
  setMatchSlotBlocked,
  setMatchSlotParticipant,
};
