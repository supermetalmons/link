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
export function retainEventProjectionOutbox<
  Kind extends EventProjectionOutboxKind,
>(_kind: Kind, value: unknown): EventProjectionOutboxDocument<Kind> {
  return value as EventProjectionOutboxDocument<Kind>;
}
export function createEventProfileGameProjectionRequest(
  value: EventProfileGameProjectionRequest,
): EventProjectionOutboxDocument<"profile-game"> {
  return retainEventProjectionOutbox("profile-game", value);
}
export function createEventTelegramProjectionRequest(
  value: EventTelegramProjectionRequest,
): EventProjectionOutboxDocument<"telegram"> {
  return retainEventProjectionOutbox("telegram", value);
}
