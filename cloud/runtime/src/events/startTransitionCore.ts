import {
  eventState,
  eventMatchState,
  eventRoundState,
  eventParticipantAt,
  eventRoundAt,
  eventRoundMatches,
  eventMatchAt,
  eventMatchEntryKind,
  eventThirdPlaceMatch,
  createEventMatchInvite,
  createEventMatchDocument,
  createEventRoundDocument,
  createEventRoundsDocument,
  createEventMatchesDocument,
  patchEventDocument,
  patchEventMatch,
  patchEventRound,
  setEventRound,
  setEventMatch,
  setEventMatchSlotBlocked,
  copyEventParticipantToMatchSlot,
  readEventDocument,
} from "./documents.js";
import type { EventCommitPlan, EventMutation } from "../eventCommands.js";
import type { EventOwnershipSnapshot } from "./ownership.js";
import type {
  EventData,
  EventParticipants,
  EventMatch,
  EventRounds,
  MatchResolution,
  MatchReadinessInput,
  BuildGameSeed,
} from "./model.js";
import { eventField } from "../eventCommands.js";

import { buildAutoInviteId, pickHostColor, shuffle } from "@mons/shared/ids";
import {
  CONTROLLER_VERSION,
  buildFreshMatchRecord,
} from "@mons/shared/match-protocol";
import {
  THIRD_PLACE_MATCH_KEY,
  buildEventMatchKey,
  buildEventSeedOrder,
  getEventBracketSize,
  parseEventMatchKey,
} from "@mons/shared/events";
import { isEventPrizeEvent } from "@mons/shared/event-prizes";
import { getEventParticipantIds } from "./participants.js";
import {
  canonicalizeEventParticipants,
  canonicalizeEventPrizeSelections,
  profileOwnershipUnavailable,
  resolveOwnedProfileReferences,
} from "./ownership.js";
export type ScheduledEventTransitionResult = {
  didChange: boolean;
  updates: EventCommitPlan;
};
export type EventStartTransitionDependencies = {
  random?: () => number;
  buildRandomGameSeed: BuildGameSeed;
  ownershipSnapshot: EventOwnershipSnapshot | null;
  prizeSelections?: Record<string, string> | null;
};
export type FixedBracketInput = {
  eventId: string;
  participantIds: string[];
  participantsById: EventParticipants;
  nowMs: number;
  enableThirdPlace?: boolean;
  random?: () => number;
  buildRandomGameSeed: BuildGameSeed;
  ownershipSnapshot: EventOwnershipSnapshot;
};
export type ThirdPlaceReadinessOptions = {
  thirdPlaceMatch: EventMatch | null;
} & (
  | {
      allowInviteCreation: false;
      ownershipSnapshot?: EventOwnershipSnapshot | null;
    }
  | {
      allowInviteCreation?: true;
      ownershipSnapshot: EventOwnershipSnapshot | null;
    }
);
export type ThirdPlaceReadinessInput = Omit<
  MatchReadinessInput,
  "ownershipSnapshot"
> &
  ThirdPlaceReadinessOptions;

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const normalizeStringOrNull = (value: unknown) =>
  normalizeString(value) || null;

const toFiniteInteger = (value: unknown, fallback = 0) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
};

const getMatchIndexFromKey = (matchKey: string) =>
  parseEventMatchKey(matchKey)?.matchIndex ?? 0;

const getSortedMatchKeys = (matchesByKey: object | null | undefined) =>
  Object.keys(matchesByKey || {}).sort(
    (left, right) => getMatchIndexFromKey(left) - getMatchIndexFromKey(right),
  );

const getSortedRoundIndexes = (roundsByKey: object | null | undefined) =>
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

const isResolvedMatchStatus = (status: unknown) =>
  status === "host" || status === "guest" || status === "bye";

const isMatchWinnerDisqualified = (match: EventMatch | null | undefined) =>
  !!(match && eventMatchState(match).winnerDisqualified === true);

const isMatchResolved = (match: EventMatch | null | undefined) => {
  if (isMatchWinnerDisqualified(match)) {
    return true;
  }
  const status = normalizeString(match && eventMatchState(match).status);
  if (status === "bye") {
    return true;
  }
  return (
    (status === "host" || status === "guest") &&
    normalizeString(match && eventMatchState(match).winnerProfileId) !== ""
  );
};

const isMatchSlotBlocked = (
  match: EventMatch | null | undefined,
  slot: "host" | "guest",
) => {
  if (!match) {
    return false;
  }
  return slot === "guest"
    ? eventMatchState(match).guestSlotBlocked === true
    : eventMatchState(match).hostSlotBlocked === true;
};

