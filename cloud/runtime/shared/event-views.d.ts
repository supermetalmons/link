// Generated from src/shared/event-views.ts. Run npm run generate:runtime.
import { type EventPrizeId } from "./event-prizes.js";
import {
  type EventMatchView,
  type EventParticipantView,
  type EventPrizeAssignmentView,
  type EventPrizeAssignmentsView,
  type EventView,
  type EventRoundView,
} from "./event-types.js";
export declare const decodeEventParticipantView: (
  rawData: Record<string, unknown>,
  fallbackProfileId: string,
) => EventParticipantView;
export declare const decodeEventMatchView: (
  rawData: Record<string, unknown>,
  fallbackMatchKey: string,
) => EventMatchView;
export declare const decodeEventRoundView: (
  rawData: Record<string, unknown>,
  fallbackRoundIndex: number,
) => EventRoundView;
export declare const normalizeEventPrizeId: (
  value: unknown,
  eventId: string,
) => EventPrizeId | null;
export declare const decodeEventPrizeAssignmentView: (
  rawValue: unknown,
  fallbackEventId: string,
) => EventPrizeAssignmentView | null;
export declare const decodeEventPrizeAssignmentsView: (
  rawValue: unknown,
  fallbackEventId: string,
) => EventPrizeAssignmentsView;
export declare const decodeEventView: (
  rawValue: unknown,
  fallbackEventId: string,
) => EventView | null;
