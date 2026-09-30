// Generated from src/telegram/queueBridge.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signTelegramBridgeRequest =
  exports.sendTelegramCommand =
  exports.TELEGRAM_COMMAND_BRIDGE_URL =
  exports.TELEGRAM_BRIDGE_TIMEOUT_MS =
    void 0;
const values_js_1 = require("./values.js");
const node_crypto_1 = require("node:crypto");
const TELEGRAM_COMMAND_BRIDGE_URL =
  "https://api.mons.link/internal/telegram/command";
exports.TELEGRAM_COMMAND_BRIDGE_URL = TELEGRAM_COMMAND_BRIDGE_URL;
const TELEGRAM_BRIDGE_TIMEOUT_MS = 5_000;
exports.TELEGRAM_BRIDGE_TIMEOUT_MS = TELEGRAM_BRIDGE_TIMEOUT_MS;
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const signTelegramBridgeRequest = ({ body, secret, timestamp }) =>
  (0, node_crypto_1.createHmac)("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("base64url");
exports.signTelegramBridgeRequest = signTelegramBridgeRequest;
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
    const failure = Object.assign(
      new Error(
        normalizeString((0, values_js_1.readProperty)(payload, "error")) ||
          "telegram-command-bridge-rejected",
      ),
      {
        code:
          normalizeString((0, values_js_1.readProperty)(payload, "error")) ||
          "unavailable",
        status: response.status,
      },
    );
    throw failure;
  }
  return payload;
};
exports.sendTelegramCommand = sendTelegramCommand;
