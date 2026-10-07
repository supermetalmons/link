// Generated from src/telegram/deliveryEngine.ts. Run npm run generate:runtime.
import {
  TELEGRAM_SAFE_RETRY_MAX_DELAY_MS,
  TELEGRAM_SAFE_RETRY_WINDOW_MS,
  createTelegramLocalRetryBarrier,
} from "./deliveryPolicy.js";
import type {
  TelegramEngineOptions,
  TelegramEngineResult,
  TelegramReconcileInput,
} from "./deliveryTypes.js";
import {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_MESSAGE_ROOT,
  TELEGRAM_SCHEMA_VERSION,
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  resolveTelegramDestination,
  validateTelegramMessageKey,
} from "./desiredStateCore.js";
import { TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND } from "./taskKinds.js";
export type {
  TelegramApiGateResult,
  TelegramEngineOptions,
  TelegramEngineResult,
  TelegramReconcileInput,
  TelegramRepository,
  TelegramRetrySchedule,
  TelegramRetryScheduler,
} from "./deliveryTypes.js";
declare const TELEGRAM_LEASE_TTL_MS = 60000;
declare const createTelegramDeliveryEngine: (input: TelegramEngineOptions) => {
  reconcile(input: TelegramReconcileInput): Promise<TelegramEngineResult>;
};
export {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_LEASE_TTL_MS,
  TELEGRAM_MESSAGE_ROOT,
  TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
  TELEGRAM_SAFE_RETRY_MAX_DELAY_MS,
  TELEGRAM_SAFE_RETRY_WINDOW_MS,
  TELEGRAM_SCHEMA_VERSION,
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
  resolveTelegramDestination,
  validateTelegramMessageKey,
};
