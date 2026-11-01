// Generated from src/telegram/deliveryEngine.ts. Run npm run generate:runtime.
import { createTelegramLocalRetryBarrier } from "./deliveryPolicy.js";
import type {
  TelegramEngineOptions,
  TelegramEngineResult,
  TelegramReconcileInput,
} from "./deliveryTypes.js";
import { buildTelegramSendDesired } from "./desiredStateCore.js";
export type {
  TelegramEngineResult,
  TelegramRepository,
  TelegramRetryScheduler,
} from "./deliveryTypes.js";
declare const createTelegramDeliveryEngine: (input: TelegramEngineOptions) => {
  reconcile(input: TelegramReconcileInput): Promise<TelegramEngineResult>;
};
export {
  buildTelegramSendDesired,
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
};
