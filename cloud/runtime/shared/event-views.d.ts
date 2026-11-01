// Generated from src/shared/event-views.ts. Run npm run generate:runtime.
import { type EventPrizeId } from "./event-prizes.js";
import {
  type EventMatchRecord,
  type EventParticipantRecord,
  type EventPrizeAssignmentView,
  type EventPrizeAssignmentsView,
  type EventRecord,
  type EventRoundRecord,
  type EventTelegramAnnouncements,
} from "./event-types.js";
export declare function isEventAnnouncements(
  value: unknown,
): value is EventTelegramAnnouncements;
export declare function isEventParticipantRecord(
  value: unknown,
): value is EventParticipantRecord;
export declare function isEventParticipants(
  value: unknown,
): value is Record<string, EventParticipantRecord>;
export declare function isEventMatchRecord(
  value: unknown,
): value is EventMatchRecord;
export declare function isEventMatches(
  value: unknown,
): value is Record<string, EventMatchRecord>;
export declare function isEventRoundRecord(
  value: unknown,
): value is EventRoundRecord;
export declare function isEventRounds(
  value: unknown,
): value is Record<string, EventRoundRecord>;
export declare function isEventPrizeAssignments(
  value: unknown,
  eventId: string,
): value is EventPrizeAssignmentsView;
export declare function isEventRecord(value: unknown): value is EventRecord;
export declare function parseEventRecord(value: unknown): EventRecord;
export declare function decodeEventParticipantView(
  value: unknown,
  profileId: string,
): EventParticipantRecord;
export declare function decodeEventMatchView(
  value: unknown,
  matchKey: string,
): EventMatchRecord;
export declare function decodeEventRoundView(
  value: unknown,
  roundIndex: number,
): EventRoundRecord;
export declare function normalizeEventPrizeId(
  value: unknown,
  eventId: string,
): EventPrizeId | null;
export declare function decodeEventPrizeAssignmentView(
  value: unknown,
  eventId: string,
): EventPrizeAssignmentView | null;
export declare function decodeEventPrizeAssignmentsView(
  value: unknown,
  eventId: string,
): EventPrizeAssignmentsView;
export declare function decodeEventView(
  value: unknown,
  eventId: string,
): EventRecord | null;
