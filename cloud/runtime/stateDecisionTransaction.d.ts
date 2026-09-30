// Generated from src/stateDecisionTransaction.ts. Run npm run generate:runtime.
import type { TransactionDecision } from "./transactions.js";
export type StateTransactionReference<T> = {
  transaction(update: (current: T | null | undefined) => T | null): Promise<
    | {
        committed?: boolean;
        value?: T | null;
      }
    | null
    | undefined
  >;
};
export declare const runStateDecisionTransaction: <T>(
  reference: StateTransactionReference<T>,
  decide: (current: T | null) => TransactionDecision<T>,
) => Promise<{
  committed: boolean;
  storageCommitted: boolean;
  decision: string | undefined;
  value: NonNullable<T> | null;
}>;
