"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { persistSubmittedTransaction } = require("./withdrawalRepository");
const {
  CONFIRMATION_COMMITMENT,
  CONFIRMATION_TIMEOUT_MS,
  SEND_TRANSACTION_TIMEOUT_MS,
  SIGNATURE_STATUS_TIMEOUT_MS,
  TRANSACTION_STATUS_RETRY_DELAYS_MS,
  loadSolanaDependencies,
} = require("./solana");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

class DefinitiveSubmittedTransactionFailure extends Error {}

const isDefinitiveSubmittedTransactionFailure = (error) =>
  error instanceof DefinitiveSubmittedTransactionFailure;

const deserializePersistedSubmittedTransaction = (umi, withdrawal) => {
  const encoded = normalizeString(withdrawal?.signedTransactionBase64);
  const transactionSignature = normalizeString(
    withdrawal?.transactionSignature,
  );
  const blockhash = normalizeString(withdrawal?.blockhash);
  const lastValidBlockHeight = Number(withdrawal?.lastValidBlockHeight);
  if (
    !encoded ||
    !transactionSignature ||
    !blockhash ||
    !Number.isFinite(lastValidBlockHeight)
  ) {
    return null;
  }
  try {
    return {
      signedTransaction: umi.transactions.deserialize(
        new Uint8Array(Buffer.from(encoded, "base64")),
      ),
      transactionSignature,
      blockhash,
      lastValidBlockHeight: Math.floor(lastValidBlockHeight),
    };
  } catch {
    return null;
  }
};

const buildSubmittedTransaction = async ({
  umi,
  builder,
  withdrawalRef,
  leaseId,
}) => {
  const { base58 } = loadSolanaDependencies();
  const latestBlockhash = await umi.rpc.getLatestBlockhash({
    commitment: CONFIRMATION_COMMITMENT,
  });
  const signedTransaction = await builder
    .setBlockhash(latestBlockhash)
    .buildAndSign(umi);
  const simulation = await umi.rpc.simulateTransaction(signedTransaction, {
    commitment: CONFIRMATION_COMMITMENT,
    verifySignatures: true,
  });
  if (simulation.err) {
    throw new HttpsError(
      "failed-precondition",
      "The prize transfer could not be simulated.",
    );
  }
  const transactionSignature = base58.deserialize(
    signedTransaction.signatures[0],
  )[0];
  const signedTransactionBase64 = Buffer.from(
    umi.transactions.serialize(signedTransaction),
  ).toString("base64");
  const persistedWithdrawal = await persistSubmittedTransaction({
    withdrawalRef,
    leaseId,
    transactionSignature,
    signedTransactionBase64,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });
  return {
    signedTransaction,
    transactionSignature,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    persistedWithdrawal,
  };
};

const waitForPromiseWithTimeout = (
  promise,
  timeoutMs,
  timeoutCode = "rpc-timeout",
) =>
  new Promise((resolve, reject) => {
    const timeoutId = setTimeout(
      () => {
        const error = new Error("Prize transaction RPC timed out.");
        error.code = timeoutCode;
        reject(error);
      },
      Math.max(0, Number(timeoutMs) || 0),
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });

const getSubmittedTransactionSignature = (submitted) => {
  const transactionSignature = submitted?.signedTransaction?.signatures?.[0];
  if (!transactionSignature) {
    throw new HttpsError("internal", "Prize transaction signature is missing.");
  }
  const { base58 } = loadSolanaDependencies();
  const transactionSignatureString =
    base58.deserialize(transactionSignature)[0];
  if (transactionSignatureString !== submitted.transactionSignature) {
    throw new HttpsError("internal", "Prize transaction signature mismatch.");
  }
  return transactionSignature;
};

const readSubmittedTransactionStatus = async ({
  umi,
  transactionSignature,
  statusRequestTimeoutMs = SIGNATURE_STATUS_TIMEOUT_MS,
}) => {
  const [status] = await waitForPromiseWithTimeout(
    umi.rpc.getSignatureStatuses([transactionSignature], {
      searchTransactionHistory: true,
    }),
    statusRequestTimeoutMs,
  );
  if (!status) {
    return { kind: "pending", signatureFound: false };
  }
  if (!["confirmed", "finalized"].includes(status.commitment)) {
    return { kind: "pending", signatureFound: true };
  }
  return status.error != null
    ? { kind: "failed", error: status.error }
    : { kind: "confirmed" };
};

const waitForSubmittedTransactionStatus = async ({
  umi,
  submitted,
  retryDelaysMs = TRANSACTION_STATUS_RETRY_DELAYS_MS,
  statusRequestTimeoutMs = SIGNATURE_STATUS_TIMEOUT_MS,
}) => {
  const transactionSignature = getSubmittedTransactionSignature(submitted);
  let observedStatus = false;
  let signatureFound = false;
  let lastError = null;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const status = await readSubmittedTransactionStatus({
        umi,
        transactionSignature,
        statusRequestTimeoutMs,
      });
      observedStatus = true;
      if (status.kind !== "pending") {
        return status;
      }
      signatureFound ||= status.signatureFound;
    } catch (error) {
      lastError = error;
    }
  }
  return observedStatus
    ? { kind: "pending", signatureFound }
    : { kind: "unknown", error: lastError };
};

