"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const telegramDelivery = require("../functions/telegramDelivery");
const desiredState = require("../functions/telegram/desiredState");
const deliveryPolicy = require("../functions/telegram/deliveryPolicy");
const rtdbRepository = require("../functions/telegram/rtdbRepository");
const taskAdapters = require("../functions/telegramDeliveryFunctions");
const taskIdentity = require("../functions/telegram/taskIdentity");

test("Telegram compatibility facades delegate to focused modules", () => {
  for (const [facadePath, modulePath] of [
    ["../functions/telegramClient", "../functions/telegram/client"],
    ["../functions/telegramDelivery", "../functions/telegram/deliveryEngine"],
    [
      "../functions/telegramDeliveryFunctions",
      "../functions/telegram/taskAdapters",
    ],
    [
      "../functions/eventTelegramAnnouncements",
      "../functions/telegram/eventAnnouncements",
    ],
    [
      "../functions/eventPrizeTelegramAnnouncement",
      "../functions/telegram/eventPrizeAnnouncement",
    ],
    [
      "../functions/automatchTelegramMessages",
      "../functions/telegram/automatchMessages",
    ],
    [
      "../functions/ratingTelegramProjector",
      "../functions/telegram/ratingProjector",
    ],
  ]) {
    assert.strictEqual(require(facadePath), require(modulePath));
  }
});

test("delivery exports use the extracted desired-state and repository modules", () => {
  assert.strictEqual(
    telegramDelivery.buildTelegramSendDesired,
    desiredState.buildTelegramSendDesired,
  );
  assert.strictEqual(
    telegramDelivery.buildTelegramEditUpdates,
    desiredState.buildTelegramEditUpdates,
  );
  assert.strictEqual(
    telegramDelivery.queueTelegramDelete,
    desiredState.queueTelegramDelete,
  );
  assert.strictEqual(
    telegramDelivery.createFirebaseTelegramRepository,
    rtdbRepository.createFirebaseTelegramRepository,
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

test("task adapters retain the extracted deterministic task identity", () => {
  assert.strictEqual(
    taskAdapters.buildTelegramDeliveryTaskId,
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
