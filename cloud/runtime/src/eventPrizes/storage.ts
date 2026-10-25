import type {
  TransactionDecision,
  TransactionResult,
} from "../transactions.js";
import type { WithdrawalDocument } from "./records.js";

export type WithdrawalRecordStorage = {
  read(): Promise<WithdrawalDocument | null>;
  transaction(
    update: (
      current: WithdrawalDocument | null,
    ) => TransactionDecision<WithdrawalDocument>,
  ): Promise<TransactionResult<WithdrawalDocument>>;
};

export type WithdrawalStorage = {
  get(eventId: string, prizeId: string): Promise<WithdrawalDocument | null>;
  record(eventId: string, prizeId: string): WithdrawalRecordStorage;
  replaceRecords(
    records: readonly {
      eventId: string;
      prizeId: string;
      value: WithdrawalDocument | null;
    }[],
  ): Promise<void>;
};
