// Generated from src/eventPrizeAwards.ts. Run npm run generate:runtime.
import type { EventPrizeAssignmentRecord } from "./eventReads.js";
import { isEventPrizeId } from "@mons/shared/event-prizes";
declare const EVENT_PRIZE_PLACES: readonly [1, 2, 3];
declare const normalizeEventPrizeAssignments: (
  value: unknown,
  eventId: unknown,
) => Record<string, EventPrizeAssignmentRecord>;
declare const buildEventPrizeAssignments: ({
  eventId,
  placements,
  selections,
  assignedAtMs,
}: {
  eventId: unknown;
  placements: unknown;
  selections: unknown;
  assignedAtMs: unknown;
}) => Record<string, EventPrizeAssignmentRecord>;
export {
  EVENT_PRIZE_PLACES,
  buildEventPrizeAssignments,
  isEventPrizeId,
  normalizeEventPrizeAssignments,
};
