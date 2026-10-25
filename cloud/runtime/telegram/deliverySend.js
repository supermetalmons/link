// Generated from src/telegram/deliverySend.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramSendDelivery = createTelegramSendDelivery;
const deliveryState_js_1 = require("./deliveryState.js");
const records_js_1 = require("./records.js");
const deliverySendRecords_js_1 = require("./deliverySendRecords.js");
const records_js_2 = require("./records.js");
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const deliveryState_js_2 = require("./deliveryState.js");
const values_js_1 = require("./values.js");
function createTelegramSendDelivery({
  client,
  now,
  createAttemptId,
  control,
  operations,
}) {
  const {
    updateOwned,
    acquireApiGate,
    buildGateBlockedFailure,
    settlePersistedApiGate,
    logFailure,
  } = control;
  const {
    finishExpiredOwnedRetryWindow,
    finishRetryable,
    finishStatusAndSettleApiGate,
  } = operations;
  const runSend = async ({
    messageKey,
    ownerToken,
    desired,
    chatId,
    previousApplied,
    nowMs,
  }) => {
    const attemptId = createAttemptId();
    const marker = desired.createSendMarker(attemptId, chatId, nowMs);
    const marked = await updateOwned(
      messageKey,
      ownerToken,
      (record, delivery) =>
        (0, deliverySendRecords_js_1.markSendInFlightRecord)(
          (0, records_js_2.messageDocument)(record),
          delivery,
          {
            desired,
            marker,
          },
        ),
    );
    if (
      !marked.committed ||
      !(0, deliveryState_js_1.readDelivery)(
        (0, records_js_1.messageDeliveryDocument)(marked.value),
      ).sendInFlightMatchesRevision(desired.revision)
    ) {
      return { status: "stale" };
    }
    const expired = await finishExpiredOwnedRetryWindow({
      messageKey,
      ownerToken,
      desired,
      currentDelivery: (0, records_js_1.messageDeliveryDocument)(marked.value),
    });
    if (expired) {
      return expired;
    }
    const gateResult = await acquireApiGate({
      messageKey,
      revision: desired.revision,
      operation: "send",
      owner: marker.apiGateOwner,
      attemptId: marker.attemptId,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishRetryable({
        messageKey,
        ownerToken,
        desired,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        currentDelivery: (0, records_js_1.messageDeliveryDocument)(
          marked.value,
        ),
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const callAtMs = now();
    if (
      (0, deliveryPolicy_js_1.normalizeTimestamp)(
        (0, values_js_1.readProperty)(
          (0, records_js_1.messageDeliveryDocument)(marked.value),
          "retryDeadlineAtMs",
        ),
      ) > 0 &&
      (0, deliveryPolicy_js_1.normalizeTimestamp)(
        (0, values_js_1.readProperty)(
          (0, records_js_1.messageDeliveryDocument)(marked.value),
          "retryDeadlineAtMs",
        ),
      ) <= callAtMs
    ) {
      const expiredResult = { code: "safe-retry-window-exhausted" };
      await finishStatusAndSettleApiGate({
        messageKey,
        ownerToken,
        desired,
        status: "terminal",
        result: expiredResult,
        nowMs: callAtMs,
        apiGateSettleOwner: marker.apiGateOwner,
      });
      return { status: "terminal", reason: expiredResult.code };
    }
    const result = await client.sendTelegramMessage(desired.sendInput(chatId));
    if (result.ok) {
      const applied = desired.createAppliedReceipt(
        chatId,
        result.messageId,
        nowMs,
      );
      const receiptWrite = await updateOwned(
        messageKey,
        ownerToken,
        (record, delivery) =>
          (0, deliverySendRecords_js_1.acknowledgeSendRecord)(
            (0, records_js_2.messageDocument)(record),
            delivery,
            {
              applied,
              chatId,
              desired,
              marker,
              nowMs,
              previousApplied,
              result,
            },
          ),
      );
      (0, deliveryState_js_2.ensureCommitted)(
        receiptWrite,
        "send-receipt-not-persisted",
      );
      await settlePersistedApiGate({
        messageKey,
        field: "apiGateSettleOwner",
        owner: marker.apiGateOwner,
      });
      return { status: "delivered", messageId: result.messageId };
    }
    if (result.classification === "retryable") {
      const retryState = await finishRetryable({
        messageKey,
        ownerToken,
        desired,
        result,
        safeRejectedAttemptId: marker.attemptId,
        currentDelivery: (0, records_js_1.messageDeliveryDocument)(
          marked.value,
        ),
        apiGateOwner: marker.apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const status =
      result.classification === "uncertain" ? "uncertain" : "terminal";
    await finishStatusAndSettleApiGate({
      messageKey,
      ownerToken,
      desired,
      status,
      result,
      nowMs,
      apiGateSettleOwner: marker.apiGateOwner,
    });
    logFailure(messageKey, status, result);
    return { status, reason: result.code };
  };
  return { runSend };
}
