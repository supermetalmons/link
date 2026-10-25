// Generated from src/events/startTransitionCore.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setMatchSlotParticipant =
  exports.setMatchSlotBlocked =
  exports.reconcileThirdPlaceMatchReadiness =
  exports.reconcileBracketMatchReadiness =
  exports.recomputeRoundStatuses =
  exports.isMatchWinnerDisqualified =
  exports.isMatchSlotBlocked =
  exports.isMatchResolved =
  exports.hasThirdPlaceMatchField =
  exports.getSortedRoundIndexes =
  exports.getSortedMatchKeys =
  exports.createInviteForMatch =
  exports.createEmptyEventMatch =
  exports.buildScheduledEventDueUpdatesCore =
  exports.buildFixedBracketState =
  exports.buildSeedToProfileId =
  exports.assignWinnerToNextRound =
  exports.applyMatchResolution =
    void 0;
const documents_js_1 = require("./documents.js");
const eventCommands_js_1 = require("../eventCommands.js");
const ids_1 = require("@mons/shared/ids");
const match_protocol_1 = require("@mons/shared/match-protocol");
const events_1 = require("@mons/shared/events");
const event_prizes_1 = require("@mons/shared/event-prizes");
const participants_js_1 = require("./participants.js");
const ownership_js_1 = require("./ownership.js");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const normalizeStringOrNull = (value) => normalizeString(value) || null;
const toFiniteInteger = (value, fallback = 0) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
};
const getMatchIndexFromKey = (matchKey) =>
  (0, events_1.parseEventMatchKey)(matchKey)?.matchIndex ?? 0;
const getSortedMatchKeys = (matchesByKey) =>
  Object.keys(matchesByKey || {}).sort(
    (left, right) => getMatchIndexFromKey(left) - getMatchIndexFromKey(right),
  );
exports.getSortedMatchKeys = getSortedMatchKeys;
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
exports.getSortedRoundIndexes = getSortedRoundIndexes;
const isResolvedMatchStatus = (status) =>
  status === "host" || status === "guest" || status === "bye";
const isMatchWinnerDisqualified = (match) =>
  !!(
    match &&
    (0, documents_js_1.eventMatchState)(match).winnerDisqualified === true
  );
