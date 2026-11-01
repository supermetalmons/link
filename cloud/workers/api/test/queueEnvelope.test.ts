import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalQueueBatch,
  parseQueueEnvelope,
  queueEnvelope,
} from "../src/queueEnvelope.ts";

test("canonical Queue envelopes reject old, cross-family and extension payloads", () => {
  const body = { kind: "auth-profile-recovery", profileId: "profile" };
  const envelope = queueEnvelope("AUTH_RECOVERY_QUEUE", body);
  assert.deepEqual(
    parseQueueEnvelope(envelope, "AUTH_RECOVERY_QUEUE"),
    envelope,
  );
  for (const invalid of [
    body,
    { ...envelope, dataEpoch: 0 },
    { ...envelope, dataEpoch: "1" },
    { ...envelope, queue: "TELEGRAM_DELIVERY_QUEUE" },
    { ...envelope, dispatchId: "legacy" },
    { ...envelope, extension: true },
  ])
    assert.equal(parseQueueEnvelope(invalid, "AUTH_RECOVERY_QUEUE"), null);
});

test("invalid deliveries cannot enter domain handlers and accepted messages retain native acknowledgements", () => {
  const acknowledged: string[] = [];
  const retried: Array<{ id: string; delay: number | undefined }> = [];
  const body = { kind: "auth-profile-recovery", profileId: "profile" };
  const messages: Message<unknown>[] = [
    { id: "old", body },
    { id: "current", body: queueEnvelope("AUTH_RECOVERY_QUEUE", body) },
  ].map((message) => ({
    ...message,
    timestamp: new Date(1),
    attempts: 2,
    ack() {
      acknowledged.push(this.id);
    },
    retry(options) {
      retried.push({ id: this.id, delay: options?.delaySeconds });
    },
  }));
  const batch = canonicalQueueBatch(
    {
      queue: "canonical-auth-recovery",
      messages,
      metadata: { metrics: { backlogCount: 2, backlogBytes: 256 } },
      ackAll() {
        assert.fail("unfiltered ackAll");
      },
      retryAll() {
        assert.fail("unfiltered retryAll");
      },
    },
    "AUTH_RECOVERY_QUEUE",
  );
  assert.deepEqual(acknowledged, ["old"]);
  assert.equal(batch.messages.length, 1);
  assert.equal(batch.messages[0]?.body, body);
  batch.retryAll({ delaySeconds: 60 });
  assert.deepEqual(retried, [{ id: "current", delay: 60 }]);
  batch.ackAll();
  assert.deepEqual(acknowledged, ["old", "current"]);
});
