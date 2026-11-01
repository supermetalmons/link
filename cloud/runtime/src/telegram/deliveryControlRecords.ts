import type { TransactionDecision } from "../transactions.js";

import {
  buildApiGateOwner,
  normalizeString,
  omitKeys,
  readDelivery,
  readPendingDelete,
  DeliverySnapshot,
  deliveryDocument,
} from "./deliveryState.js";
import { normalizeTimestamp } from "./deliveryPolicy.js";

import { readProperty } from "./values.js";
import type { TelegramMessageDocument } from "./records.js";
import {
  requireTelegramMessageDocument,
  requireTelegramTransaction,
} from "./recordCodec.js";

type ClearRateLimitProofRecordInput = {
  owner: string;
};
export function clearRateLimitProofRecord(
  current: TelegramMessageDocument,
  input: ClearRateLimitProofRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const { owner } = input;
  const apply = (record: TelegramMessageDocument) => {
    const delivery = readDelivery(record.delivery);
    const pendingDelete = readPendingDelete(delivery.pendingDelete);
    const clearsDesired =
      normalizeString(readProperty(delivery.apiGateProofRequired, "owner")) ===
      owner;
    const clearsPending =
      normalizeString(
        readProperty(pendingDelete.apiGateProofRequired, "owner"),
      ) === owner;
    if (!clearsDesired && !clearsPending) {
      return { commit: false, decision: "rate-limit-proof-marker-stale" };
    }
    return {
      value: {
        ...record,
        delivery: {
          ...(clearsDesired
            ? omitKeys(delivery, ["apiGateProofRequired"])
            : deliveryDocument(delivery)),
          ...(clearsPending
            ? {
                pendingDelete: omitKeys(pendingDelete, [
                  "apiGateProofRequired",
                ]),
              }
            : {}),
        },
      },
      decision: "rate-limit-proof-marker-cleared",
    };
  };
  return requireTelegramTransaction(apply(current));
}

type PrepareDesiredGateRecordInput = {
  generation: string;
  messageKey: string;
  preparedAtMs: number;
  revision: string;
};
export function prepareDesiredGateRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: PrepareDesiredGateRecordInput,
): TelegramMessageDocument {
  const { generation, messageKey, preparedAtMs, revision } = input;
  const apply = (record: TelegramMessageDocument) => {
    const existingOwner = normalizeString(delivery.apiGateOwner);
    return {
      ...record,
      delivery: {
        ...deliveryDocument(delivery),
        apiGateOwner:
          existingOwner ||
          buildApiGateOwner(messageKey, "desired", revision, generation),
        apiGateGeneration:
          normalizeString(delivery.apiGateGeneration) || generation,
        apiGateStartedAtMs:
          normalizeTimestamp(delivery.apiGateStartedAtMs) || preparedAtMs,
      },
    };
  };
  return requireTelegramMessageDocument(apply(current));
}

type SettleApiGateRecordInput = {
  field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner";
  settleOwner: string;
};
export function settleApiGateRecord(
  current: TelegramMessageDocument,
  input: SettleApiGateRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const { field, settleOwner } = input;
  const apply = (record: TelegramMessageDocument) => {
    const delivery = readDelivery(record.delivery);
    if (delivery.settlementOwner(field) !== settleOwner) {
      return { commit: false, decision: "api-gate-settle-stale" };
    }
    return {
      value: {
        ...record,
        delivery: omitKeys(delivery, [field]),
      },
      decision: "api-gate-settled",
    };
  };
  return requireTelegramTransaction(apply(current));
}
