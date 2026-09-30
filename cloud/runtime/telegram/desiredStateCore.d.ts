// Generated from src/telegram/desiredStateCore.ts. Run npm run generate:runtime.
export type TelegramDesiredInput = {
  destination?: unknown;
  instanceKey?: unknown;
  text?: unknown;
  parseMode?: unknown;
  silent?: unknown;
  sourceRevision?: unknown;
  ifMissing?: unknown;
};
export type TelegramDesired = {
  schemaVersion: number;
  operation: "send" | "edit" | "delete";
  destination: "community" | "events";
  revision: string;
  sourceRevision: string;
  contentHash?: string;
  instanceKey?: string;
  text?: string;
  parseMode?: "HTML";
  silent?: boolean;
  disableWebPagePreview?: boolean;
  ifMissing?: "send" | "skip";
};
declare const TELEGRAM_MESSAGE_ROOT = "telegramMessages";
declare const TELEGRAM_SCHEMA_VERSION = 2;
declare const TELEGRAM_DESTINATIONS: Readonly<{
  community: "community";
  events: "events";
}>;
declare const validateTelegramMessageKey: (messageKey: unknown) => string;
declare const buildTelegramSendDesired: (
  input: TelegramDesiredInput,
) => TelegramDesired;
declare const buildTelegramEditDesired: (
  input: TelegramDesiredInput,
) => TelegramDesired;
declare const buildTelegramDeleteDesired: (
  input: TelegramDesiredInput,
) => TelegramDesired;
declare const resolveTelegramDestination: (
  destination: unknown,
  environment?: Record<string, string | undefined>,
) => string;
export {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_MESSAGE_ROOT,
  TELEGRAM_SCHEMA_VERSION,
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  resolveTelegramDestination,
  validateTelegramMessageKey,
};
