// Generated from src/telegram/deliveryRetryCoordinator.ts. Run npm run generate:runtime.
import type {
  TelegramRetryDependencies,
  TelegramRetryInput,
  TelegramRetryResult,
} from "./deliveryRetryTypes.js";
declare const createTelegramRetryCoordinator: (
  dependencies: TelegramRetryDependencies,
) => {
  finish(input: TelegramRetryInput): Promise<TelegramRetryResult>;
};
export { createTelegramRetryCoordinator };
