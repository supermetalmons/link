// Generated from src/telegram/eventParticipants.ts. Run npm run generate:runtime.
import { type EventParticipantDocument } from "../events/documents.js";
declare const getParticipantRecords: (eventData: unknown) => {
  profileId: string;
  participant: import("../shared/event-types.js").EventParticipantRecord;
}[];
declare const buildParticipantRenderKey: (eventData: unknown) => string;
declare const resolveParticipantToken: (
  participant: EventParticipantDocument | null | undefined,
  fallbackDisplayName?: string | null,
) => string;
declare const renderParticipantLine: (eventData: unknown) => string;
export {
  buildParticipantRenderKey,
  getParticipantRecords,
  renderParticipantLine,
  resolveParticipantToken,
};
