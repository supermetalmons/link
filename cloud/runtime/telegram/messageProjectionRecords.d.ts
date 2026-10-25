// Generated from src/telegram/messageProjectionRecords.ts. Run npm run generate:runtime.
import type { TransactionDecision } from "../transactions.js";
import {
  type TelegramDesired,
  type TelegramEditDesired,
} from "./desiredStateCore.js";
import { type AutomatchTelegramProjection } from "./projectionCore.js";
import type { EventTelegramDesiredChange } from "./eventProjectionCore.js";
import {
  type TelegramAppliedDocument,
  type TelegramMessageDocument,
} from "./records.js";
export declare function replaceTelegramDesired(
  current: TelegramMessageDocument | null,
  desired: TelegramDesired,
): TelegramMessageDocument;
export declare function projectAutomatchMessage(
  current: TelegramMessageDocument | null,
  projection: AutomatchTelegramProjection,
  desired: TelegramDesired,
): TransactionDecision<TelegramMessageDocument>;
export declare function adoptTelegramReminder(
  current: TelegramMessageDocument | null,
  desired: TelegramEditDesired,
  chatId: string,
  confirmed: {
    messageId: number;
    appliedAtMs: number;
  },
): TransactionDecision<TelegramMessageDocument>;
export declare function projectEventMessage(
  current: TelegramMessageDocument | null,
  value: EventTelegramDesiredChange["value"],
  expectedGeneration: number,
  expectedApplied?: TelegramAppliedDocument,
): TransactionDecision<TelegramMessageDocument>;
