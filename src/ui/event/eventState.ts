import type {
  EventMatch,
  EventParticipant,
  EventRecord,
  EventRound,
} from "../../connection/connectionModels";
import { storage } from "../../utils/storage";
import { buildEventMatchKey, parseEventMatchKey } from "@mons/shared/events";
import { isEventPrizeEvent } from "@mons/shared/event-prizes";

export type EventUiState = {
  isJoined: boolean;
  isEliminated: boolean;
  playableMatch: EventMatch | null;
  waitingForNext: boolean;
};

export type EventAutoRecoveryReason =
  | "start-overdue"
  | "active-no-rounds"
  | "active-pending-without-invite"
  | "active-should-end"
  | "ended-missing-prize-assignments";

export const PENDING_JOIN_POLL_INTERVAL_MS = 350;
export const PENDING_JOIN_POLL_TIMEOUT_MS = 60_000;
export const DEFAULT_NOW_REFRESH_MS = 30_000;
export const POST_START_NOW_REFRESH_MS = 5_000;
export const MAX_NOW_REFRESH_MS = 60_000;
export const NOW_REFRESH_BOUNDARY_FUDGE_MS = 50;
export const EVENT_AUTO_RECOVERY_DELAY_MS = 1_000;
export const EVENT_AUTO_RECOVERY_MIN_GAP_MS = 6_000;
export const EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON = 2;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const formatRelativeStartUnit = (value: number, unit: string): string =>
  `${value} ${unit}${value === 1 ? "" : "s"}`;

export const formatRelativeStartUnits = (
  primary: string,
  secondaryValue: number,
  secondaryUnit: string,
): string =>
  secondaryValue <= 0
    ? `in ${primary}`
    : `in ${primary} ${formatRelativeStartUnit(secondaryValue, secondaryUnit)}`;

export const formatRelativeStart = (
  event: EventRecord | null,
  nowMs: number,
): string => {
  if (!event) {
    return "";
  }
  if (event.status === "dismissed") {
    return "";
  }
  if (event.status === "ended") {
    return event.winnerDisplayName ? "" : "";
  }
  if (event.status === "active") {
    return "";
  }
  const deltaMs = event.startAtMs - nowMs;
  if (deltaMs <= 0) {
    const participantCount = Object.keys(event.participants).length;
    return participantCount < 2 ? "" : "starting now";
  }

  const roundedMinutes = Math.max(1, Math.ceil(deltaMs / MINUTE_MS));
  if (deltaMs >= DAY_MS) {
    const days = Math.floor(deltaMs / DAY_MS);
    const hours = Math.floor((deltaMs % DAY_MS) / HOUR_MS);
    return formatRelativeStartUnits(
      formatRelativeStartUnit(days, "day"),
      hours,
      "hour",
    );
  }

  if (deltaMs >= HOUR_MS) {
    const hours = Math.floor(roundedMinutes / 60);
    const minutes = roundedMinutes % 60;
    return formatRelativeStartUnits(
      formatRelativeStartUnit(hours, "hour"),
      minutes,
      "minute",
    );
  }

  const minutes = roundedMinutes;
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
};

