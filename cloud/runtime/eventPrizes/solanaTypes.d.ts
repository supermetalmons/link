// Generated from src/eventPrizes/solanaTypes.ts. Run npm run generate:runtime.
import type {
  Transaction,
  TransactionBuilder,
  Umi,
} from "@metaplex-foundation/umi";
import type { EventPrizeStandard } from "@mons/shared/event-prizes";
import type {
  WithdrawalCompletionDependencies,
  WithdrawalData,
  SubmittedTransactionStatus,
} from "./types.js";
export type WithdrawalRuntimeDependencies = WithdrawalCompletionDependencies & {
  readProfileEventPrizeAssignment(
    profileId: string,
    eventId: string,
  ): Promise<WithdrawalData | null>;
  createEventPrizeUmi(standard: EventPrizeStandard): Umi;
  resolveWithdrawalProfileId(profileId: string): Promise<string>;
};
export type SubmittedTransaction = {
  signedTransaction: Transaction;
  transactionSignature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  persistedWithdrawal?: WithdrawalData;
};
export type PrizeAssetState = {
  assetOwner: string;
  blocked: boolean;
  message?: string;
  buildTransferBuilder?: () => Promise<TransactionBuilder>;
};
export type SubmittedInspection = {
  submitted: SubmittedTransaction;
  status: SubmittedTransactionStatus;
};
