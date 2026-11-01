// Generated from src/eventPrizes/records.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readWithdrawalDocument = readWithdrawalDocument;
exports.readStoredWithdrawalDocument = readStoredWithdrawalDocument;
exports.storedWithdrawalMatchesIdentity = storedWithdrawalMatchesIdentity;
exports.withdrawalStatus = withdrawalStatus;
exports.withdrawalExecutionStatus = withdrawalExecutionStatus;
exports.withdrawalIdentity = withdrawalIdentity;
exports.withdrawalOwnership = withdrawalOwnership;
exports.withdrawalRecipientAddress = withdrawalRecipientAddress;
exports.withdrawalLeaseId = withdrawalLeaseId;
exports.withdrawalLeaseExpiresAtMs = withdrawalLeaseExpiresAtMs;
exports.withdrawalPlace = withdrawalPlace;
exports.withdrawalStartedAtForClaim = withdrawalStartedAtForClaim;
exports.withdrawalSubmittedAtForPersistence =
  withdrawalSubmittedAtForPersistence;
exports.withdrawalStartedAtForCompletion = withdrawalStartedAtForCompletion;
exports.withdrawalSubmittedAtForCompletion = withdrawalSubmittedAtForCompletion;
exports.withdrawalStorageUpdatedAtMs = withdrawalStorageUpdatedAtMs;
exports.withdrawalSubmissionStrings = withdrawalSubmissionStrings;
exports.withdrawalLastValidBlockHeight = withdrawalLastValidBlockHeight;
exports.withdrawalResponseFields = withdrawalResponseFields;
exports.writeProcessingWithdrawal = writeProcessingWithdrawal;
exports.writeReacquiredSubmittedWithdrawal = writeReacquiredSubmittedWithdrawal;
exports.writeBlockedWithdrawal = writeBlockedWithdrawal;
exports.writeSubmittedWithdrawal = writeSubmittedWithdrawal;
exports.writeCompletedWithdrawal = writeCompletedWithdrawal;
const event_prizes_js_1 = require("../shared/event-prizes.js");
const solana_js_1 = require("../shared/solana.js");
const KEYS = [
  "schemaVersion",
  "eventId",
  "prizeId",
  "assetAddress",
  "assetStandard",
  "entitledProfileId",
  "profileId",
  "place",
  "recipientAddress",
  "requesterUid",
  "startedAtMs",
  "updatedAtMs",
  "status",
  "leaseId",
  "leaseExpiresAtMs",
  "transactionSignature",
  "signedTransactionBase64",
  "blockhash",
  "lastValidBlockHeight",
  "submittedAtMs",
  "completedAtMs",
  "observedOwner",
  "blockReason",
  "blockedAtMs",
  "sourceDigest",
];
const text = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
const key = (value) => text(value) && !value.includes("/");
const integer = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const address = (value) =>
  text(value) && (0, solana_js_1.isValidSolanaAddress)(value);
const base64 = (value) =>
  text(value) &&
  value.length <= 2_000_000 &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    value,
  );
function isWithdrawalDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value;
  if (
    Object.keys(row).length !== KEYS.length ||
    !KEYS.every((key) => Object.hasOwn(row, key)) ||
    row.schemaVersion !== 1 ||
    !key(row.eventId) ||
    !key(row.prizeId) ||
    !address(row.assetAddress) ||
    !(0, event_prizes_js_1.isEventPrizeStandard)(row.assetStandard) ||
    !key(row.entitledProfileId) ||
    !key(row.profileId) ||
    (row.place !== 1 && row.place !== 2 && row.place !== 3) ||
    !address(row.recipientAddress) ||
    !key(row.requesterUid) ||
    !integer(row.startedAtMs) ||
    !integer(row.updatedAtMs) ||
    row.updatedAtMs < row.startedAtMs
  )
    return false;
  const noSubmission =
    row.transactionSignature === null &&
    row.signedTransactionBase64 === null &&
    row.blockhash === null &&
    row.lastValidBlockHeight === null &&
    row.submittedAtMs === null;
  const signature = text(row.transactionSignature);
  const submittedTime =
    integer(row.submittedAtMs) &&
    row.submittedAtMs >= row.startedAtMs &&
    row.submittedAtMs <= row.updatedAtMs;
  const signedEvidence =
    base64(row.signedTransactionBase64) &&
    address(row.blockhash) &&
    integer(row.lastValidBlockHeight);
  const noSignedEvidence =
    row.signedTransactionBase64 === null &&
    row.blockhash === null &&
    row.lastValidBlockHeight === null;
  const noBlock =
    row.observedOwner === null &&
    row.blockReason === null &&
    row.blockedAtMs === null &&
    row.sourceDigest === null;
  if (row.status === "processing" || row.status === "submitted") {
    if (
      !text(row.leaseId) ||
      !integer(row.leaseExpiresAtMs) ||
      row.leaseExpiresAtMs < row.startedAtMs ||
      row.completedAtMs !== null ||
      !noBlock
    )
      return false;
    return row.status === "processing"
      ? noSubmission
      : signature && submittedTime && signedEvidence;
  }
  if (row.leaseId !== null || row.leaseExpiresAtMs !== null) return false;
  if (row.status === "completed")
    return (
      noBlock &&
      signature &&
      submittedTime &&
      (signedEvidence || noSignedEvidence) &&
      integer(row.completedAtMs) &&
      integer(row.submittedAtMs) &&
      row.completedAtMs >= row.submittedAtMs &&
      row.completedAtMs <= row.updatedAtMs
    );
  if (
    row.status !== "blocked" ||
    row.completedAtMs !== null ||
    !integer(row.blockedAtMs) ||
    row.blockedAtMs < row.startedAtMs ||
    row.blockedAtMs > row.updatedAtMs ||
    (row.observedOwner !== null && !address(row.observedOwner)) ||
    !(
      noSubmission ||
      (signature && submittedTime && (signedEvidence || noSignedEvidence))
    )
  )
    return false;
  return row.blockReason === "asset-owner-mismatch"
    ? address(row.observedOwner) && row.sourceDigest === null
    : row.blockReason === "canonical-data-cutover" &&
        typeof row.sourceDigest === "string" &&
        /^[a-f0-9]{64}$/.test(row.sourceDigest);
}
function readWithdrawalDocument(value) {
  return isWithdrawalDocument(value) ? value : null;
}
function readStoredWithdrawalDocument(value) {
  return readWithdrawalDocument(value);
}
function requireDocument(value) {
  const document = readWithdrawalDocument(value);
  if (!document) throw new TypeError("invalid-canonical-withdrawal");
  return document;
}
function storedWithdrawalMatchesIdentity(value, eventId, prizeId) {
  return value.eventId === eventId && value.prizeId === prizeId;
}
function withdrawalStatus(value) {
  return value?.status ?? null;
}
function withdrawalExecutionStatus(value) {
  return value?.status ?? "";
}
function withdrawalIdentity(value) {
  return {
    eventId: value?.eventId ?? "",
    prizeId: value?.prizeId ?? "",
    assetAddress: value?.assetAddress ?? "",
    assetStandard: value?.assetStandard ?? "",
  };
}
function withdrawalOwnership(value) {
  return {
    profileId: value?.profileId ?? "",
    entitledProfileId: value?.entitledProfileId ?? "",
    requesterUid: value?.requesterUid ?? "",
  };
}
function withdrawalRecipientAddress(value) {
  return value?.recipientAddress ?? "";
}
function withdrawalLeaseId(value) {
  return value?.leaseId ?? "";
}
function withdrawalLeaseExpiresAtMs(value) {
  return value?.leaseExpiresAtMs ?? 0;
}
function withdrawalPlace(value) {
  return value?.place ?? 0;
}
function withdrawalStartedAtForClaim(value, nowMs) {
  return value?.startedAtMs ?? nowMs;
}
function withdrawalSubmittedAtForPersistence(value, now) {
  return value.submittedAtMs ?? now();
}
function withdrawalStartedAtForCompletion(value, _completedAtMs) {
  return value.startedAtMs;
}
function withdrawalSubmittedAtForCompletion(value, completedAtMs) {
  return value.submittedAtMs ?? completedAtMs;
}
function withdrawalStorageUpdatedAtMs(value) {
  return value.updatedAtMs;
}
function withdrawalSubmissionStrings(value) {
  return {
    signedTransactionBase64: value?.signedTransactionBase64 ?? "",
    transactionSignature: value?.transactionSignature ?? "",
    blockhash: value?.blockhash ?? "",
  };
}
function withdrawalLastValidBlockHeight(value) {
  return value?.lastValidBlockHeight ?? null;
}
function withdrawalResponseFields(value) {
  if (value.status !== "completed")
    throw new TypeError("withdrawal-not-completed");
  return {
    eventId: value.eventId,
    prizeId: value.prizeId,
    assetAddress: value.assetAddress,
    recipientAddress: value.recipientAddress,
    transactionSignature: value.transactionSignature,
  };
}
const noSubmission = {
  transactionSignature: null,
  signedTransactionBase64: null,
  blockhash: null,
  lastValidBlockHeight: null,
  submittedAtMs: null,
};
const noBlock = {
  observedOwner: null,
  blockReason: null,
  blockedAtMs: null,
  sourceDigest: null,
};
function writeProcessingWithdrawal(value) {
  const result = requireDocument({
    ...value,
    ...noSubmission,
    ...noBlock,
    schemaVersion: 1,
    status: "processing",
    completedAtMs: null,
  });
  if (result.status !== "processing")
    throw new TypeError("invalid-canonical-withdrawal");
  return result;
}
function writeReacquiredSubmittedWithdrawal(previous, value) {
  if (previous.status !== "submitted")
    throw new TypeError("withdrawal-not-submitted");
  const result = requireDocument({
    ...previous,
    ...value,
    schemaVersion: 1,
    status: "submitted",
  });
  if (result.status !== "submitted")
    throw new TypeError("invalid-canonical-withdrawal");
  return result;
}
function writeBlockedWithdrawal(current, observedOwner, updatedAtMs) {
  const result = requireDocument({
    ...current,
    status: "blocked",
    observedOwner,
    updatedAtMs,
    leaseId: null,
    leaseExpiresAtMs: null,
    completedAtMs: null,
    blockReason: "asset-owner-mismatch",
    blockedAtMs: updatedAtMs,
    sourceDigest: null,
  });
  if (result.status !== "blocked")
    throw new TypeError("invalid-canonical-withdrawal");
  return result;
}
function writeSubmittedWithdrawal(
  current,
  evidence,
  submittedAtMs,
  updatedAtMs,
) {
  if (current.status !== "processing" && current.status !== "submitted")
    throw new TypeError("withdrawal-not-processing");
  const result = requireDocument({
    ...current,
    ...evidence,
    status: "submitted",
    submittedAtMs,
    updatedAtMs,
  });
  if (result.status !== "submitted")
    throw new TypeError("invalid-canonical-withdrawal");
  return result;
}
function writeCompletedWithdrawal(value) {
  const result = requireDocument({
    ...value,
    ...noBlock,
    schemaVersion: 1,
    leaseId: null,
    leaseExpiresAtMs: null,
  });
  if (result.status !== "completed")
    throw new TypeError("invalid-canonical-withdrawal");
  return result;
}
