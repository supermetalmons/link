// Generated from src/eventPrizeAwards.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeEventPrizeAssignments =
  exports.isEventPrizeId =
  exports.buildEventPrizeAssignments =
  exports.buildProfileEventPrizeMergeCopies =
  exports.EVENT_PRIZE_PLACES =
    void 0;
const event_prizes_1 = require("@mons/shared/event-prizes");
Object.defineProperty(exports, "isEventPrizeId", {
  enumerable: true,
  get: function () {
    return event_prizes_1.isEventPrizeId;
  },
});
const EVENT_PRIZE_PLACES = Object.freeze([1, 2, 3]);
exports.EVENT_PRIZE_PLACES = EVENT_PRIZE_PLACES;
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
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
      !(0, event_prizes_1.isEventPrizeId)(normalizedEventId, prizeId) ||
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
exports.normalizeEventPrizeAssignments = normalizeEventPrizeAssignments;
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
exports.buildProfileEventPrizeMergeCopies = buildProfileEventPrizeMergeCopies;
const buildEventPrizeAssignments = ({
  eventId,
  placements,
  selections,
  assignedAtMs,
}) => {
  const normalizedEventId = normalizeString(eventId);
  const normalizedAssignedAtMs = Math.floor(Number(assignedAtMs));
  const eventPrizeIds = (0, event_prizes_1.getEventPrizeDefinitions)(
    normalizedEventId,
  ).map((prize) => prize.id);
  if (
    !normalizedEventId ||
    eventPrizeIds.length === 0 ||
    !Number.isFinite(normalizedAssignedAtMs)
  ) {
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
      (0, event_prizes_1.isEventPrizeId)(normalizedEventId, preferredPrizeId) &&
      !assignedPrizeIds.has(preferredPrizeId)
    ) {
      assignPrize(placement, preferredPrizeId);
    }
  }
  for (const placement of normalizedPlacements) {
    if (assignments[String(placement.place)]) {
      continue;
    }
    const fallbackPrizeId = eventPrizeIds.find(
      (prizeId) => !assignedPrizeIds.has(prizeId),
    );
    if (!fallbackPrizeId) {
      break;
    }
    assignPrize(placement, fallbackPrizeId);
  }
  return assignments;
};
exports.buildEventPrizeAssignments = buildEventPrizeAssignments;
