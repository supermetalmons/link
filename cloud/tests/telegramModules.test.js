"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const telegramDelivery = require("../functions/telegramDelivery");
const deliveryEngine = require("../functions/telegram/deliveryEngine");
const desiredState = require("../functions/telegram/desiredState");
const deliveryPolicy = require("../functions/telegram/deliveryPolicy");
const queueBridge = require("../functions/telegram/queueBridge");
const taskIdentity = require("../functions/telegram/taskIdentity");
const eventProjectionCore = require("../functions/telegram/eventProjectionCore");

test("event Telegram projection is exposed through the shared core", () => {
  assert.equal(
    typeof eventProjectionCore.buildEventTelegramProjection,
    "function",
  );
  assert.equal(typeof eventProjectionCore.loadEndedMatchResults, "function");
});

test("delivery exports use the extracted engine and desired-state modules", () => {
  assert.strictEqual(
    telegramDelivery.createTelegramDeliveryEngine,
    deliveryEngine.createTelegramDeliveryEngine,
  );
  assert.strictEqual(
    telegramDelivery.buildTelegramSendDesired,
    desiredState.buildTelegramSendDesired,
  );
  assert.strictEqual(
    telegramDelivery.buildTelegramEditUpdates,
    desiredState.buildTelegramEditUpdates,
  );
});

test("retry policy preserves deadline clamping and rate-limit proof timing", () => {
  const retryState = deliveryPolicy.buildSafeRetryState({
    current: {},
    result: { retryAfterSeconds: 90 },
    nowMs: 1_000,
  });
  assert.deepEqual(retryState, {
    retryStartedAtMs: 1_000,
    retryDeadlineAtMs: 601_000,
    retryAtMs: 91_000,
    retrySequence: 1,
  });
  assert.equal(
    deliveryPolicy.buildRateLimitBarrierAtMs({
      result: { retryAfterSeconds: 120 },
      retryState,
      nowMs: 1_000,
    }),
    121_000,
  );
});

test("queue bridge retains the extracted deterministic task identity", () => {
  assert.strictEqual(
    queueBridge.buildTelegramDeliveryTaskId,
    taskIdentity.buildTelegramDeliveryTaskId,
  );
  const payload = {
    messageKey: "automatch:invite-1",
    revision: "revision-1",
    taskKind: "pending-delete",
    retrySequence: 2,
    generation: "generation-1",
    pendingDeleteId: "delete-1",
  };
  assert.equal(
    taskIdentity.buildTelegramDeliveryTaskId(payload),
    taskIdentity.buildTelegramDeliveryTaskId({ ...payload }),
  );
  assert.notEqual(
    taskIdentity.buildTelegramDeliveryTaskId(payload),
    taskIdentity.buildTelegramDeliveryTaskId({
      ...payload,
      pendingDeleteId: "delete-2",
    }),
  );
});
