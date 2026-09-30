import type { Umi } from "@metaplex-foundation/umi";
import type { WithdrawalData } from "./types.js";
import type {
  SubmittedTransaction,
  SubmittedInspection,
  PrizeAssetState,
} from "./solanaTypes.js";

import { EventPrizeWithdrawalError as HttpsError } from "./errors.js";
import {
  EVENT_PRIZE_ADMIN_WALLET,
  normalizeSolanaAddress,
} from "../eventPrizeWithdrawalState.js";
import { createPrizeAssetVerificationError } from "./assets.js";
import {
  CONFIRMATION_COMMITMENT,
  TRANSACTION_STATUS_RETRY_DELAYS_MS,
} from "./solana.js";
import {
  deserializePersistedSubmittedTransaction,
  waitForSubmittedTransactionStatus,
} from "./submittedTransactions.js";

type SubmittedRecoveryInput = {
  umi: Umi;
  withdrawal: WithdrawalData;
  assetOwner: string;
  recipientAddress: string;
  inspection?: SubmittedInspection | null;
  statusRetryDelaysMs?: readonly number[];
};
type SubmittedRecoveryResult =
  | { kind: "completed"; submitted: SubmittedTransaction }
  | { kind: "blocked"; submitted: SubmittedTransaction }
  | {
      kind: "retry";
      discardPersistedSubmission: boolean;
      submitted: SubmittedTransaction;
    };

const getCurrentBlockHeight = async (umi: Umi): Promise<number> => {
  const blockHeight = await umi.rpc.call<number>("getBlockHeight", [
    { commitment: CONFIRMATION_COMMITMENT },
  ]);
  if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
    throw new Error("Solana RPC returned an invalid block height.");
  }
  return blockHeight;
};

const inspectSubmittedWithdrawal = async ({
  umi,
  withdrawal,
}: {
  umi: Umi;
  withdrawal: WithdrawalData;
}): Promise<SubmittedInspection> => {
  const submitted = deserializePersistedSubmittedTransaction(umi, withdrawal);
  if (!submitted) {
    throw new HttpsError(
      "internal",
      "The submitted prize transaction is unavailable.",
    );
  }
  const status = await waitForSubmittedTransactionStatus({
    umi,
    submitted,
    retryDelaysMs: [0],
  });
  return { submitted, status };
};

const recoverSubmittedWithdrawal = async ({
  umi,
  withdrawal,
  assetOwner,
  recipientAddress,
  inspection,
  statusRetryDelaysMs = TRANSACTION_STATUS_RETRY_DELAYS_MS,
}: SubmittedRecoveryInput): Promise<SubmittedRecoveryResult> => {
  const submittedInspection =
    inspection || (await inspectSubmittedWithdrawal({ umi, withdrawal }));
  const { submitted } = submittedInspection;
  let { status } = submittedInspection;
  if (status.kind === "confirmed") {
    return { kind: "completed", submitted };
  }
  if (status.kind === "failed") {
    return assetOwner === EVENT_PRIZE_ADMIN_WALLET
      ? { kind: "retry", discardPersistedSubmission: true, submitted }
      : { kind: "blocked", submitted };
  }
  if (assetOwner === recipientAddress) {
    return { kind: "completed", submitted };
  }
  if (assetOwner === EVENT_PRIZE_ADMIN_WALLET) {
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
    status = await waitForSubmittedTransactionStatus({
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

const reconcileSubmittedAssetState = async ({
  umi,
  withdrawal,
  assetState,
  recipientAddress,
  inspection,
  statusRetryDelaysMs,
}: Omit<SubmittedRecoveryInput, "assetOwner"> & {
  assetState: PrizeAssetState;
}): Promise<{
  kind: "completed" | "blocked" | "discard" | "retry" | "resume";
  assetOwner: string;
  submitted: SubmittedTransaction;
}> => {
  const assetOwner = normalizeSolanaAddress(assetState.assetOwner);
  if (!assetOwner) {
    throw createPrizeAssetVerificationError(
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
  const finalStatus = await waitForSubmittedTransactionStatus({
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

export {
  inspectSubmittedWithdrawal,
  reconcileSubmittedAssetState,
  recoverSubmittedWithdrawal,
};
