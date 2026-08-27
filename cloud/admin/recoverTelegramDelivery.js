#!/usr/bin/env node

"use strict";

const { randomUUID } = require("node:crypto");
const {
  createDispatchers,
  parseBridgeSecretFile,
  readBridgeSecret,
} = require("./telegramQueueCli");
const {
  validateTelegramMessageKey,
} = require("../functions/telegram/desiredStateCore");

const RECOVERY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const RECOVERY_ACTIONS = new Set([
  "confirm-send-absent",
  "confirm-send-applied",
  "abandon",
]);
const VALUE_FLAGS = new Set(["--action", "--message-id", "--message-key"]);
const USAGE =
  "Usage: npm run recover:telegram -- --message-key <key> --action <confirm-send-absent|confirm-send-applied|abandon> [--message-id <id>] --bridge-secret-file <path> [--dry-run | --execute]";

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const parseArgs = (argv) => {
  const { bridgeSecretFile, remainingArgs } = parseBridgeSecretFile(argv);
  let action = "";
  let dryRun = true;
  let messageId;
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
    if (!VALUE_FLAGS.has(arg)) throw new TypeError(USAGE);
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
  if (!messageKey || !RECOVERY_ACTIONS.has(action)) {
    throw new TypeError(USAGE);
  }
  if (
    (action === "confirm-send-applied" &&
      (!Number.isSafeInteger(messageId) || messageId <= 0)) ||
    (action !== "confirm-send-applied" && messageId !== undefined)
  ) {
    throw new TypeError(USAGE);
  }
  return {
    action,
    bridgeSecretFile,
    dryRun,
    messageId,
    messageKey,
  };
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const recoverTelegramDelivery = async (
  options,
  {
    now = Date.now,
    randomId = randomUUID,
    sendCommand,
    sleepImpl = sleep,
  } = {},
) => {
  if (typeof sendCommand !== "function") {
    throw new TypeError("sendCommand is required");
  }
  const messageKey = validateTelegramMessageKey(options.messageKey);
  const recovery = {
    messageKey,
    action: options.action,
    ...(options.messageId === undefined
      ? {}
      : { messageId: options.messageId }),
  };
  if (options.dryRun) {
    return sendCommand({ kind: "recovery-preview", ...recovery });
  }
  const proposedRequestId = randomId();
  let requested;
  try {
    requested = await sendCommand({
      kind: "recovery-request",
      requestId: proposedRequestId,
      ...recovery,
    });
  } catch (error) {
    throw new Error(
      `Manual recovery ${proposedRequestId} may remain pending. Retry the same recover:telegram command.`,
      { cause: error },
    );
  }
  const requestId = normalizeString(requested?.requestId);
  if (!requestId) throw new Error("Manual recovery request was not accepted.");
  const deadlineAtMs = now() + RECOVERY_TIMEOUT_MS;
  while (now() < deadlineAtMs) {
    let result;
    try {
      result = await sendCommand({
        kind: "recovery-status",
        messageKey,
        requestId,
      });
    } catch (error) {
      if (error?.status !== 404) throw error;
      result = { status: "pending" };
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

const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  const { sendCommand } = createDispatchers(
    readBridgeSecret(options.bridgeSecretFile),
  );
  console.log(
    JSON.stringify(await recoverTelegramDelivery(options, { sendCommand })),
  );
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  POLL_INTERVAL_MS,
  RECOVERY_TIMEOUT_MS,
  main,
  parseArgs,
  recoverTelegramDelivery,
};
