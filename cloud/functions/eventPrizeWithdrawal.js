"use strict";

const { onCall } = require("firebase-functions/v2/https");
const { HELIUS_RPC_API_KEY } = require("./heliusRpc");
const {
  buildCompressedTransferBuilder,
  loadPrizeAssetState,
  validateCompressedPrizeAsset,
} = require("./eventPrizes/assets");
const {
  reconcileCompletedWithdrawalProjections,
} = require("./eventPrizes/projectionReconciliation");
const {
  inspectSubmittedWithdrawal,
  reconcileSubmittedAssetState,
  recoverSubmittedWithdrawal,
} = require("./eventPrizes/submissionRecovery");
const {
  EVENT_PRIZE_ADMIN_PRIVATE_KEY,
  loadSolanaDependencies,
} = require("./eventPrizes/solana");
const {
  buildSubmittedTransaction,
  deserializePersistedSubmittedTransaction,
  isDefinitiveSubmittedTransactionFailure,
  sendAndConfirmSubmittedTransaction,
  waitForSubmittedTransactionStatus,
} = require("./eventPrizes/submittedTransactions");
const {
  handleWithdrawEventPrize,
  validatePrizeAssignment,
} = require("./eventPrizes/withdrawalOrchestrator");
const {
  acquireWithdrawalClaim,
  discardDefinitiveSubmittedTransaction,
  persistSubmittedTransaction,
} = require("./eventPrizes/withdrawalRepository");

const withdrawEventPrize = onCall(
  {
    secrets: [EVENT_PRIZE_ADMIN_PRIVATE_KEY, HELIUS_RPC_API_KEY],
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 3,
    concurrency: 1,
  },
  handleWithdrawEventPrize,
);

module.exports = {
  acquireWithdrawalClaim,
  buildCompressedTransferBuilder,
  buildSubmittedTransaction,
  discardDefinitiveSubmittedTransaction,
  deserializePersistedSubmittedTransaction,
  handleWithdrawEventPrize,
  inspectSubmittedWithdrawal,
  isDefinitiveSubmittedTransactionFailure,
  loadPrizeAssetState,
  loadSolanaDependencies,
  persistSubmittedTransaction,
  reconcileSubmittedAssetState,
  recoverSubmittedWithdrawal,
  reconcileCompletedWithdrawalProjections,
  sendAndConfirmSubmittedTransaction,
  validateCompressedPrizeAsset,
  validatePrizeAssignment,
  waitForSubmittedTransactionStatus,
  withdrawEventPrize,
};
