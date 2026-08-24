#!/usr/bin/env node

"use strict";

const { stdout } = require("node:process");
const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  cleanupAdmin,
  initAdmin,
} = require("./_admin");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const USAGE =
  "Usage: npm run reconcile:merge-projections -- [--project <id>] [--database-url <url>] [--after <source-profile-id>] [--limit <1-100>] [--dry-run | --execute]";

const readValue = (argv, index) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(USAGE);
  }
  return value;
};

const readPositiveInteger = (value, maximum) => {
  if (!/^\d+$/.test(value)) {
    throw new TypeError(USAGE);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new TypeError(USAGE);
  }
  return number;
};

const parseArgs = (argv) => {
  const options = {
    adminArgs: [],
    after: "",
    dryRun: true,
    limit: DEFAULT_LIMIT,
  };
  let modeSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--execute") {
      if (modeSet) {
        throw new TypeError(USAGE);
      }
      modeSet = true;
      options.dryRun = arg === "--dry-run";
      continue;
    }
    if (
      arg !== "--after" &&
      arg !== "--database-url" &&
      arg !== "--limit" &&
      arg !== "--project"
    ) {
      throw new TypeError(USAGE);
    }
    const value = readValue(argv, index);
    index += 1;
    if (arg === "--after") {
      options.after = value;
    } else if (arg === "--limit") {
      options.limit = readPositiveInteger(value, MAX_LIMIT);
    } else {
      options.adminArgs.push(arg, value);
    }
  }
  return options;
};

const reconcileProfileMergeProjectionPage = async (
  options,
  {
    firestore = admin.firestore(),
    reconcileProfileMergeProjections = require("../functions/profileGamesProjector")
      .reconcileProfileMergeProjections,
  } = {},
) => {
  let query = firestore
    .collection("profileMergeTargets")
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(options.limit + 1);
  if (options.after) {
    query = query.startAfter(options.after);
  }
  const snapshot = await query.get();
  const candidates = snapshot.docs.slice(0, options.limit);
  const results = [];
  const blockedProjections = new Map();
  const scannedProfileIds = new Set();
  for (const candidate of candidates) {
    const targetProfileId =
      typeof candidate.data()?.targetProfileId === "string"
        ? candidate.data().targetProfileId.trim()
        : "";
    if (!targetProfileId) {
      throw new Error(`Invalid merge target: ${candidate.id}`);
    }
    const result = await reconcileProfileMergeProjections(
      {
        dryRun: options.dryRun,
        sourceProfileId: candidate.id,
        targetProfileId,
      },
      { scannedProfileIds },
    );
    results.push({ sourceProfileId: candidate.id, targetProfileId, ...result });
    for (const projection of result.blockedProjections || []) {
      blockedProjections.set(
        `${projection.entityType}:${projection.id}`,
        projection,
      );
    }
  }
  return {
    complete: blockedProjections.size === 0,
    blockedProjections: Array.from(blockedProjections.values()),
    dryRun: options.dryRun,
    hasMore: snapshot.docs.length > candidates.length,
    nextCursor:
      snapshot.docs.length > candidates.length && candidates.length > 0
        ? candidates[candidates.length - 1].id
        : null,
    results,
  };
};

const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (!initAdmin(options.adminArgs)) {
    throw new Error(ADC_FAILURE_MESSAGE);
  }
  try {
    const result = await reconcileProfileMergeProjectionPage(options);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    throw addApplicationDefaultCredentialHelp(error);
  } finally {
    await cleanupAdmin();
  }
};

if (require.main === module) {
  main()
    .then((result) => {
      if (!result.complete) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    });
}

module.exports = {
  main,
  parseArgs,
  reconcileProfileMergeProjectionPage,
};
