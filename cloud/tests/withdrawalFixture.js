"use strict";
const { getEventPrizeDefinition } = require("../runtime/shared/event-prizes");
const { readWithdrawalDocument } = require("../runtime/eventPrizes/records");

/**
 * @typedef {import("../runtime/eventPrizes/records").WithdrawalDocument} WithdrawalDocument
 * @typedef {Partial<Omit<WithdrawalDocument, "schemaVersion">> & {schemaVersion?: never}} WithdrawalPatch
 */
/**
 * @overload
 * @param {WithdrawalPatch | WithdrawalDocument} [fields]
 * @returns {WithdrawalDocument}
 */
/**
 * @overload
 * @param {null} fields
 * @returns {null}
 */
/**
 * @overload
 * @param {WithdrawalPatch | WithdrawalDocument | null} fields
 * @returns {WithdrawalDocument | null}
 */
/** @param {WithdrawalPatch | WithdrawalDocument | null} [fields] */
function canonicalWithdrawalFixture(fields = {}) {
  if (fields === null) return null;
  if (fields.schemaVersion === 1) return fields;
  const eventId = fields.eventId ?? "NN3eRzoZo80";
  const prizeId = fields.prizeId ?? "1092";
  const prize = getEventPrizeDefinition(eventId, prizeId);
  const status = fields.status ?? "processing";
  const startedAtMs = fields.startedAtMs ?? 10;
  const submittedAtMs = fields.submittedAtMs ?? Math.max(startedAtMs, 20);
  const completedAtMs = fields.completedAtMs ?? Math.max(submittedAtMs, 30);
  const updatedAtMs =
    fields.updatedAtMs ??
    (status === "completed"
      ? completedAtMs
      : status === "submitted"
        ? submittedAtMs
        : startedAtMs);
  const value = {
    schemaVersion: 1,
    eventId,
    prizeId,
    assetAddress: prize?.assetAddress,
    assetStandard: prize?.standard,
    entitledProfileId: fields.profileId ?? "profile",
    profileId: "profile",
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
    leaseExpiresAtMs: Math.max(updatedAtMs, 1000),
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
  };
  const document = readWithdrawalDocument(value);
  if (!document) throw new TypeError("invalid-canonical-withdrawal-fixture");
  return document;
}
module.exports = { canonicalWithdrawalFixture };
