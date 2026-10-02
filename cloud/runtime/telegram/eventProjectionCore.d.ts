// Generated from src/telegram/eventProjectionCore.ts. Run npm run generate:runtime.
import type { TelegramDesired } from "./desiredStateCore.js";
type ProjectionState = {
  upcomingText: string;
  reminderText: string;
  startedText: string;
  endedText: string;
  endedAnnouncementArmed: boolean;
  startedMatchKeys: string[];
  startedMatchLinesByKey: Record<string, unknown>;
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
export type EventTelegramProjectionOperation = {
  channel: "upcoming" | "reminder" | "started" | "ended";
  generation?: string;
  ifMissing: "send" | "skip" | null;
  instanceKey: string;
  messageKey: string;
  operation: "send" | "edit";
  sourceRevision: string;
  text: string;
};
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
      state: Record<string, unknown>;
    };
export type EventTelegramProjectionGuard = {
  eventId: string;
  generation?: number;
  lockId: string;
  lockRoot: string;
  ownerUid: string;
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
  state: Record<string, unknown>;
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
    readRatingUpdate(operationId: string): Promise<unknown>;
  },
) => Promise<Record<string, unknown>>;
declare const isV2TelegramEvent: (
  eventData: unknown,
) => eventData is Record<string, unknown>;
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
  resultsByKey?: Record<string, unknown>,
) => EndedState;
declare const buildEventTelegramProjection: (input: {
  eventId: string;
  eventData: unknown;
  endedMatchResults?: Record<string, unknown>;
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
