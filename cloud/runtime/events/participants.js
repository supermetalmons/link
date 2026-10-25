// Generated from src/events/participants.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEventParticipantIds = void 0;
const documents_js_1 = require("./documents.js");
const getEventParticipantIds = (event) =>
  (0, documents_js_1.eventParticipantEntries)(
    (0, documents_js_1.eventParticipants)(event),
  ).map(([profileId]) => profileId);
exports.getEventParticipantIds = getEventParticipantIds;
