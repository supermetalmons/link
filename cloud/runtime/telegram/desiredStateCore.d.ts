// Generated from src/telegram/desiredStateCore.ts. Run npm run generate:runtime.
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
export type TelegramDesiredInput =
  | TelegramSendDesiredInput
  | TelegramEditDesiredInput
  | TelegramDeleteDesiredInput;
type DesiredIdentity = {
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
export type TelegramDeleteDesired = DesiredIdentity & {
  operation: "delete";
};
export type TelegramDesired =
  TelegramSendDesired | TelegramEditDesired | TelegramDeleteDesired;
declare const TELEGRAM_MESSAGE_ROOT = "telegramMessages";
declare const TELEGRAM_SCHEMA_VERSION = 2;
declare const TELEGRAM_DESTINATIONS: Readonly<{
  community: "community";
  events: "events";
}>;
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
  TELEGRAM_DESTINATIONS,
  TELEGRAM_MESSAGE_ROOT,
  TELEGRAM_SCHEMA_VERSION,
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  resolveTelegramDestination,
  validateTelegramMessageKey,
};
