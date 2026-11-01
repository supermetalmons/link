import type { EventPrizeAssignmentRecord } from "./eventReads.js";
import type { EventPlacement } from "./events/model.js";
import { isEventPrizeAssignments } from "./shared/event-views.js";

import {
  getEventPrizeDefinitions,
  isEventPrizeId,
} from "@mons/shared/event-prizes";
const EVENT_PRIZE_PLACES = Object.freeze([1, 2, 3] as const);

const normalizeEventPrizeAssignments = (
  value: unknown,
  eventId: string,
): Record<string, EventPrizeAssignmentRecord> => {
  if (!isEventPrizeAssignments(value, eventId)) {
    throw new TypeError("invalid-canonical-event-prizes");
  }
  return { ...value };
};

const buildEventPrizeAssignments = ({
  eventId,
  placements,
  selections,
  assignedAtMs,
}: {
  eventId: string;
  placements: readonly EventPlacement[];
  selections: Readonly<Record<string, string>>;
  assignedAtMs: number;
}): Record<string, EventPrizeAssignmentRecord> => {
  if (!Number.isSafeInteger(assignedAtMs) || assignedAtMs < 0) {
    throw new TypeError("invalid-event-prize-assignment-time");
  }
  const eventPrizeIds = getEventPrizeDefinitions(eventId).map(
    (prize) => prize.id,
  );
  if (eventPrizeIds.length === 0) {
    return {};
  }

  const normalizedPlacements: EventPlacement[] = [];
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

  const assignments: Record<string, EventPrizeAssignmentRecord> = {};
  const assignedPrizeIds = new Set();
  const assignPrize = (placement: EventPlacement, prizeId: string) => {
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
      isEventPrizeId(eventId, preferredPrizeId) &&
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

export {
  EVENT_PRIZE_PLACES,
  buildEventPrizeAssignments,
  isEventPrizeId,
  normalizeEventPrizeAssignments,
};
