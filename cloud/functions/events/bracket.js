"use strict";

const admin = require("../firebaseAdmin");
const { batchReadWithRetry } = require("../batchRead");
const { resolveMatchWinner } = require("../matchOutcome");
const {
  buildEventPrizeAssignments,
  normalizeEventPrizeAssignments,
} = require("../eventPrizeAwards");
const { getEventPrizeDefinitions } = require("@mons/shared/event-prizes");
const {
  filterProjectableEventPrizeAssignments,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
} = require("../eventPrizeWithdrawalState");
const { buildRandomGameSeed } = require("../gameVariants");
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
  buildEventMatchKey: getMatchKey,
  buildEventSeedOrder: buildSeedOrder,
  getEventBracketSize: getBracketSize,
  getFirstRoundByeSeeds,
  isMonsLinkAdmin,
  parseEventMatchKey: parseMatchKey,
} = require("@mons/shared/events");
const { getEventParticipantIds } = require("./participants");

const EVENT_MATCH_RESOLVE_CONCURRENCY = 4;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const normalizeStringOrNull = (value) => normalizeString(value) || null;
const normalizeUsername = (value) => normalizeString(value).toLowerCase();

const toFiniteInteger = (value, fallback = 0) => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.floor(numeric);
};

const generateEventInviteId = () => buildAutoInviteId();

const createMatchRecord = (color, emojiId, aura, gameSeed) =>
  buildFreshMatchRecord({
    color,
    emojiId: typeof emojiId === "number" ? Math.floor(emojiId) : 0,
    aura: normalizeString(aura) || null,
    seed: gameSeed,
  });

const getMatchIndexFromKey = (matchKey) =>
  parseMatchKey(matchKey)?.matchIndex ?? 0;
const getSortedMatchKeys = (matchesByKey) =>
  Object.keys(matchesByKey || {}).sort(
    (left, right) => getMatchIndexFromKey(left) - getMatchIndexFromKey(right),
  );
