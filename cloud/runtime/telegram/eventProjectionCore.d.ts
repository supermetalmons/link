// Generated from src/telegram/eventProjectionCore.ts. Run npm run generate:runtime.
import { type EventTelegramEndedResultsDocument } from "./eventProjectionRecords.js";
import type { TelegramDesired } from "./desiredStateCore.js";
import type { EventDocument } from "../events/documents.js";
import {
  type EventTelegramProjectionGuard,
  type EventTelegramProjectionStateDocument,
  type RetainedStartedMatchLines,
} from "./eventProjectionRecords.js";
export type { EventTelegramProjectionGuard } from "./eventProjectionRecords.js";
type ProjectionState = {
  upcomingText: string;
  reminderText: string;
  startedText: string;
  endedText: string;
  endedAnnouncementArmed: boolean;
  startedMatchKeys: string[];
  startedMatchLinesByKey: RetainedStartedMatchLines;
  lastProjectedSignature: string;
};
type StartedState = {
  text: string | null;
  startedMatchKeys: string[];
  startedMatchLinesByKey: Record<string, string>;
  appendedCount: number;
};
type EndedState = {
  text: string;
  matchLines: string[];
  placementLines: string[];
};
type EventTelegramProjectionOperationFields = {
  channel: "upcoming" | "reminder" | "started" | "ended";
  generation?: string;
  instanceKey: string;
  messageKey: string;
  sourceRevision: string;
  text: string;
};
type EventTelegramProjectionAction =
  | {
      operation: "send";
      ifMissing: null;
    }
  | {
      operation: "edit";
      ifMissing: "send" | "skip";
    };
export type EventTelegramProjectionOperation =
  EventTelegramProjectionOperationFields & EventTelegramProjectionAction;
export type EventTelegramProjection =
  | {
      action: "skip";
      reason: string;
    }
  | {
      action: "unchanged";
      signature: string;
    }
  | {
      action: "project";
      operations: EventTelegramProjectionOperation[];
      signature: string;
      state: EventTelegramProjectionStateDocument;
    };
export type EventTelegramDesiredChange = {
  messageKey: string;
  value: TelegramDesired & {
    eventTelegramProjectionGuard?: EventTelegramProjectionGuard & {
      messageKey: string;
    };
  };
};
export type EventTelegramProjectionChanges = {
  eventId: string;
  state: EventTelegramProjectionStateDocument;
  desired: EventTelegramDesiredChange[];
};
declare const EVENT_TELEGRAM_PROJECTION_LOCK_ROOT =
  "eventTelegramProjectionLocks";
declare const EVENT_TELEGRAM_PROJECTION_GUARD_FIELD =
  "eventTelegramProjectionGuard";
declare const EVENT_TELEGRAM_DELIVERY_VERSION = 2;
declare const formatPtEtUtcLine: (startAtMs: number) => string;
declare const loadEndedMatchResults: (
  eventData: unknown,
  dependencies: {
    readRatingUpdates(
      operationIds: readonly string[],
    ): Promise<readonly unknown[]>;
  },
) => Promise<EventTelegramEndedResultsDocument>;
declare const isV2TelegramEvent: (
  eventData: unknown,
) => eventData is EventDocument;
declare const buildEventSignature: (
  eventData: unknown,
  nowMs?: number,
) => string;
declare const renderUpcomingMessage: (
  eventId: string,
  eventData: unknown,
  nowMs?: number,
  heading?: "sunday mons soon" | "join sunday mons" | "upcoming event",
) => string | null;
declare const renderStartedMessage: (
  eventId: string,
  matchLines?: string[],
  heading?: "event started" | "sunday mons starting now!",
) => string;
declare const renderEndedMessage: (
  eventId: string,
  matchLines?: string[],
  placementLines?: string[],
  heading?: "event complete" | "good games",
) => string;
declare const parseProjectionState: (value: unknown) => ProjectionState;
declare const buildStartedState: (
  eventId: string,
  eventData: unknown,
  rawState?: unknown,
) => StartedState;
declare const buildEndedState: (
  eventId: string,
  eventData: unknown,
  resultsByKey?: EventTelegramEndedResultsDocument,
) => EndedState;
declare const buildEventTelegramProjection: (input: {
  eventId: string;
  eventData: unknown;
  endedMatchResults?: EventTelegramEndedResultsDocument;
  state?: unknown;
  upcomingMessage?: unknown;
  reminderMessage?: unknown;
  nowMs?: number;
}) => EventTelegramProjection;
declare const buildEventTelegramProjectionChanges: (input: {
  eventId: string;
  projection: EventTelegramProjection;
}) => EventTelegramProjectionChanges | null;
declare const addEventTelegramProjectionGuard: (input: {
  changes: EventTelegramProjectionChanges;
  guard?: EventTelegramProjectionGuard | null;
}) => EventTelegramProjectionChanges;
declare const buildEventTelegramDispatches: (input: {
  eventId: string;
  desiredChanges: EventTelegramDesiredChange[];
}) => Array<{
  generation: string;
  messageKey: string;
  revision: string;
}>;
export {
  EVENT_TELEGRAM_DELIVERY_VERSION,
  EVENT_TELEGRAM_PROJECTION_GUARD_FIELD,
  EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
  addEventTelegramProjectionGuard,
  buildEndedState,
  buildEventSignature,
  buildEventTelegramDispatches,
  buildEventTelegramProjection,
  buildEventTelegramProjectionChanges,
  buildStartedState,
  formatPtEtUtcLine,
  isV2TelegramEvent,
  loadEndedMatchResults,
  parseProjectionState,
  renderEndedMessage,
  renderStartedMessage,
  renderUpcomingMessage,
};
