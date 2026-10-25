// Generated from src/telegram/deliverySendRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.markSendInFlightRecord = markSendInFlightRecord;
exports.acknowledgeSendRecord = acknowledgeSendRecord;
const deliveryState_js_1 = require("./deliveryState.js");
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const values_js_1 = require("./values.js");
function markSendInFlightRecord(current, delivery, input) {
  const { desired, marker } = input;
  const apply = (record) => {
    if (
      (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(record.desired, "revision"),
      ) !== desired.revision
    ) {
      return {
        ...record,
        delivery: (0, deliveryState_js_1.writeDelivery)({
          ...(0, deliveryState_js_1.omitKeys)(delivery, [
            "leaseOwner",
            "leaseExpiresAtMs",
          ]),
          status: "pending",
          revision: (0, deliveryState_js_1.normalizeString)(
            (0, values_js_1.readProperty)(record.desired, "revision"),
          ),
        }),
      };
    }
    return {
      ...record,
      delivery: {
        ...(0, deliveryState_js_1.deliveryDocument)(delivery),
        sendInFlight: marker,
      },
    };
  };
  const output = apply(asObject(current));
  return output;
}
function acknowledgeSendRecord(current, delivery, input) {
  const {
    applied: retainedApplied,
    chatId,
    desired,
    marker,
    nowMs,
    previousApplied: retainedPreviousApplied,
    result,
  } = input;
  const applied = asObject(retainedApplied);
  const previousApplied =
    retainedPreviousApplied === null ? null : asObject(retainedPreviousApplied);
  const apply = (record) => {
    const latestRevision = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(record.desired, "revision"),
    );
    const nextDelivery = asObject(
      (0, deliveryState_js_1.writeDelivery)({
        ...(0, deliveryPolicy_js_1.omitRetryState)(
          (0, deliveryState_js_1.omitKeys)(delivery, [
            "leaseOwner",
            "leaseExpiresAtMs",
            "sendInFlight",
            "lastError",
            "deadLetterAtMs",
            "apiGateOwner",
            "apiGateGeneration",
            "apiGateStartedAtMs",
            "appliedStateUnknown",
          ]),
        ),
        ...(latestRevision === desired.revision
          ? {
              status: "delivered",
              revision: latestRevision || desired.revision,
              deliveredAtMs: nowMs,
            }
          : {
              status: "pending",
              revision: latestRevision || desired.revision,
            }),
        apiGateSettleOwner: marker.apiGateOwner,
      }),
    );
    if (latestRevision !== desired.revision) {
      nextDelivery.attempts = 0;
    }
    if (
      previousApplied &&
      typeof previousApplied.messageId === "number" &&
      Number.isInteger(previousApplied.messageId) &&
      previousApplied.messageId > 0 &&
      (previousApplied.messageId !== result.messageId ||
        (0, deliveryState_js_1.normalizeString)(previousApplied.chatId) !==
          chatId)
    ) {
      const pendingDelete = (0, deliveryState_js_1.writeCleanup)({
        chatId:
          (0, deliveryState_js_1.normalizeString)(previousApplied.chatId) ||
          chatId,
        messageId: previousApplied.messageId,
        instanceKey: (0, deliveryState_js_1.normalizeString)(
          previousApplied.instanceKey,
        ),
        pendingDeleteId: (0, deliveryState_js_1.buildPendingDeleteId)({
          chatId:
            (0, deliveryState_js_1.normalizeString)(previousApplied.chatId) ||
            chatId,
          messageId: previousApplied.messageId,
        }),
        status: "pending",
        attempts: 0,
      });
      Object.assign(
        nextDelivery,
        (0, deliveryState_js_1.appendPendingDelete)(
          nextDelivery,
          pendingDelete,
        ),
      );
    }
    return {
      ...record,
      applied,
      delivery: nextDelivery,
    };
  };
  const output = apply(asObject(current));
  return output;
}
const asObject = (value) => {
  const retained =
    value instanceof deliveryState_js_1.DeliverySnapshot
      ? (0, deliveryState_js_1.deliveryDocument)(value)
      : value instanceof deliveryState_js_1.PendingDeleteSnapshot
        ? (0, deliveryState_js_1.pendingDeleteDocument)(value)
        : value;
  return retained && typeof retained === "object" && !Array.isArray(retained)
    ? retained
    : {};
};