const sendAndConfirmSubmittedTransaction = async ({
  umi,
  submitted,
  statusRetryDelaysMs,
  confirmationTimeoutMs = CONFIRMATION_TIMEOUT_MS,
  sendTimeoutMs = SEND_TRANSACTION_TIMEOUT_MS,
  statusRequestTimeoutMs = SIGNATURE_STATUS_TIMEOUT_MS,
}) => {
  const transactionSignature = getSubmittedTransactionSignature(submitted);
  const { base58 } = loadSolanaDependencies();
  let sendError = null;
  try {
    const sentSignature = await waitForPromiseWithTimeout(
      umi.rpc.sendTransaction(submitted.signedTransaction, {
        skipPreflight: false,
        preflightCommitment: CONFIRMATION_COMMITMENT,
        maxRetries: 3,
      }),
      sendTimeoutMs,
    );
    const sentSignatureString = base58.deserialize(sentSignature)[0];
    if (sentSignatureString !== submitted.transactionSignature) {
      throw new HttpsError("internal", "Prize transaction signature mismatch.");
    }
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    sendError = error;
  }
  try {
    const confirmation = await waitForPromiseWithTimeout(
      umi.rpc.confirmTransaction(transactionSignature, {
        commitment: CONFIRMATION_COMMITMENT,
        strategy: {
          type: "blockhash",
          blockhash: submitted.blockhash,
          lastValidBlockHeight: submitted.lastValidBlockHeight,
        },
      }),
      confirmationTimeoutMs,
      "confirmation-timeout",
    );
    if (confirmation.value.err) {
      throw new DefinitiveSubmittedTransactionFailure("Prize transfer failed.");
    }
  } catch (error) {
    if (
      error instanceof HttpsError ||
      isDefinitiveSubmittedTransactionFailure(error)
    ) {
      throw error;
    }
    const status = await waitForSubmittedTransactionStatus({
      umi,
      submitted,
      retryDelaysMs: statusRetryDelaysMs,
      statusRequestTimeoutMs,
    });
    if (status.kind === "failed") {
      throw new DefinitiveSubmittedTransactionFailure("Prize transfer failed.");
    }
    if (status.kind !== "confirmed") {
      throw sendError || status.error || error;
    }
    console.info("event-prize-withdrawal-confirmation-reconciled", {
      transactionSignature: submitted.transactionSignature,
    });
  }
  if (sendError) {
    console.info("event-prize-withdrawal-send-reconciled", {
      transactionSignature: submitted.transactionSignature,
    });
  }
};

module.exports = {
  buildSubmittedTransaction,
  deserializePersistedSubmittedTransaction,
  getSubmittedTransactionSignature,
  isDefinitiveSubmittedTransactionFailure,
  sendAndConfirmSubmittedTransaction,
  waitForSubmittedTransactionStatus,
};
