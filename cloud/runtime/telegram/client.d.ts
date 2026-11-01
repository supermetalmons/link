// Generated from src/telegram/client.ts. Run npm run generate:runtime.
export type TelegramFetch = (
  input: string,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;
type TelegramTransportOptions = {
  token?: string;
  fetchImpl?: TelegramFetch;
  timeoutMs?: number;
};
export type TelegramSendInput = TelegramTransportOptions & {
  chatId: string | number;
  text: string;
  parseMode?: string | null;
  silent?: boolean;
  disableWebPagePreview?: boolean;
};
export type TelegramEditInput = Omit<TelegramSendInput, "silent"> & {
  messageId: number;
};
export type TelegramDeleteInput = TelegramTransportOptions & {
  chatId: string | number;
  messageId: number;
};
export type TelegramMediaGroupInput = TelegramTransportOptions & {
  chatId: string | number;
  imageUrls: readonly string[];
  text: string;
  parseMode?: string | null;
  silent?: boolean;
  hasSpoiler?: boolean;
};
type RetainedTelegramSendInput = TelegramSendInput;
type RetainedTelegramEditInput = TelegramEditInput;
export type RetainedTelegramDeleteInput = TelegramDeleteInput;
type RetainedTelegramMediaGroupInput = TelegramMediaGroupInput;
export declare const retainTelegramDeleteInput: (
  value: TelegramDeleteInput,
) => TelegramDeleteInput;
export type TelegramFailure = {
  ok: false;
  classification: "missing" | "retryable" | "terminal" | "uncertain";
  code: string;
  description: string;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
};
type SuccessBase = {
  ok: true;
  httpStatus: number;
};
export type TelegramSendSuccess = SuccessBase & {
  outcome: "sent";
  messageId: number;
  messageIds?: never;
};
export type TelegramMediaGroupSuccess = SuccessBase & {
  outcome: "sent";
  messageIds: number[];
  messageId?: never;
};
export type TelegramEditSuccess = SuccessBase & {
  outcome: "edited" | "not-modified";
  messageId?: never;
  messageIds?: never;
};
export type TelegramDeleteSuccess = SuccessBase & {
  outcome: "deleted" | "not-found";
  messageId?: never;
  messageIds?: never;
};
export type TelegramSuccess =
  | TelegramSendSuccess
  | TelegramMediaGroupSuccess
  | TelegramEditSuccess
  | TelegramDeleteSuccess;
export type TelegramSendResult = TelegramFailure | TelegramSendSuccess;
export type TelegramMediaGroupResult =
  TelegramFailure | TelegramMediaGroupSuccess;
export type TelegramEditResult = TelegramFailure | TelegramEditSuccess;
type TelegramDeleteResult = TelegramFailure | TelegramDeleteSuccess;
export type TelegramResult = TelegramFailure | TelegramSuccess;
export type TelegramClient = {
  sendTelegramMessage(
    input: TelegramSendInput | RetainedTelegramSendInput,
  ): Promise<TelegramSendResult>;
  editTelegramMessage(
    input: TelegramEditInput | RetainedTelegramEditInput,
  ): Promise<TelegramEditResult>;
  deleteTelegramMessage(
    input: TelegramDeleteInput | RetainedTelegramDeleteInput,
  ): Promise<TelegramDeleteResult>;
};
declare const TELEGRAM_HTTP_TIMEOUT_MS = 10000;
declare const sendTelegramMessage: (
  input: TelegramSendInput | RetainedTelegramSendInput,
) => Promise<TelegramSendResult>;
declare const sendTelegramMediaGroup: (
  input: TelegramMediaGroupInput | RetainedTelegramMediaGroupInput,
) => Promise<TelegramMediaGroupResult>;
declare const editTelegramMessage: (
  input: TelegramEditInput | RetainedTelegramEditInput,
) => Promise<TelegramEditResult>;
declare const deleteTelegramMessage: (
  input: TelegramDeleteInput | RetainedTelegramDeleteInput,
) => Promise<TelegramDeleteResult>;
export {
  TELEGRAM_HTTP_TIMEOUT_MS,
  deleteTelegramMessage,
  editTelegramMessage,
  sendTelegramMediaGroup,
  sendTelegramMessage,
};
