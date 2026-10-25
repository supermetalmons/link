import { readPlainEventDocument } from "../../../runtime/events/documents.js";
import type { EventReads } from "../../../runtime/eventReads.js";
import {
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
    readEvent: async (eventId) =>
      readPlainEventDocument(await readEvent(db, eventId)),
    readEventPrizeSelections: (eventId) =>
      readEventPrizeSelections(db, eventId),
    readProfileEventPrizeAssignment: (profileId, eventId) =>
      readProfileEventPrizeAssignment(db, profileId, eventId),
    readEventSnapshot: async (eventId) => {
      const snapshot = await readEventSnapshot(db, eventId);
      return { ...snapshot, event: readPlainEventDocument(snapshot.event) };
    },
    readProfileEventPrizes: (profileId) =>
      readProfileEventPrizes(db, profileId),
    listProfileEventPrizeAssignments: (profileId, query) =>
      listProfileEventPrizeAssignments(db, profileId, query),
  };
}
