import type { TelegramClient } from "./client.js";
import type { TelegramDeliveryControl } from "./deliveryControl.js";
import { normalizeTimestamp, omitRetryState } from "./deliveryPolicy.js";
import {
  appendPendingDelete,
  buildPendingDeleteId,
  ensureCommitted,
  normalizeString,
  omitKeys,
  writeCleanup,
  writeDelivery,
  type DesiredContext,
  type DesiredSendOperations,
  type RawRecord,
  type SendInFlight,
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
    chatId: string;
    previousApplied: RawRecord | null;
    nowMs: number;
    requestedGeneration?: string;
  }) => {
    const attemptId = createAttemptId();
    const marker: SendInFlight = {
      attemptId,
      revision: desired.revision,
      destination: desired.destination,
      chatId,
      instanceKey: desired.instanceKey,
      contentHash: desired.contentHash,
      startedAtMs: nowMs,
      apiGateOwner: `send:${attemptId}`,
    };
    const marked = await updateOwned(
      messageKey,
      ownerToken,
      (record, delivery) => {
        if (
          normalizeString(readProperty(record.desired, "revision")) !==
          desired.revision
        ) {
          return {
            ...record,
            delivery: writeDelivery({
              ...omitKeys(delivery, ["leaseOwner", "leaseExpiresAtMs"]),
              status: "pending",
              revision: normalizeString(
                readProperty(record.desired, "revision"),
              ),
            }),
          };
        }
        return {
          ...record,
          delivery: {
            ...delivery.source,
            sendInFlight: marker,
          },
        };
      },
    );
    if (
      !marked.committed ||
      readProperty(
        readProperty(marked.value?.delivery, "sendInFlight"),
        "revision",
      ) !== desired.revision
    ) {
      return { status: "stale" };
    }

    const expired = await finishExpiredOwnedRetryWindow({
      messageKey,
      ownerToken,
      desired,
      currentDelivery: marked.value?.delivery,
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
        currentDelivery: marked.value?.delivery,
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
        readProperty(marked.value?.delivery, "retryDeadlineAtMs"),
      ) > 0 &&
      normalizeTimestamp(
        readProperty(marked.value?.delivery, "retryDeadlineAtMs"),
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

    const result = await client.sendTelegramMessage({
      chatId,
      text: desired.text,
      parseMode: desired.parseMode || null,
      silent: desired.silent === true,
      disableWebPagePreview: desired.disableWebPagePreview !== false,
    });
    if (result.ok) {
      const applied = {
        destination: desired.destination,
        chatId,
        messageId: result.messageId,
        instanceKey: desired.instanceKey,
        revision: desired.revision,
        contentHash: desired.contentHash,
        appliedAtMs: nowMs,
      };
      const receiptWrite = await updateOwned(
        messageKey,
        ownerToken,
        (record, delivery) => {
          const latestRevision = normalizeString(
            readProperty(record.desired, "revision"),
          );
          const nextDelivery = writeDelivery({
            ...omitRetryState(
              omitKeys(delivery, [
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
                  status: "delivered" as const,
                  revision: latestRevision || desired.revision,
                  deliveredAtMs: nowMs,
                }
              : {
                  status: "pending" as const,
                  revision: latestRevision || desired.revision,
                }),
            apiGateSettleOwner: marker.apiGateOwner,
          });
          if (latestRevision !== desired.revision) {
            nextDelivery.attempts = 0;
          }
          if (
            previousApplied &&
            typeof previousApplied.messageId === "number" &&
            Number.isInteger(previousApplied.messageId) &&
            previousApplied.messageId > 0 &&
            (previousApplied.messageId !== result.messageId ||
              normalizeString(previousApplied.chatId) !== chatId)
          ) {
            const pendingDelete = writeCleanup({
              chatId: normalizeString(previousApplied.chatId) || chatId,
              messageId: previousApplied.messageId,
              instanceKey: normalizeString(previousApplied.instanceKey),
              pendingDeleteId: buildPendingDeleteId({
                chatId: normalizeString(previousApplied.chatId) || chatId,
                messageId: previousApplied.messageId,
              }),
              status: "pending",
              attempts: 0,
            });
            Object.assign(
              nextDelivery,
              appendPendingDelete(nextDelivery, pendingDelete),
            );
          }
          return {
            ...record,
            applied,
            delivery: nextDelivery,
          };
        },
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
        currentDelivery: marked.value?.delivery,
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
