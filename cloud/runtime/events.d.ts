// Generated from src/events.ts. Run npm run generate:runtime.
import type { EventSyncSkipReason } from "./shared/events.js";
import type { WithdrawalDocument } from "./eventPrizes/records.js";
import type { EventData } from "./events/model.js";
import { type EventLockManager } from "./events/lockManagerCore.js";
import type { EventRuntimeStore } from "./eventCommands.js";
import type { EventMatchPairRequest } from "./events/bracket.js";
import type { EventOwnershipSnapshot } from "./events/ownership.js";
type EventSyncLog = {
  mode?: string;
  eventId?: string | null;
  requesterUid?: string | null;
  sourceKey?: string;
  triggerReason?: string;
  workflowInstanceId?: string;
  targetMatchKey?: string | null;
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
  data: unknown;
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
export type EventRuntimeCreateResult = {
  ok: true;
  eventId: string;
  event: EventData;
};
export type EventRuntimePostponeResult = EventRuntimeCreateResult & {
  postponeByMinutes: number;
  startAtMs: number;
};
export type EventRuntimeSyncResult =
  | {
      ok: true;
      eventId: string;
      didChange: boolean;
      event: EventData | null;
      skipped?: never;
      reason?: never;
    }
  | {
      ok: true;
      eventId: string;
      skipped: true;
      reason: EventSyncSkipReason;
      event?: EventData | null;
      didChange?: never;
    };
export type EventRuntimeDisqualifyResult = EventRuntimeSyncResult & {
  didDisqualify: boolean;
  matchKey: string;
};
export type EventRuntime = {
  createEvent(request: EventRuntimeRequest): Promise<EventRuntimeCreateResult>;
  disqualifyEventMatchWinners(
    request: EventRuntimeRequest,
  ): Promise<EventRuntimeDisqualifyResult>;
  postponeEventStart(
    request: EventRuntimeRequest,
  ): Promise<EventRuntimePostponeResult>;
  runEventSyncState(input: {
    eventId: string;
    requesterUid: string;
    enforceParticipantGate: boolean;
    enforceThrottle: boolean;
    syncLog: EventSyncLog;
  }): Promise<EventRuntimeSyncResult>;
  syncEventState(request: EventRuntimeRequest): Promise<EventRuntimeSyncResult>;
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
  ) => Promise<Record<string, WithdrawalDocument>>;
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
