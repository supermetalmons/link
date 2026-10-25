import { readDelivery } from "./deliveryState.js";
import type { TextDesiredView } from "./desiredRecords.js";
import {
  messageDeliveryDocument,
  type TelegramAppliedDocument,
} from "./records.js";
import {
  markSendInFlightRecord,
  acknowledgeSendRecord,
} from "./deliverySendRecords.js";
import { messageDocument } from "./records.js";
import type { TelegramClient } from "./client.js";
import type { TelegramDeliveryControl } from "./deliveryControl.js";
import { normalizeTimestamp } from "./deliveryPolicy.js";
import {
  ensureCommitted,
  type DesiredContext,
  type DesiredSendOperations,
} from "./deliveryState.js";
import { readProperty } from "./values.js";
export function createTelegramSendDelivery({
  client,
  now,
  createAttemptId,
  control,
  operations,
}: {
  client: TelegramClient;
  now: () => number;
  createAttemptId: () => string;
  control: Pick<
    TelegramDeliveryControl,
    | "updateOwned"
    | "acquireApiGate"
    | "buildGateBlockedFailure"
    | "settlePersistedApiGate"
    | "logFailure"
  >;
  operations: DesiredSendOperations;
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
  }: DesiredContext & {
    desired: TextDesiredView;
    chatId: string;
    previousApplied: TelegramAppliedDocument | null;
    nowMs: number;
    requestedGeneration?: string;
  }) => {
    const attemptId = createAttemptId();
    const marker = desired.createSendMarker(attemptId, chatId, nowMs);
    const marked = await updateOwned(
      messageKey,
      ownerToken,
      (record, delivery) =>
        markSendInFlightRecord(messageDocument(record), delivery, {
          desired,
          marker,
        }),
    );
    if (
      !marked.committed ||
      !readDelivery(
        messageDeliveryDocument(marked.value),
      ).sendInFlightMatchesRevision(desired.revision)
    ) {
      return { status: "stale" };
    }

    const expired = await finishExpiredOwnedRetryWindow({
      messageKey,
      ownerToken,
      desired,
      currentDelivery: messageDeliveryDocument(marked.value),
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
        currentDelivery: messageDeliveryDocument(marked.value),
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
      normalizeTimestamp(
        readProperty(
          messageDeliveryDocument(marked.value),
          "retryDeadlineAtMs",
        ),
      ) > 0 &&
      normalizeTimestamp(
        readProperty(
          messageDeliveryDocument(marked.value),
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
          acknowledgeSendRecord(messageDocument(record), delivery, {
            applied,
            chatId,
            desired,
            marker,
            nowMs,
            previousApplied,
            result,
          }),
      );
      ensureCommitted(receiptWrite, "send-receipt-not-persisted");
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
        currentDelivery: messageDeliveryDocument(marked.value),
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
