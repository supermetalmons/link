import { readProperty } from "./values.js";
export type TelegramFetch = (
  input: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type TelegramTransportOptions = {
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
declare const retainedTelegramRequest: unique symbol;
export type RetainedTelegramSendInput = {
  readonly [retainedTelegramRequest]: "send";
};
export type RetainedTelegramEditInput = {
  readonly [retainedTelegramRequest]: "edit";
};
export type RetainedTelegramDeleteInput = {
  readonly [retainedTelegramRequest]: "delete";
};
export type RetainedTelegramMediaGroupInput = {
  readonly [retainedTelegramRequest]: "send-media-group";
};
export const retainTelegramSendInput = (
  value: unknown,
): RetainedTelegramSendInput => value as RetainedTelegramSendInput;
export const retainTelegramEditInput = (
  value: unknown,
): RetainedTelegramEditInput => value as RetainedTelegramEditInput;
export const retainTelegramDeleteInput = (
  value: unknown,
): RetainedTelegramDeleteInput => value as RetainedTelegramDeleteInput;
export const retainTelegramMediaGroupInput = (
  value: unknown,
): RetainedTelegramMediaGroupInput => value as RetainedTelegramMediaGroupInput;

type RequestFields = {
  chatId?: unknown;
  messageId?: unknown;
  text?: unknown;
  parseMode?: unknown;
  silent?: unknown;
  disableWebPagePreview?: unknown;
  imageUrls?: unknown;
  hasSpoiler?: unknown;
  token?: unknown;
  fetchImpl?: TelegramFetch;
  timeoutMs?: number;
};
type RequestOptions = {
  token: unknown;
  fetchImpl?: TelegramFetch;
  timeoutMs?: number;
};
type MessageBody = {
  chat_id: unknown;
  text: unknown;
  disable_web_page_preview: unknown;
  parse_mode?: unknown;
};
type MediaItem = {
  type: "photo";
  media: string;
  has_spoiler?: true;
  caption?: unknown;
  parse_mode?: unknown;
};
type TelegramRequest = RequestOptions &
  (
    | {
        operation: "send-media-group";
        method: "sendMediaGroup";
        body: {
          chat_id: unknown;
          media: MediaItem[];
          disable_notification: unknown;
        };
      }
    | {
        operation: "send";
        method: "sendMessage";
        body: MessageBody & { disable_notification: unknown };
      }
    | {
        operation: "edit";
        method: "editMessageText";
        body: MessageBody & { message_id: unknown };
      }
    | {
        operation: "delete";
        method: "deleteMessage";
        body: { chat_id: unknown; message_id: unknown };
      }
  );
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
export type TelegramDeleteResult = TelegramFailure | TelegramDeleteSuccess;
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
const TELEGRAM_API_ROOT = "https://api.telegram.org";
const TELEGRAM_HTTP_TIMEOUT_MS = 10_000;
const TELEGRAM_SAFE_SEND_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizePositiveInteger = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const sanitizeDescription = (value: unknown, token: unknown): string => {
  const description = normalizeString(value);
  if (!description) {
    return "";
  }
  const normalizedToken = normalizeString(token);
  return (
    normalizedToken
      ? description.split(normalizedToken).join("[redacted]")
      : description
  ).slice(0, 500);
};

const parseRetryAfterSeconds = (data: unknown): number | null => {
  const value = readProperty(readProperty(data, "parameters"), "retry_after");
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : null;
};

const getTransportErrorCode = (error: unknown): string => {
  for (const value of [
    readProperty(error, "code"),
    readProperty(readProperty(error, "cause"), "code"),
  ]) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim().toUpperCase();
    }
  }
  return "";
};

const isKnownSafeTelegramSendError: (error: unknown) => boolean = (error) =>
  TELEGRAM_SAFE_SEND_ERROR_CODES.has(getTransportErrorCode(error));

const isSendOperation = (operation: string): boolean =>
  operation === "send" || operation === "send-media-group";

const isNotModifiedDescription = (description: string): boolean =>
  description.includes("message is not modified");

const isMissingDescription = (description: string): boolean =>
  description.includes("message to edit not found") ||
  description.includes("message to delete not found") ||
  description.includes("message not found");

const buildFailure = ({
  classification,
  code,
  description,
  httpStatus = null,
  retryAfterSeconds = null,
}: Omit<TelegramFailure, "ok" | "httpStatus" | "retryAfterSeconds"> & {
  httpStatus?: number | null;
  retryAfterSeconds?: number | null;
}): TelegramFailure => ({
  ok: false,
  classification,
  code,
  description,
  httpStatus,
  retryAfterSeconds,
});

