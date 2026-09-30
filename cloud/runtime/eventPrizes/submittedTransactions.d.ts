// Generated from src/eventPrizes/submittedTransactions.ts. Run npm run generate:runtime.
import type {
  Umi,
  TransactionBuilder,
  TransactionSignature,
} from "@metaplex-foundation/umi";
import type {
  WithdrawalData,
  WithdrawalRecord,
  SubmittedTransactionStatus,
} from "./types.js";
import type { SubmittedTransaction } from "./solanaTypes.js";
declare class DefinitiveSubmittedTransactionFailure extends Error {}
declare const isDefinitiveSubmittedTransactionFailure: (
  error: unknown,
) => error is DefinitiveSubmittedTransactionFailure;
declare const deserializePersistedSubmittedTransaction: (
  umi: Umi,
  withdrawal: WithdrawalData | null | undefined,
) => SubmittedTransaction | null;
declare const buildSubmittedTransaction: ({
  umi,
  builder,
  withdrawalRecord,
  leaseId,
}: {
  umi: Umi;
  builder: TransactionBuilder;
  withdrawalRecord: WithdrawalRecord;
  leaseId: string;
}) => Promise<
  SubmittedTransaction & {
    persistedWithdrawal: WithdrawalData;
  }
>;
declare const getSubmittedTransactionSignature: (
  submitted: SubmittedTransaction,
) => TransactionSignature;
declare const waitForSubmittedTransactionStatus: ({
  umi,
  submitted,
  retryDelaysMs,
  statusRequestTimeoutMs,
}: {
  umi: Umi;
  submitted: SubmittedTransaction;
  retryDelaysMs?: readonly number[];
  statusRequestTimeoutMs?: number;
}) => Promise<SubmittedTransactionStatus>;
declare const sendAndConfirmSubmittedTransaction: ({
  umi,
  submitted,
  statusRetryDelaysMs,
  confirmationTimeoutMs,
  sendTimeoutMs,
  statusRequestTimeoutMs,
}: {
  umi: Umi;
  submitted: SubmittedTransaction;
  statusRetryDelaysMs?: readonly number[];
  confirmationTimeoutMs?: number;
  sendTimeoutMs?: number;
  statusRequestTimeoutMs?: number;
}) => Promise<void>;
export {
  buildSubmittedTransaction,
  deserializePersistedSubmittedTransaction,
  getSubmittedTransactionSignature,
  isDefinitiveSubmittedTransactionFailure,
  sendAndConfirmSubmittedTransaction,
  waitForSubmittedTransactionStatus,
};
