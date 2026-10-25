import type {
  TransactionDecision,
  TransactionResult,
} from "../../../runtime/transactions.js";
import type {
  EventD1Connection,
  EventTransactionOptions,
} from "../src/eventD1/types.ts";
import {
  transactEventProfileGameProjectionOutbox,
  transactEventTelegramProjectionOutbox,
} from "../src/eventD1/transactions.ts";

type LegacyOutboxTransaction = (
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: Record<string, unknown> | null,
  ) => TransactionDecision<Record<string, unknown>>,
  options: EventTransactionOptions,
) => Promise<TransactionResult<Record<string, unknown>>>;
export const transactProfileProjectionFixture: LegacyOutboxTransaction = (
  ...args
) => Reflect.apply(transactEventProfileGameProjectionOutbox, undefined, args);
export const transactTelegramProjectionFixture: LegacyOutboxTransaction = (
  ...args
) => Reflect.apply(transactEventTelegramProjectionOutbox, undefined, args);
