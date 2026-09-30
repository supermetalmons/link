// Generated from src/telegram/client.ts. Run npm run generate:runtime.
export type TelegramFetch = (
  input: string,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;
export type TelegramMessageInput = Record<string, unknown> & {
  fetchImpl?: TelegramFetch;
  timeoutMs?: number;
};
export type TelegramFailure = {
  ok: false;
  classification: "missing" | "retryable" | "terminal" | "uncertain";
  code: string;
  description: string;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
};
export type TelegramSuccess = {
  ok: true;
  outcome: "deleted" | "edited" | "not-found" | "not-modified" | "sent";
  httpStatus: number;
  messageId?: number;
  messageIds?: number[];
};
export type TelegramResult = TelegramFailure | TelegramSuccess;
export type TelegramClient = {
  sendTelegramMessage(input: TelegramMessageInput): Promise<TelegramResult>;
  editTelegramMessage(input: TelegramMessageInput): Promise<TelegramResult>;
  deleteTelegramMessage(input: TelegramMessageInput): Promise<TelegramResult>;
};
declare const TELEGRAM_HTTP_TIMEOUT_MS = 10000;
declare const isKnownSafeTelegramSendError: (error: unknown) => boolean;
declare const sendTelegramMessage: (
  input: TelegramMessageInput,
) => Promise<TelegramResult>;
declare const sendTelegramMediaGroup: (
  input: TelegramMessageInput,
) => Promise<TelegramResult>;
declare const editTelegramMessage: (
  input: TelegramMessageInput,
) => Promise<TelegramResult>;
declare const deleteTelegramMessage: (
  input: TelegramMessageInput,
) => Promise<TelegramResult>;
export {
  TELEGRAM_HTTP_TIMEOUT_MS,
  deleteTelegramMessage,
  editTelegramMessage,
  isKnownSafeTelegramSendError,
  sendTelegramMediaGroup,
  sendTelegramMessage,
};
