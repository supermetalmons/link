#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDispatchers,
  isRecoveryAction,
  parseBridgeSecretFile,
  parseTelegramCommandResponse,
  readBridgeSecret,
  type TelegramCommandSender,
  type TelegramRecoveryAccepted,
  type TelegramRecoveryPreview,
  type TelegramRecoveryStatus,
} from "./telegramQueueCli.ts";
import { validateTelegramMessageKey } from "../runtime/telegram/desiredStateCore.js";
import type {
  TelegramRecoveryAction,
  TelegramRecoveryCommand,
  TelegramRecoveryStatusCommand,
} from "../runtime/shared/api-contracts.js";

export const RECOVERY_TIMEOUT_MS = 60_000;
export const POLL_INTERVAL_MS = 1_000;
const VALUE_FLAGS = new Set(["--action", "--message-id", "--message-key"]);
const USAGE =
  "Usage: npm run recover:telegram -- --message-key <key> --action <confirm-send-absent|confirm-send-applied|abandon> [--message-id <id>] --bridge-secret-file <path> [--dry-run | --execute]";

type RecoveryChoice =
  | { action: "confirm-send-applied"; messageId: number }
  | { action: "confirm-send-absent" | "abandon"; messageId?: never };
export type RecoveryOptions = RecoveryChoice & {
  dryRun: boolean;
  messageKey: string;
};
type RecoveryCliOptions = RecoveryOptions & { bridgeSecretFile: string };
type RecoveryAppliedResult = {
  ok: true;
  dryRun: false;
  messageKey: string;
  requestId: string;
  action: TelegramRecoveryAction;
  status: "accepted";
  deliveryStatus: string | null;
};

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

export const parseArgs = (argv: readonly string[]): RecoveryCliOptions => {
  const { bridgeSecretFile, remainingArgs } = parseBridgeSecretFile(argv);
  let action = "";
  let dryRun = true;
  let messageId: number | undefined;
  let messageKey = "";
  let modeSet = false;
  for (let index = 0; index < remainingArgs.length; index += 1) {
    const arg = remainingArgs[index];
    if (arg === "--dry-run" || arg === "--execute") {
      if (modeSet) throw new TypeError(USAGE);
      modeSet = true;
      dryRun = arg === "--dry-run";
      continue;
    }
    if (arg === undefined || !VALUE_FLAGS.has(arg)) throw new TypeError(USAGE);
    const value = remainingArgs[++index];
    if (!value || value.startsWith("--")) throw new TypeError(USAGE);
    if (arg === "--message-key") {
      if (messageKey) throw new TypeError(USAGE);
      messageKey = validateTelegramMessageKey(value);
    } else if (arg === "--action") {
      if (action) throw new TypeError(USAGE);
      action = normalizeString(value);
    } else {
      if (messageId !== undefined || !/^\d+$/.test(value)) {
        throw new TypeError(USAGE);
      }
      messageId = Number(value);
    }
  }
  if (!messageKey || !isRecoveryAction(action)) {
    throw new TypeError(USAGE);
  }
  if (action === "confirm-send-applied") {
    if (
      typeof messageId !== "number" ||
      !Number.isSafeInteger(messageId) ||
      messageId <= 0
    ) {
      throw new TypeError(USAGE);
    }
    return { action, bridgeSecretFile, dryRun, messageId, messageKey };
  }
  if (messageId !== undefined) throw new TypeError(USAGE);
  return {
    action,
    bridgeSecretFile,
    dryRun,
    messageKey,
  };
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const recoverTelegramDelivery = async (
  options: RecoveryOptions,
  {
    now = Date.now,
    randomId = randomUUID,
    sendCommand,
    sleepImpl = sleep,
  }: {
    now?: () => number;
    randomId?: () => string;
    sendCommand?: TelegramCommandSender;
    sleepImpl?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<TelegramRecoveryPreview | RecoveryAppliedResult> => {
  if (typeof sendCommand !== "function") {
    throw new TypeError("sendCommand is required");
  }
  const messageKey = validateTelegramMessageKey(options.messageKey);
  const recovery =
    options.action === "confirm-send-applied"
      ? { messageKey, action: options.action, messageId: options.messageId }
      : { messageKey, action: options.action };
  if (options.dryRun) {
    const command: Extract<
      TelegramRecoveryCommand,
      { kind: "recovery-preview" }
    > = {
      kind: "recovery-preview",
      ...recovery,
    };
    return parseTelegramCommandResponse(command, await sendCommand(command));
  }
  const proposedRequestId = randomId();
  let requested: TelegramRecoveryAccepted;
  try {
    const command: Extract<
      TelegramRecoveryCommand,
      { kind: "recovery-request" }
    > = {
      kind: "recovery-request",
      requestId: proposedRequestId,
      ...recovery,
    };
    requested = parseTelegramCommandResponse(
      command,
      await sendCommand(command),
    );
  } catch (error) {
    throw new Error(
      `Manual recovery ${proposedRequestId} may remain pending. Retry the same recover:telegram command.`,
      { cause: error },
    );
  }
  const requestId = normalizeString(requested.requestId);
  if (!requestId) throw new Error("Manual recovery request was not accepted.");
  const deadlineAtMs = now() + RECOVERY_TIMEOUT_MS;
  while (now() < deadlineAtMs) {
    let result: TelegramRecoveryStatus;
    try {
      const command: TelegramRecoveryStatusCommand = {
        kind: "recovery-status",
        messageKey,
        requestId,
      };
      result = parseTelegramCommandResponse(
        command,
        await sendCommand(command),
      );
    } catch (error) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("status" in error) ||
        error.status !== 404
      ) {
        throw error;
      }
      result = {
        ok: true,
        messageKey,
        requestId,
        status: "pending",
        deliveryStatus: null,
      };
    }
    if (result?.status === "accepted") {
      return {
        ok: true,
        dryRun: false,
        messageKey,
        requestId,
        action: options.action,
        status: result.status,
        deliveryStatus: result.deliveryStatus ?? null,
      };
    }
    if (result?.status && result.status !== "pending") {
      throw new Error(
        `Manual recovery was rejected: ${normalizeString(result.code) || "unknown"}.`,
      );
    }
    await sleepImpl(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Manual recovery ${requestId} remains pending. Retry the same recover:telegram command.`,
  );
};

export const main = async (argv = process.argv.slice(2)): Promise<void> => {
  const options = parseArgs(argv);
  const { sendCommand } = createDispatchers(
    readBridgeSecret(options.bridgeSecretFile),
  );
  console.log(
    JSON.stringify(await recoverTelegramDelivery(options, { sendCommand })),
  );
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
