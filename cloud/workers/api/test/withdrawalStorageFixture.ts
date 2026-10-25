import { createD1EventPrizeWithdrawalStorage } from "../src/eventPrizeWithdrawalD1.ts";
import {
  readWithdrawalDocument,
  type WithdrawalDocument,
} from "../../../runtime/eventPrizes/records.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../../../runtime/transactions.js";

type RawWithdrawal = Record<string, unknown>;

export function withdrawalFixture(value: RawWithdrawal): WithdrawalDocument {
  const document = readWithdrawalDocument(value);
  if (!document) throw new TypeError("invalid-withdrawal-fixture");
  return document;
}

function raw(value: WithdrawalDocument | null): RawWithdrawal | null {
  return value as object as RawWithdrawal | null;
}

export function createWithdrawalStorageFixture(
  db: D1Database,
  options: { now?: () => number } = {},
) {
  const storage = createD1EventPrizeWithdrawalStorage(db, options);
  return {
    async get(eventId: string, prizeId: string) {
      return raw(await storage.get(eventId, prizeId));
    },
    record(eventId: string, prizeId: string) {
      const reference = storage.record(eventId, prizeId);
      return {
        async read() {
          return raw(await reference.read());
        },
        async transaction(
          updater: (
            current: RawWithdrawal | null,
          ) => TransactionDecision<RawWithdrawal>,
        ): Promise<TransactionResult<RawWithdrawal>> {
          const result = await reference.transaction((current) => {
            const decision = updater(raw(current));
            return "commit" in decision
              ? decision
              : {
                  ...decision,
                  value:
                    decision.value === null
                      ? null
                      : withdrawalFixture(decision.value),
                };
          });
          return { ...result, value: raw(result.value) };
        },
      };
    },
    replaceRecords(
      records: readonly {
        eventId: string;
        prizeId: string;
        value: RawWithdrawal | null;
      }[],
    ) {
      return storage.replaceRecords(
        records.map((record) => ({
          ...record,
          value: record.value === null ? null : withdrawalFixture(record.value),
        })),
      );
    },
  };
}
