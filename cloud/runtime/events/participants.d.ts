// Generated from src/events/participants.ts. Run npm run generate:runtime.
import type { EventDocument } from "./documents.js";
declare const getEventParticipantIds: (
  event: Pick<EventDocument, "participants"> | null | undefined,
) => string[];
export { getEventParticipantIds };
