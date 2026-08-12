import { isEventPrizeId } from "@mons/shared/event-prizes";
import { THIRD_PLACE_MATCH_KEY } from "@mons/shared/events";

import type {
  EventMatch,
  EventParticipant,
  EventPrizeAssignment,
  EventPrizeAssignments,
  EventPrizeId,
  EventRecord,
  EventRound,
} from "./connectionModels";
import {
  normalizeFiniteNumber,
  normalizeString,
  normalizeStringOrNull,
} from "./valueNormalizers";

export const mapEventParticipant = (
  rawData: Record<string, unknown>,
  fallbackProfileId: string,
): EventParticipant => ({
  profileId: normalizeString(rawData.profileId) || fallbackProfileId,
  loginUid: normalizeString(rawData.loginUid),
  username: normalizeString(rawData.username),
  displayName: normalizeString(rawData.displayName),
  emojiId: normalizeFiniteNumber(rawData.emojiId, 0),
  aura: normalizeString(rawData.aura),
  joinedAtMs: normalizeFiniteNumber(rawData.joinedAtMs, 0),
  state:
    rawData.state === "eliminated" || rawData.state === "winner"
      ? rawData.state
      : "active",
  eliminatedRoundIndex: Number.isFinite(
    normalizeFiniteNumber(rawData.eliminatedRoundIndex, NaN),
  )
    ? normalizeFiniteNumber(rawData.eliminatedRoundIndex, NaN)
    : null,
  eliminatedByProfileId: normalizeStringOrNull(rawData.eliminatedByProfileId),
});

export const mapEventMatch = (
  rawData: Record<string, unknown>,
  fallbackMatchKey: string,
): EventMatch => ({
  matchKey: normalizeString(rawData.matchKey) || fallbackMatchKey,
  inviteId: normalizeStringOrNull(rawData.inviteId),
  status:
    rawData.status === "upcoming" ||
    rawData.status === "host" ||
    rawData.status === "guest" ||
    rawData.status === "bye"
      ? rawData.status
      : "pending",
  resolvedAtMs: Number.isFinite(
    normalizeFiniteNumber(rawData.resolvedAtMs, NaN),
  )
    ? normalizeFiniteNumber(rawData.resolvedAtMs, NaN)
    : null,
  winnerDisqualified: rawData.winnerDisqualified === true,
  winnerProfileId: normalizeStringOrNull(rawData.winnerProfileId),
  loserProfileId: normalizeStringOrNull(rawData.loserProfileId),
  hostSlotBlocked: rawData.hostSlotBlocked === true,
  hostProfileId: normalizeStringOrNull(rawData.hostProfileId),
  hostLoginUid: normalizeStringOrNull(rawData.hostLoginUid),
  hostDisplayName: normalizeStringOrNull(rawData.hostDisplayName),
  hostEmojiId: Number.isFinite(normalizeFiniteNumber(rawData.hostEmojiId, NaN))
    ? normalizeFiniteNumber(rawData.hostEmojiId, NaN)
    : null,
  hostAura: normalizeStringOrNull(rawData.hostAura),
  guestProfileId: normalizeStringOrNull(rawData.guestProfileId),
  guestLoginUid: normalizeStringOrNull(rawData.guestLoginUid),
  guestDisplayName: normalizeStringOrNull(rawData.guestDisplayName),
  guestEmojiId: Number.isFinite(
    normalizeFiniteNumber(rawData.guestEmojiId, NaN),
  )
    ? normalizeFiniteNumber(rawData.guestEmojiId, NaN)
    : null,
  guestAura: normalizeStringOrNull(rawData.guestAura),
  guestSlotBlocked: rawData.guestSlotBlocked === true,
});

export const mapEventRound = (
  rawData: Record<string, unknown>,
  fallbackRoundIndex: number,
): EventRound => {
  const matchesInput =
    rawData.matches && typeof rawData.matches === "object"
      ? (rawData.matches as Record<string, unknown>)
      : {};
  const matches: Record<string, EventMatch> = {};
  Object.keys(matchesInput).forEach((matchKey) => {
    const matchValue = matchesInput[matchKey];
    if (!matchValue || typeof matchValue !== "object") {
      return;
    }
    matches[matchKey] = mapEventMatch(
      matchValue as Record<string, unknown>,
      matchKey,
    );
  });
  const completedAtMs = normalizeFiniteNumber(rawData.completedAtMs, NaN);
  return {
    roundIndex: normalizeFiniteNumber(rawData.roundIndex, fallbackRoundIndex),
    status:
      rawData.status === "completed" || rawData.status === "upcoming"
        ? rawData.status
        : "active",
    createdAtMs: normalizeFiniteNumber(rawData.createdAtMs, 0),
    completedAtMs: Number.isFinite(completedAtMs) ? completedAtMs : null,
    matches,
  };
};

export const normalizeEventPrizeId = (
  value: unknown,
  eventId: string,
): EventPrizeId | null => {
  const normalizedValue = normalizeString(value).trim();
  const normalizedEventId = eventId.trim();
  return isEventPrizeId(normalizedEventId, normalizedValue)
    ? normalizedValue
    : null;
};

