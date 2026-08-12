import type {
  EventMatch,
  EventParticipant,
  EventRecord,
  EventRound,
} from "../../connection/connectionModels";
import type { PrizeSelectionDensity, WinnerPodiumPlace } from "./eventLayout";
import {
  type MatchSide,
  buildParticipantFromMatchSide,
  getDisplayedByeSide,
  getSortedMatches,
  getThirdPlaceMatch,
} from "./eventState";

export const getParticipantDisplayName = (
  participant: EventParticipant,
): string => {
  const displayName = participant.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const username = participant.username?.trim();
  if (username) {
    return username;
  }
  return "anon";
};

export const getPrizeAvatarScatter = (
  prizeId: string,
  profileId: string,
  density: PrizeSelectionDensity,
) => {
  const value = `${prizeId}:${profileId}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const normalizedHash = hash >>> 0;
  const scatterScale =
    density === "relaxed" ? 0.4 : density === "compact" ? 0.75 : 1;
  return {
    x: ((normalizedHash % 9) - 4) * scatterScale,
    y: (((normalizedHash >>> 4) % 7) - 3) * scatterScale,
    layer: (normalizedHash >>> 6) % 8,
  };
};

export const getParticipantProfileCacheKey = (
  participant: EventParticipant,
): string => {
  if (participant.profileId) {
    return `profile:${participant.profileId}`;
  }
  return participant.loginUid ? `login:${participant.loginUid}` : "";
};

export type WinnerPodiumEntry = {
  place: WinnerPodiumPlace;
  participant: EventParticipant;
};

export const getParticipantIdentityKey = (
  participant: EventParticipant | null | undefined,
): string => {
  return participant?.profileId?.trim() || participant?.loginUid?.trim() || "";
};

export const getDisqualifiedParticipantIdentityKeys = (
  event: EventRecord | null,
  rounds: EventRound[],
): Set<string> => {
  const disqualifiedKeys = new Set<string>();
  const addMatchParticipantKeys = (match: EventMatch | null | undefined) => {
    if (!match || match.winnerDisqualified !== true) {
      return;
    }
    const hostProfileId = match.hostProfileId?.trim() ?? "";
    const hostLoginUid = match.hostLoginUid?.trim() ?? "";
    const guestProfileId = match.guestProfileId?.trim() ?? "";
    const guestLoginUid = match.guestLoginUid?.trim() ?? "";
    if (hostProfileId) {
      disqualifiedKeys.add(hostProfileId);
    }
    if (hostLoginUid) {
      disqualifiedKeys.add(hostLoginUid);
    }
    if (guestProfileId) {
      disqualifiedKeys.add(guestProfileId);
    }
    if (guestLoginUid) {
      disqualifiedKeys.add(guestLoginUid);
    }
  };

  for (const round of rounds) {
    for (const match of getSortedMatches(round)) {
      addMatchParticipantKeys(match);
    }
  }
  addMatchParticipantKeys(getThirdPlaceMatch(event));
  return disqualifiedKeys;
};

export const isParticipantDisqualified = (
  participant: EventParticipant | null | undefined,
  disqualifiedIdentityKeys: Set<string>,
): boolean => {
  if (!participant) {
    return false;
  }
  const profileId = participant.profileId?.trim() ?? "";
  if (profileId && disqualifiedIdentityKeys.has(profileId)) {
    return true;
  }
  const loginUid = participant.loginUid?.trim() ?? "";
  if (loginUid && disqualifiedIdentityKeys.has(loginUid)) {
    return true;
  }
  return false;
};

export const addParticipantIdentityKeys = (
  identityKeys: Set<string>,
  participant: EventParticipant | null | undefined,
): void => {
  if (!participant) {
    return;
  }
  const profileId = participant.profileId?.trim() ?? "";
  if (profileId) {
    identityKeys.add(profileId);
  }
  const loginUid = participant.loginUid?.trim() ?? "";
  if (loginUid) {
    identityKeys.add(loginUid);
  }
  const primaryIdentityKey = getParticipantIdentityKey(participant);
  if (primaryIdentityKey) {
    identityKeys.add(primaryIdentityKey);
  }
};

export const hasAnyParticipantIdentityKey = (
  identityKeys: Set<string>,
  participant: EventParticipant | null | undefined,
): boolean => {
  if (!participant) {
    return false;
  }
  const profileId = participant.profileId?.trim() ?? "";
  if (profileId && identityKeys.has(profileId)) {
    return true;
  }
  const loginUid = participant.loginUid?.trim() ?? "";
  if (loginUid && identityKeys.has(loginUid)) {
    return true;
  }
  const primaryIdentityKey = getParticipantIdentityKey(participant);
  if (primaryIdentityKey && identityKeys.has(primaryIdentityKey)) {
    return true;
  }
  return false;
};

export const getMatchSideForProfileId = (
  match: EventMatch,
  profileId: string | null | undefined,
): MatchSide | null => {
  const normalizedProfileId = profileId?.trim() ?? "";
  if (!normalizedProfileId) {
    return null;
  }
  if (match.hostProfileId === normalizedProfileId) {
    return "host";
  }
  if (match.guestProfileId === normalizedProfileId) {
    return "guest";
  }
  return null;
};

export const resolveMatchParticipant = (
  match: EventMatch,
  participantsById: Record<string, EventParticipant>,
  profileId: string | null | undefined,
): EventParticipant | null => {
  const normalizedProfileId = profileId?.trim() ?? "";
  if (!normalizedProfileId) {
    return null;
  }
  const knownParticipant = participantsById[normalizedProfileId];
  if (knownParticipant) {
    return knownParticipant;
  }
  const side = getMatchSideForProfileId(match, normalizedProfileId);
  if (!side) {
    return null;
  }
  return buildParticipantFromMatchSide(match, side, participantsById);
};

export const getResolvedMatchWinnerSide = (
  match: EventMatch,
): MatchSide | null => {
  if (match.status === "host") {
    return "host";
  }
  if (match.status === "guest") {
    return "guest";
  }
  if (match.status === "bye") {
    return getDisplayedByeSide(match);
  }
  return null;
};

export const getEndedEventWinnerPodiumEntries = (
  event: EventRecord | null,
  rounds: EventRound[],
  participantsById: Record<string, EventParticipant>,
): WinnerPodiumEntry[] => {
  if (!event || event.status !== "ended" || rounds.length === 0) {
    return [];
  }
  const finalRound = rounds[rounds.length - 1];
  const finalMatch = getSortedMatches(finalRound)[0];
  if (!finalMatch) {
    return [];
  }
  const disqualifiedParticipantIdentityKeys =
    getDisqualifiedParticipantIdentityKeys(event, rounds);
  const participantList = Object.values(event.participants ?? {});
  const shouldShowTopThree = participantList.length >= 3;

  const winnerSide = getResolvedMatchWinnerSide(finalMatch);
  const winner =
    resolveMatchParticipant(
      finalMatch,
      participantsById,
      event.winnerProfileId,
    ) ??
    resolveMatchParticipant(
      finalMatch,
      participantsById,
      finalMatch.winnerProfileId,
    ) ??
    (winnerSide
      ? buildParticipantFromMatchSide(finalMatch, winnerSide, participantsById)
      : null);

  const runnerUpSide: MatchSide | null =
    winnerSide === "host" ? "guest" : winnerSide === "guest" ? "host" : null;
  const runnerUp =
    resolveMatchParticipant(
      finalMatch,
      participantsById,
      finalMatch.loserProfileId,
    ) ??
    (runnerUpSide
      ? buildParticipantFromMatchSide(
          finalMatch,
          runnerUpSide,
          participantsById,
        )
      : null);

  const winnerKey = getParticipantIdentityKey(winner);
  if (
    !winner ||
    !winnerKey ||
    isParticipantDisqualified(winner, disqualifiedParticipantIdentityKeys)
  ) {
    return [];
  }

  const entriesByPlace = new Map<WinnerPodiumPlace, EventParticipant>();
  entriesByPlace.set(1, winner);
  const reservedParticipantKeys = new Set<string>();
  addParticipantIdentityKeys(reservedParticipantKeys, winner);
  const placementCandidates: EventParticipant[] = [];
  const pushPlacementCandidate = (
    participant: EventParticipant | null | undefined,
  ) => {
    if (!participant) {
      return;
    }
    if (
      hasAnyParticipantIdentityKey(reservedParticipantKeys, participant) ||
      isParticipantDisqualified(
        participant,
        disqualifiedParticipantIdentityKeys,
      )
    ) {
      return;
    }
    addParticipantIdentityKeys(reservedParticipantKeys, participant);
    placementCandidates.push(participant);
  };
  pushPlacementCandidate(runnerUp);

  if (shouldShowTopThree) {
    const thirdPlaceMatch = getThirdPlaceMatch(event);
    const thirdPlaceWinnerSide = thirdPlaceMatch
      ? getResolvedMatchWinnerSide(thirdPlaceMatch)
      : null;
    const thirdPlaceMatchWinner =
      thirdPlaceMatch &&
      (resolveMatchParticipant(
        thirdPlaceMatch,
        participantsById,
        thirdPlaceMatch.winnerProfileId,
      ) ??
        (thirdPlaceWinnerSide
          ? buildParticipantFromMatchSide(
              thirdPlaceMatch,
              thirdPlaceWinnerSide,
              participantsById,
            )
          : null));
    pushPlacementCandidate(thirdPlaceMatchWinner);
  }

  const fallbackPlacementCandidates = participantList
    .filter((participant) => {
      return !isParticipantDisqualified(
        participant,
        disqualifiedParticipantIdentityKeys,
      );
    })
    .sort((left, right) => {
      const leftEliminationRound = left.eliminatedRoundIndex ?? -1;
      const rightEliminationRound = right.eliminatedRoundIndex ?? -1;
      if (leftEliminationRound !== rightEliminationRound) {
        return rightEliminationRound - leftEliminationRound;
      }
      if (left.joinedAtMs !== right.joinedAtMs) {
        return left.joinedAtMs - right.joinedAtMs;
      }
      return left.profileId.localeCompare(right.profileId);
    });
  for (const candidate of fallbackPlacementCandidates) {
    pushPlacementCandidate(candidate);
  }

  const runnerUpPlacement = placementCandidates[0] ?? null;
  if (runnerUpPlacement) {
    entriesByPlace.set(2, runnerUpPlacement);
  }
  const thirdPlacePlacement =
    shouldShowTopThree && placementCandidates.length > 1
      ? placementCandidates[1]
      : null;
  if (thirdPlacePlacement) {
    entriesByPlace.set(3, thirdPlacePlacement);
  }

  return ([2, 1, 3] as WinnerPodiumPlace[]).flatMap((place) => {
    const participant = entriesByPlace.get(place);
    if (!participant) {
      return [];
    }
    return [
      {
        place,
        participant,
      },
    ];
  });
};
