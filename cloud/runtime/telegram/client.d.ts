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
  sendTelegramMessage(input: Record<string, unknown>): Promise<TelegramResult>;
  editTelegramMessage(input: Record<string, unknown>): Promise<TelegramResult>;
  deleteTelegramMessage(
    input: Record<string, unknown>,
  ): Promise<TelegramResult>;
};

export const TELEGRAM_HTTP_TIMEOUT_MS: number;
export function sendTelegramMessage(
  input: Record<string, unknown>,
): Promise<TelegramResult>;
export function sendTelegramMediaGroup(
  input: Record<string, unknown>,
): Promise<TelegramResult>;
export function editTelegramMessage(
  input: Record<string, unknown>,
): Promise<TelegramResult>;
export function deleteTelegramMessage(
  input: Record<string, unknown>,
): Promise<TelegramResult>;
export function isKnownSafeTelegramSendError(error: unknown): boolean;
