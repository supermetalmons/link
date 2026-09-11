"use strict";

const { createHmac } = require("node:crypto");
const TELEGRAM_COMMAND_BRIDGE_URL =
  "https://api.mons.link/internal/telegram/command";
const TELEGRAM_BRIDGE_TIMEOUT_MS = 5_000;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const signTelegramBridgeRequest = ({ body, secret, timestamp }) =>
  createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("base64url");

const sendTelegramCommand = async (
  command,
  {
    bridgeUrl = TELEGRAM_COMMAND_BRIDGE_URL,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    secret = "",
    timeoutMs = TELEGRAM_BRIDGE_TIMEOUT_MS,
  } = {},
) => {
  const normalizedSecret = normalizeString(secret);
  if (!normalizedSecret) {
    throw new Error("telegram-command-bridge-secret-missing");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("telegram-command-bridge-fetch-missing");
  }
  const body = JSON.stringify(command);
  const timestamp = String(Math.floor(now() / 1_000));
  const signature = signTelegramBridgeRequest({
    body,
    secret: normalizedSecret,
    timestamp,
  });
  let response;
  try {
    response = await fetchImpl(bridgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mons-Telegram-Signature": signature,
        "X-Mons-Telegram-Timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error("telegram-command-bridge-unavailable", { cause: error });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("telegram-command-bridge-invalid-response", {
      cause: error,
    });
  }
  if (!response.ok) {
    const failure = new Error(
      normalizeString(payload?.error) || "telegram-command-bridge-rejected",
    );
    failure.code = normalizeString(payload?.error) || "unavailable";
    failure.status = response.status;
    throw failure;
  }
  return payload;
};

module.exports = {
  TELEGRAM_BRIDGE_TIMEOUT_MS,
  TELEGRAM_COMMAND_BRIDGE_URL,
  sendTelegramCommand,
  signTelegramBridgeRequest,
};