function telegramRequest(
  input: TelegramRequest & { operation: "send" },
): Promise<TelegramSendResult>;
function telegramRequest(
  input: TelegramRequest & { operation: "send-media-group" },
): Promise<TelegramMediaGroupResult>;
function telegramRequest(
  input: TelegramRequest & { operation: "edit" },
): Promise<TelegramEditResult>;
function telegramRequest(
  input: TelegramRequest & { operation: "delete" },
): Promise<TelegramDeleteResult>;
async function telegramRequest({
  operation,
  method,
  body,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = TELEGRAM_HTTP_TIMEOUT_MS,
}: TelegramRequest): Promise<TelegramResult> {
  const normalizedToken = normalizeString(token);
  if (!normalizedToken) {
    return buildFailure({
      classification: "terminal",
      code: "missing-token",
      description: "Telegram bot token is not configured",
    });
  }
  if (typeof fetchImpl !== "function") {
    return buildFailure({
      classification: "terminal",
      code: "missing-fetch",
      description: "Fetch implementation is unavailable",
    });
  }

  const controller = new AbortController();
  const normalizedTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : TELEGRAM_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), normalizedTimeout);
  let response;
  try {
    response = await fetchImpl(
      `${TELEGRAM_API_ROOT}/bot${normalizedToken}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
  } catch (error) {
    clearTimeout(timer);
    const timedOut =
      controller.signal.aborted || readProperty(error, "name") === "AbortError";
    return buildFailure({
      classification:
        isSendOperation(operation) &&
        (timedOut || !isKnownSafeTelegramSendError(error))
          ? "uncertain"
          : "retryable",
      code: timedOut ? "timeout" : "network-error",
      description: sanitizeDescription(
        readProperty(error, "message"),
        normalizedToken,
      ),
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    clearTimeout(timer);
    if (response.status === 429) {
      return buildFailure({
        classification: "retryable",
        code: "rate-limited",
        description: "Telegram rate limit",
        httpStatus: response.status,
      });
    }
    return buildFailure({
      classification: isSendOperation(operation) ? "uncertain" : "retryable",
      code: "malformed-response",
      description: sanitizeDescription(
        readProperty(error, "message"),
        normalizedToken,
      ),
      httpStatus: response.status,
    });
  }
  clearTimeout(timer);

  const description = sanitizeDescription(
    readProperty(data, "description"),
    normalizedToken,
  );
  const normalizedDescription = description.toLowerCase();
  const telegramErrorCode = Number(readProperty(data, "error_code"));
  if (response.status === 429 || telegramErrorCode === 429) {
    return buildFailure({
      classification: "retryable",
      code: "rate-limited",
      description: description || "Telegram rate limit",
      httpStatus: response.status,
      retryAfterSeconds: parseRetryAfterSeconds(data),
    });
  }

  if (
    !data ||
    typeof data !== "object" ||
    typeof readProperty(data, "ok") !== "boolean"
  ) {
    return buildFailure({
      classification: isSendOperation(operation) ? "uncertain" : "retryable",
      code: "malformed-response",
      description: "Telegram returned an invalid response",
      httpStatus: response.status,
    });
  }

  const transientHttpStatus = response.status === 408 || response.status >= 500;
  const transientTelegramCode =
    telegramErrorCode === 408 || telegramErrorCode >= 500;
  if (transientHttpStatus || transientTelegramCode) {
    const code = transientHttpStatus
      ? `http-${response.status}`
      : `telegram-${telegramErrorCode}`;
    return buildFailure({
      classification: isSendOperation(operation) ? "uncertain" : "retryable",
      code,
      description: description || "Telegram transient failure",
      httpStatus: response.status,
    });
  }

  if (response.ok && data && readProperty(data, "ok") === true) {
    if (operation === "send-media-group") {
      const messageIds = Array.isArray(readProperty(data, "result"))
        ? (readProperty(data, "result") as unknown[]).map((message) =>
            normalizePositiveInteger(readProperty(message, "message_id")),
          )
        : [];
      if (
        messageIds.length !== body.media.length ||
        messageIds.some((messageId) => messageId === null)
      ) {
        return buildFailure({
          classification: "uncertain",
          code: "missing-message-id",
          description:
            "Telegram acknowledged media group send without all message IDs",
          httpStatus: response.status,
        });
      }
      return {
        ok: true,
        outcome: "sent",
        messageIds: messageIds as number[],
        httpStatus: response.status,
      };
    }
    if (operation === "send") {
      const messageId = normalizePositiveInteger(
        readProperty(readProperty(data, "result"), "message_id"),
      );
      if (!messageId) {
        return buildFailure({
          classification: "uncertain",
          code: "missing-message-id",
          description: "Telegram acknowledged send without a message ID",
          httpStatus: response.status,
        });
      }
      return {
        ok: true,
        outcome: "sent",
        messageId,
        httpStatus: response.status,
      };
    }
    return {
      ok: true,
      outcome: operation === "edit" ? "edited" : "deleted",
      httpStatus: response.status,
    };
  }

  if (operation === "edit" && isNotModifiedDescription(normalizedDescription)) {
    return {
      ok: true,
      outcome: "not-modified",
      httpStatus: response.status,
    };
  }
  if (isMissingDescription(normalizedDescription)) {
    if (operation === "delete") {
      return {
        ok: true,
        outcome: "not-found",
        httpStatus: response.status,
      };
    }
    return buildFailure({
      classification: "missing",
      code: "message-not-found",
      description: description || "Telegram message not found",
      httpStatus: response.status,
    });
  }

  return buildFailure({
    classification: "terminal",
    code:
      Number.isInteger(telegramErrorCode) && telegramErrorCode > 0
        ? `telegram-${telegramErrorCode}`
        : `http-${response.status}`,
    description: description || "Telegram rejected the request",
    httpStatus: response.status,
  });
}

const sendTelegramMessage: (
  input: TelegramSendInput | RetainedTelegramSendInput,
) => Promise<TelegramSendResult> = async ({
  chatId,
  text,
  parseMode = null,
  silent = false,
  disableWebPagePreview = true,
  token,
  fetchImpl,
  timeoutMs,
}: RequestFields & Partial<RetainedTelegramSendInput>) => {
  const body: MessageBody & { disable_notification: unknown } = {
    chat_id: chatId,
    text,
    disable_web_page_preview: disableWebPagePreview,
    disable_notification: silent,
  };
  if (parseMode) {
    body.parse_mode = parseMode;
  }
  return telegramRequest({
    operation: "send",
    method: "sendMessage",
    body,
    token,
    fetchImpl,
    timeoutMs,
  });
};

const sendTelegramMediaGroup: (
  input: TelegramMediaGroupInput | RetainedTelegramMediaGroupInput,
) => Promise<TelegramMediaGroupResult> = async ({
  chatId,
  imageUrls,
  text,
  hasSpoiler = false,
  parseMode = null,
  silent = false,
  token,
  fetchImpl,
  timeoutMs,
}: RequestFields & Partial<RetainedTelegramMediaGroupInput>) => {
  const normalizedImageUrls = Array.isArray(imageUrls)
    ? imageUrls.map(normalizeString)
    : [];
  if (
    normalizedImageUrls.length < 2 ||
    normalizedImageUrls.length > 10 ||
    normalizedImageUrls.some((imageUrl) => !imageUrl)
  ) {
    throw new TypeError("Telegram media groups require 2 to 10 image URLs");
  }
  return telegramRequest({
    operation: "send-media-group",
    method: "sendMediaGroup",
    body: {
      chat_id: chatId,
      media: normalizedImageUrls.map<MediaItem>((imageUrl, index) => ({
        type: "photo",
        media: imageUrl,
        ...(hasSpoiler ? { has_spoiler: true } : {}),
        ...(index === 0
          ? {
              caption: text,
              ...(parseMode ? { parse_mode: parseMode } : {}),
            }
          : {}),
      })),
      disable_notification: silent,
    },
    token,
    fetchImpl,
    timeoutMs,
  });
};

const editTelegramMessage: (
  input: TelegramEditInput | RetainedTelegramEditInput,
) => Promise<TelegramEditResult> = async ({
  chatId,
  messageId,
  text,
  parseMode = null,
  disableWebPagePreview = true,
  token,
  fetchImpl,
  timeoutMs,
}: RequestFields & Partial<RetainedTelegramEditInput>) => {
  const body: MessageBody & { message_id: unknown } = {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: disableWebPagePreview,
  };
  if (parseMode) {
    body.parse_mode = parseMode;
  }
  return telegramRequest({
    operation: "edit",
    method: "editMessageText",
    body,
    token,
    fetchImpl,
    timeoutMs,
  });
};

const deleteTelegramMessage: (
  input: TelegramDeleteInput | RetainedTelegramDeleteInput,
) => Promise<TelegramDeleteResult> = async ({
  chatId,
  messageId,
  token,
  fetchImpl,
  timeoutMs,
}: RequestFields & Partial<RetainedTelegramDeleteInput>) => {
  return telegramRequest({
    operation: "delete",
    method: "deleteMessage",
    body: {
      chat_id: chatId,
      message_id: messageId,
    },
    token,
    fetchImpl,
    timeoutMs,
  });
};

export {
  TELEGRAM_HTTP_TIMEOUT_MS,
  deleteTelegramMessage,
  editTelegramMessage,
  isKnownSafeTelegramSendError,
  sendTelegramMediaGroup,
  sendTelegramMessage,
};
