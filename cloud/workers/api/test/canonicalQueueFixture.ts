import assert from "node:assert/strict";
import { parseQueueEnvelope } from "../src/queueEnvelope.ts";
import type { QueueBinding } from "../src/queueEnvelope.ts";

const bindings: readonly QueueBinding[] = [
  "AUTH_RECOVERY_QUEUE",
  "PROFILE_GAME_PROJECTION_QUEUE",
  "EVENT_PROFILE_GAME_PROJECTION_QUEUE",
  "TELEGRAM_PROJECTION_QUEUE",
  "TELEGRAM_DELIVERY_QUEUE",
  "WAGER_SETTLEMENT_QUEUE",
];
export function canonicalQueuePayloadFixture(value: unknown): unknown {
  assert.ok(value !== null && typeof value === "object" && "queue" in value);
  const binding = bindings.find((binding) => binding === value.queue);
  assert.ok(binding);
  const envelope = parseQueueEnvelope(value, binding);
  assert.ok(envelope);
  return envelope.payload;
}
