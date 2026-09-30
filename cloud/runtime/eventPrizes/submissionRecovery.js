// Generated from src/eventPrizes/submissionRecovery.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recoverSubmittedWithdrawal =
  exports.reconcileSubmittedAssetState =
  exports.inspectSubmittedWithdrawal =
    void 0;
const errors_js_1 = require("./errors.js");
const eventPrizeWithdrawalState_js_1 = require("../eventPrizeWithdrawalState.js");
const assets_js_1 = require("./assets.js");
const solana_js_1 = require("./solana.js");
const submittedTransactions_js_1 = require("./submittedTransactions.js");
const getCurrentBlockHeight = async (umi) => {
  const blockHeight = await umi.rpc.call("getBlockHeight", [
    { commitment: solana_js_1.CONFIRMATION_COMMITMENT },
  ]);
  if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
    throw new Error("Solana RPC returned an invalid block height.");
  }
  return blockHeight;
};
const inspectSubmittedWithdrawal = async ({ umi, withdrawal }) => {
  const submitted = (0,
  submittedTransactions_js_1.deserializePersistedSubmittedTransaction)(
    umi,
    withdrawal,
  );
  if (!submitted) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "internal",
      "The submitted prize transaction is unavailable.",
    );
  }
  const status = await (0,
  submittedTransactions_js_1.waitForSubmittedTransactionStatus)({
    umi,
    submitted,
    retryDelaysMs: [0],
  });
  return { submitted, status };
};
exports.inspectSubmittedWithdrawal = inspectSubmittedWithdrawal;
const recoverSubmittedWithdrawal = async ({
  umi,
  withdrawal,
  assetOwner,
  recipientAddress,
  inspection,
  statusRetryDelaysMs = solana_js_1.TRANSACTION_STATUS_RETRY_DELAYS_MS,
}) => {
  const submittedInspection =
    inspection || (await inspectSubmittedWithdrawal({ umi, withdrawal }));
  const { submitted } = submittedInspection;
  let { status } = submittedInspection;
  if (status.kind === "confirmed") {
    return { kind: "completed", submitted };
  }
  if (status.kind === "failed") {
    return assetOwner ===
      eventPrizeWithdrawalState_js_1.EVENT_PRIZE_ADMIN_WALLET
      ? { kind: "retry", discardPersistedSubmission: true, submitted }
      : { kind: "blocked", submitted };
  }
  if (assetOwner === recipientAddress) {
    return { kind: "completed", submitted };
  }
  if (assetOwner === eventPrizeWithdrawalState_js_1.EVENT_PRIZE_ADMIN_WALLET) {
    if (status.kind === "unknown") {
      throw (
        status.error || new Error("Prize transaction status is unavailable.")
      );
    }
    return { kind: "retry", discardPersistedSubmission: false, submitted };
  }
  const remainingRetryDelaysMs =
    statusRetryDelaysMs[0] === 0
      ? statusRetryDelaysMs.slice(1)
      : statusRetryDelaysMs;
  if (remainingRetryDelaysMs.length > 0) {
    status = await (0,
    submittedTransactions_js_1.waitForSubmittedTransactionStatus)({
      umi,
      submitted,
      retryDelaysMs: remainingRetryDelaysMs,
    });
  }
  if (status.kind === "confirmed") {
    return { kind: "completed", submitted };
  }
  if (status.kind === "failed") {
    return { kind: "blocked", submitted };
  }
  throw status.error || new Error("Prize transaction confirmation is pending.");
};
exports.recoverSubmittedWithdrawal = recoverSubmittedWithdrawal;
const reconcileSubmittedAssetState = async ({
  umi,
  withdrawal,
  assetState,
  recipientAddress,
  inspection,
  statusRetryDelaysMs,
}) => {
  const assetOwner = (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
    assetState.assetOwner,
  );
  if (!assetOwner) {
    throw (0, assets_js_1.createPrizeAssetVerificationError)(
      "The prize ownership could not be verified.",
    );
  }
  const submittedInspection =
    inspection || (await inspectSubmittedWithdrawal({ umi, withdrawal }));
  const recovery = await recoverSubmittedWithdrawal({
    umi,
    withdrawal,
    assetOwner,
    recipientAddress,
    inspection: submittedInspection,
    statusRetryDelaysMs,
  });
  if (recovery.kind === "completed" || recovery.kind === "blocked") {
    return { kind: recovery.kind, assetOwner, submitted: recovery.submitted };
  }
  if (recovery.discardPersistedSubmission) {
    return { kind: "discard", assetOwner, submitted: recovery.submitted };
  }
  const currentBlockHeight = await getCurrentBlockHeight(umi);
  if (currentBlockHeight <= recovery.submitted.lastValidBlockHeight) {
    return {
      kind: assetState.blocked ? "retry" : "resume",
      assetOwner,
      submitted: recovery.submitted,
    };
  }
  const finalStatus = await (0,
  submittedTransactions_js_1.waitForSubmittedTransactionStatus)({
    umi,
    submitted: recovery.submitted,
    retryDelaysMs: [0],
  });
  if (finalStatus.kind === "confirmed") {
    return {
      kind: "completed",
      assetOwner,
      submitted: recovery.submitted,
    };
  }
  const signatureRemainsAbsent =
    submittedInspection.status.kind === "pending" &&
    submittedInspection.status.signatureFound === false &&
    finalStatus.kind === "pending" &&
    finalStatus.signatureFound === false;
  return {
    kind:
      finalStatus.kind === "failed" || signatureRemainsAbsent
        ? "discard"
        : "retry",
    assetOwner,
    submitted: recovery.submitted,
  };
};
exports.reconcileSubmittedAssetState = reconcileSubmittedAssetState;
