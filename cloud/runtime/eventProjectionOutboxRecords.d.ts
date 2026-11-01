// Generated from src/eventProjectionOutboxRecords.ts. Run npm run generate:runtime.
export type EventProjectionOutboxKind = "profile-game" | "telegram";
export type EventProfileGameProjectionRequest = {
  schemaVersion: 1;
  status: "pending";
  requestId: string;
  lastQueuedAtMs: number;
  cleanupOwnerProfileIds?: Record<string, true>;
  reason?: string;
};
export type EventTelegramProjectionRequest = {
  schemaVersion: 1;
  status: "pending";
  requestId: string;
  firstQueuedAtMs: number;
  updatedAtMs: number;
};
type EventProjectionRequestMap = {
  "profile-game": EventProfileGameProjectionRequest;
  telegram: EventTelegramProjectionRequest;
};
export type EventProjectionDeadLetter<Kind extends EventProjectionOutboxKind> =
  {
    schemaVersion: 2;
    status: "dead";
    requestId: string;
    reason: "invalid-record";
    deadAtMs: number;
    sourceDigest: string;
    originalRecord: EventProjectionRequestMap[Kind] | null;
  };
export type EventProjectionOutboxDocument<
  Kind extends EventProjectionOutboxKind,
> = EventProjectionRequestMap[Kind] | EventProjectionDeadLetter<Kind>;
export declare function isEventProjectionPending<
  Kind extends EventProjectionOutboxKind,
>(kind: Kind, value: unknown): value is EventProjectionRequestMap[Kind];
export declare function isEventProjectionOutbox<
  Kind extends EventProjectionOutboxKind,
>(kind: Kind, value: unknown): value is EventProjectionOutboxDocument<Kind>;
export declare function retainEventProjectionOutbox<
  Kind extends EventProjectionOutboxKind,
>(kind: Kind, value: unknown): EventProjectionOutboxDocument<Kind>;
export declare function createEventProfileGameProjectionRequest(
  value: EventProfileGameProjectionRequest,
): EventProfileGameProjectionRequest;
export declare function createEventTelegramProjectionRequest(
  value: EventTelegramProjectionRequest,
): EventTelegramProjectionRequest;
export {};
