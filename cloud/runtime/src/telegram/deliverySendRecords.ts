import type { TelegramSendAttemptDocument } from "./desiredRecords.js";

import type { TelegramSendSuccess } from "./client.js";

import {
  appendPendingDelete,
  buildPendingDeleteId,
  normalizeString,
  omitKeys,
  writeCleanup,
  writeDelivery,
  DeliverySnapshot,
  deliveryDocument,
} from "./deliveryState.js";
import { omitRetryState } from "./deliveryPolicy.js";

import { readProperty } from "./values.js";
import type {
  TelegramMessageDocument,
  TelegramAppliedDocument,
} from "./records.js";
import { requireTelegramMessageDocument } from "./recordCodec.js";
import { documentFields } from "./deliveryState.js";

type MarkSendInFlightRecordInput = {
  desired: { readonly revision: string };
  marker: TelegramSendAttemptDocument;
};
export function markSendInFlightRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: MarkSendInFlightRecordInput,
): TelegramMessageDocument {
  const { desired, marker } = input;
  const apply = (record: TelegramMessageDocument) => {
    if (
      normalizeString(readProperty(record.desired, "revision")) !==
      desired.revision
    ) {
      return {
        ...record,
        delivery: writeDelivery({
          ...omitKeys(delivery, ["leaseOwner", "leaseExpiresAtMs"]),
          status: "pending",
          revision: normalizeString(readProperty(record.desired, "revision")),
        }),
      };
    }
    return {
      ...record,
      delivery: {
        ...deliveryDocument(delivery),
        sendInFlight: marker,
      },
    };
  };
  return requireTelegramMessageDocument(apply(current));
}

type AcknowledgeSendRecordInput = {
  applied: TelegramAppliedDocument;
  chatId: string;
  desired: { readonly revision: string };
  marker: TelegramSendAttemptDocument;
  nowMs: number;
  previousApplied: TelegramAppliedDocument | null;
  result: TelegramSendSuccess;
};
export function acknowledgeSendRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: AcknowledgeSendRecordInput,
): TelegramMessageDocument {
  const {
    applied: retainedApplied,
    chatId,
    desired,
    marker,
    nowMs,
    previousApplied: retainedPreviousApplied,
    result,
  } = input;
  const applied = documentFields(retainedApplied);
  const previousApplied =
    retainedPreviousApplied === null
      ? null
      : documentFields(retainedPreviousApplied);
  const apply = (record: TelegramMessageDocument) => {
    const latestRevision = normalizeString(
      readProperty(record.desired, "revision"),
    );
    const nextDelivery = documentFields(
      writeDelivery({
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
  };
  return requireTelegramMessageDocument(apply(current));
}
