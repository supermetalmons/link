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
const { queueTelegramDelete } = require("../functions/telegramDelivery");
const {
  createDispatchers,
  parseBridgeSecretFile,
  readBridgeSecret,
} = require("./telegramQueueCli");

const SMOKE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const smokeTelegramDelivery = async ({
  database = admin.database(),
  dispatchDelivery,
  now = Date.now,
  randomId = randomUUID,
  sleepImpl = sleep,
} = {}) => {
  const smokeId = randomId();
  const messageKey = `migration-smoke:${smokeId}`;
  const messageRef = database.ref(`telegramMessages/${messageKey}`);
  try {
    const queued = await queueTelegramDelete(
      {
        messageKey,
        destination: "community",
        sourceRevision: smokeId,
      },
      {
        database,
        dispatchDelivery,
        generation: `smoke:${smokeId}`,
      },
    );
    const deadlineAtMs = now() + SMOKE_TIMEOUT_MS;
    while (now() < deadlineAtMs) {
      const snapshot = await messageRef.once("value");
      const value = snapshot.val() || {};
      if (
        value.desired?.revision === queued.revision &&
        (value.delivery?.status === "delivered" ||
          value.delivery?.status === "settled") &&
        !value.applied
      ) {
        return { ok: true, messageKey, status: value.delivery.status };
      }
      await sleepImpl(POLL_INTERVAL_MS);
    }
    throw new Error("Telegram delivery smoke timed out.");
  } finally {
    await messageRef.remove();
  }
};

const main = async (argv = process.argv.slice(2)) => {
  const { bridgeSecretFile, remainingArgs } = parseBridgeSecretFile(argv);
  const { dispatchDelivery } = createDispatchers(
    readBridgeSecret(bridgeSecretFile),
  );
  if (!initAdmin(remainingArgs)) throw new Error(ADC_FAILURE_MESSAGE);
  try {
    console.log(
      JSON.stringify(await smokeTelegramDelivery({ dispatchDelivery })),
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
  SMOKE_TIMEOUT_MS,
  main,
  smokeTelegramDelivery,
};
