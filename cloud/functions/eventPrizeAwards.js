"use strict";

const PRIZES_EVENT_ID = "NN3eRzoZo80";
const EVENT_PRIZE_IDS = Object.freeze(["1092", "1111", "1514"]);
const EVENT_PRIZE_PLACES = Object.freeze([1, 2, 3]);

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const isEventPrizeId = (value) =>
  EVENT_PRIZE_IDS.includes(normalizeString(value));

const normalizeEventPrizeAssignments = (value, eventId) => {
  if (!value || typeof value !== "object") {
    return {};
  }
  const normalizedEventId = normalizeString(eventId);
  const assignments = {};
  const assignedProfileIds = new Set();
  const assignedPrizeIds = new Set();

  for (const place of EVENT_PRIZE_PLACES) {
    const assignment = value[String(place)];
    if (!assignment || typeof assignment !== "object") {
      continue;
    }
    const assignmentEventId = normalizeString(assignment.eventId);
    const profileId = normalizeString(assignment.profileId);
    const prizeId = normalizeString(assignment.prizeId);
    const assignedAtMs = Number(assignment.assignedAtMs);
    if (
      assignmentEventId !== normalizedEventId ||
      Number(assignment.place) !== place ||
      !profileId ||
      !isEventPrizeId(prizeId) ||
      !Number.isFinite(assignedAtMs) ||
      assignedProfileIds.has(profileId) ||
      assignedPrizeIds.has(prizeId)
    ) {
      continue;
    }
    assignments[String(place)] = {
      eventId: normalizedEventId,
      profileId,
      place,
      prizeId,
      assignedAtMs: Math.floor(assignedAtMs),
    };
    assignedProfileIds.add(profileId);
    assignedPrizeIds.add(prizeId);
  }

  return assignments;
};

const normalizeProfileEventPrizes = (value, profileId) => {
  if (!value || typeof value !== "object") {
    return {};
  }
  const normalizedProfileId = normalizeString(profileId);
  if (!normalizedProfileId) {
    return {};
  }
  const prizes = {};
  for (const [eventIdValue, rawAssignment] of Object.entries(value)) {
    const eventId = normalizeString(eventIdValue);
    const place = Number(rawAssignment?.place);
    if (!eventId || !EVENT_PRIZE_PLACES.includes(place)) {
      continue;
    }
    const assignment = normalizeEventPrizeAssignments(
      { [String(place)]: rawAssignment },
      eventId,
    )[String(place)];
    if (assignment?.profileId === normalizedProfileId) {
      prizes[eventId] = assignment;
    }
  }
  return prizes;
};

const buildProfileEventPrizeMergeCopies = ({
  targetProfileId,
  sourceProfileId,
  targetPrizes,
  sourcePrizes,
}) => {
  const normalizedTargetProfileId = normalizeString(targetProfileId);
  const normalizedSourceProfileId = normalizeString(sourceProfileId);
  if (
    !normalizedTargetProfileId ||
    !normalizedSourceProfileId ||
    normalizedTargetProfileId === normalizedSourceProfileId
  ) {
    return {};
  }
  const existingTargetPrizes = normalizeProfileEventPrizes(
    targetPrizes,
    normalizedTargetProfileId,
  );
  const normalizedSourcePrizes = normalizeProfileEventPrizes(
    sourcePrizes,
    normalizedSourceProfileId,
  );
  const copies = {};
  for (const [eventId, assignment] of Object.entries(normalizedSourcePrizes)) {
    if (existingTargetPrizes[eventId]) {
      continue;
    }
    copies[eventId] = {
      ...assignment,
      profileId: normalizedTargetProfileId,
    };
  }
  return copies;
};

const buildEventPrizeAssignments = ({
  eventId,
  placements,
  selections,
  assignedAtMs,
}) => {
  const normalizedEventId = normalizeString(eventId);
  const normalizedAssignedAtMs = Math.floor(Number(assignedAtMs));
  if (!normalizedEventId || !Number.isFinite(normalizedAssignedAtMs)) {
    return {};
  }

  const normalizedPlacements = [];
  const placedProfileIds = new Set();
  for (const place of EVENT_PRIZE_PLACES) {
    const placement = Array.isArray(placements)
      ? placements.find((candidate) => Number(candidate?.place) === place)
      : null;
    const profileId = normalizeString(placement?.profileId);
    if (!profileId || placedProfileIds.has(profileId)) {
      continue;
    }
    normalizedPlacements.push({ place, profileId });
    placedProfileIds.add(profileId);
  }

  const assignments = {};
  const assignedPrizeIds = new Set();
  const assignPrize = (placement, prizeId) => {
    assignments[String(placement.place)] = {
      eventId: normalizedEventId,
      profileId: placement.profileId,
      place: placement.place,
      prizeId,
      assignedAtMs: normalizedAssignedAtMs,
    };
    assignedPrizeIds.add(prizeId);
  };

  for (const placement of normalizedPlacements) {
    const preferredPrizeId = normalizeString(
      selections && typeof selections === "object"
        ? selections[placement.profileId]
        : "",
    );
    if (
      isEventPrizeId(preferredPrizeId) &&
      !assignedPrizeIds.has(preferredPrizeId)
    ) {
      assignPrize(placement, preferredPrizeId);
    }
  }

  for (const placement of normalizedPlacements) {
    if (assignments[String(placement.place)]) {
      continue;
    }
    const fallbackPrizeId = EVENT_PRIZE_IDS.find(
      (prizeId) => !assignedPrizeIds.has(prizeId),
    );
    if (!fallbackPrizeId) {
      break;
    }
    assignPrize(placement, fallbackPrizeId);
  }

  return assignments;
};

module.exports = {
  EVENT_PRIZE_IDS,
  EVENT_PRIZE_PLACES,
  PRIZES_EVENT_ID,
  buildProfileEventPrizeMergeCopies,
  buildEventPrizeAssignments,
  isEventPrizeId,
  normalizeEventPrizeAssignments,
};
