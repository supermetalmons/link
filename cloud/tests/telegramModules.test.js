"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const deliveryPolicy = require("../runtime/telegram/deliveryPolicy");
const taskIdentity = require("../runtime/telegram/taskIdentity");
const eventProjectionCore = require("../runtime/telegram/eventProjectionCore");

test("event Telegram projection is exposed through the shared core", () => {
  assert.equal(
    typeof eventProjectionCore.buildEventTelegramProjection,
    "function",
  );
  assert.equal(typeof eventProjectionCore.loadEndedMatchResults, "function");
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

test("task identities stay deterministic and distinguish pending deletes", () => {
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
