#!/usr/bin/env node

"use strict";

const { createHmac, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  cleanupAdmin,
  initAdmin,
} = require("./_admin");
const {
  buildTelegramDeliveryTaskId,
  normalizeTaskPayload,
} = require("../functions/telegram/taskIdentity");

const requireFromFunctions = createRequire(
  path.resolve(__dirname, "../functions/package.json"),
);
const { getFunctions } = requireFromFunctions("firebase-admin/functions");
const BRIDGE_URL = "https://api.mons.link/internal/telegram/delivery";
const USAGE =
  "Usage: node cloud/admin/requeueTelegramDelivery.js --target <cloudflare|firebase> [--project <id>] [--database-url <url>] [--bridge-secret-file <path>] [--dry-run | --execute]";

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const parseArgs = (argv) => {
  let dryRun = true;
  let modeSet = false;
  let target = "";
  let bridgeSecretFile = "";
  const adminArgs = [];
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--target" ||
      arg === "--project" ||
      arg === "--database-url" ||
      arg === "--bridge-secret-file"
    ) {
      const value = argv[++index];
      if (seen.has(arg) || !value || value.startsWith("--")) {
        throw new TypeError(USAGE);
      }
      seen.add(arg);
      if (arg === "--target") target = value;
      if (arg === "--bridge-secret-file") bridgeSecretFile = value;
      if (arg === "--project" || arg === "--database-url") {
        adminArgs.push(arg, value);
      }
      continue;
    }
    if (arg === "--dry-run" || arg === "--execute") {
      if (modeSet) throw new TypeError(USAGE);
      dryRun = arg === "--dry-run";
      modeSet = true;
      continue;
    }
    throw new TypeError(USAGE);
  }
  if (target !== "cloudflare" && target !== "firebase") {
    throw new TypeError(USAGE);
  }
  if (!dryRun && target === "cloudflare" && !bridgeSecretFile) {
    throw new TypeError(USAGE);
  }
  return { adminArgs, bridgeSecretFile, dryRun, target };
};

const buildRecoveryTasks = (records, runId) => {
  const tasks = [];
  for (const [messageKey, rawRecord] of Object.entries(records || {})) {
    const record = rawRecord && typeof rawRecord === "object" ? rawRecord : {};
    const desiredRevision = normalizeString(record.desired?.revision);
    if (desiredRevision) {
      tasks.push(
        normalizeTaskPayload({
          messageKey,
          revision: desiredRevision,
          taskKind: "desired",
          retrySequence: 0,
          generation: `recovery:${runId}:desired:${tasks.length}`,
        }),
      );
    }
    const requestId = normalizeString(record.manualRecovery?.requestId);
    const processedRequestId = normalizeString(
      record.delivery?.lastRecoveryRequestId,
    );
    if (requestId && requestId !== processedRequestId) {
      tasks.push(
        normalizeTaskPayload({
          messageKey,
          revision: "manual-recovery",
          taskKind: "manual-recovery",
          retrySequence: 0,
          generation: `${requestId}:recovery:${runId}:manual:${tasks.length}`,
        }),
      );
    }
  }
  return tasks;
};

const postCloudflareTask = async (
  payload,
  { fetchImpl = globalThis.fetch, now = Date.now, secret },
) => {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now() / 1_000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("base64url");
  const response = await fetchImpl(BRIDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mons-Telegram-Signature": signature,
      "X-Mons-Telegram-Timestamp": timestamp,
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (response.body) {
    await response.body.cancel().catch(() => undefined);
  }
  if (response.status !== 202) {
    throw new Error(`Cloudflare bridge returned ${response.status}`);
  }
};

const enqueueFirebaseTask = async (payload, functions = getFunctions()) => {
  await functions.taskQueue("telegramDeliveryWorker").enqueue(payload, {
    id: buildTelegramDeliveryTaskId(payload),
    dispatchDeadlineSeconds: 30,
  });
};

const requeueTelegramDelivery = async (options, dependencies = {}) => {
  const database = dependencies.database || admin.database();
  const snapshot = await database.ref("telegramMessages").once("value");
  const tasks = buildRecoveryTasks(
    snapshot.val(),
    dependencies.runId || randomUUID(),
  );
  const summary = {
    target: options.target,
    dryRun: options.dryRun,
    tasks: tasks.length,
    desired: tasks.filter((task) => task.taskKind === "desired").length,
    manualRecovery: tasks.filter((task) => task.taskKind === "manual-recovery")
      .length,
  };
  if (options.dryRun) return summary;
  let secret = "";
  if (options.target === "cloudflare") {
    secret = fs.readFileSync(options.bridgeSecretFile, "utf8").trim();
    if (!secret) throw new Error("Bridge secret file is empty.");
  }
  for (const task of tasks) {
    if (options.target === "cloudflare") {
      await (dependencies.postCloudflareTask || postCloudflareTask)(task, {
        secret,
      });
    } else {
      await (dependencies.enqueueFirebaseTask || enqueueFirebaseTask)(task);
    }
  }
  return summary;
};

const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (!initAdmin(options.adminArgs)) throw new Error(ADC_FAILURE_MESSAGE);
  try {
    const summary = await requeueTelegramDelivery(options);
    console.log(JSON.stringify(summary));
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
  BRIDGE_URL,
  buildRecoveryTasks,
  enqueueFirebaseTask,
  main,
  parseArgs,
  postCloudflareTask,
  requeueTelegramDelivery,
};
