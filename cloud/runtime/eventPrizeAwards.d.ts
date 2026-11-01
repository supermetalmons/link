// Generated from src/eventPrizeAwards.ts. Run npm run generate:runtime.
import type { EventPrizeAssignmentRecord } from "./eventReads.js";
import type { EventPlacement } from "./events/model.js";
import { isEventPrizeId } from "@mons/shared/event-prizes";
declare const EVENT_PRIZE_PLACES: readonly [1, 2, 3];
declare const normalizeEventPrizeAssignments: (
  value: unknown,
  eventId: string,
) => Record<string, EventPrizeAssignmentRecord>;
declare const buildEventPrizeAssignments: ({
  eventId,
  placements,
  selections,
  assignedAtMs,
}: {
  eventId: string;
  placements: readonly EventPlacement[];
  selections: Readonly<Record<string, string>>;
  assignedAtMs: number;
}) => Record<string, EventPrizeAssignmentRecord>;
export {
  EVENT_PRIZE_PLACES,
  buildEventPrizeAssignments,
  isEventPrizeId,
  normalizeEventPrizeAssignments,
};
