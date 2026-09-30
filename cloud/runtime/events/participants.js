// Generated from src/events/participants.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEventParticipantIds = void 0;
const getEventParticipantIds = (event) => {
  const participants =
    event && event.participants && typeof event.participants === "object"
      ? event.participants
      : {};
  return Object.keys(participants).filter(
    (profileId) =>
      participants[profileId] && typeof participants[profileId] === "object",
  );
};
exports.getEventParticipantIds = getEventParticipantIds;
