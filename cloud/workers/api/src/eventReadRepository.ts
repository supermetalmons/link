import type { EventReads } from "../../../runtime/eventReads.js";
import {
  listEventAggregates,
  listProfileEventPrizeAssignments,
  readEvent,
  readEventPrizeSelections,
  readEventSnapshot,
  readProfileEventPrizeAssignment,
  readProfileEventPrizes,
  type EventD1Connection,
} from "./eventD1.ts";

export function createEventReadRepository(db: EventD1Connection): EventReads {
  return {
    readEvent: (eventId) => readEvent(db, eventId),
    readEventPrizeSelections: (eventId) =>
      readEventPrizeSelections(db, eventId),
    readProfileEventPrizeAssignment: (profileId, eventId) =>
      readProfileEventPrizeAssignment(db, profileId, eventId),
    readEventSnapshot: (eventId) => readEventSnapshot(db, eventId),
    readProfileEventPrizes: (profileId) =>
      readProfileEventPrizes(db, profileId),
    listEventsByStatus: (status, limit) =>
      listEventAggregates(db, { status, limit }),
    listProfileEventPrizeAssignments: (profileId, query) =>
      listProfileEventPrizeAssignments(db, profileId, query),
  };
}
