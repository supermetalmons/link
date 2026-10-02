// Generated from src/events.ts. Run npm run generate:runtime.
import { type EventLockManager } from "./events/lockManagerCore.js";
import type { EventRuntimeStore } from "./eventCommands.js";
import type { EventMatchPairRequest } from "./events/bracket.js";
import type { EventOwnershipSnapshot } from "./events/ownership.js";
type EventSyncLog = Record<string, unknown> & {
  reason?: string | null;
  requesterProfileId?: string | null;
  skipped?: boolean;
  didChange?: boolean;
  durationMs?: number;
};
export type EventRuntimeCode =
  | "aborted"
  | "failed-precondition"
  | "invalid-argument"
  | "not-found"
  | "permission-denied"
  | "unauthenticated"
  | "unavailable";
export type EventRuntimeRequest = {
  auth: {
    uid: string;
  } | null;
  data: Record<string, unknown>;
};
export type EventProgressOutboxRecord = {
  schemaVersion: 1;
  eventId: string;
  sourceKey: string;
  reason: string;
  runAtMs: number | null;
  firstQueuedAtMs: number;
  lastQueuedAtMs: number;
};
export type EventRuntime = {
  createEvent(request: EventRuntimeRequest): Promise<Record<string, unknown>>;
  disqualifyEventMatchWinners(
    request: EventRuntimeRequest,
  ): Promise<Record<string, unknown>>;
  postponeEventStart(
    request: EventRuntimeRequest,
  ): Promise<Record<string, unknown>>;
  runEventSyncState(input: {
    eventId: string;
    requesterUid: string;
    enforceParticipantGate: boolean;
    enforceThrottle: boolean;
    syncLog: EventSyncLog;
  }): Promise<Record<string, unknown>>;
  syncEventState(
    request: EventRuntimeRequest,
  ): Promise<Record<string, unknown>>;
};
type Signature_createEventRuntime = (dependencies: {
  readMatchPair: (input: EventMatchPairRequest) => Promise<[unknown, unknown]>;
  readMatchPairs: (
    inputs: EventMatchPairRequest[],
  ) => Promise<Array<[unknown, unknown]>>;
  state: EventRuntimeStore;
  enqueueEventProgressTask(input: {
    eventId: string;
    sourceKey: string;
    reason: string;
    scheduleTimeMs?: number;
  }): Promise<{
    outboxId: string;
    outbox: EventProgressOutboxRecord;
  }>;
  eventLockManager: Pick<
    EventLockManager,
    | "acquireEventLockWithRetry"
    | "isEventLockStillOwned"
    | "releaseEventLock"
    | "startEventLockHeartbeat"
  >;
  readProfileOwnershipSnapshot(query: {
    loginUids: string[];
    profileIds: string[];
  }): Promise<EventOwnershipSnapshot>;
  readEventPrizeWithdrawals?: (
    eventId: string,
  ) => Promise<Record<string, Record<string, unknown>>>;
  now?: () => number;
  random?: () => number;
  sleep(milliseconds: number): Promise<void>;
}) => EventRuntime;
declare class EventRuntimeError extends Error {
  code: EventRuntimeCode;
  constructor(code: EventRuntimeCode, message: string);
}
declare const createEventRuntime: Signature_createEventRuntime;
export { createEventRuntime, EventRuntimeError };
