import type { TelegramRepository } from "./deliveryEngine.js";

export type TelegramTransactionResult = {
  committed: boolean;
  decision?: string;
  value: unknown;
};

export function createTelegramRepository(input: {
  getPath(path: string): Promise<unknown>;
  transactPath(
    path: string,
    updater: (current: unknown) => unknown,
  ): Promise<TelegramTransactionResult>;
}): TelegramRepository;

export const TELEGRAM_DELIVERY_CONTROL_ROOT: string;
