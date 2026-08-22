#!/usr/bin/env node

"use strict";

const { randomUUID } = require("node:crypto");
const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  cleanupAdmin,
  initAdmin,
} = require("./_admin");
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
const VALUE_FLAGS = new Set([
  "--action",
  "--database-url",
  "--message-id",
  "--message-key",
  "--project",
]);
const USAGE =
  "Usage: npm run recover:telegram -- --message-key <key> --action <confirm-send-absent|confirm-send-applied|abandon> [--message-id <id>] --bridge-secret-file <path> [--project <id>] [--database-url <url>] [--dry-run | --execute]";

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const isSameRecovery = (request, options) =>
  normalizeString(request?.action) === options.action &&
  (options.messageId === undefined
    ? request?.messageId === undefined
    : Number(request?.messageId) === options.messageId);

const parseArgs = (argv) => {
  const { bridgeSecretFile, remainingArgs } = parseBridgeSecretFile(argv);
  const adminArgs = [];
  let action = "";
  let dryRun = true;
  let messageId;
  let messageKey = "";
  let modeSet = false;
  for (let index = 0; index < remainingArgs.length; index += 1) {
    const arg = remainingArgs[index];
    if (arg === "--dry-run" || arg === "--execute") {
      if (modeSet) {
        throw new TypeError(USAGE);
      }
      modeSet = true;
      dryRun = arg === "--dry-run";
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new TypeError(USAGE);
    }
    const value = remainingArgs[++index];
    if (!value || value.startsWith("--")) {
      throw new TypeError(USAGE);
    }
    if (arg === "--project" || arg === "--database-url") {
      adminArgs.push(arg, value);
    } else if (arg === "--message-key") {
      if (messageKey) {
        throw new TypeError(USAGE);
      }
      messageKey = validateTelegramMessageKey(value);
    } else if (arg === "--action") {
      if (action) {
        throw new TypeError(USAGE);
      }
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
    adminArgs,
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
    database = admin.database(),
    dispatchManualRecovery,
    now = Date.now,
    randomId = randomUUID,
    sleepImpl = sleep,
  } = {},
) => {
  if (typeof dispatchManualRecovery !== "function") {
    throw new TypeError("dispatchManualRecovery is required");
  }
  const messageKey = validateTelegramMessageKey(options.messageKey);
  const messageRef = database.ref(`telegramMessages/${messageKey}`);
  const snapshot = await messageRef.once("value");
  const record = snapshot.val() || {};
  const attemptId = normalizeString(record.delivery?.sendInFlight?.attemptId);
  if (record.delivery?.status !== "uncertain" || !attemptId) {
    throw new Error("Telegram delivery is not awaiting manual recovery.");
  }
  const proposedRequest = {
    requestId: randomId(),
    action: options.action,
    ...(options.messageId === undefined
      ? {}
      : { messageId: options.messageId }),
  };
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      messageKey,
      request: proposedRequest,
    };
  }
  const transaction = await messageRef.transaction((current) => {
    const currentRecord = current || {};
    const currentAttemptId = normalizeString(
      currentRecord.delivery?.sendInFlight?.attemptId,
    );
    if (currentRecord.delivery?.status !== "uncertain" || !currentAttemptId) {
      return undefined;
    }
    const pendingRequestId = normalizeString(
      currentRecord.manualRecovery?.requestId,
    );
    const processedRequestId = normalizeString(
      currentRecord.delivery?.lastRecoveryRequestId,
    );
    if (pendingRequestId && pendingRequestId !== processedRequestId) {
      return undefined;
    }
    return { ...currentRecord, manualRecovery: proposedRequest };
  });
  const persisted = transaction.snapshot.val() || {};
  const persistedAttemptId = normalizeString(
    persisted.delivery?.sendInFlight?.attemptId,
  );
  if (persisted.delivery?.status !== "uncertain" || !persistedAttemptId) {
    throw new Error("Telegram delivery is not awaiting manual recovery.");
  }
  const request = persisted.manualRecovery || {};
  const requestId = normalizeString(request.requestId);
  if (!requestId || !isSameRecovery(request, options)) {
    throw new Error("Another manual recovery request is already pending.");
  }
  try {
    await dispatchManualRecovery({
      messageKey,
      requestId,
      generation: "operator",
    });
  } catch (error) {
    throw new Error(
      `Manual recovery ${requestId} remains pending. Retry the same recover:telegram command.`,
      { cause: error },
    );
  }
  const deadlineAtMs = now() + RECOVERY_TIMEOUT_MS;
  while (now() < deadlineAtMs) {
    const resultSnapshot = await messageRef
      .child("manualRecoveryResult")
      .once("value");
    const result = resultSnapshot.val() || {};
    if (normalizeString(result.requestId) === requestId) {
      if (result.status !== "accepted") {
        throw new Error(
          `Manual recovery was rejected: ${normalizeString(result.code) || "unknown"}.`,
        );
      }
      const deliverySnapshot = await messageRef
        .child("delivery/status")
        .once("value");
      return {
        ok: true,
        dryRun: false,
        messageKey,
        requestId,
        action: options.action,
        status: result.status,
        deliveryStatus: deliverySnapshot.val() || null,
      };
    }
    await sleepImpl(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Manual recovery ${requestId} remains pending. Retry the same recover:telegram command.`,
  );
};

const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  const { dispatchManualRecovery } = createDispatchers(
    readBridgeSecret(options.bridgeSecretFile),
  );
  if (!initAdmin(options.adminArgs)) {
    throw new Error(ADC_FAILURE_MESSAGE);
  }
  try {
    console.log(
      JSON.stringify(
        await recoverTelegramDelivery(options, { dispatchManualRecovery }),
      ),
    );
  } finally {
    await cleanupAdmin();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(addApplicationDefaultCredentialHelp(error));
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
