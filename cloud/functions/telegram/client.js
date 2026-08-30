"use strict";

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
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizePositiveInteger = (value) => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const sanitizeDescription = (value, token) => {
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

const parseRetryAfterSeconds = (data) => {
  const value = data?.parameters?.retry_after;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : null;
};

const getTransportErrorCode = (error) => {
  for (const value of [error?.code, error?.cause?.code]) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim().toUpperCase();
    }
  }
  return "";
};

const isKnownSafeTelegramSendError = (error) =>
  TELEGRAM_SAFE_SEND_ERROR_CODES.has(getTransportErrorCode(error));

const isSendOperation = (operation) =>
  operation === "send" || operation === "send-media-group";

const isNotModifiedDescription = (description) =>
  description.includes("message is not modified");

const isMissingDescription = (description) =>
  description.includes("message to edit not found") ||
  description.includes("message to delete not found") ||
  description.includes("message not found");

const buildFailure = ({
  classification,
  code,
  description,
  httpStatus = null,
  retryAfterSeconds = null,
}) => ({
  ok: false,
  classification,
  code,
  description,
  httpStatus,
  retryAfterSeconds,
});

const telegramRequest = async ({
  operation,
  method,
  body,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = TELEGRAM_HTTP_TIMEOUT_MS,
}) => {
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
    const timedOut = controller.signal.aborted || error?.name === "AbortError";
    return buildFailure({
      classification:
        isSendOperation(operation) &&
        (timedOut || !isKnownSafeTelegramSendError(error))
          ? "uncertain"
          : "retryable",
      code: timedOut ? "timeout" : "network-error",
      description: sanitizeDescription(error?.message, normalizedToken),
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
      description: sanitizeDescription(error?.message, normalizedToken),
      httpStatus: response.status,
    });
  }
  clearTimeout(timer);

  const description = sanitizeDescription(data?.description, normalizedToken);
  const normalizedDescription = description.toLowerCase();
  const telegramErrorCode = Number(data?.error_code);
  if (response.status === 429 || telegramErrorCode === 429) {
    return buildFailure({
      classification: "retryable",
      code: "rate-limited",
      description: description || "Telegram rate limit",
      httpStatus: response.status,
      retryAfterSeconds: parseRetryAfterSeconds(data),
    });
  }

  if (!data || typeof data !== "object" || typeof data.ok !== "boolean") {
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

  if (response.ok && data && data.ok === true) {
    if (operation === "send-media-group") {
      const messageIds = Array.isArray(data.result)
        ? data.result.map((message) =>
            normalizePositiveInteger(message?.message_id),
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
        messageIds,
        httpStatus: response.status,
      };
    }
    if (operation === "send") {
      const messageId = normalizePositiveInteger(data?.result?.message_id);
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
};

const sendTelegramMessage = async ({
  chatId,
  text,
  parseMode = null,
  silent = false,
  disableWebPagePreview = true,
  token,
  fetchImpl,
  timeoutMs,
}) => {
  const body = {
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

const sendTelegramMediaGroup = async ({
  chatId,
  imageUrls,
  text,
  hasSpoiler = false,
  silent = false,
  token,
  fetchImpl,
  timeoutMs,
}) => {
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
      media: normalizedImageUrls.map((imageUrl, index) => ({
        type: "photo",
        media: imageUrl,
        ...(hasSpoiler ? { has_spoiler: true } : {}),
        ...(index === 0 ? { caption: text } : {}),
      })),
      disable_notification: silent,
    },
    token,
    fetchImpl,
    timeoutMs,
  });
};

const editTelegramMessage = async ({
  chatId,
  messageId,
  text,
  parseMode = null,
  disableWebPagePreview = true,
  token,
  fetchImpl,
  timeoutMs,
}) => {
  const body = {
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

const deleteTelegramMessage = async ({
  chatId,
  messageId,
  token,
  fetchImpl,
  timeoutMs,
}) =>
  telegramRequest({
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

module.exports = {
  TELEGRAM_HTTP_TIMEOUT_MS,
  deleteTelegramMessage,
  editTelegramMessage,
  isKnownSafeTelegramSendError,
  sendTelegramMediaGroup,
  sendTelegramMessage,
};
