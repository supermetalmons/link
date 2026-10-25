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
const source = (value) => value ?? {};
const trimmed = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
function readWithdrawalDocument(value) {
  return value !== null && typeof value === "object" ? value : null;
}
function readStoredWithdrawalDocument(value) {
  return Array.isArray(value) ? null : readWithdrawalDocument(value);
}
function storedWithdrawalMatchesIdentity(value, eventId, prizeId) {
  const record = source(value);
  return (
    record.eventId === eventId &&
    record.prizeId === prizeId &&
    ["blocked", "completed", "processing", "submitted"].includes(
      String(record.status),
    )
  );
}
function withdrawalStatus(value) {
  const status = source(value).status;
  return status === "blocked" ||
    status === "completed" ||
    status === "processing" ||
    status === "submitted"
    ? status
    : null;
}
function withdrawalExecutionStatus(value) {
  return trimmed(source(value).status);
}
function withdrawalIdentity(value) {
  const record = source(value);
  return {
    eventId: trimmed(record.eventId),
    prizeId: trimmed(record.prizeId),
    assetAddress: trimmed(record.assetAddress),
    assetStandard: trimmed(record.assetStandard),
  };
}
function withdrawalOwnership(value) {
  const record = source(value);
  return {
    profileId: trimmed(record.profileId),
    entitledProfileId: trimmed(record.entitledProfileId),
    requesterUid: trimmed(record.requesterUid),
  };
}
function withdrawalRecipientAddress(value) {
  return trimmed(source(value).recipientAddress);
}
function withdrawalLeaseId(value) {
  return trimmed(source(value).leaseId);
}
function withdrawalLeaseExpiresAtMs(value) {
  return Number(source(value).leaseExpiresAtMs) || 0;
}
function withdrawalPlace(value) {
  return Number(source(value).place);
}
function withdrawalStartedAtForClaim(value, nowMs) {
  const startedAtMs = source(value).startedAtMs;
  return Number.isFinite(startedAtMs) ? Math.floor(startedAtMs) : nowMs;
}
function withdrawalSubmittedAtForPersistence(value, now) {
  const submittedAtMs = source(value).submittedAtMs;
  return Number.isFinite(submittedAtMs) && submittedAtMs > 0
    ? Math.floor(submittedAtMs)
    : now();
}
function withdrawalStartedAtForCompletion(value, completedAtMs) {
  return Number(source(value).startedAtMs) || completedAtMs;
}
function withdrawalSubmittedAtForCompletion(value, completedAtMs) {
  return Number(source(value).submittedAtMs) || completedAtMs;
}
function withdrawalStorageUpdatedAtMs(value) {
  return Number(source(value).updatedAtMs);
}
function withdrawalSubmissionStrings(value) {
  const record = source(value);
  return {
    signedTransactionBase64: trimmed(record.signedTransactionBase64),
    transactionSignature: trimmed(record.transactionSignature),
    blockhash: trimmed(record.blockhash),
  };
}
function withdrawalLastValidBlockHeight(value) {
  return Number(source(value).lastValidBlockHeight);
}
function withdrawalResponseFields(value) {
  const identity = withdrawalIdentity(value);
  return {
    eventId: identity.eventId,
    prizeId: identity.prizeId,
    assetAddress: identity.assetAddress,
    recipientAddress: withdrawalRecipientAddress(value),
    transactionSignature:
      withdrawalSubmissionStrings(value).transactionSignature,
  };
}
function writeWithdrawalClaim(previous, value, status) {
  return readWithdrawalDocument({
    ...(previous ? source(previous) : {}),
    eventId: value.eventId,
    prizeId: value.prizeId,
    assetAddress: value.assetAddress,
    ...(value.assetStandard ? { assetStandard: value.assetStandard } : {}),
    entitledProfileId: value.entitledProfileId,
    profileId: value.profileId,
    place: value.place,
    recipientAddress: value.recipientAddress,
    requesterUid: value.requesterUid,
    status,
    leaseId: value.leaseId,
    leaseExpiresAtMs: value.leaseExpiresAtMs,
    startedAtMs: value.startedAtMs,
    updatedAtMs: value.updatedAtMs,
  });
}
function writeProcessingWithdrawal(value) {
  return writeWithdrawalClaim(null, value, "processing");
}
function writeReacquiredSubmittedWithdrawal(previous, value) {
  return writeWithdrawalClaim(previous, value, "submitted");
}
function writeBlockedWithdrawal(current, observedOwner, updatedAtMs) {
  return readWithdrawalDocument({
    ...source(current),
    status: "blocked",
    observedOwner,
    updatedAtMs,
    leaseId: null,
    leaseExpiresAtMs: null,
  });
}
function writeSubmittedWithdrawal(
  current,
  evidence,
  submittedAtMs,
  updatedAtMs,
) {
  return readWithdrawalDocument({
    ...source(current),
    status: "submitted",
    transactionSignature: evidence.transactionSignature,
    signedTransactionBase64: evidence.signedTransactionBase64,
    blockhash: evidence.blockhash,
    lastValidBlockHeight: evidence.lastValidBlockHeight,
    submittedAtMs,
    updatedAtMs,
  });
}
function writeCompletedWithdrawal(value) {
  return value;
}
