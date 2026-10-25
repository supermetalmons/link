// Generated from src/telegram/eventParticipants.ts. Run npm run generate:runtime.
import { type EventParticipantDocument } from "../events/documents.js";
declare const getParticipantRecords: (eventData: unknown) => {
  profileId: string;
  participant: EventParticipantDocument;
}[];
declare const buildParticipantRenderKey: (eventData: unknown) => string;
declare const resolveParticipantToken: (
  participant: unknown,
  fallbackDisplayName?: unknown,
) => string;
declare const renderParticipantLine: (eventData: unknown) => string;
export {
  buildParticipantRenderKey,
  getParticipantRecords,
  renderParticipantLine,
  resolveParticipantToken,
};
