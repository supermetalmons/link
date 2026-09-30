import type {
  TransactionDecision,
  TransactionResult,
} from "../transactions.js";

export type WithdrawalData = Record<string, unknown>;

export type WithdrawalRecord = {
  read(): Promise<WithdrawalData | null>;
  transaction(
    update: (
      current: WithdrawalData | null,
    ) => TransactionDecision<WithdrawalData>,
  ): Promise<TransactionResult<WithdrawalData>>;
};

export type WithdrawalStore = {
  record(eventId: string, prizeId: string): WithdrawalRecord;
  replaceRecords(
    records: readonly {
      eventId: string;
      prizeId: string;
      value: WithdrawalData | null;
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
    ): Promise<{ id: unknown } | null>;
    now?: () => number;
  };

export type WithdrawalCompletionInput = {
  withdrawal: WithdrawalData;
  profileId: string;
  eventId: string;
  prizeId: string;
  assetAddress: string;
  recipientAddress: string;
  transactionSignature: string;
};

export type SubmittedTransactionStatus =
  | { kind: "pending"; signatureFound: boolean; error?: never }
  | { kind: "failed"; error: unknown }
  | { kind: "confirmed"; error?: never }
  | { kind: "unknown"; error: unknown };
