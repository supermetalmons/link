// Generated from src/transactions.ts. Run npm run generate:runtime.
export type TransactionDecision<T> =
  | {
      commit: false;
      decision?: string;
    }
  | {
      value: T | null;
      decision?: string;
    };
export type TransactionResult<T> = {
  committed: boolean;
  decision?: string;
  value: T | null;
};
