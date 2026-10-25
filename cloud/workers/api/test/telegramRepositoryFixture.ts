import {
  readTelegramMessageDocument,
  readTelegramControlDocument,
  type TelegramControlDocument,
} from "../../../runtime/telegram/records.js";
import type { TransactionResult } from "../../../runtime/transactions.js";
import {
  createTelegramRepository,
  type TelegramTransactionResult,
} from "../../../runtime/telegram/repositoryCore.js";

export function telegramRepositoryFixture(storage: {
  getPath(path: string): Promise<unknown>;
  transactPath(
    path: string,
    updater: (current: unknown) => unknown,
  ): Promise<{ committed: boolean; decision?: string; value: unknown }>;
}) {
  return createTelegramRepository({
    readMessage: async (key) =>
      readTelegramMessageDocument(
        await storage.getPath(`telegramMessages/${key}`),
      ),
    transactMessage: async (key, updater) =>
      (await storage.transactPath(`telegramMessages/${key}`, (current) =>
        updater(readTelegramMessageDocument(current)),
      )) as TelegramTransactionResult,
    readControl: async () =>
      readTelegramControlDocument(
        await storage.getPath("telegramDeliveryControl"),
      ),
    transactControl: async (updater) =>
      (await storage.transactPath("telegramDeliveryControl", (current) =>
        updater(readTelegramControlDocument(current)),
      )) as TransactionResult<TelegramControlDocument>,
  });
}