export const mapEventPrizeAssignment = (
  rawValue: unknown,
  fallbackEventId: string,
): EventPrizeAssignment | null => {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }
  const rawData = rawValue as Record<string, unknown>;
  const eventId = normalizeString(rawData.eventId) || fallbackEventId;
  const profileId = normalizeString(rawData.profileId);
  const prizeId = normalizeEventPrizeId(rawData.prizeId, eventId);
  const placeValue = normalizeFiniteNumber(rawData.place, NaN);
  const place =
    placeValue === 1 || placeValue === 2 || placeValue === 3
      ? placeValue
      : null;
  const assignedAtMs = normalizeFiniteNumber(rawData.assignedAtMs, NaN);
  if (
    !eventId ||
    !profileId ||
    !prizeId ||
    place === null ||
    !Number.isFinite(assignedAtMs)
  ) {
    return null;
  }
  return {
    eventId,
    profileId,
    prizeId,
    place,
    assignedAtMs: Math.floor(assignedAtMs),
  };
};

export const mapEventPrizeAssignments = (
  rawValue: unknown,
  fallbackEventId: string,
): EventPrizeAssignments => {
  if (!rawValue || typeof rawValue !== "object") {
    return {};
  }
  const rawAssignments = rawValue as Record<string, unknown>;
  const assignments: EventPrizeAssignments = {};
  for (const place of [1, 2, 3] as const) {
    const assignment = mapEventPrizeAssignment(
      rawAssignments[String(place)],
      fallbackEventId,
    );
    if (assignment?.place === place) {
      assignments[`${place}`] = assignment;
    }
  }
  return assignments;
};

export const mapDatabaseEventRecord = (
  rawValue: unknown,
  fallbackEventId: string,
): EventRecord | null => {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }
  const rawData = rawValue as Record<string, unknown>;
  const eventId = normalizeString(rawData.eventId) || fallbackEventId;
  if (!eventId) {
    return null;
  }
  const participantsInput =
    rawData.participants && typeof rawData.participants === "object"
      ? (rawData.participants as Record<string, unknown>)
      : {};
  const roundsInput =
    rawData.rounds && typeof rawData.rounds === "object"
      ? (rawData.rounds as Record<string, unknown>)
      : {};
  const thirdPlaceMatchInput =
    rawData.thirdPlaceMatch && typeof rawData.thirdPlaceMatch === "object"
      ? (rawData.thirdPlaceMatch as Record<string, unknown>)
      : null;
  const prizeSelectionsLockedAtMs = normalizeFiniteNumber(
    rawData.prizeSelectionsLockedAtMs,
    NaN,
  );
  const participants: Record<string, EventParticipant> = {};
  const rounds: Record<string, EventRound> = {};

  Object.keys(participantsInput).forEach((profileId) => {
    const participantValue = participantsInput[profileId];
    if (!participantValue || typeof participantValue !== "object") {
      return;
    }
    participants[profileId] = mapEventParticipant(
      participantValue as Record<string, unknown>,
      profileId,
    );
  });

  Object.keys(roundsInput).forEach((roundKey) => {
    const roundValue = roundsInput[roundKey];
    if (!roundValue || typeof roundValue !== "object") {
      return;
    }
    rounds[roundKey] = mapEventRound(
      roundValue as Record<string, unknown>,
      normalizeFiniteNumber(roundKey, 0),
    );
  });

  return {
    schemaVersion: normalizeFiniteNumber(rawData.schemaVersion, 1),
    eventId,
    status:
      rawData.status === "active" ||
      rawData.status === "ended" ||
      rawData.status === "dismissed"
        ? rawData.status
        : "scheduled",
    createdAtMs: normalizeFiniteNumber(rawData.createdAtMs, 0),
    updatedAtMs: normalizeFiniteNumber(rawData.updatedAtMs, 0),
    startAtMs: normalizeFiniteNumber(rawData.startAtMs, 0),
    startedAtMs: Number.isFinite(
      normalizeFiniteNumber(rawData.startedAtMs, NaN),
    )
      ? normalizeFiniteNumber(rawData.startedAtMs, NaN)
      : null,
    endedAtMs: Number.isFinite(normalizeFiniteNumber(rawData.endedAtMs, NaN))
      ? normalizeFiniteNumber(rawData.endedAtMs, NaN)
      : null,
    createdByProfileId: normalizeString(rawData.createdByProfileId),
    createdByLoginUid: normalizeString(rawData.createdByLoginUid),
    createdByUsername: normalizeString(rawData.createdByUsername),
    winnerProfileId: normalizeStringOrNull(rawData.winnerProfileId),
    winnerDisplayName: normalizeStringOrNull(rawData.winnerDisplayName),
    currentRoundIndex: Number.isFinite(
      normalizeFiniteNumber(rawData.currentRoundIndex, NaN),
    )
      ? normalizeFiniteNumber(rawData.currentRoundIndex, NaN)
      : null,
    bracketSize: normalizeFiniteNumber(rawData.bracketSize, 0),
    roundCount: normalizeFiniteNumber(rawData.roundCount, 0),
    thirdPlaceMatch: thirdPlaceMatchInput
      ? mapEventMatch(thirdPlaceMatchInput, THIRD_PLACE_MATCH_KEY)
      : null,
    prizeSelectionsLockedAtMs: Number.isFinite(prizeSelectionsLockedAtMs)
      ? prizeSelectionsLockedAtMs
      : null,
    prizeAssignments: mapEventPrizeAssignments(
      rawData.prizeAssignments,
      eventId,
    ),
    participants,
    rounds,
  };
};
