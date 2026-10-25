// Generated from src/eventPrizes/submissionRecovery.ts. Run npm run generate:runtime.
import type { WithdrawalDocument } from "./records.js";
import type { Umi } from "@metaplex-foundation/umi";
import type {
  SubmittedTransaction,
  SubmittedInspection,
  PrizeAssetState,
} from "./solanaTypes.js";
type SubmittedRecoveryInput = {
  umi: Umi;
  withdrawal: WithdrawalDocument;
  assetOwner: string;
  recipientAddress: string;
  inspection?: SubmittedInspection | null;
  statusRetryDelaysMs?: readonly number[];
};
type SubmittedRecoveryResult =
  | {
      kind: "completed";
      submitted: SubmittedTransaction;
    }
  | {
      kind: "blocked";
      submitted: SubmittedTransaction;
    }
  | {
      kind: "retry";
      discardPersistedSubmission: boolean;
      submitted: SubmittedTransaction;
    };
declare const inspectSubmittedWithdrawal: ({
  umi,
  withdrawal,
}: {
  umi: Umi;
  withdrawal: WithdrawalDocument;
}) => Promise<SubmittedInspection>;
declare const recoverSubmittedWithdrawal: ({
  umi,
  withdrawal,
  assetOwner,
  recipientAddress,
  inspection,
  statusRetryDelaysMs,
}: SubmittedRecoveryInput) => Promise<SubmittedRecoveryResult>;
declare const reconcileSubmittedAssetState: ({
  umi,
  withdrawal,
  assetState,
  recipientAddress,
  inspection,
  statusRetryDelaysMs,
}: Omit<SubmittedRecoveryInput, "assetOwner"> & {
  assetState: PrizeAssetState;
}) => Promise<{
  kind: "completed" | "blocked" | "discard" | "retry" | "resume";
  assetOwner: string;
  submitted: SubmittedTransaction;
}>;
export {
  inspectSubmittedWithdrawal,
  reconcileSubmittedAssetState,
  recoverSubmittedWithdrawal,
};
