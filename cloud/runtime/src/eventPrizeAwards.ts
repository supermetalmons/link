import type { EventPrizeAssignmentRecord } from "./eventReads.js";
import type { EventPlacement } from "./events/model.js";

import {
  getEventPrizeDefinitions,
  isEventPrizeId,
} from "@mons/shared/event-prizes";
const EVENT_PRIZE_PLACES = Object.freeze([1, 2, 3] as const);

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizeEventPrizeAssignments = (
  value: unknown,
  eventId: unknown,
): Record<string, EventPrizeAssignmentRecord> => {
  if (!value || typeof value !== "object") {
    return {};
  }
  const normalizedEventId = normalizeString(eventId);
  const assignments: Record<string, EventPrizeAssignmentRecord> = {};
  const assignedProfileIds = new Set();
  const assignedPrizeIds = new Set();

  for (const place of EVENT_PRIZE_PLACES) {
    const assignment = (
      value as Record<string, Record<string, unknown> | null>
    )[String(place)];
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
      !isEventPrizeId(normalizedEventId, prizeId) ||
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

const buildEventPrizeAssignments = ({
  eventId,
  placements,
  selections,
  assignedAtMs,
}: {
  eventId: unknown;
  placements: unknown;
  selections: unknown;
  assignedAtMs: unknown;
}): Record<string, EventPrizeAssignmentRecord> => {
  const normalizedEventId = normalizeString(eventId);
  const normalizedAssignedAtMs = Math.floor(Number(assignedAtMs));
  const eventPrizeIds = getEventPrizeDefinitions(normalizedEventId).map(
    (prize) => prize.id,
  );
  if (
    !normalizedEventId ||
    eventPrizeIds.length === 0 ||
    !Number.isFinite(normalizedAssignedAtMs)
  ) {
    return {};
  }

  const normalizedPlacements: EventPlacement[] = [];
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

  const assignments: Record<string, EventPrizeAssignmentRecord> = {};
  const assignedPrizeIds = new Set();
  const assignPrize = (placement: EventPlacement, prizeId: string) => {
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
        ? (selections as Record<string, unknown>)[placement.profileId]
        : "",
    );
    if (
      isEventPrizeId(normalizedEventId, preferredPrizeId) &&
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
