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
const generation = (value) =>
  value?.eventTelegramProjectionGuard?.generation ?? 0;
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
  const record = (0, records_js_1.messageDocument)(current);
  if (generation(record.desired) > expectedGeneration)
    return { commit: false, decision: "newer-projection" };
  if (expectedApplied !== undefined) {
    const desired = value;
    const delivery = record.delivery;
    const abandoned = delivery?.abandonedSend;
    if (
      delivery?.status === "terminal" &&
      delivery.lastError?.code === "manually-abandoned" &&
      abandoned?.destination === desired.destination &&
      desired.operation !== "delete" &&
      abandoned.instanceKey === desired.instanceKey
    )
      return { commit: false, decision: "abandoned" };
    const applied = record.applied;
    if (
      delivery?.sendInFlight ||
      [
        "destination",
        "instanceKey",
        "messageId",
        "contentHash",
        "revision",
      ].some((key) => applied?.[key] !== expectedApplied?.[key])
    ) {
      const previousDesired = record.desired;
      if (
        desired.operation === "edit" &&
        desired.ifMissing === "skip" &&
        previousDesired &&
        previousDesired.operation !== "delete" &&
        previousDesired.destination === desired.destination &&
        previousDesired.instanceKey === desired.instanceKey
      ) {
        const next = {
          ...(0, desiredStateCore_js_1.buildTelegramEditDesired)({
            ...previousDesired,
            ifMissing: "skip",
            sourceRevision: desired.sourceRevision,
          }),
          ...(desired.eventTelegramProjectionGuard
            ? {
                eventTelegramProjectionGuard:
                  desired.eventTelegramProjectionGuard,
              }
            : {}),
        };
        return {
          value: (0, records_js_1.updateTelegramMessage)(record, {
            desired: next,
          }),
          decision: "delivery-changed",
        };
      }
      return { commit: false, decision: "delivery-changed" };
    }
  }
  return {
    value: (0, records_js_1.updateTelegramMessage)(record, { desired: value }),
    decision: "projection-committed",
  };
}
