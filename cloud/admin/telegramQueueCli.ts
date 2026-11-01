import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sendTelegramCommand } from "../runtime/telegram/queueBridge.js";
import type { TelegramFetch } from "../runtime/telegram/client.js";
import type {
  TelegramCommandRequest,
  TelegramCommandResponse,
  TelegramRecoveryAction,
  TelegramCommandReadResponse,
  TelegramCommandAcceptedResponse,
} from "../runtime/shared/api-contracts.js";

export const MAX_BRIDGE_SECRET_BYTES = 8 * 1024;
export type TelegramCommandSender = (
  command: TelegramCommandRequest,
) => Promise<TelegramCommandResponse>;
export type TelegramRecoveryPreview = Extract<
  TelegramCommandReadResponse,
  { dryRun: true }
>;
export type TelegramRecoveryAccepted = Extract<
  TelegramCommandAcceptedResponse,
  { requestId: string }
>;
export type TelegramRecoveryStatus = Extract<
  TelegramCommandReadResponse,
  { status: string }
>;

export const parseBridgeSecretFile = (argv: readonly string[]) => {
  let bridgeSecretFile = "";
  const remainingArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) throw new TypeError("Invalid bridge arguments.");
    if (arg !== "--bridge-secret-file") {
      remainingArgs.push(arg);
      continue;
    }
    const value = argv[++index];
    if (bridgeSecretFile || !value || value.startsWith("--")) {
      throw new TypeError("--bridge-secret-file requires one file path");
    }
    bridgeSecretFile = value;
  }
  if (!bridgeSecretFile) {
    throw new TypeError("--bridge-secret-file is required");
  }
  return { bridgeSecretFile, remainingArgs };
};

export const readBridgeSecret = (
  filePath: string,
  { readFile = readFileSync }: { readFile?: (path: string) => Buffer } = {},
): string => {
  let value: Buffer;
  try {
    value = readFile(resolve(filePath));
  } catch {
    throw new Error("Could not read the Telegram bridge secret file.");
  }
  if (value.length > MAX_BRIDGE_SECRET_BYTES) {
    throw new Error("Telegram bridge secret file is too large.");
  }
  const secret = String(value).trim();
  if (!secret) {
    throw new Error("Telegram bridge secret file is empty.");
  }
  return secret;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

export function isRecoveryAction(
  value: unknown,
): value is TelegramRecoveryAction {
  return (
    value === "abandon" ||
    value === "confirm-send-absent" ||
    value === "confirm-send-applied"
  );
}

function invalidResponse(): never {
  throw new Error("telegram-command-bridge-invalid-response");
}

export function parseTelegramCommandResponse(
  command: Extract<TelegramCommandRequest, { kind: "recovery-preview" }>,
  value: unknown,
): TelegramRecoveryPreview;
export function parseTelegramCommandResponse(
  command: Extract<TelegramCommandRequest, { kind: "recovery-request" }>,
  value: unknown,
): TelegramRecoveryAccepted;
export function parseTelegramCommandResponse(
  command: Extract<TelegramCommandRequest, { kind: "recovery-status" }>,
  value: unknown,
): TelegramRecoveryStatus;
export function parseTelegramCommandResponse(
  command: TelegramCommandRequest,
  value: unknown,
): TelegramCommandResponse;
export function parseTelegramCommandResponse(
  command: TelegramCommandRequest,
  value: unknown,
): TelegramCommandResponse {
  if (!isRecord(value) || value.ok !== true) invalidResponse();
  if (command.kind === "event-reminder-refresh") {
    if (
      !exactKeys(
        value,
        ["ok", "eventId", "status"],
        ["messageKey", "requestId", "reason"],
      ) ||
      value.eventId !== command.eventId ||
      value.status !== "queued" ||
      (Object.hasOwn(value, "messageKey") && !validString(value.messageKey)) ||
      (Object.hasOwn(value, "requestId") && !validString(value.requestId)) ||
      (Object.hasOwn(value, "reason") && !validString(value.reason))
    )
      invalidResponse();
    return {
      ok: true,
      eventId: command.eventId,
      status: "queued",
      ...(typeof value.messageKey === "string"
        ? { messageKey: value.messageKey }
        : {}),
      ...(typeof value.requestId === "string"
        ? { requestId: value.requestId }
        : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  if (value.messageKey !== command.messageKey) invalidResponse();
  if (command.kind === "send") {
    if (
      !exactKeys(value, ["ok", "messageKey", "revision"]) ||
      !validString(value.revision)
    ) {
      invalidResponse();
    }
    return {
      ok: true,
      messageKey: command.messageKey,
      revision: value.revision,
    };
  }
  if (command.kind === "recovery-request") {
    if (
      !exactKeys(value, ["ok", "messageKey", "requestId", "action"]) ||
      !validString(value.requestId) ||
      value.action !== command.action
    )
      invalidResponse();
    return {
      ok: true,
      messageKey: command.messageKey,
      requestId: value.requestId,
      action: command.action,
    };
  }
  if (command.kind === "recovery-preview") {
    if (
      !exactKeys(
        value,
        ["ok", "dryRun", "messageKey", "action"],
        ["messageId", "pendingRequestId"],
      ) ||
      value.dryRun !== true ||
      value.action !== command.action ||
      (Object.hasOwn(value, "pendingRequestId") &&
        !validString(value.pendingRequestId)) ||
      (command.action === "confirm-send-applied"
        ? value.messageId !== command.messageId
        : Object.hasOwn(value, "messageId"))
    )
      invalidResponse();
    return {
      ok: true,
      dryRun: true,
      messageKey: command.messageKey,
      action: command.action,
      ...(command.action === "confirm-send-applied"
        ? { messageId: command.messageId }
        : {}),
      ...(typeof value.pendingRequestId === "string"
        ? { pendingRequestId: value.pendingRequestId }
        : {}),
    };
  }
  if (
    !exactKeys(
      value,
      ["ok", "messageKey", "requestId", "status", "deliveryStatus"],
      ["action", "code"],
    ) ||
    value.requestId !== command.requestId ||
    !validString(value.status) ||
    !(
      value.deliveryStatus === null || typeof value.deliveryStatus === "string"
    ) ||
    (Object.hasOwn(value, "action") && typeof value.action !== "string") ||
    (Object.hasOwn(value, "code") && typeof value.code !== "string")
  )
    invalidResponse();
  return {
    ok: true,
    messageKey: command.messageKey,
    requestId: command.requestId,
    status: value.status,
    deliveryStatus: value.deliveryStatus,
    ...(typeof value.action === "string" ? { action: value.action } : {}),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
  };
}

export const createDispatchers = (
  secret: string,
  dependencies: { fetchImpl?: TelegramFetch; now?: () => number } = {},
): { sendCommand: TelegramCommandSender } => {
  return {
    sendCommand: async (command) =>
      parseTelegramCommandResponse(
        command,
        await sendTelegramCommand(command, { ...dependencies, secret }),
      ),
  };
};
