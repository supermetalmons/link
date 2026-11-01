// Generated from src/eventPrizeAwards.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeEventPrizeAssignments =
  exports.isEventPrizeId =
  exports.buildEventPrizeAssignments =
  exports.EVENT_PRIZE_PLACES =
    void 0;
const event_views_js_1 = require("./shared/event-views.js");
const event_prizes_1 = require("@mons/shared/event-prizes");
Object.defineProperty(exports, "isEventPrizeId", {
  enumerable: true,
  get: function () {
    return event_prizes_1.isEventPrizeId;
  },
});
const EVENT_PRIZE_PLACES = Object.freeze([1, 2, 3]);
exports.EVENT_PRIZE_PLACES = EVENT_PRIZE_PLACES;
const normalizeEventPrizeAssignments = (value, eventId) => {
  if (!(0, event_views_js_1.isEventPrizeAssignments)(value, eventId)) {
    throw new TypeError("invalid-canonical-event-prizes");
  }
  return { ...value };
};
exports.normalizeEventPrizeAssignments = normalizeEventPrizeAssignments;
const buildEventPrizeAssignments = ({
  eventId,
  placements,
  selections,
  assignedAtMs,
}) => {
  if (!Number.isSafeInteger(assignedAtMs) || assignedAtMs < 0) {
    throw new TypeError("invalid-event-prize-assignment-time");
  }
  const eventPrizeIds = (0, event_prizes_1.getEventPrizeDefinitions)(
    eventId,
  ).map((prize) => prize.id);
  if (eventPrizeIds.length === 0) {
    return {};
  }
  const normalizedPlacements = [];
  const placedProfileIds = new Set();
  for (const place of EVENT_PRIZE_PLACES) {
    const placement = placements.find((candidate) => candidate.place === place);
    const profileId = placement?.profileId;
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
      eventId,
      profileId: placement.profileId,
      place: placement.place,
      prizeId,
      assignedAtMs,
    };
    assignedPrizeIds.add(prizeId);
  };
  for (const placement of normalizedPlacements) {
    const preferredPrizeId = selections[placement.profileId];
    if (
      (0, event_prizes_1.isEventPrizeId)(eventId, preferredPrizeId) &&
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
