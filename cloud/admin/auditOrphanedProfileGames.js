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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 400;
const USAGE =
  "Usage: node cloud/admin/auditOrphanedProfileGames.js [--project <id>] [--database-url <url>] [--after <document-path>] [--limit <1-400>] [--dry-run | --execute]";

const parseArgs = (argv) => {
  const options = {
    adminArgs: [],
    after: "",
    dryRun: true,
    limit: DEFAULT_LIMIT,
  };
  let modeSet = false;
  const seenValueFlags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--execute") {
      if (modeSet) throw new TypeError(USAGE);
      modeSet = true;
      options.dryRun = arg === "--dry-run";
      continue;
    }
    if (!["--after", "--database-url", "--limit", "--project"].includes(arg)) {
      throw new TypeError(USAGE);
    }
    if (seenValueFlags.has(arg)) throw new TypeError(USAGE);
    seenValueFlags.add(arg);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new TypeError(USAGE);
    if (arg === "--after") options.after = value;
    else if (arg === "--limit") {
      const limit = Number(value);
      if (!/^\d+$/.test(value) || limit < 1 || limit > MAX_LIMIT) {
        throw new TypeError(USAGE);
      }
      options.limit = limit;
    } else options.adminArgs.push(arg, value);
  }
  return options;
};

const auditOrphanedProfileGamesPage = async (
  options,
  { firestore = admin.firestore() } = {},
) => {
  let query = firestore
    .collectionGroup("games")
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(options.limit + 1);
  if (options.after) query = query.startAfter(options.after);
  const snapshot = await query.get();
  const documents = snapshot.docs.slice(0, options.limit);
  const profileRefs = documents.map((document) => document.ref.parent.parent);
  const profiles =
    profileRefs.length > 0 ? await firestore.getAll(...profileRefs) : [];
  const orphaned = documents.filter((_, index) => !profiles[index]?.exists);
  let deleted = 0;
  if (!options.dryRun && orphaned.length > 0) {
    const confirmation = await firestore.getAll(
      ...orphaned.map((document) => document.ref.parent.parent),
    );
    const confirmed = orphaned.filter(
      (_, index) => !confirmation[index]?.exists,
    );
    for (let index = 0; index < confirmed.length; index += 400) {
      const batch = firestore.batch();
      confirmed
        .slice(index, index + 400)
        .forEach((document) => batch.delete(document.ref));
      await batch.commit();
    }
    deleted = confirmed.length;
  }
  const hasMore = snapshot.docs.length > documents.length;
  return {
    complete: !hasMore && orphaned.length === 0,
    dryRun: options.dryRun,
    scanned: documents.length,
    orphaned: orphaned.map((document) => document.ref.path),
    deleted,
    hasMore,
    nextCursor:
      hasMore && documents.length > 0 ? documents.at(-1).ref.path : null,
  };
};

const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (!initAdmin(options.adminArgs)) throw new Error(ADC_FAILURE_MESSAGE);
  try {
    const result = await auditOrphanedProfileGamesPage(options);
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
      if (!result.complete) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    });
}

module.exports = { auditOrphanedProfileGamesPage, main, parseArgs };