const buildSeedToProfileId = ({
  participantIds,
  random,
}: {
  participantIds: string[];
  random?: () => number;
}) => {
  const shuffledParticipantIds = shuffle(participantIds, random);
  const seedToProfileId = new Map<number, string>();
  for (let seed = 1; seed <= shuffledParticipantIds.length; seed += 1) {
    const profileId = shuffledParticipantIds[seed - 1];
    if (!profileId) {
      break;
    }
    seedToProfileId.set(seed, profileId);
  }
  return seedToProfileId;
};

const createEmptyEventMatch = (matchKey: string): EventMatch =>
  createEventMatchDocument({
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

const hasThirdPlaceMatchField = (event: EventData | null | undefined) =>
  !!event &&
  (eventState(event).supportsThirdPlaceMatch ||
    eventThirdPlaceMatch(event) !== null);

const setMatchSlotBlocked = setEventMatchSlotBlocked;
const setMatchSlotParticipant = copyEventParticipantToMatchSlot;

const applyMatchResolution = (
  match: EventMatch | null,
  resolved: MatchResolution | null,
  nowMs: number,
) => {
  if (!match || !resolved) {
    return false;
  }
  let didChange = false;
  if (eventMatchState(match).status !== resolved.status) {
    patchEventMatch(match, { status: resolved.status });
    didChange = true;
  }
  if (
    normalizeStringOrNull(eventMatchState(match).winnerProfileId) !==
    resolved.winnerProfileId
  ) {
    patchEventMatch(match, { winnerProfileId: resolved.winnerProfileId });
    didChange = true;
  }
  if (
    normalizeStringOrNull(eventMatchState(match).loserProfileId) !==
    resolved.loserProfileId
  ) {
    patchEventMatch(match, { loserProfileId: resolved.loserProfileId });
    didChange = true;
  }
  if (typeof eventMatchState(match).resolvedAtMs !== "number") {
    patchEventMatch(match, { resolvedAtMs: nowMs });
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
}: {
  rounds: EventRounds;
  roundIndex: number;
  matchIndex: number;
  winnerProfileId: unknown;
  participantsById: EventParticipants;
  winnerDisqualified?: boolean;
}) => {
  const nextRound = eventRoundAt(rounds, String(roundIndex + 1));
  if (
    !nextRound ||
    !eventRoundMatches(nextRound) ||
    typeof eventRoundMatches(nextRound) !== "object"
  ) {
    return false;
  }
  const nextMatchIndex = Math.floor(matchIndex / 2);
  const nextMatches = eventRoundMatches(nextRound);
  const nextMatchKey = buildEventMatchKey(roundIndex + 1, nextMatchIndex);
  const targetKind = eventMatchEntryKind(nextMatches, nextMatchKey);
  if (targetKind === "missing") return false;
  if (targetKind === "invalid")
    throw new TypeError("Cannot assign an event match slot to a scalar.");
  const nextMatch = eventMatchAt(nextMatches, nextMatchKey)!;
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
    eventParticipantAt(participantsById, normalizedWinnerProfileId) || null,
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
  useStoredMatchKey = false,
}: {
  eventId: string;
  roundIndex: number | null;
  matchKey: string;
  match: EventMatch;
  inviteUpdates: EventCommitPlan;
  random?: () => number;
  buildRandomGameSeed: BuildGameSeed;
  ownershipSnapshot?: EventOwnershipSnapshot | null;
  useStoredMatchKey?: boolean;
}) => {
  if (isMatchSlotBlocked(match, "host") || isMatchSlotBlocked(match, "guest")) {
    return false;
  }
  const hostLoginUid = normalizeString(eventMatchState(match).hostLoginUid);
  const guestLoginUid = normalizeString(eventMatchState(match).guestLoginUid);
  if (
    !hostLoginUid ||
    !guestLoginUid ||
    normalizeString(eventMatchState(match).inviteId)
  ) {
    return false;
  }
  if (!ownershipSnapshot) throw profileOwnershipUnavailable();
  resolveOwnedProfileReferences(ownershipSnapshot, [
    {
      loginUid: hostLoginUid,
      profileId: normalizeString(eventMatchState(match).hostProfileId),
    },
    {
      loginUid: guestLoginUid,
      profileId: normalizeString(eventMatchState(match).guestProfileId),
    },
  ]);
  const inviteId = buildAutoInviteId(random);
  const hostColor = pickHostColor(random);
  const guestColor = hostColor === "white" ? "black" : "white";
  const gameSeed = await buildRandomGameSeed(random);
  patchEventMatch(match, { inviteId: inviteId });
  patchEventMatch(match, { status: "pending" });
  inviteUpdates.push({
    kind: "invite",
    inviteId: inviteId,
    value: createEventMatchInvite(
      match,
      {
        version: CONTROLLER_VERSION,
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
  const createMatchRecord = (
    color: "white" | "black",
    emojiId: unknown,
    aura: unknown,
  ) =>
    buildFreshMatchRecord({
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
      eventMatchState(match).hostEmojiId,
      eventMatchState(match).hostAura,
    ),
  });
  inviteUpdates.push({
    kind: "match-creation",
    playerId: guestLoginUid,
    matchId: inviteId,
    value: createMatchRecord(
      guestColor,
      eventMatchState(match).guestEmojiId,
      eventMatchState(match).guestAura,
    ),
  });
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
}: ThirdPlaceReadinessInput) => {
  if (!thirdPlaceMatch || typeof thirdPlaceMatch !== "object") {
    return { didChange: false, thirdPlaceMatch: null };
  }
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  if (sortedRoundIndexes.length < 2) {
    return { didChange: false, thirdPlaceMatch };
  }
  const semifinalRound = eventRoundAt(
    rounds,
    String(sortedRoundIndexes[sortedRoundIndexes.length - 2]),
  );
  if (
    !eventRoundMatches(semifinalRound) ||
    typeof eventRoundMatches(semifinalRound) !== "object"
  ) {
    return { didChange: false, thirdPlaceMatch };
  }
  const semifinalMatchKeys = getSortedMatchKeys(
    eventRoundMatches(semifinalRound),
  );
  const semifinalMatches = [
    eventMatchAt(eventRoundMatches(semifinalRound), semifinalMatchKeys[0]),
    eventMatchAt(eventRoundMatches(semifinalRound), semifinalMatchKeys[1]),
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
          eventMatchState(semifinalMatch).loserProfileId,
        );
        participant =
          eventParticipantAt(participantsById, loserProfileId) || null;
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
  const status = normalizeString(eventMatchState(thirdPlaceMatch).status);
  const hostProfileId = normalizeString(
    eventMatchState(thirdPlaceMatch).hostProfileId,
  );
  const guestProfileId = normalizeString(
    eventMatchState(thirdPlaceMatch).guestProfileId,
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
        matchKey: THIRD_PLACE_MATCH_KEY,
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
    patchEventMatch(thirdPlaceMatch, { status: "upcoming" });
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
}: MatchReadinessInput) => {
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  let didChange = false;
  let passChanged = true;
  let passCount = 0;
  while (passChanged && passCount < 32) {
    passChanged = false;
    passCount += 1;
    for (const roundIndex of sortedRoundIndexes) {
      const round = eventRoundAt(rounds, String(roundIndex));
      if (!round || !eventRoundMatches(round)) {
        continue;
      }
      for (const matchKey of getSortedMatchKeys(eventRoundMatches(round))) {
        const match = eventMatchAt(eventRoundMatches(round), matchKey);
        if (!match || typeof match !== "object") {
          continue;
        }
        const status = normalizeString(eventMatchState(match).status);
        const hostProfileId = normalizeString(
          eventMatchState(match).hostProfileId,
        );
        const guestProfileId = normalizeString(
          eventMatchState(match).guestProfileId,
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
            eventMatchState(match).winnerProfileId,
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
          patchEventMatch(match, { status: "upcoming" });
          didChange = true;
          passChanged = true;
        }
      }
    }
  }
  return didChange;
};

const recomputeRoundStatuses = ({
  rounds,
  nowMs,
}: {
  rounds: EventRounds;
  nowMs: number;
}) => {
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  const finalRoundIndex = sortedRoundIndexes.at(-1) ?? null;
  let earliestUnresolvedRoundIndex = null;
  let finalRoundWinnerProfileId = null;
  let didChange = false;
  for (const roundIndex of sortedRoundIndexes) {
    const round = eventRoundAt(rounds, String(roundIndex));
    if (!round || !eventRoundMatches(round)) {
      continue;
    }
    const matchKeys = getSortedMatchKeys(eventRoundMatches(round));
    const winnerProfileIds = new Set<string>();
    let allResolved = matchKeys.length > 0;
    let hasStarted = false;
    for (const matchKey of matchKeys) {
      const match = eventMatchAt(eventRoundMatches(round), matchKey);
      if (!match || typeof match !== "object") {
        allResolved = false;
        continue;
      }
      if (
        normalizeString(eventMatchState(match).status) !== "upcoming" ||
        normalizeString(eventMatchState(match).hostProfileId) ||
        normalizeString(eventMatchState(match).guestProfileId) ||
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
        eventMatchState(match).winnerProfileId,
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
    if (eventRoundState(round).status !== nextStatus) {
      patchEventRound(round, { status: nextStatus });
      didChange = true;
    }
    if (nextStatus === "completed") {
      if (typeof eventRoundState(round).completedAtMs !== "number") {
        patchEventRound(round, { completedAtMs: nowMs });
        didChange = true;
      }
    } else if (!eventRoundState(round).completedAtIsNull) {
      patchEventRound(round, { completedAtMs: null });
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
}: FixedBracketInput) => {
  const bracketSize = getEventBracketSize(participantIds.length);
  const roundCount = Math.max(1, Math.round(Math.log2(bracketSize)));
  const seedOrder = buildEventSeedOrder(bracketSize);
  const inviteUpdates: EventCommitPlan = [];
  const rounds = createEventRoundsDocument();
  let thirdPlaceMatch: EventMatch | null = null;
  const seedToProfileId = buildSeedToProfileId({ participantIds, random });
  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const matches = createEventMatchesDocument();
    const round = createEventRoundDocument({
      roundIndex,
      status: roundIndex === 0 ? "active" : "upcoming",
      createdAtMs: nowMs,
      completedAtMs: null,
      matches,
    });
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
          eventParticipantAt(participantsById, String(hostProfileId)) || null,
        );
        setMatchSlotParticipant(
          match,
          "guest",
          eventParticipantAt(participantsById, String(guestProfileId)) || null,
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
      setEventMatch(matches, matchKey, match);
    }
    setEventRound(rounds, String(roundIndex), round);
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
}: {
  eventId: string;
  event: EventData;
  nowMs: number;
} & EventStartTransitionDependencies): Promise<ScheduledEventTransitionResult> => {
  if (typeof buildRandomGameSeed !== "function") {
    throw new TypeError("buildRandomGameSeed is required");
  }
  if (!event || eventState(event).status !== "scheduled") {
    return { didChange: false, updates: [] };
  }
  const startAtMs = eventState(event).startAtMs;
  if (typeof startAtMs !== "number" || nowMs < startAtMs) {
    return { didChange: false, updates: [] };
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
    patchEventDocument(event, {
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
                kind: "prize-selections" as const,
                eventId: eventId,
                value: null,
              },
            ]
          : []),
        eventField(eventId, "status", "dismissed"),
        eventField(eventId, "endedAtMs", eventState(event).endedAtMs!),
        eventField(eventId, "updatedAtMs", eventState(event).updatedAtMs!),
        eventField(eventId, "winnerProfileId", null),
        eventField(eventId, "winnerDisplayName", null),
      ],
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
  const prizeSelectionUpdates: EventMutation[] = prizeSelectionResult.didChange
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
  if (!ownershipSnapshot) throw profileOwnershipUnavailable();
  const canonicalParticipants = canonicalizeEventParticipants(
    event,
    ownershipSnapshot,
  );
  const participantsById = canonicalParticipants.participantsById;
  const participantIds = getEventParticipantIds(
    readEventDocument({
      participants: participantsById,
    }),
  );
  patchEventDocument(event, { participants: participantsById });
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
    patchEventDocument(event, {
      status: "active",
      startedAtMs: nowMs,
      updatedAtMs: nowMs,
      currentRoundIndex: bracket.currentRoundIndex,
      bracketSize: bracket.bracketSize,
      roundCount: bracket.roundCount,
    });
    if (supportsThirdPlaceMatch) {
      patchEventDocument(event, { thirdPlaceMatch: bracket.thirdPlaceMatch });
    }
    return {
      didChange: true,
      updates: [
        ...bracket.inviteUpdates,
        ...prizeSelectionUpdates,
        eventField(eventId, "status", "active"),
        eventField(eventId, "startedAtMs", eventState(event).startedAtMs!),
        eventField(eventId, "updatedAtMs", eventState(event).updatedAtMs!),
        eventField(
          eventId,
          "currentRoundIndex",
          eventState(event).currentRoundIndex!,
        ),
        eventField(eventId, "bracketSize", eventState(event).bracketSize!),
        eventField(eventId, "roundCount", eventState(event).roundCount!),
        eventField(eventId, "rounds", bracket.rounds),
        ...(canonicalParticipants.didChange
          ? [eventField(eventId, "participants", participantsById)]
          : []),
        ...(supportsThirdPlaceMatch
          ? [eventField(eventId, "thirdPlaceMatch", bracket.thirdPlaceMatch)]
          : []),
      ],
    };
  }
  throw profileOwnershipUnavailable();
};

export {
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
