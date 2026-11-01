import { getEventPrizeDefinition } from "../../../runtime/shared/event-prizes.js";
import {
  readWithdrawalDocument,
  type WithdrawalDocument,
} from "../../../runtime/eventPrizes/records.js";

export function canonicalWithdrawalFixture(
  fields: Record<string, unknown>,
): WithdrawalDocument {
  const eventId =
    typeof fields.eventId === "string" ? fields.eventId : "NN3eRzoZo80";
  const prizeId = typeof fields.prizeId === "string" ? fields.prizeId : "1092";
  const prize = getEventPrizeDefinition(eventId, prizeId);
  const status = fields.status ?? "processing";
  const startedAtMs = fields.startedAtMs ?? 10;
  const submittedAtMs =
    fields.submittedAtMs ??
    (typeof startedAtMs === "number" ? Math.max(startedAtMs, 20) : startedAtMs);
  const completedAtMs =
    fields.completedAtMs ??
    (typeof submittedAtMs === "number"
      ? Math.max(submittedAtMs, 30)
      : submittedAtMs);
  const updatedAtMs =
    fields.updatedAtMs ??
    (status === "completed"
      ? completedAtMs
      : status === "submitted"
        ? submittedAtMs
        : startedAtMs);
  const value = readWithdrawalDocument({
    schemaVersion: 1,
    eventId,
    prizeId,
    assetAddress: prize?.assetAddress,
    assetStandard: prize?.standard,
    profileId: "profile",
    entitledProfileId: fields.profileId ?? "profile",
    place: 1,
    recipientAddress: "11111111111111111111111111111111",
    requesterUid: "uid",
    startedAtMs,
    updatedAtMs,
    transactionSignature: null,
    signedTransactionBase64: null,
    blockhash: null,
    lastValidBlockHeight: null,
    submittedAtMs: null,
    observedOwner: null,
    blockReason: null,
    blockedAtMs: null,
    sourceDigest: null,
    completedAtMs: null,
    leaseId: "lease",
    leaseExpiresAtMs:
      typeof updatedAtMs === "number" ? Math.max(updatedAtMs, 1000) : 1000,
    status,
    ...(status === "submitted" || status === "completed"
      ? {
          transactionSignature: "signature",
          signedTransactionBase64: "AQID",
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: 123,
          submittedAtMs,
        }
      : {}),
    ...(status === "completed"
      ? { leaseId: null, leaseExpiresAtMs: null, completedAtMs }
      : {}),
    ...fields,
  });
  if (!value) throw new TypeError("invalid-canonical-withdrawal-fixture");
  return value;
}
