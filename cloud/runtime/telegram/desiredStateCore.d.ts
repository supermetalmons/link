// Generated from src/telegram/desiredStateCore.ts. Run npm run generate:runtime.
import type { EventTelegramProjectionGuard } from "./eventProjectionRecords.js";
export type TelegramSendDesiredInput = {
  destination: string;
  instanceKey: string;
  text: string;
  sourceRevision: string | number;
  parseMode?: "HTML" | null | "";
  silent?: boolean;
};
export type TelegramEditDesiredInput = TelegramSendDesiredInput & {
  ifMissing?: "send" | "skip";
};
export type TelegramDeleteDesiredInput = {
  destination: string;
  sourceRevision: string | number;
};
type DesiredIdentity = {
  eventTelegramProjectionGuard?: EventTelegramProjectionGuard & {
    messageKey: string;
  };
  schemaVersion: 2;
  destination: "community" | "events";
  revision: string;
  sourceRevision: string;
};
type TextDesired = DesiredIdentity & {
  contentHash: string;
  instanceKey: string;
  text: string;
  parseMode?: "HTML";
  silent: boolean;
  disableWebPagePreview: true;
};
export type TelegramSendDesired = TextDesired & {
  operation: "send";
};
export type TelegramEditDesired = TextDesired & {
  operation: "edit";
  ifMissing: "send" | "skip";
};
type TelegramDeleteDesired = DesiredIdentity & {
  operation: "delete";
};
export type TelegramDesired =
  TelegramSendDesired | TelegramEditDesired | TelegramDeleteDesired;
declare const TELEGRAM_MESSAGE_ROOT = "telegramMessages";
declare const validateTelegramMessageKey: (messageKey: unknown) => string;
declare const buildTelegramSendDesired: (
  input: TelegramSendDesiredInput,
) => TelegramSendDesired;
declare const buildTelegramEditDesired: (
  input: TelegramEditDesiredInput,
) => TelegramEditDesired;
declare const buildTelegramDeleteDesired: (
  input: TelegramDeleteDesiredInput,
) => TelegramDeleteDesired;
declare const resolveTelegramDestination: (
  destination: unknown,
  environment?: Record<string, string | undefined>,
) => string;
export {
  TELEGRAM_MESSAGE_ROOT,
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  resolveTelegramDestination,
  validateTelegramMessageKey,
};
