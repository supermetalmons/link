// Generated from src/eventProjectionOutboxRecords.ts. Run npm run generate:runtime.
export type EventProjectionOutboxKind = "profile-game" | "telegram";
declare const eventProjectionOutbox: unique symbol;
export type EventProjectionOutboxDocument<
  Kind extends EventProjectionOutboxKind,
> = {
  readonly [eventProjectionOutbox]: Kind;
};
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
export declare function retainEventProjectionOutbox<
  Kind extends EventProjectionOutboxKind,
>(_kind: Kind, value: unknown): EventProjectionOutboxDocument<Kind>;
export declare function createEventProfileGameProjectionRequest(
  value: EventProfileGameProjectionRequest,
): EventProjectionOutboxDocument<"profile-game">;
export declare function createEventTelegramProjectionRequest(
  value: EventTelegramProjectionRequest,
): EventProjectionOutboxDocument<"telegram">;
export {};
