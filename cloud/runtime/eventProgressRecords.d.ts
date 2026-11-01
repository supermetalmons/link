// Generated from src/eventProgressRecords.ts. Run npm run generate:runtime.
export type EventProgressPendingRecord = {
  schemaVersion: 2;
  dataEpoch: 1;
  eventId: string;
  sourceKey: string;
  reason: string;
  runAtMs: number | null;
  firstQueuedAtMs: number;
  lastQueuedAtMs: number;
};
export type EventProgressWorkflowParams = {
  schemaVersion: 2;
  dataEpoch: 1;
  eventId: string;
  outboxId: string;
  reason: string;
  runAtMs: number | null;
  sourceKey: string;
};
export type RetainedEventProgressParams = EventProgressWorkflowParams;
export type EventProgressDeadLetter = {
  schemaVersion: 1;
  dataEpoch: 1;
  deadAtMs: number;
  sourceDigest: string;
  originalRecord: EventProgressPendingRecord | null;
  reason: "invalid-event-progress-outbox" | "canonical-data-cutover";
};
export type EventProgressRecordKind = "pending" | "dead";
export type EventProgressDocument<Kind extends EventProgressRecordKind> =
  Kind extends "pending" ? EventProgressPendingRecord : EventProgressDeadLetter;
export declare function readEventProgressPending(
  value: unknown,
): EventProgressPendingRecord | null;
export declare function readEventProgressDeadLetter(
  value: unknown,
): EventProgressDeadLetter | null;
export declare function retainEventProgressRecord<
  Kind extends EventProgressRecordKind,
>(kind: Kind, value: unknown): EventProgressDocument<Kind>;
