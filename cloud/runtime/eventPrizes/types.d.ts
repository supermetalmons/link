// Generated from src/eventPrizes/types.ts. Run npm run generate:runtime.
import type { TransactionResult } from "../transactions.js";
import type { WithdrawalClaimInput } from "../eventPrizeWithdrawalState.js";
import type {
  CompletedWithdrawalDocument,
  WithdrawalDocument,
  WithdrawalSubmissionEvidence,
} from "./records.js";
export type WithdrawalClaimCommand = Omit<
  WithdrawalClaimInput,
  "current" | "nowMs"
>;
export type WithdrawalTransactionResult = TransactionResult<WithdrawalDocument>;
export type WithdrawalRecord = {
  read(): Promise<WithdrawalDocument | null>;
  claim(input: WithdrawalClaimCommand): Promise<WithdrawalTransactionResult>;
  releaseProcessing(leaseId: string): Promise<WithdrawalTransactionResult>;
  block(input: {
    leaseId: string;
    observedOwner: string;
  }): Promise<WithdrawalTransactionResult>;
  persistSubmission(
    input: WithdrawalSubmissionEvidence & {
      leaseId: string;
    },
  ): Promise<WithdrawalTransactionResult>;
  discardSubmission(input: {
    leaseId: string;
    transactionSignature: string;
  }): Promise<WithdrawalTransactionResult>;
};
export type WithdrawalStore = {
  get(eventId: string, prizeId: string): Promise<WithdrawalDocument | null>;
  record(eventId: string, prizeId: string): WithdrawalRecord;
  replaceCompleted(
    records: readonly {
      eventId: string;
      prizeId: string;
      value: CompletedWithdrawalDocument;
    }[],
  ): Promise<void>;
};
export type WithdrawalProjectionDependencies = {
  removeMatchingProfileEventPrizeAssignment(input: {
    profileId: string;
    eventId: string;
    prizeId: string;
  }): Promise<boolean>;
  resolveCanonicalProfilePath(profileId: string): Promise<string[]>;
};
export type WithdrawalCompletionDependencies =
  WithdrawalProjectionDependencies & {
    withdrawals: WithdrawalStore;
    readProfileByLoginUid(
      uid: string,
      fields?: readonly string[],
    ): Promise<{
      id: string;
    } | null>;
    now?: () => number;
  };
export type WithdrawalCompletionInput = {
  withdrawal: WithdrawalDocument;
  profileId: string;
  eventId: string;
  prizeId: string;
  assetAddress: string;
  recipientAddress: string;
  transactionSignature: string;
};
export type SubmittedTransactionStatus =
  | {
      kind: "pending";
      signatureFound: boolean;
      error?: never;
    }
  | {
      kind: "failed";
      error: unknown;
    }
  | {
      kind: "confirmed";
      error?: never;
    }
  | {
      kind: "unknown";
      error: unknown;
    };