const getSortedRoundIndexes = (roundsByKey) => {
  return Array.from(
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
};
const isResolvedMatchStatus = (status) =>
  status === "host" || status === "guest" || status === "bye";
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
const isMatchWinnerDisqualified = (match) =>
  !!(match && match.winnerDisqualified === true);
const isMatchSlotBlocked = (match, slot) => {
  if (!match) {
    return false;
  }
  return slot === "guest"
    ? match.guestSlotBlocked === true
    : match.hostSlotBlocked === true;
};

const buildSeedToProfileId = ({
  participantIds,
  participantsById,
  bracketSize,
  seedOrder,
}) => {
  const participantCount = participantIds.length;
  const adminParticipantIds = [];
  const nonAdminParticipantIds = [];

  for (const profileId of participantIds) {
    const participant = participantsById[profileId];
    const username = normalizeUsername(participant && participant.username);
    if (isMonsLinkAdmin(username)) {
      adminParticipantIds.push(profileId);
    } else {
      nonAdminParticipantIds.push(profileId);
    }
  }

  const shuffledAdminParticipantIds = shuffle(adminParticipantIds);
  const shuffledNonAdminParticipantIds = shuffle(nonAdminParticipantIds);
  const byeSeeds = shuffle(
    getFirstRoundByeSeeds(participantCount, bracketSize, seedOrder),
  );
  const seedToProfileId = new Map();

  while (byeSeeds.length > 0 && shuffledAdminParticipantIds.length > 0) {
    const byeSeed = byeSeeds.pop();
    const profileId = shuffledAdminParticipantIds.pop();
    if (!byeSeed || !profileId) {
      break;
    }
    seedToProfileId.set(byeSeed, profileId);
  }

  const remainingProfileIds = shuffle([
    ...shuffledAdminParticipantIds,
    ...shuffledNonAdminParticipantIds,
  ]);
  let remainingIndex = 0;
  for (let seed = 1; seed <= participantCount; seed += 1) {
    if (seedToProfileId.has(seed)) {
      continue;
    }
    const profileId = remainingProfileIds[remainingIndex];
    remainingIndex += 1;
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
  const nextProfileId = participant ? participant.profileId : null;
  const nextLoginUid = participant ? participant.loginUid : null;
  const nextDisplayName = participant ? participant.displayName : null;
  const nextEmojiId = participant ? participant.emojiId : null;
  const nextAura = participant ? participant.aura || null : null;
  let didChange = false;

  if (match[`${prefix}ProfileId`] !== nextProfileId) {
    match[`${prefix}ProfileId`] = nextProfileId;
    didChange = true;
  }
  if (match[`${prefix}LoginUid`] !== nextLoginUid) {
    match[`${prefix}LoginUid`] = nextLoginUid;
    didChange = true;
  }
  if (match[`${prefix}DisplayName`] !== nextDisplayName) {
    match[`${prefix}DisplayName`] = nextDisplayName;
    didChange = true;
  }
  if (match[`${prefix}EmojiId`] !== nextEmojiId) {
    match[`${prefix}EmojiId`] = nextEmojiId;
    didChange = true;
  }
  if (match[`${prefix}Aura`] !== nextAura) {
    match[`${prefix}Aura`] = nextAura;
    didChange = true;
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
  const nextMatchKey = getMatchKey(roundIndex + 1, nextMatchIndex);
  const nextMatch = nextRound.matches[nextMatchKey];
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
}) => {
  if (isMatchSlotBlocked(match, "host") || isMatchSlotBlocked(match, "guest")) {
    return false;
  }
  const hostLoginUid = normalizeString(match.hostLoginUid);
  const guestLoginUid = normalizeString(match.guestLoginUid);
  if (!hostLoginUid || !guestLoginUid || normalizeString(match.inviteId)) {
    return false;
  }

  const inviteId = generateEventInviteId();
  const hostColor = pickHostColor();
  const guestColor = hostColor === "white" ? "black" : "white";
  const gameSeed = await buildRandomGameSeed();

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
  inviteUpdates[`players/${hostLoginUid}/matches/${inviteId}`] =
    createMatchRecord(hostColor, match.hostEmojiId, match.hostAura, gameSeed);
  inviteUpdates[`players/${guestLoginUid}/matches/${inviteId}`] =
    createMatchRecord(
      guestColor,
      match.guestEmojiId,
      match.guestAura,
      gameSeed,
    );

  return true;
};

const reconcileThirdPlaceMatchReadiness = async ({
  eventId,
  rounds,
  nowMs,
  participantsById,
  inviteUpdates,
  thirdPlaceMatch,
  allowInviteCreation = true,
}) => {
  if (!thirdPlaceMatch || typeof thirdPlaceMatch !== "object") {
    return {
      didChange: false,
      thirdPlaceMatch: null,
    };
  }

  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  if (sortedRoundIndexes.length < 2) {
    return {
      didChange: false,
      thirdPlaceMatch,
    };
  }

  const semifinalRoundIndex = sortedRoundIndexes[sortedRoundIndexes.length - 2];
  const semifinalRound = rounds[String(semifinalRoundIndex)];
  if (
    !semifinalRound ||
    !semifinalRound.matches ||
    typeof semifinalRound.matches !== "object"
  ) {
    return {
      didChange: false,
      thirdPlaceMatch,
    };
  }

  const semifinalMatchKeys = getSortedMatchKeys(semifinalRound.matches);
  const semifinalHostMatch = semifinalRound.matches[semifinalMatchKeys[0]];
  const semifinalGuestMatch = semifinalRound.matches[semifinalMatchKeys[1]];

  let didChange = false;

  const resolveThirdPlaceSlotState = (semifinalMatch) => {
    if (!semifinalMatch || typeof semifinalMatch !== "object") {
      return {
        participant: null,
        blocked: false,
      };
    }

    if (isMatchWinnerDisqualified(semifinalMatch)) {
      return {
        participant: null,
        blocked: true,
      };
    }

    if (!isMatchResolved(semifinalMatch)) {
      return {
        participant: null,
        blocked: false,
      };
    }

    const loserProfileId = normalizeString(semifinalMatch.loserProfileId);
    if (!loserProfileId) {
      return {
        participant: null,
        blocked: true,
      };
    }
    return {
      participant: participantsById[loserProfileId] || null,
      blocked: false,
    };
  };

  const hostSlotState = resolveThirdPlaceSlotState(semifinalHostMatch);
  const hostSlotParticipantChanged = setMatchSlotParticipant(
    thirdPlaceMatch,
    "host",
    hostSlotState.participant,
  );
  const hostSlotBlockedChanged = setMatchSlotBlocked(
    thirdPlaceMatch,
    "host",
    hostSlotState.blocked,
  );
  if (hostSlotParticipantChanged || hostSlotBlockedChanged) {
    didChange = true;
  }

  const guestSlotState = resolveThirdPlaceSlotState(semifinalGuestMatch);
  const guestSlotParticipantChanged = setMatchSlotParticipant(
    thirdPlaceMatch,
    "guest",
    guestSlotState.participant,
  );
  const guestSlotBlockedChanged = setMatchSlotBlocked(
    thirdPlaceMatch,
    "guest",
    guestSlotState.blocked,
  );
  if (guestSlotParticipantChanged || guestSlotBlockedChanged) {
    didChange = true;
  }

  const status = normalizeString(thirdPlaceMatch.status);
  const hostProfileId = normalizeString(thirdPlaceMatch.hostProfileId);
  const guestProfileId = normalizeString(thirdPlaceMatch.guestProfileId);
  const hostSlotBlocked = isMatchSlotBlocked(thirdPlaceMatch, "host");
  const guestSlotBlocked = isMatchSlotBlocked(thirdPlaceMatch, "guest");
  const winnerDisqualified = isMatchWinnerDisqualified(thirdPlaceMatch);

  if (winnerDisqualified && !isResolvedMatchStatus(status)) {
    if (
      applyMatchResolution(
        thirdPlaceMatch,
        {
          status: "bye",
          winnerProfileId: null,
          loserProfileId: null,
        },
        nowMs,
      )
    ) {
      didChange = true;
    }
    return {
      didChange,
      thirdPlaceMatch,
    };
  }

  if (isMatchResolved(thirdPlaceMatch)) {
    return {
      didChange,
      thirdPlaceMatch,
    };
  }

  if (hostProfileId && guestProfileId) {
    if (!allowInviteCreation) {
      return {
        didChange,
        thirdPlaceMatch,
      };
    }
    if (
      await createInviteForMatch({
        eventId,
        roundIndex: null,
        matchKey: thirdPlaceMatch.matchKey || THIRD_PLACE_MATCH_KEY,
        match: thirdPlaceMatch,
        inviteUpdates,
      })
    ) {
      didChange = true;
    }
    return {
      didChange,
      thirdPlaceMatch,
    };
  }

  const hasSingleParticipant = !!hostProfileId !== !!guestProfileId;
  if (hasSingleParticipant && (hostSlotBlocked || guestSlotBlocked)) {
    if (
      applyMatchResolution(
        thirdPlaceMatch,
        {
          status: "bye",
          winnerProfileId: hostProfileId || guestProfileId,
          loserProfileId: null,
        },
        nowMs,
      )
    ) {
      didChange = true;
    }
    return {
      didChange,
      thirdPlaceMatch,
    };
  }

  if (
    !hostProfileId &&
    !guestProfileId &&
    hostSlotBlocked &&
    guestSlotBlocked
  ) {
    if (
      applyMatchResolution(
        thirdPlaceMatch,
        {
          status: "bye",
          winnerProfileId: null,
          loserProfileId: null,
        },
        nowMs,
      )
    ) {
      didChange = true;
    }
    return {
      didChange,
      thirdPlaceMatch,
    };
  }

  if (status !== "upcoming") {
    thirdPlaceMatch.status = "upcoming";
    didChange = true;
  }

  return {
    didChange,
    thirdPlaceMatch,
  };
};

const reconcileBracketMatchReadiness = async ({
  eventId,
  rounds,
  nowMs,
  participantsById,
  inviteUpdates,
}) => {
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  if (sortedRoundIndexes.length <= 0) {
    return false;
  }

  let didChange = false;
  let passChanged = true;
  let passCount = 0;

  while (passChanged && passCount < 32) {
    passChanged = false;
    passCount += 1;

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
          const resolvedWinnerProfileId = normalizeString(
            match.winnerProfileId,
          );
          const shouldBlockDownstream =
            winnerDisqualified || resolvedWinnerProfileId === "";
          if (
            assignWinnerToNextRound({
              rounds,
              roundIndex,
              matchIndex,
              winnerProfileId: resolvedWinnerProfileId,
              participantsById,
              winnerDisqualified: shouldBlockDownstream,
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
              {
                status: "bye",
                winnerProfileId,
                loserProfileId: null,
              },
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
              {
                status: "bye",
                winnerProfileId: null,
                loserProfileId: null,
              },
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
  const finalRoundIndex =
    sortedRoundIndexes.length > 0
      ? sortedRoundIndexes[sortedRoundIndexes.length - 1]
      : null;
  let earliestUnresolvedRoundIndex = null;
  let finalRoundWinnerProfileId = null;
  let didChange = false;

  for (const roundIndex of sortedRoundIndexes) {
    const round = rounds[String(roundIndex)];
    if (!round || !round.matches || typeof round.matches !== "object") {
      continue;
    }

    const matchKeys = getSortedMatchKeys(round.matches);
    const roundWinnerProfileIds = new Set();
    let allResolved = matchKeys.length > 0;
    let hasStarted = false;

    for (const matchKey of matchKeys) {
      const match = round.matches[matchKey];
      if (!match || typeof match !== "object") {
        allResolved = false;
        continue;
      }

      const status = normalizeString(match.status);
      const hostProfileId = normalizeString(match.hostProfileId);
      const guestProfileId = normalizeString(match.guestProfileId);
      if (
        status !== "upcoming" ||
        hostProfileId ||
        guestProfileId ||
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
        roundWinnerProfileIds.add(winnerProfileId);
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

    if (
      finalRoundIndex !== null &&
      roundIndex === finalRoundIndex &&
      allResolved
    ) {
      const winners = Array.from(roundWinnerProfileIds);
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

const getEventPrizeDisqualifiedIdentityKeys = ({ rounds, thirdPlaceMatch }) => {
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
    result === "winner" ? winnerSide : winnerSide === "host" ? "guest" : "host";
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
      isEventPrizeParticipantDisqualified(participant, disqualifiedIdentityKeys)
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
  eventId,
  assignments,
}) => {
  const withdrawalsSnapshot = await admin
    .database()
    .ref(`eventPrizeWithdrawals/${eventId}`)
    .once("value");
  return filterProjectableEventPrizeAssignments({
    eventId,
    assignments,
    withdrawals: withdrawalsSnapshot.val() || {},
  });
};

const addEventPrizeAssignmentUpdates = async ({
  updates,
  eventId,
  assignments,
  includeEventAssignments,
}) => {
  if (includeEventAssignments) {
    updates[`events/${eventId}/prizeAssignments`] = assignments;
  }
  const projectableAssignments = await getProjectableEventPrizeAssignments({
    eventId,
    assignments,
  });
  for (const assignment of Object.values(projectableAssignments)) {
    updates[`profileEventPrizes/${assignment.profileId}/${eventId}`] =
      assignment;
  }
};

const getMissingEventPrizeProjectionUpdates = async ({
  eventId,
  assignments,
}) => {
  const updates = {};
  const projectableAssignments = await getProjectableEventPrizeAssignments({
    eventId,
    assignments,
  });
  await Promise.all(
    Object.values(projectableAssignments).map(async (assignment) => {
      const snapshot = await admin
        .database()
        .ref(`profileEventPrizes/${assignment.profileId}/${eventId}`)
        .once("value");
      const current = snapshot.val();
      if (
        !current ||
        current.eventId !== assignment.eventId ||
        current.profileId !== assignment.profileId ||
        Number(current.place) !== assignment.place ||
        current.prizeId !== assignment.prizeId ||
        Number(current.assignedAtMs) !== assignment.assignedAtMs
      ) {
        updates[`profileEventPrizes/${assignment.profileId}/${eventId}`] =
          assignment;
      }
    }),
  );
  return updates;
};

const removeCompletedEventPrizeProjections = async ({
  eventId,
  assignments,
}) => {
  const withdrawalsSnapshot = await admin
    .database()
    .ref(`eventPrizeWithdrawals/${eventId}`)
    .once("value");
  const withdrawals = withdrawalsSnapshot.val() || {};
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
      await admin
        .database()
        .ref(`profileEventPrizes/${assignment.profileId}/${eventId}`)
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
  const selectionsSnapshot = await admin
    .database()
    .ref(`eventPrizeSelections/${eventId}`)
    .once("value");
  return {
    assignments: buildEventPrizeAssignments({
      eventId,
      placements,
      selections: selectionsSnapshot.val() || {},
      assignedAtMs,
    }),
    didCreate: true,
  };
};

const buildFixedBracketState = async ({
  eventId,
  participantIds,
  participantsById,
  nowMs,
  enableThirdPlace = false,
}) => {
  const bracketSize = getBracketSize(participantIds.length);
  const roundCount = Math.max(1, Math.round(Math.log2(bracketSize)));
  const seedOrder = buildSeedOrder(bracketSize);
  const inviteUpdates = {};
  const rounds = {};
  let thirdPlaceMatch = null;
  const seedToProfileId = buildSeedToProfileId({
    participantIds,
    participantsById,
    bracketSize,
    seedOrder,
  });

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
      const matchKey = getMatchKey(roundIndex, matchIndex);
      const match = createEmptyEventMatch(matchKey);

      if (roundIndex === 0) {
        const hostSeed = seedOrder[matchIndex * 2];
        const guestSeed = seedOrder[matchIndex * 2 + 1];
        const hostProfileId = seedToProfileId.get(hostSeed) || null;
        const guestProfileId = seedToProfileId.get(guestSeed) || null;

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

const buildScheduledEventDueUpdates = async ({ eventId, event, nowMs }) => {
  if (!event || event.status !== "scheduled") {
    return { didChange: false, updates: {} };
  }
  if (typeof event.startAtMs !== "number" || nowMs < event.startAtMs) {
    return { didChange: false, updates: {} };
  }

  const participantIds = getEventParticipantIds(event);
  if (participantIds.length >= 2) {
    const participantsById = event.participants || {};
    const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
    const bracket = await buildFixedBracketState({
      eventId,
      participantIds,
      participantsById,
      nowMs,
      enableThirdPlace: supportsThirdPlaceMatch,
    });

    event.status = "active";
    event.startedAtMs = nowMs;
    event.updatedAtMs = nowMs;
    event.currentRoundIndex = bracket.currentRoundIndex;
    event.bracketSize = bracket.bracketSize;
    event.roundCount = bracket.roundCount;
    if (supportsThirdPlaceMatch) {
      event.thirdPlaceMatch = bracket.thirdPlaceMatch;
    }

    return {
      didChange: true,
      updates: {
        ...bracket.inviteUpdates,
        [`events/${eventId}/status`]: event.status,
        [`events/${eventId}/startedAtMs`]: event.startedAtMs,
        [`events/${eventId}/updatedAtMs`]: event.updatedAtMs,
        [`events/${eventId}/currentRoundIndex`]: event.currentRoundIndex,
        [`events/${eventId}/bracketSize`]: event.bracketSize,
        [`events/${eventId}/roundCount`]: event.roundCount,
        [`events/${eventId}/rounds`]: bracket.rounds,
        ...(supportsThirdPlaceMatch
          ? {
              [`events/${eventId}/thirdPlaceMatch`]: bracket.thirdPlaceMatch,
            }
          : {}),
      },
    };
  }

  event.status = "dismissed";
  event.endedAtMs = nowMs;
  event.updatedAtMs = nowMs;
  event.winnerProfileId = null;
  event.winnerDisplayName = null;
  return {
    didChange: true,
    updates: {
      [`events/${eventId}/status`]: event.status,
      [`events/${eventId}/endedAtMs`]: event.endedAtMs,
      [`events/${eventId}/updatedAtMs`]: event.updatedAtMs,
      [`events/${eventId}/winnerProfileId`]: null,
      [`events/${eventId}/winnerDisplayName`]: null,
    },
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

module.exports = {
  addEventPrizeAssignmentUpdates,
  applyMatchResolution,
  assignWinnerToNextRound,
  buildFixedBracketState,
  buildScheduledEventDueUpdates,
  buildSeedToProfileId,
  createEmptyEventMatch,
  getEventPrizePlacements,
  getMissingEventPrizeProjectionUpdates,
  getSortedMatchKeys,
  getSortedRoundIndexes,
  hasThirdPlaceMatchField,
  isMatchResolved,
  isMatchSlotBlocked,
  isMatchWinnerDisqualified,
  rebuildParticipantStatesFromRounds,
  recomputeRoundStatuses,
  reconcileBracketMatchReadiness,
  reconcileThirdPlaceMatchReadiness,
  removeCompletedEventPrizeProjections,
  resolveEventPrizeAssignments,
  resolveRoundMatchState,
  resolveRoundMatchesWithConcurrency,
  setMatchSlotBlocked,
  setMatchSlotParticipant,
};
