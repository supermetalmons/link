// Generated from src/eventPrizes/withdrawalOrchestrator.ts. Run npm run generate:runtime.
import type { WithdrawalData } from "./types.js";
import type { WithdrawalRuntimeDependencies } from "./solanaTypes.js";
export type WithdrawalCompletedResponse = {
  ok: true;
  status: "completed";
  eventId: string;
  prizeId: string;
  assetAddress: string;
  recipientAddress: string;
  transactionSignature: string;
};
declare const validatePrizeAssignment: ({
  assignment,
  eventId,
  prizeId,
  profileId,
}: {
  assignment: WithdrawalData | null | undefined;
  eventId: string;
  prizeId: string;
  profileId: string;
}) => number;
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
