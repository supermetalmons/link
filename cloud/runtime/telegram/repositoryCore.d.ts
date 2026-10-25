// Generated from src/telegram/repositoryCore.ts. Run npm run generate:runtime.
import type { TelegramRepository } from "./deliveryEngine.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../transactions.js";
import {
  type TelegramControlDocument,
  type TelegramMessageDocument,
} from "./records.js";
export type TelegramStoredRecord = TelegramMessageDocument;
export type TelegramTransactionResult = TransactionResult<TelegramStoredRecord>;
export type TelegramStorage = {
  readMessage(messageKey: string): Promise<TelegramStoredRecord | null>;
  transactMessage(
    messageKey: string,
    updater: (
      current: TelegramStoredRecord | null,
    ) => TransactionDecision<TelegramStoredRecord>,
  ): Promise<TelegramTransactionResult>;
  readControl(): Promise<TelegramControlDocument | null>;
  transactControl(
    updater: (
      current: TelegramControlDocument | null,
    ) => TransactionDecision<TelegramControlDocument>,
  ): Promise<TransactionResult<TelegramControlDocument>>;
};
declare const createTelegramRepository: (
  input: TelegramStorage,
) => TelegramRepository;
export { createTelegramRepository };
