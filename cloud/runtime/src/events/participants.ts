import type { EventDocument } from "./documents.js";
import { eventParticipants, eventParticipantEntries } from "./documents.js";

const getEventParticipantIds = (
  event: Pick<EventDocument, "participants"> | null | undefined,
) =>
  eventParticipantEntries(eventParticipants(event)).map(
    ([profileId]) => profileId,
  );

export { getEventParticipantIds };
