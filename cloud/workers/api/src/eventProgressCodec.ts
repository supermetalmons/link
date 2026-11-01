import {
  readEventProgressPending,
  type EventProgressPendingRecord,
  type EventProgressWorkflowParams,
} from "../../../runtime/eventProgressRecords.js";
export type { EventProgressWorkflowParams } from "../../../runtime/eventProgressRecords.js";
export type EventProgressPlan = {
  outbox: EventProgressPendingRecord;
  outboxId: string;
  params: EventProgressWorkflowParams;
  workflowId: string;
};
type EventProgressInput = {
  eventId: string;
  sourceKey: string;
  reason: string;
  runAtMs?: number | null;
};
async function digestIdentity(
  eventId: string,
  sourceKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${eventId}\n${sourceKey}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function paramsFor(
  outboxId: string,
  outbox: EventProgressPendingRecord,
): EventProgressWorkflowParams {
  return {
    schemaVersion: 2,
    dataEpoch: 1,
    eventId: outbox.eventId,
    outboxId,
    reason: outbox.reason,
    runAtMs: outbox.runAtMs,
    sourceKey: outbox.sourceKey,
  };
}
export async function buildEventProgressPlan(
  input: EventProgressInput,
  nowMs = Date.now(),
): Promise<EventProgressPlan> {
  const outbox = readEventProgressPending({
    schemaVersion: 2,
    dataEpoch: 1,
    eventId: input.eventId,
    sourceKey: input.sourceKey,
    reason: input.reason,
    runAtMs: input.runAtMs ?? null,
    firstQueuedAtMs: nowMs,
    lastQueuedAtMs: nowMs,
  });
  if (!outbox) throw new TypeError("invalid-event-progress-input");
  const digest = await digestIdentity(outbox.eventId, outbox.sourceKey);
  const outboxId = `ep_${digest}`;
  return {
    outbox,
    outboxId,
    workflowId: `data1_event-progress-${digest}`,
    params: paramsFor(outboxId, outbox),
  };
}
export function workflowIdFromOutboxId(outboxId: string): string | null {
  return /^ep_[0-9a-f]{64}$/.test(outboxId)
    ? `data1_event-progress-${outboxId.slice(3)}`
    : null;
}
export async function parseEventProgressOutbox(
  outboxId: string,
  value: unknown,
): Promise<EventProgressPlan | null> {
  const outbox = readEventProgressPending(value);
  if (!outbox) return null;
  const workflowId = workflowIdFromOutboxId(outboxId);
  if (
    !workflowId ||
    outboxId.slice(3) !==
      (await digestIdentity(outbox.eventId, outbox.sourceKey))
  )
    return null;
  return { outbox, outboxId, workflowId, params: paramsFor(outboxId, outbox) };
}
export async function parseEventProgressParams(
  value: unknown,
): Promise<EventProgressWorkflowParams | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 7 || typeof record.outboxId !== "string")
    return null;
  const plan = await parseEventProgressOutbox(record.outboxId, {
    schemaVersion: record.schemaVersion,
    dataEpoch: record.dataEpoch,
    eventId: record.eventId,
    sourceKey: record.sourceKey,
    reason: record.reason,
    runAtMs: record.runAtMs,
    firstQueuedAtMs: 0,
    lastQueuedAtMs: 0,
  });
  return plan?.params ?? null;
}
