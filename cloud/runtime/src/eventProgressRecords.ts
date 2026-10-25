export type EventProgressRecordKind = "pending" | "dead";
declare const eventProgressRecord: unique symbol;
export type EventProgressDocument<Kind extends EventProgressRecordKind> = {
  readonly [eventProgressRecord]: Kind;
};
declare const retainedEventProgressParams: unique symbol;
export type RetainedEventProgressParams = {
  readonly [retainedEventProgressParams]: true;
};
export type EventProgressDeadLetter = {
  deadAtMs: number;
  originalRecord: EventProgressDocument<"pending"> | null;
  reason: "invalid-event-progress-outbox";
};
export function retainEventProgressRecord<Kind extends EventProgressRecordKind>(
  _kind: Kind,
  value: unknown,
): EventProgressDocument<Kind> {
  return value as EventProgressDocument<Kind>;
}