exports.isMatchWinnerDisqualified = isMatchWinnerDisqualified;
const isMatchResolved = (match) => {
  if (isMatchWinnerDisqualified(match)) {
    return true;
  }
  const status = normalizeString(
    match && (0, documents_js_1.eventMatchState)(match).status,
  );
  if (status === "bye") {
    return true;
  }
  return (
    (status === "host" || status === "guest") &&
    normalizeString(
      match && (0, documents_js_1.eventMatchState)(match).winnerProfileId,
    ) !== ""
  );
};
exports.isMatchResolved = isMatchResolved;
const isMatchSlotBlocked = (match, slot) => {
  if (!match) {
    return false;
  }
  return slot === "guest"
    ? (0, documents_js_1.eventMatchState)(match).guestSlotBlocked === true
    : (0, documents_js_1.eventMatchState)(match).hostSlotBlocked === true;
};
exports.isMatchSlotBlocked = isMatchSlotBlocked;
const buildSeedToProfileId = ({ participantIds, random }) => {
  const shuffledParticipantIds = (0, ids_1.shuffle)(participantIds, random);
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
exports.buildSeedToProfileId = buildSeedToProfileId;
const createEmptyEventMatch = (matchKey) =>
  (0, documents_js_1.createEventMatchDocument)({
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
exports.createEmptyEventMatch = createEmptyEventMatch;
const hasThirdPlaceMatchField = (event) =>
  !!event &&
  ((0, documents_js_1.eventState)(event).supportsThirdPlaceMatch ||
    (0, documents_js_1.eventThirdPlaceMatch)(event) !== null);
exports.hasThirdPlaceMatchField = hasThirdPlaceMatchField;
const setMatchSlotBlocked = documents_js_1.setEventMatchSlotBlocked;
exports.setMatchSlotBlocked = setMatchSlotBlocked;
const setMatchSlotParticipant = documents_js_1.copyEventParticipantToMatchSlot;
exports.setMatchSlotParticipant = setMatchSlotParticipant;
const applyMatchResolution = (match, resolved, nowMs) => {
  if (!match || !resolved) {
    return false;
  }
  let didChange = false;
  if ((0, documents_js_1.eventMatchState)(match).status !== resolved.status) {
    (0, documents_js_1.patchEventMatch)(match, { status: resolved.status });
    didChange = true;
  }
  if (
    normalizeStringOrNull(
      (0, documents_js_1.eventMatchState)(match).winnerProfileId,
    ) !== resolved.winnerProfileId
  ) {
    (0, documents_js_1.patchEventMatch)(match, {
      winnerProfileId: resolved.winnerProfileId,
    });
    didChange = true;
  }
  if (
    normalizeStringOrNull(
      (0, documents_js_1.eventMatchState)(match).loserProfileId,
    ) !== resolved.loserProfileId
  ) {
    (0, documents_js_1.patchEventMatch)(match, {
      loserProfileId: resolved.loserProfileId,
    });
    didChange = true;
  }
  if (
    typeof (0, documents_js_1.eventMatchState)(match).resolvedAtMs !== "number"
  ) {
    (0, documents_js_1.patchEventMatch)(match, { resolvedAtMs: nowMs });
    didChange = true;
  }
  return didChange;
};
exports.applyMatchResolution = applyMatchResolution;
const assignWinnerToNextRound = ({
  rounds,
  roundIndex,
  matchIndex,
  winnerProfileId,
  participantsById,
  winnerDisqualified = false,
}) => {
  const nextRound = (0, documents_js_1.eventRoundAt)(
    rounds,
    String(roundIndex + 1),
  );
  if (
    !nextRound ||
    !(0, documents_js_1.eventRoundMatches)(nextRound) ||
    typeof (0, documents_js_1.eventRoundMatches)(nextRound) !== "object"
  ) {
    return false;
  }
  const nextMatchIndex = Math.floor(matchIndex / 2);
  const nextMatches = (0, documents_js_1.eventRoundMatches)(nextRound);
  const nextMatchKey = (0, events_1.buildEventMatchKey)(
    roundIndex + 1,
    nextMatchIndex,
  );
  const targetKind = (0, documents_js_1.eventMatchEntryKind)(
    nextMatches,
    nextMatchKey,
  );
  if (targetKind === "missing") return false;
  if (targetKind === "invalid")
    throw new TypeError("Cannot assign an event match slot to a scalar.");
  const nextMatch = (0, documents_js_1.eventMatchAt)(nextMatches, nextMatchKey);
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
    (0, documents_js_1.eventParticipantAt)(
      participantsById,
      normalizedWinnerProfileId,
    ) || null,
  );
  const didClearBlocked = setMatchSlotBlocked(nextMatch, slot, false);
  return didSetParticipant || didClearBlocked;
};
exports.assignWinnerToNextRound = assignWinnerToNextRound;
const createInviteForMatch = async ({
  eventId,
  roundIndex,
  matchKey,
  match,
  inviteUpdates,
  random,
  buildRandomGameSeed,
  ownershipSnapshot,
  useStoredMatchKey = false,
}) => {
  if (isMatchSlotBlocked(match, "host") || isMatchSlotBlocked(match, "guest")) {
    return false;
  }
  const hostLoginUid = normalizeString(
    (0, documents_js_1.eventMatchState)(match).hostLoginUid,
  );
  const guestLoginUid = normalizeString(
    (0, documents_js_1.eventMatchState)(match).guestLoginUid,
  );
  if (
    !hostLoginUid ||
    !guestLoginUid ||
    normalizeString((0, documents_js_1.eventMatchState)(match).inviteId)
  ) {
    return false;
  }
  if (!ownershipSnapshot)
    throw (0, ownership_js_1.profileOwnershipUnavailable)();
  (0, ownership_js_1.resolveOwnedProfileReferences)(ownershipSnapshot, [
    {
      loginUid: hostLoginUid,
      profileId: normalizeString(
        (0, documents_js_1.eventMatchState)(match).hostProfileId,
      ),
    },
    {
      loginUid: guestLoginUid,
      profileId: normalizeString(
        (0, documents_js_1.eventMatchState)(match).guestProfileId,
      ),
    },
  ]);
  const inviteId = (0, ids_1.buildAutoInviteId)(random);
  const hostColor = (0, ids_1.pickHostColor)(random);
  const guestColor = hostColor === "white" ? "black" : "white";
  const gameSeed = await buildRandomGameSeed(random);
  (0, documents_js_1.patchEventMatch)(match, { inviteId: inviteId });
  (0, documents_js_1.patchEventMatch)(match, { status: "pending" });
  inviteUpdates.push({
    kind: "invite",
    inviteId: inviteId,
    value: (0, documents_js_1.createEventMatchInvite)(
      match,
      {
        version: match_protocol_1.CONTROLLER_VERSION,
        hostId: hostLoginUid,
        hostColor,
        guestId: guestLoginUid,
        eventId,
        eventRoundIndex: roundIndex,
      },
      matchKey,
      useStoredMatchKey,
    ),
  });
  const createMatchRecord = (color, emojiId, aura) =>
    (0, match_protocol_1.buildFreshMatchRecord)({
      color,
      emojiId: typeof emojiId === "number" ? Math.floor(emojiId) : 0,
      aura: normalizeString(aura) || null,
      seed: gameSeed,
    });
  inviteUpdates.push({
    kind: "match-creation",
    playerId: hostLoginUid,
    matchId: inviteId,
    value: createMatchRecord(
      hostColor,
      (0, documents_js_1.eventMatchState)(match).hostEmojiId,
      (0, documents_js_1.eventMatchState)(match).hostAura,
    ),
  });
  inviteUpdates.push({
    kind: "match-creation",
    playerId: guestLoginUid,
    matchId: inviteId,
    value: createMatchRecord(
      guestColor,
      (0, documents_js_1.eventMatchState)(match).guestEmojiId,
      (0, documents_js_1.eventMatchState)(match).guestAura,
    ),
  });
  return true;
};
exports.createInviteForMatch = createInviteForMatch;
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
  const semifinalRound = (0, documents_js_1.eventRoundAt)(
    rounds,
    String(sortedRoundIndexes[sortedRoundIndexes.length - 2]),
  );
  if (
    !(0, documents_js_1.eventRoundMatches)(semifinalRound) ||
    typeof (0, documents_js_1.eventRoundMatches)(semifinalRound) !== "object"
  ) {
    return { didChange: false, thirdPlaceMatch };
  }
  const semifinalMatchKeys = getSortedMatchKeys(
    (0, documents_js_1.eventRoundMatches)(semifinalRound),
  );
  const semifinalMatches = [
    (0, documents_js_1.eventMatchAt)(
      (0, documents_js_1.eventRoundMatches)(semifinalRound),
      semifinalMatchKeys[0],
    ),
    (0, documents_js_1.eventMatchAt)(
      (0, documents_js_1.eventRoundMatches)(semifinalRound),
      semifinalMatchKeys[1],
    ),
  ];
  let didChange = false;
  for (const [index, semifinalMatch] of semifinalMatches.entries()) {
    let participant = null;
    let blocked = false;
    if (semifinalMatch && typeof semifinalMatch === "object") {
      if (isMatchWinnerDisqualified(semifinalMatch)) {
        blocked = true;
      } else if (isMatchResolved(semifinalMatch)) {
        const loserProfileId = normalizeString(
          (0, documents_js_1.eventMatchState)(semifinalMatch).loserProfileId,
        );
        participant =
          (0, documents_js_1.eventParticipantAt)(
            participantsById,
            loserProfileId,
          ) || null;
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
  const status = normalizeString(
    (0, documents_js_1.eventMatchState)(thirdPlaceMatch).status,
  );
  const hostProfileId = normalizeString(
    (0, documents_js_1.eventMatchState)(thirdPlaceMatch).hostProfileId,
  );
  const guestProfileId = normalizeString(
    (0, documents_js_1.eventMatchState)(thirdPlaceMatch).guestProfileId,
  );
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
        matchKey: events_1.THIRD_PLACE_MATCH_KEY,
        useStoredMatchKey: true,
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
    (0, documents_js_1.patchEventMatch)(thirdPlaceMatch, {
      status: "upcoming",
    });
    didChange = true;
  }
  return { didChange, thirdPlaceMatch };
};
exports.reconcileThirdPlaceMatchReadiness = reconcileThirdPlaceMatchReadiness;
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
      const round = (0, documents_js_1.eventRoundAt)(
        rounds,
        String(roundIndex),
      );
      if (!round || !(0, documents_js_1.eventRoundMatches)(round)) {
        continue;
      }
      for (const matchKey of getSortedMatchKeys(
        (0, documents_js_1.eventRoundMatches)(round),
      )) {
        const match = (0, documents_js_1.eventMatchAt)(
          (0, documents_js_1.eventRoundMatches)(round),
          matchKey,
        );
        if (!match || typeof match !== "object") {
          continue;
        }
        const status = normalizeString(
          (0, documents_js_1.eventMatchState)(match).status,
        );
        const hostProfileId = normalizeString(
          (0, documents_js_1.eventMatchState)(match).hostProfileId,
        );
        const guestProfileId = normalizeString(
          (0, documents_js_1.eventMatchState)(match).guestProfileId,
        );
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
          const winnerProfileId = normalizeString(
            (0, documents_js_1.eventMatchState)(match).winnerProfileId,
          );
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
          (0, documents_js_1.patchEventMatch)(match, { status: "upcoming" });
          didChange = true;
          passChanged = true;
        }
      }
    }
  }
  return didChange;
};
exports.reconcileBracketMatchReadiness = reconcileBracketMatchReadiness;
const recomputeRoundStatuses = ({ rounds, nowMs }) => {
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  const finalRoundIndex = sortedRoundIndexes.at(-1) ?? null;
  let earliestUnresolvedRoundIndex = null;
  let finalRoundWinnerProfileId = null;
  let didChange = false;
  for (const roundIndex of sortedRoundIndexes) {
    const round = (0, documents_js_1.eventRoundAt)(rounds, String(roundIndex));
    if (!round || !(0, documents_js_1.eventRoundMatches)(round)) {
      continue;
    }
    const matchKeys = getSortedMatchKeys(
      (0, documents_js_1.eventRoundMatches)(round),
    );
    const winnerProfileIds = new Set();
    let allResolved = matchKeys.length > 0;
    let hasStarted = false;
    for (const matchKey of matchKeys) {
      const match = (0, documents_js_1.eventMatchAt)(
        (0, documents_js_1.eventRoundMatches)(round),
        matchKey,
      );
      if (!match || typeof match !== "object") {
        allResolved = false;
        continue;
      }
      if (
        normalizeString((0, documents_js_1.eventMatchState)(match).status) !==
          "upcoming" ||
        normalizeString(
          (0, documents_js_1.eventMatchState)(match).hostProfileId,
        ) ||
        normalizeString(
          (0, documents_js_1.eventMatchState)(match).guestProfileId,
        ) ||
        isMatchSlotBlocked(match, "host") ||
        isMatchSlotBlocked(match, "guest")
      ) {
        hasStarted = true;
      }
      if (!isMatchResolved(match)) {
        allResolved = false;
        continue;
      }
      const winnerProfileId = normalizeString(
        (0, documents_js_1.eventMatchState)(match).winnerProfileId,
      );
      if (winnerProfileId && !isMatchWinnerDisqualified(match)) {
        winnerProfileIds.add(winnerProfileId);
      }
    }
    const nextStatus = allResolved
      ? "completed"
      : hasStarted
        ? "active"
        : "upcoming";
    if ((0, documents_js_1.eventRoundState)(round).status !== nextStatus) {
      (0, documents_js_1.patchEventRound)(round, { status: nextStatus });
      didChange = true;
    }
    if (nextStatus === "completed") {
      if (
        typeof (0, documents_js_1.eventRoundState)(round).completedAtMs !==
        "number"
      ) {
        (0, documents_js_1.patchEventRound)(round, { completedAtMs: nowMs });
        didChange = true;
      }
    } else if (!(0, documents_js_1.eventRoundState)(round).completedAtIsNull) {
      (0, documents_js_1.patchEventRound)(round, { completedAtMs: null });
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
exports.recomputeRoundStatuses = recomputeRoundStatuses;
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
  const bracketSize = (0, events_1.getEventBracketSize)(participantIds.length);
  const roundCount = Math.max(1, Math.round(Math.log2(bracketSize)));
  const seedOrder = (0, events_1.buildEventSeedOrder)(bracketSize);
  const inviteUpdates = [];
  const rounds = (0, documents_js_1.createEventRoundsDocument)();
  let thirdPlaceMatch = null;
  const seedToProfileId = buildSeedToProfileId({ participantIds, random });
  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const matches = (0, documents_js_1.createEventMatchesDocument)();
    const round = (0, documents_js_1.createEventRoundDocument)({
      roundIndex,
      status: roundIndex === 0 ? "active" : "upcoming",
      createdAtMs: nowMs,
      completedAtMs: null,
      matches,
    });
    const matchCount = bracketSize / Math.pow(2, roundIndex + 1);
    for (let matchIndex = 0; matchIndex < matchCount; matchIndex += 1) {
      const matchKey = (0, events_1.buildEventMatchKey)(roundIndex, matchIndex);
      const match = createEmptyEventMatch(matchKey);
      if (roundIndex === 0) {
        const hostProfileId =
          seedToProfileId.get(seedOrder[matchIndex * 2]) || null;
        const guestProfileId =
          seedToProfileId.get(seedOrder[matchIndex * 2 + 1]) || null;
        setMatchSlotParticipant(
          match,
          "host",
          (0, documents_js_1.eventParticipantAt)(
            participantsById,
            String(hostProfileId),
          ) || null,
        );
        setMatchSlotParticipant(
          match,
          "guest",
          (0, documents_js_1.eventParticipantAt)(
            participantsById,
            String(guestProfileId),
          ) || null,
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
      (0, documents_js_1.setEventMatch)(matches, matchKey, match);
    }
    (0, documents_js_1.setEventRound)(rounds, String(roundIndex), round);
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
    thirdPlaceMatch = createEmptyEventMatch(events_1.THIRD_PLACE_MATCH_KEY);
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
exports.buildFixedBracketState = buildFixedBracketState;
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
  if (!event || (0, documents_js_1.eventState)(event).status !== "scheduled") {
    return { didChange: false, updates: [] };
  }
  const startAtMs = (0, documents_js_1.eventState)(event).startAtMs;
  if (typeof startAtMs !== "number" || nowMs < startAtMs) {
    return { didChange: false, updates: [] };
  }
  const storedParticipantIds = (0, participants_js_1.getEventParticipantIds)(
    event,
  );
  if (storedParticipantIds.length < 2) {
    const shouldClearPrizeSelections =
      (0, event_prizes_1.isEventPrizeEvent)(eventId) &&
      prizeSelections !== undefined &&
      prizeSelections !== null &&
      (!prizeSelections ||
        typeof prizeSelections !== "object" ||
        Array.isArray(prizeSelections) ||
        Object.keys(prizeSelections).length > 0);
    (0, documents_js_1.patchEventDocument)(event, {
      status: "dismissed",
      endedAtMs: nowMs,
      updatedAtMs: nowMs,
      winnerProfileId: null,
      winnerDisplayName: null,
    });
    return {
      didChange: true,
      updates: [
        ...(shouldClearPrizeSelections
          ? [
              {
                kind: "prize-selections",
                eventId: eventId,
                value: null,
              },
            ]
          : []),
        (0, eventCommands_js_1.eventField)(eventId, "status", "dismissed"),
        (0, eventCommands_js_1.eventField)(
          eventId,
          "endedAtMs",
          (0, documents_js_1.eventState)(event).endedAtMs,
        ),
        (0, eventCommands_js_1.eventField)(
          eventId,
          "updatedAtMs",
          (0, documents_js_1.eventState)(event).updatedAtMs,
        ),
        (0, eventCommands_js_1.eventField)(eventId, "winnerProfileId", null),
        (0, eventCommands_js_1.eventField)(eventId, "winnerDisplayName", null),
      ],
    };
  }
  const prizeSelectionResult = (0, event_prizes_1.isEventPrizeEvent)(eventId)
    ? (() => {
        if (prizeSelections === undefined) {
          throw (0, ownership_js_1.profileOwnershipUnavailable)();
        }
        return (0, ownership_js_1.canonicalizeEventPrizeSelections)(
          event,
          prizeSelections,
          ownershipSnapshot,
        );
      })()
    : { didChange: false, selectionsByProfileId: {} };
  const prizeSelectionUpdates = prizeSelectionResult.didChange
    ? [
        {
          kind: "prize-selections",
          eventId: eventId,
          value:
            Object.keys(prizeSelectionResult.selectionsByProfileId).length > 0
              ? prizeSelectionResult.selectionsByProfileId
              : null,
        },
      ]
    : [];
  if (!ownershipSnapshot)
    throw (0, ownership_js_1.profileOwnershipUnavailable)();
  const canonicalParticipants = (0,
  ownership_js_1.canonicalizeEventParticipants)(event, ownershipSnapshot);
  const participantsById = canonicalParticipants.participantsById;
  const participantIds = (0, participants_js_1.getEventParticipantIds)(
    (0, documents_js_1.readEventDocument)({
      participants: participantsById,
    }),
  );
  (0, documents_js_1.patchEventDocument)(event, {
    participants: participantsById,
  });
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
    (0, documents_js_1.patchEventDocument)(event, {
      status: "active",
      startedAtMs: nowMs,
      updatedAtMs: nowMs,
      currentRoundIndex: bracket.currentRoundIndex,
      bracketSize: bracket.bracketSize,
      roundCount: bracket.roundCount,
    });
    if (supportsThirdPlaceMatch) {
      (0, documents_js_1.patchEventDocument)(event, {
        thirdPlaceMatch: bracket.thirdPlaceMatch,
      });
    }
    return {
      didChange: true,
      updates: [
        ...bracket.inviteUpdates,
        ...prizeSelectionUpdates,
        (0, eventCommands_js_1.eventField)(eventId, "status", "active"),
        (0, eventCommands_js_1.eventField)(
          eventId,
          "startedAtMs",
          (0, documents_js_1.eventState)(event).startedAtMs,
        ),
        (0, eventCommands_js_1.eventField)(
          eventId,
          "updatedAtMs",
          (0, documents_js_1.eventState)(event).updatedAtMs,
        ),
        (0, eventCommands_js_1.eventField)(
          eventId,
          "currentRoundIndex",
          (0, documents_js_1.eventState)(event).currentRoundIndex,
        ),
        (0, eventCommands_js_1.eventField)(
          eventId,
          "bracketSize",
          (0, documents_js_1.eventState)(event).bracketSize,
        ),
        (0, eventCommands_js_1.eventField)(
          eventId,
          "roundCount",
          (0, documents_js_1.eventState)(event).roundCount,
        ),
        (0, eventCommands_js_1.eventField)(eventId, "rounds", bracket.rounds),
        ...(canonicalParticipants.didChange
          ? [
              (0, eventCommands_js_1.eventField)(
                eventId,
                "participants",
                participantsById,
              ),
            ]
          : []),
        ...(supportsThirdPlaceMatch
          ? [
              (0, eventCommands_js_1.eventField)(
                eventId,
                "thirdPlaceMatch",
                bracket.thirdPlaceMatch,
              ),
            ]
          : []),
      ],
    };
  }
  throw (0, ownership_js_1.profileOwnershipUnavailable)();
};
exports.buildScheduledEventDueUpdatesCore = buildScheduledEventDueUpdatesCore;
