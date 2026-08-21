#!/usr/bin/env node

"use strict";

const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  cleanupAdmin,
  initAdmin,
} = require("./_admin");
const {
  getAutomatchTelegramProjectionOutboxPath,
} = require("../functions/telegram/automatchSource");
const {
  projectAutomatchTelegramSource,
} = require("../functions/telegram/automatchMessages");
const {
  projectRatingTelegramUpdate,
} = require("../functions/telegram/ratingProjector");

const USAGE =
  "Usage: node cloud/admin/replayTelegramProjections.js [--project <id>] [--database-url <url>] [--dry-run | --execute]";

const parseArgs = (argv) => {
  let dryRun = true;
  let modeSet = false;
  const adminArgs = [];
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project" || arg === "--database-url") {
      const value = argv[++index];
      if (seen.has(arg) || !value || value.startsWith("--")) {
        throw new TypeError(USAGE);
      }
      seen.add(arg);
      adminArgs.push(arg, value);
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
  return { adminArgs, dryRun };
};

const readPendingProjections = async ({ database, firestore }) => {
  const [automatchSnapshot, ratingSnapshot] = await Promise.all([
    database.ref("telegramProjectionOutbox/automatch").once("value"),
    firestore
      .collection("ratingUpdates")
      .where("telegramProjectionState", "==", "pending")
      .get(),
  ]);
  const automatch = Object.entries(automatchSnapshot.val() || {})
    .filter(([, record]) => record?.status === "pending")
    .map(([inviteId, record]) => ({
      inviteId,
      requestId: typeof record.requestId === "string" ? record.requestId : "",
    }))
    .filter(({ requestId }) => requestId !== "");
  const ratings = ratingSnapshot.docs.map((document) => ({
    operationId: document.id,
    data: document.data(),
    ref: document.ref,
  }));
  return { automatch, ratings };
};

const replayTelegramProjections = async (options, dependencies = {}) => {
  const database = dependencies.database || admin.database();
  const firestore = dependencies.firestore || admin.firestore();
  const pending = await (
    dependencies.readPendingProjections || readPendingProjections
  )({ database, firestore });
  const summary = {
    dryRun: options.dryRun,
    automatch: pending.automatch.length,
    ratings: pending.ratings.length,
    failures: [],
  };
  if (options.dryRun) return summary;
  const projectAutomatch =
    dependencies.projectAutomatch || projectAutomatchTelegramSource;
  const projectRating =
    dependencies.projectRating || projectRatingTelegramUpdate;
  for (const record of pending.automatch) {
    try {
      const result = await projectAutomatch(record.inviteId);
      if (result?.status === "skipped") {
        throw new Error("projection-skipped");
      }
      const clearResult = await database
        .ref(getAutomatchTelegramProjectionOutboxPath(record.inviteId))
        .transaction((current) =>
          current?.requestId === record.requestId ? null : undefined,
        );
      if (
        !clearResult.committed &&
        clearResult.snapshot.val()?.status === "pending"
      ) {
        throw new Error("outbox-changed");
      }
    } catch (error) {
      summary.failures.push({
        kind: "automatch",
        id: record.inviteId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  for (const record of pending.ratings) {
    try {
      const ratingResult = await projectRating(record.data);
      if (ratingResult?.status === "skipped") {
        throw new Error("rating-projection-skipped");
      }
      const automatchResult = await projectAutomatch(record.data.inviteId);
      if (automatchResult?.status === "skipped") {
        throw new Error("automatch-projection-skipped");
      }
      await record.ref.update({
        telegramProjectionState: "done",
        telegramProjectionUpdatedAtMs: Date.now(),
        telegramProjectionReason: null,
      });
    } catch (error) {
      summary.failures.push({
        kind: "rating",
        id: record.operationId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return summary;
};

const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (!initAdmin(options.adminArgs)) throw new Error(ADC_FAILURE_MESSAGE);
  try {
    const summary = await replayTelegramProjections(options);
    console.log(JSON.stringify(summary));
    if (summary.failures.length > 0) process.exitCode = 1;
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
  main,
  parseArgs,
  readPendingProjections,
  replayTelegramProjections,
};
