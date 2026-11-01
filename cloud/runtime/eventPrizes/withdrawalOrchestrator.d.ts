// Generated from src/eventPrizes/withdrawalOrchestrator.ts. Run npm run generate:runtime.
import type { WithdrawalRuntimeDependencies } from "./solanaTypes.js";
import { validatePrizeAssignment } from "./assignmentValidation.js";
type WithdrawalCompletedResponse = {
  ok: true;
  status: "completed";
  eventId: string;
  prizeId: string;
  assetAddress: string;
  recipientAddress: string;
  transactionSignature: string;
};
declare const handleWithdrawEventPrize: (
  request: {
    auth?: {
      uid: string;
    } | null;
    data?: unknown;
  },
  dependencies: WithdrawalRuntimeDependencies,
) => Promise<WithdrawalCompletedResponse>;
export { handleWithdrawEventPrize, validatePrizeAssignment };