export const formatAbsoluteStart = (event: EventRecord | null): string => {
  if (!event || event.status !== "scheduled") {
    return "";
  }
  const d = new Date(event.startAtMs);
  const now = new Date();
  const time = d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    return time;
  }
  const date = d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${time} · ${date}`;
};

export const getEventNowRefreshDelayMs = (
  eventStatus: EventRecord["status"] | null,
  eventStartAtMs: number | null,
  nowMs: number,
): number => {
  if (
    eventStatus !== "scheduled" ||
    typeof eventStartAtMs !== "number" ||
    !Number.isFinite(eventStartAtMs)
  ) {
    return DEFAULT_NOW_REFRESH_MS;
  }

  const deltaMs = eventStartAtMs - nowMs;
  if (deltaMs <= 0) {
    return POST_START_NOW_REFRESH_MS;
  }

  const minuteRemainderMs = deltaMs % MINUTE_MS;
  const untilNextMinuteBoundaryMs =
    minuteRemainderMs === 0 ? MINUTE_MS : minuteRemainderMs;

  return Math.min(
    MAX_NOW_REFRESH_MS,
    untilNextMinuteBoundaryMs + NOW_REFRESH_BOUNDARY_FUDGE_MS,
  );
};

export const getParticipantCount = (event: EventRecord | null): number => {
  if (!event || !event.participants) {
    return 0;
  }
  return Object.keys(event.participants).length;
};

export const isLocalEventCreator = (event: EventRecord | null): boolean => {
  if (!event) {
    return false;
  }
  const localLoginUid = storage.getLoginId("").trim();
  const localProfileId = storage.getProfileId("").trim();
  const creatorLoginUid = event.createdByLoginUid?.trim() ?? "";
  const creatorProfileId = event.createdByProfileId?.trim() ?? "";

  return (
    (localLoginUid !== "" &&
      creatorLoginUid !== "" &&
      localLoginUid === creatorLoginUid) ||
    (localProfileId !== "" &&
      creatorProfileId !== "" &&
      localProfileId === creatorProfileId)
  );
};

export const isLocalEventParticipant = (event: EventRecord | null): boolean => {
  if (!event) {
    return false;
  }
  if (isLocalEventCreator(event)) {
    return true;
  }
  const localLoginUid = storage.getLoginId("").trim();
  const localProfileId = storage.getProfileId("").trim();
  if (localProfileId && event.participants[localProfileId]) {
    return true;
  }
  return Object.values(event.participants).some((participant) => {
    const participantLoginUid = participant.loginUid?.trim() ?? "";
    return (
      localLoginUid !== "" &&
      participantLoginUid !== "" &&
      localLoginUid === participantLoginUid
    );
  });
};

export const getSortedParticipants = (
  event: EventRecord | null,
): EventParticipant[] => {
  if (!event) {
    return [];
  }
  return Object.values(event.participants).sort(
    (left, right) => left.joinedAtMs - right.joinedAtMs,
  );
};

export const getSortedRounds = (event: EventRecord | null): EventRound[] => {
  if (!event) {
    return [];
  }
  return Object.values(event.rounds).sort(
    (left, right) => left.roundIndex - right.roundIndex,
  );
};

export const getThirdPlaceMatch = (
  event: EventRecord | null,
): EventMatch | null => {
  if (!event || !event.thirdPlaceMatch) {
    return null;
  }
  return event.thirdPlaceMatch;
};

export const getEventAutoRecoveryReason = (
  event: EventRecord | null,
  nowMs: number,
): EventAutoRecoveryReason | null => {
  if (!event) {
    return null;
  }

  if (event.status === "scheduled") {
    if (nowMs >= event.startAtMs && getParticipantCount(event) >= 2) {
      return "start-overdue";
    }
    return null;
  }

  if (
    event.status === "ended" &&
    isEventPrizeEvent(event.eventId) &&
    Object.keys(event.prizeAssignments ?? {}).length === 0
  ) {
    return "ended-missing-prize-assignments";
  }

  if (event.status !== "active") {
    return null;
  }

  const rounds = getSortedRounds(event);
  if (rounds.length === 0) {
    return "active-no-rounds";
  }

  for (const round of rounds) {
    for (const match of getSortedMatches(round)) {
      if (match.status === "pending" && getEventMatchInviteId(match) === "") {
        return "active-pending-without-invite";
      }
    }
  }

  const finalRound = rounds[rounds.length - 1] ?? null;
  if (!finalRound) {
    return null;
  }
  const finalRoundMatches = getSortedMatches(finalRound);
  if (finalRoundMatches.length <= 0) {
    return null;
  }
  const isFinalRoundResolved = finalRoundMatches.every((match) =>
    isResolvedEventMatch(match),
  );
  if (!isFinalRoundResolved) {
    return null;
  }
  const thirdPlaceMatch = getThirdPlaceMatch(event);
  if (thirdPlaceMatch && !isResolvedEventMatch(thirdPlaceMatch)) {
    return null;
  }

  return "active-should-end";
};

export const isProfileParticipatingInMatch = (
  match: EventMatch,
  profileId: string,
): boolean => {
  return (
    match.hostProfileId === profileId || match.guestProfileId === profileId
  );
};

export const getMatchKeyIndex = (matchKey: string): number | null => {
  return parseEventMatchKey(matchKey)?.matchIndex ?? null;
};

export const getSortedMatches = (round: EventRound | null): EventMatch[] => {
  if (!round) {
    return [];
  }
  return Object.values(round.matches).sort((left, right) => {
    const leftIndex = getMatchKeyIndex(left.matchKey);
    const rightIndex = getMatchKeyIndex(right.matchKey);
    if (leftIndex !== null && rightIndex !== null) {
      return leftIndex - rightIndex;
    }
    if (leftIndex !== null) {
      return -1;
    }
    if (rightIndex !== null) {
      return 1;
    }
    return left.matchKey.localeCompare(right.matchKey);
  });
};

export type MatchSide = "host" | "guest";

export type MatchSideData = {
  profileId: string | null;
  loginUid: string | null;
  displayName: string | null;
  emojiId: number | null;
  aura: string | null;
};

export type BracketMatchAction =
  | { kind: "none" }
  | { kind: "game"; inviteId: string }
  | {
      kind: "participant";
      participant: EventParticipant;
      side: MatchSide;
    };

export const getMatchSideData = (
  match: EventMatch,
  side: MatchSide,
): MatchSideData => {
  if (side === "host") {
    return {
      profileId: match.hostProfileId,
      loginUid: match.hostLoginUid,
      displayName: match.hostDisplayName,
      emojiId: match.hostEmojiId,
      aura: match.hostAura,
    };
  }
  return {
    profileId: match.guestProfileId,
    loginUid: match.guestLoginUid,
    displayName: match.guestDisplayName,
    emojiId: match.guestEmojiId,
    aura: match.guestAura,
  };
};

export const isKnownMatchSide = (side: MatchSideData): boolean => {
  const displayName = side.displayName?.trim();
  return (
    !!side.profileId ||
    !!side.loginUid ||
    !!displayName ||
    (typeof side.emojiId === "number" && Number.isFinite(side.emojiId))
  );
};

export const getSingleKnownMatchSide = (
  match: EventMatch,
): MatchSide | null => {
  const hostKnown = isKnownMatchSide(getMatchSideData(match, "host"));
  const guestKnown = isKnownMatchSide(getMatchSideData(match, "guest"));
  if (hostKnown === guestKnown) {
    return null;
  }
  return hostKnown ? "host" : "guest";
};

export const getDisplayedByeSide = (match: EventMatch): MatchSide => {
  return isKnownMatchSide(getMatchSideData(match, "host")) ? "host" : "guest";
};

export const isMatchSideBlocked = (
  match: EventMatch,
  side: MatchSide,
): boolean => {
  return side === "host" ? match.hostSlotBlocked : match.guestSlotBlocked;
};

export const getDisplayedMatchSides = (match: EventMatch): MatchSide[] => {
  const hostBlocked = isMatchSideBlocked(match, "host");
  const guestBlocked = isMatchSideBlocked(match, "guest");
  const singleKnownSide = getSingleKnownMatchSide(match);

  if (hostBlocked && guestBlocked) {
    return [singleKnownSide ?? "host"];
  }

  if (hostBlocked !== guestBlocked && singleKnownSide) {
    return [singleKnownSide];
  }

  if (match.winnerDisqualified === true) {
    return ["host", "guest"];
  }
  if (hostBlocked || guestBlocked) {
    return ["host", "guest"];
  }
  if (match.status === "bye") {
    return [getDisplayedByeSide(match)];
  }
  return ["host", "guest"];
};

export const getMatchSideLabel = (
  match: EventMatch,
  side: MatchSide,
): string => {
  const sideData = getMatchSideData(match, side);
  const displayName = sideData.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const loginUid = sideData.loginUid?.trim();
  if (loginUid) {
    return loginUid;
  }
  return side === "host" ? "host" : "guest";
};

export const buildParticipantFromMatchSide = (
  match: EventMatch,
  side: MatchSide,
  participantsById: Record<string, EventParticipant>,
): EventParticipant | null => {
  const sideData = getMatchSideData(match, side);
  const sideProfileId = sideData.profileId?.trim() ?? "";
  if (sideProfileId) {
    const participant = participantsById[sideProfileId];
    if (participant) {
      const participantLoginUid = participant.loginUid?.trim() ?? "";
      const sideLoginUid = sideData.loginUid?.trim() ?? "";
      if (!participantLoginUid && sideLoginUid) {
        return {
          ...participant,
          loginUid: sideLoginUid,
        };
      }
      return participant;
    }
  }

  const loginUid = sideData.loginUid?.trim() ?? "";
  if (!sideProfileId && !loginUid) {
    return null;
  }

  const displayName = sideData.displayName?.trim() ?? "";
  const emojiId =
    typeof sideData.emojiId === "number" && Number.isFinite(sideData.emojiId)
      ? sideData.emojiId
      : 0;

  return {
    profileId: sideProfileId,
    loginUid,
    username: displayName,
    displayName,
    emojiId,
    aura: sideData.aura ?? "",
    joinedAtMs: 0,
    state: "active",
    eliminatedRoundIndex: null,
    eliminatedByProfileId: null,
  };
};

export const getBracketMatchAction = (
  match: EventMatch,
  participantsById: Record<string, EventParticipant>,
): BracketMatchAction => {
  const inviteId = match.inviteId?.trim() ?? "";
  if (inviteId) {
    return {
      kind: "game",
      inviteId,
    };
  }

  const singleKnownSide = getSingleKnownMatchSide(match);
  if (!singleKnownSide) {
    return { kind: "none" };
  }

  const participant = buildParticipantFromMatchSide(
    match,
    singleKnownSide,
    participantsById,
  );
  if (!participant) {
    return { kind: "none" };
  }

  return {
    kind: "participant",
    participant,
    side: singleKnownSide,
  };
};

export type IndexedEventMatch = {
  roundIndex: number;
  matchIndex: number;
  match: EventMatch;
};

export const getEventMatchInviteId = (match: EventMatch): string => {
  return match.inviteId?.trim() ?? "";
};

export const isResolvedEventMatch = (match: EventMatch): boolean => {
  return (
    match.status === "host" ||
    match.status === "guest" ||
    match.status === "bye"
  );
};

export const isPendingInviteEventMatch = (match: EventMatch): boolean => {
  return match.status === "pending" && getEventMatchInviteId(match) !== "";
};

export const isActionablePendingInviteEventMatch = (
  match: EventMatch,
): boolean => {
  return isPendingInviteEventMatch(match) && match.winnerDisqualified !== true;
};

export const getIndexedMatchesForRound = (
  round: EventRound,
): IndexedEventMatch[] => {
  return getSortedMatches(round).map((match, sortedIndex) => ({
    roundIndex: round.roundIndex,
    matchIndex: parseEventMatchKey(match.matchKey)?.matchIndex ?? sortedIndex,
    match,
  }));
};

export const getFirstPendingInviteMatch = (
  event: EventRecord | null,
): EventMatch | null => {
  if (!event) {
    return null;
  }
  const rounds = getSortedRounds(event);
  for (const round of rounds) {
    const indexedMatches = getIndexedMatchesForRound(round);
    for (const indexedMatch of indexedMatches) {
      if (isActionablePendingInviteEventMatch(indexedMatch.match)) {
        return indexedMatch.match;
      }
    }
  }
  const thirdPlaceMatch = getThirdPlaceMatch(event);
  if (thirdPlaceMatch && isActionablePendingInviteEventMatch(thirdPlaceMatch)) {
    return thirdPlaceMatch;
  }
  return null;
};

export const getActivePendingMatches = (
  event: EventRecord | null,
): Array<{ roundIndex: number | null; label: string; match: EventMatch }> => {
  if (!event || event.status !== "active") {
    return [];
  }
  const matches: Array<{
    roundIndex: number | null;
    label: string;
    match: EventMatch;
  }> = [];
  const rounds = getSortedRounds(event);
  for (const round of rounds) {
    const roundMatches = getSortedMatches(round);
    for (const match of roundMatches) {
      if (isActionablePendingInviteEventMatch(match)) {
        matches.push({
          roundIndex: round.roundIndex,
          label: `Round ${round.roundIndex + 1}`,
          match,
        });
      }
    }
  }
  const thirdPlaceMatch = getThirdPlaceMatch(event);
  if (thirdPlaceMatch && isActionablePendingInviteEventMatch(thirdPlaceMatch)) {
    matches.push({
      roundIndex: null,
      label: "Third place",
      match: thirdPlaceMatch,
    });
  }
  return matches;
};

export const getRoundMatchByIndex = (
  round: EventRound,
  matchIndex: number,
): EventMatch | null => {
  const directMatch =
    round.matches[buildEventMatchKey(round.roundIndex, matchIndex)];
  if (directMatch) {
    return directMatch;
  }
  const fallbackMatch =
    getSortedMatches(round).find((candidate) => {
      const parsed = parseEventMatchKey(candidate.matchKey);
      return parsed?.matchIndex === matchIndex;
    }) ?? null;
  return fallbackMatch;
};

export const findPendingInviteMatchInBranch = (
  roundsByIndex: Map<number, EventRound>,
  roundIndex: number,
  matchIndex: number,
): EventMatch | null => {
  if (roundIndex < 0 || !Number.isFinite(matchIndex) || matchIndex < 0) {
    return null;
  }
  const round = roundsByIndex.get(roundIndex);
  if (!round) {
    return null;
  }
  const match = getRoundMatchByIndex(round, matchIndex);
  if (!match) {
    return null;
  }
  if (isActionablePendingInviteEventMatch(match)) {
    return match;
  }
  if (isResolvedEventMatch(match) || roundIndex === 0) {
    return null;
  }
  const leftBranchMatch = findPendingInviteMatchInBranch(
    roundsByIndex,
    roundIndex - 1,
    matchIndex * 2,
  );
  if (leftBranchMatch) {
    return leftBranchMatch;
  }
  return findPendingInviteMatchInBranch(
    roundsByIndex,
    roundIndex - 1,
    matchIndex * 2 + 1,
  );
};

export const getAwaitedPendingInviteMatchForParticipant = (
  event: EventRecord | null,
  profileId: string,
): EventMatch | null => {
  if (!event || !profileId) {
    return null;
  }
  const rounds = getSortedRounds(event);
  const roundsByIndex = new Map<number, EventRound>();
  for (const round of rounds) {
    roundsByIndex.set(round.roundIndex, round);
  }

  for (const round of rounds) {
    const indexedMatches = getIndexedMatchesForRound(round);
    for (const indexedMatch of indexedMatches) {
      const match = indexedMatch.match;
      const participantSide: MatchSide | null =
        match.hostProfileId === profileId
          ? "host"
          : match.guestProfileId === profileId
            ? "guest"
            : null;
      if (!participantSide) {
        continue;
      }
      if (isResolvedEventMatch(match) || isPendingInviteEventMatch(match)) {
        continue;
      }
      if (indexedMatch.roundIndex <= 0) {
        continue;
      }
      const awaitedMatchIndex =
        indexedMatch.matchIndex * 2 + (participantSide === "host" ? 1 : 0);
      const awaitedMatch = findPendingInviteMatchInBranch(
        roundsByIndex,
        indexedMatch.roundIndex - 1,
        awaitedMatchIndex,
      );
      if (awaitedMatch) {
        return awaitedMatch;
      }
    }
  }
  return null;
};

export const getCurrentUiState = (
  event: EventRecord | null,
  profileId: string,
): EventUiState => {
  if (!event || !profileId) {
    return {
      isJoined: false,
      isEliminated: false,
      playableMatch: null,
      waitingForNext: false,
    };
  }

  const participant = event.participants[profileId];
  if (!participant) {
    return {
      isJoined: false,
      isEliminated: false,
      playableMatch: null,
      waitingForNext: false,
    };
  }

  const thirdPlaceMatch = getThirdPlaceMatch(event);
  const thirdPlacePlayableMatch =
    thirdPlaceMatch &&
    isActionablePendingInviteEventMatch(thirdPlaceMatch) &&
    isProfileParticipatingInMatch(thirdPlaceMatch, profileId)
      ? thirdPlaceMatch
      : null;

  if (participant.state === "eliminated" && !thirdPlacePlayableMatch) {
    return {
      isJoined: true,
      isEliminated: true,
      playableMatch: null,
      waitingForNext: false,
    };
  }

  const rounds = getSortedRounds(event);
  let playableMatch: EventMatch | null = thirdPlacePlayableMatch;
  for (const round of rounds) {
    if (playableMatch) {
      break;
    }
    const candidate =
      getSortedMatches(round).find(
        (match) =>
          isActionablePendingInviteEventMatch(match) &&
          (match.hostProfileId === profileId ||
            match.guestProfileId === profileId),
      ) ?? null;
    if (candidate) {
      playableMatch = candidate;
      break;
    }
  }

  return {
    isJoined: true,
    isEliminated: participant.state === "eliminated",
    playableMatch,
    waitingForNext: event.status === "active" && !playableMatch,
  };
};

export const getWatchableMatch = (
  event: EventRecord | null,
  profileId: string,
  eventUiState: EventUiState,
): EventMatch | null => {
  if (!event || event.status !== "active" || eventUiState.playableMatch) {
    return null;
  }
  if (
    eventUiState.isJoined &&
    !eventUiState.isEliminated &&
    eventUiState.waitingForNext
  ) {
    const awaitedMatch = getAwaitedPendingInviteMatchForParticipant(
      event,
      profileId,
    );
    if (awaitedMatch) {
      return awaitedMatch;
    }
  }
  return getFirstPendingInviteMatch(event);
};
