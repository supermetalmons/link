// Generated from src/telegram/messageProjectionRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.replaceTelegramDesired = replaceTelegramDesired;
exports.projectAutomatchMessage = projectAutomatchMessage;
exports.adoptTelegramReminder = adoptTelegramReminder;
exports.projectEventMessage = projectEventMessage;
const desiredStateCore_js_1 = require("./desiredStateCore.js");
const projectionCore_js_1 = require("./projectionCore.js");
const deliveryState_js_1 = require("./deliveryState.js");
const records_js_1 = require("./records.js");
const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const guardField = "eventTelegramProjectionGuard";
const generation = (value) => {
  const stored = asObject(asObject(value)[guardField]).generation;
  return typeof stored === "number" &&
    Number.isSafeInteger(stored) &&
    stored >= 0
    ? stored
    : 0;
};
function replaceTelegramDesired(current, desired) {
  return (0, records_js_1.updateTelegramMessage)(
    (0, records_js_1.messageDocument)(current),
    { desired },
  );
}
function projectAutomatchMessage(current, projection, desired) {
  const decision = (0, projectionCore_js_1.evaluateAutomatchProjectionUpdate)(
    current,
    projection,
  );
  if (!decision.allowed) return { commit: false, decision: decision.reason };
  return {
    value: (0, records_js_1.updateTelegramMessage)(
      (0, records_js_1.messageDocument)(current),
      {
        desired,
        automatchProjection: (0,
        projectionCore_js_1.buildAutomatchProjectionGuard)(projection),
      },
    ),
    decision: decision.reason,
  };
}
function adoptTelegramReminder(current, desired, chatId, confirmed) {
  if (current !== null && current !== undefined) {
    return { commit: false, decision: "existing-reminder" };
  }
  return {
    value: (0, records_js_1.updateTelegramMessage)(
      (0, records_js_1.messageDocument)(null),
      {
        desired,
        applied: {
          destination: "community",
          chatId: chatId.trim(),
          messageId: confirmed.messageId,
          instanceKey: desired.instanceKey,
          revision: desired.revision,
          contentHash: desired.contentHash,
          appliedAtMs: confirmed.appliedAtMs,
        },
        delivery: (0, deliveryState_js_1.writeDelivery)({
          status: "delivered",
          revision: desired.revision,
          deliveredAtMs: confirmed.appliedAtMs,
        }),
      },
    ),
    decision: "reminder-adopted",
  };
}
function projectEventMessage(
  current,
  value,
  expectedGeneration,
  expectedApplied,
) {
  const record = asObject(current);
  if (generation(record.desired) > expectedGeneration) {
    return { commit: false, decision: "newer-projection" };
  }
  if (expectedApplied) {
    const desired = asObject(value);
    const delivery = asObject(record.delivery);
    const abandoned = asObject(delivery.abandonedSend);
    if (
      delivery.status === "terminal" &&
      asObject(delivery.lastError).code === "manually-abandoned" &&
      abandoned.destination === desired.destination &&
      abandoned.instanceKey === desired.instanceKey
    )
      return { commit: false, decision: "abandoned" };
    const applied = asObject(record.applied);
    const expected = asObject(expectedApplied);
    if (
      delivery.sendInFlight ||
      [
        "destination",
        "instanceKey",
        "messageId",
        "contentHash",
        "revision",
      ].some((key) => applied[key] !== expected[key])
    ) {
      const previousDesired = asObject(record.desired);
      if (
        desired.operation === "edit" &&
        desired.ifMissing === "skip" &&
        previousDesired.destination === desired.destination &&
        previousDesired.instanceKey === desired.instanceKey
      ) {
        const next = {
          ...Reflect.apply(
            desiredStateCore_js_1.buildTelegramEditDesired,
            undefined,
            [
              {
                ...previousDesired,
                ifMissing: "skip",
                sourceRevision: desired.sourceRevision,
              },
            ],
          ),
          [guardField]: desired[guardField],
        };
        return {
          value: (0, records_js_1.updateTelegramMessage)(
            (0, records_js_1.messageDocument)(record),
            {
              desired: (0, records_js_1.desiredDocument)(next),
            },
          ),
          decision: "delivery-changed",
        };
      }
      return { commit: false, decision: "delivery-changed" };
    }
  }
  return {
    value: (0, records_js_1.updateTelegramMessage)(
      (0, records_js_1.messageDocument)(record),
      { desired: value },
    ),
    decision: "projection-committed",
  };
}
