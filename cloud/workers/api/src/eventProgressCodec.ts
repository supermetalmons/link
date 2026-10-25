import type {
  EventProgressDocument,
  RetainedEventProgressParams,
} from "../../../runtime/eventProgressRecords.js";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { EventProgressOutboxRecord } from "../../../runtime/events.js";

const EVENT_PROGRESS_SCHEMA_VERSION = 1;

export type EventProgressWorkflowParams = {
  schemaVersion: 1;
  eventId: string;
  outboxId: string;
  reason: string;
  runAtMs: number | null;
  sourceKey: string;
};

export type EventProgressPlan = {
  outbox: EventProgressOutboxRecord;
  outboxId: string;
  params: EventProgressWorkflowParams;
  workflowId: string;
};

export type RetainedEventProgressPlan = {
  outbox: EventProgressDocument<"pending">;
  outboxId: string;
  params: RetainedEventProgressParams;
  workflowId: string;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function digestIdentity(eventId: unknown, sourceKey: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${eventId}\n${sourceKey}`),
  );
  return bytesToHex(digest);
}

async function assembleEventProgressPlan<EventId, SourceKey, Reason, Timestamp>(
  input: {
    eventId: EventId;
    sourceKey: SourceKey;
    reason: Reason;
    runAtMs?: number | null;
  },
  nowMs: Timestamp,
) {
  const digest = await digestIdentity(input.eventId, input.sourceKey);
  const outboxId = `ep_${digest}`;
  const workflowId = `event-progress-${digest}`;
  const runAtMs = input.runAtMs ?? null;
  const outbox = {
    schemaVersion: EVENT_PROGRESS_SCHEMA_VERSION,
    eventId: input.eventId,
    sourceKey: input.sourceKey,
    reason: input.reason,
    runAtMs,
    firstQueuedAtMs: nowMs,
    lastQueuedAtMs: nowMs,
  } as const;
  return {
    outbox,
    outboxId,
    workflowId,
    params: {
      schemaVersion: outbox.schemaVersion,
      eventId: input.eventId,
      outboxId,
      reason: input.reason,
      runAtMs,
      sourceKey: input.sourceKey,
    },
  };
}

export function buildEventProgressPlan(
  input: {
    eventId: string;
    sourceKey: string;
    reason: string;
    runAtMs?: number | null;
  },
  nowMs?: number,
): Promise<EventProgressPlan> {
  try {
    return assembleEventProgressPlan(
      input,
      nowMs === undefined ? Date.now() : nowMs,
    );
  } catch (error) {
    return Promise.reject(error);
  }
}

export function buildRetainedEventProgressPlan(
  input: { eventId: unknown; sourceKey: unknown; reason: unknown },
  nowMs?: unknown,
): Promise<RetainedEventProgressPlan> {
  try {
    const retained: unknown = assembleEventProgressPlan(
      input,
      nowMs === undefined ? Date.now() : nowMs,
    );
    return retained as Promise<RetainedEventProgressPlan>;
  } catch (error) {
    return Promise.reject(error);
  }
}

export function workflowIdFromOutboxId(outboxId: string): string | null {
  return /^ep_[0-9a-f]{64}$/.test(outboxId)
    ? `event-progress-${outboxId.slice(3)}`
    : null;
}

export async function parseEventProgressOutbox(
  outboxId: string,
  value: unknown,
): Promise<EventProgressPlan | null> {
  const record = toRecord(value);
  const runAtMs = record?.runAtMs;
  const firstQueuedAtMs = record?.firstQueuedAtMs;
  const lastQueuedAtMs = record?.lastQueuedAtMs;
  if (
    !record ||
    record.schemaVersion !== EVENT_PROGRESS_SCHEMA_VERSION ||
    !isSafeRecordKey(record.eventId) ||
    typeof record.sourceKey !== "string" ||
    !record.sourceKey.trim() ||
    typeof record.reason !== "string" ||
    !record.reason.trim() ||
    (runAtMs !== null &&
      (typeof runAtMs !== "number" ||
        !Number.isSafeInteger(runAtMs) ||
        runAtMs < 0)) ||
    typeof firstQueuedAtMs !== "number" ||
    !Number.isSafeInteger(firstQueuedAtMs) ||
    typeof lastQueuedAtMs !== "number" ||
    !Number.isSafeInteger(lastQueuedAtMs)
  ) {
    return null;
  }
  const workflowId = workflowIdFromOutboxId(outboxId);
  if (
    !workflowId ||
    outboxId.slice(3) !==
      (await digestIdentity(record.eventId, record.sourceKey))
  ) {
    return null;
  }
  const outbox = {
    schemaVersion: EVENT_PROGRESS_SCHEMA_VERSION,
    eventId: record.eventId,
    sourceKey: record.sourceKey,
    reason: record.reason,
    runAtMs,
    firstQueuedAtMs,
    lastQueuedAtMs,
  } satisfies EventProgressOutboxRecord;
  return {
    outbox,
    outboxId,
    workflowId,
    params: {
      schemaVersion: EVENT_PROGRESS_SCHEMA_VERSION,
      eventId: outbox.eventId,
      outboxId,
      reason: outbox.reason,
      runAtMs: outbox.runAtMs,
      sourceKey: outbox.sourceKey,
    },
  };
}

export async function parseEventProgressParams(
  value: unknown,
): Promise<EventProgressWorkflowParams | null> {
  const record = toRecord(value);
  if (
    !record ||
    Object.keys(record).length !== 6 ||
    typeof record.outboxId !== "string"
  ) {
    return null;
  }
  const plan = await parseEventProgressOutbox(record.outboxId, {
    schemaVersion: record.schemaVersion,
    eventId: record.eventId,
    sourceKey: record.sourceKey,
    reason: record.reason,
    runAtMs: record.runAtMs,
    firstQueuedAtMs: 0,
    lastQueuedAtMs: 0,
  });
  return plan?.params || null;
}
