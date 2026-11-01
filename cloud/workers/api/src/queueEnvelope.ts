import { APPLICATION_DATA_EPOCH } from "@mons/shared/data-contract";
import type { QueueMessages } from "./queueProducers.ts";

export type QueueBinding = keyof QueueMessages;
export type CanonicalQueueEnvelope<Body = unknown> = {
  dataEpoch: typeof APPLICATION_DATA_EPOCH;
  queue: QueueBinding;
  dispatchId: string;
  payload: Body;
};

export function queueEnvelope<Body>(
  queue: QueueBinding,
  payload: Body,
): CanonicalQueueEnvelope<Body> {
  return {
    dataEpoch: APPLICATION_DATA_EPOCH,
    queue,
    dispatchId: crypto.randomUUID(),
    payload,
  };
}

export function parseQueueEnvelope(
  value: unknown,
  queue: QueueBinding,
): CanonicalQueueEnvelope | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    !("dataEpoch" in value) ||
    value.dataEpoch !== APPLICATION_DATA_EPOCH ||
    !("queue" in value) ||
    value.queue !== queue ||
    !("dispatchId" in value) ||
    typeof value.dispatchId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.dispatchId,
    ) ||
    !("payload" in value)
  )
    return null;
  return {
    dataEpoch: APPLICATION_DATA_EPOCH,
    queue,
    dispatchId: value.dispatchId,
    payload: value.payload,
  };
}

export function canonicalQueueBatch(
  batch: MessageBatch<unknown>,
  queue: QueueBinding,
): MessageBatch<unknown> {
  const messages: Message<unknown>[] = [];
  for (const message of batch.messages) {
    const envelope = parseQueueEnvelope(message.body, queue);
    if (!envelope) {
      message.ack();
      continue;
    }
    messages.push({
      id: message.id,
      timestamp: message.timestamp,
      attempts: message.attempts,
      body: envelope.payload,
      ack: () => message.ack(),
      retry: (options) => message.retry(options),
    });
  }
  return {
    queue: batch.queue,
    messages,
    metadata: batch.metadata,
    ackAll: () => messages.forEach((message) => message.ack()),
    retryAll: (options) =>
      messages.forEach((message) => message.retry(options)),
  };
}
