"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  createTelegramDeliveryDispatcher,
  createTelegramManualRecoveryDispatcher,
  enqueueTelegramDeliveryTask,
} = require("../functions/telegram/queueBridge");

const MAX_BRIDGE_SECRET_BYTES = 8 * 1024;

const parseBridgeSecretFile = (argv) => {
  let bridgeSecretFile = "";
  const remainingArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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

const readBridgeSecret = (filePath, { readFile = fs.readFileSync } = {}) => {
  let value;
  try {
    value = readFile(path.resolve(filePath));
  } catch (error) {
    throw new Error("Could not read the Telegram queue bridge secret file.", {
      cause: error,
    });
  }
  if (value.length > MAX_BRIDGE_SECRET_BYTES) {
    throw new Error("Telegram queue bridge secret file is too large.");
  }
  const secret = String(value).trim();
  if (!secret) {
    throw new Error("Telegram queue bridge secret file is empty.");
  }
  return secret;
};

const createDispatchers = (secret, dependencies = {}) => {
  const enqueueTask = (input) =>
    enqueueTelegramDeliveryTask(input, {
      fetchImpl: dependencies.fetchImpl,
      now: dependencies.now,
      secret,
    });
  return {
    dispatchDelivery: createTelegramDeliveryDispatcher({ enqueueTask }),
    dispatchManualRecovery: createTelegramManualRecoveryDispatcher({
      enqueueTask,
    }),
  };
};

module.exports = {
  MAX_BRIDGE_SECRET_BYTES,
  createDispatchers,
  parseBridgeSecretFile,
  readBridgeSecret,
};
