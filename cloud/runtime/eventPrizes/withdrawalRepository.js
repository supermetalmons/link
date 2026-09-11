"use strict";

const crypto = require("node:crypto");
const { EventPrizeWithdrawalError: HttpsError } = require("./errors");
const { runStateDecisionTransaction } = require("../stateDecisionTransaction");
const {
  decideWithdrawalClaim,
  isWithdrawalRecordForPrize,
} = require("../eventPrizeWithdrawalState");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const acquireWithdrawalClaim = async ({
  withdrawalRecord,
  eventId,
  prizeId,
  assetAddress,
  profileId,
  place,
  recipientAddress,
  requesterUid,
  canonicalRecordProfileId,
  canonicalRecordSourceProfileId,
}) => {
  const leaseId = crypto.randomBytes(16).toString("hex");
  const decide = (current) =>
    decideWithdrawalClaim({
      current,
      eventId,
      prizeId,
      assetAddress,
      profileId,
      place,
      recipientAddress,
      requesterUid,
      canonicalRecordProfileId,
      canonicalRecordSourceProfileId,
      leaseId,
      nowMs: Date.now(),
    });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await withdrawalRecord.transaction((current) => {
      const decision = decide(current);
      return decision.kind === "acquired" ? decision.value : (current ?? null);
    });
    const withdrawal = result.value;
    if (
      result.committed &&
      normalizeString(withdrawal?.leaseId) === leaseId &&
      ["processing", "submitted"].includes(withdrawal?.status) &&
      isWithdrawalRecordForPrize(withdrawal, eventId, prizeId, assetAddress)
    ) {
      return { leaseId, withdrawal };
    }
    const decision = decide(withdrawal);
    if (decision?.kind === "acquired") {
      continue;
    }
    if (decision?.kind === "completed") {
      return { completed: decision.value };
    }
    if (decision?.kind === "busy") {
      throw new HttpsError(
        "aborted",
        "This prize withdrawal is already being processed.",
      );
    }
    if (decision?.kind === "destination-mismatch") {
      throw new HttpsError(
        "failed-precondition",
        "The pending withdrawal is locked to its original destination.",
      );
    }
    if (decision?.kind === "blocked") {
      throw new HttpsError(
        "failed-precondition",
        "This prize is unavailable for withdrawal.",
      );
    }
    throw new HttpsError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  throw new HttpsError(
    "aborted",
    "Prize withdrawal changed. Please try again.",
  );
};

const releaseProcessingClaim = async ({ withdrawalRecord, leaseId }) => {
  await withdrawalRecord.transaction((current) => {
    if (
      current?.status === "processing" &&
      normalizeString(current.leaseId) === leaseId
    ) {
      return null;
    }
    return current ?? null;
  });
};

const markWithdrawalBlocked = async ({
  withdrawalRecord,
  leaseId,
  observedOwner,
}) => {
  await withdrawalRecord.transaction((current) => {
    if (
      !current ||
      current.status === "completed" ||
      normalizeString(current.leaseId) !== leaseId
    ) {
      return current ?? null;
    }
    return {
      ...current,
      status: "blocked",
      observedOwner,
      updatedAtMs: Date.now(),
      leaseId: null,
      leaseExpiresAtMs: null,
    };
  });
};

const persistSubmittedTransaction = async ({
  withdrawalRecord,
  leaseId,
  transactionSignature,
  signedTransactionBase64,
  blockhash,
  lastValidBlockHeight,
}) => {
  const result = await withdrawalRecord.transaction((current) => {
    if (
      !current ||
      current.status === "completed" ||
      normalizeString(current.leaseId) !== leaseId
    ) {
      return current ?? null;
    }
    return {
      ...current,
      status: "submitted",
      transactionSignature,
      signedTransactionBase64,
      blockhash,
      lastValidBlockHeight,
      submittedAtMs:
        Number.isFinite(current.submittedAtMs) && current.submittedAtMs > 0
          ? Math.floor(current.submittedAtMs)
          : Date.now(),
      updatedAtMs: Date.now(),
    };
  });
  const persisted = result.value;
  if (
    !result.committed ||
    persisted?.status !== "submitted" ||
    normalizeString(persisted.leaseId) !== leaseId ||
    normalizeString(persisted.transactionSignature) !== transactionSignature ||
    normalizeString(persisted.signedTransactionBase64) !==
      signedTransactionBase64 ||
    normalizeString(persisted.blockhash) !== blockhash ||
    Number(persisted.lastValidBlockHeight) !== lastValidBlockHeight
  ) {
    throw new HttpsError(
      "aborted",
      "Prize withdrawal ownership changed. Please try again.",
    );
  }
  return persisted;
};

const discardDefinitiveSubmittedTransaction = async ({
  withdrawalRecord,
  leaseId,
  transactionSignature,
}) => {
  const result = await runStateDecisionTransaction(
    withdrawalRecord,
    (current) =>
      current?.status === "submitted" &&
      normalizeString(current.leaseId) === leaseId &&
      normalizeString(current.transactionSignature) === transactionSignature
        ? { value: null, decision: "discarded" }
        : { commit: false, decision: "stale" },
  );
  if (
    !result.committed ||
    result.decision !== "discarded" ||
    result.value !== null
  ) {
    throw new HttpsError(
      "aborted",
      "Prize withdrawal changed. Please try again.",
    );
  }
};

module.exports = {
  acquireWithdrawalClaim,
  discardDefinitiveSubmittedTransaction,
  markWithdrawalBlocked,
  persistSubmittedTransaction,
  releaseProcessingClaim,
};
