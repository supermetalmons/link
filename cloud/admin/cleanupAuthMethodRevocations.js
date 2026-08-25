#!/usr/bin/env node

const { resolveAuthCooldownRetryAtMs } = require("@mons/shared/auth");
const AUTH_COOLDOWN_COLLECTIONS = [
  "authMethodRevocations",
  "authProfileMethodCooldowns",
];
const PAGE_SIZE = 400;
const USAGE =
  "Usage: node cloud/admin/cleanupAuthMethodRevocations.js [--project <id>] [--database-url <url>] [--dry-run | --execute]";

const parseArgs = (argv) => {
  let dryRun = true;
  let modeSet = false;
  const valueFlags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project" || arg === "--database-url") {
      const value = argv[++index];
      if (valueFlags.has(arg) || !value || value.startsWith("--")) {
        throw new TypeError(USAGE);
      }
      valueFlags.add(arg);
      continue;
    }
    if (arg === "--dry-run" || arg === "--execute") {
      if (modeSet) {
        throw new TypeError(USAGE);
      }
      dryRun = arg === "--dry-run";
      modeSet = true;
      continue;
    }
    throw new TypeError(USAGE);
  }

  return { dryRun };
};

const deleteDocuments = async (firestore, docs) => {
  if (docs.length === 0) {
    return 0;
  }
  const batch = firestore.batch();
  docs.forEach((doc) => {
    batch.delete(doc.ref, { lastUpdateTime: doc.updateTime });
  });
  await batch.commit();
  return docs.length;
};

const buildCleanupQuery = ({ firestore, collectionName, lastDoc, nowMs }) => {
  let query = firestore
    .collection(collectionName)
    .where("retryAtMs", "<=", nowMs)
    .orderBy("retryAtMs");
  if (lastDoc) {
    query = query.startAfter(lastDoc);
  }
  return query.limit(PAGE_SIZE);
};

const cleanupCollection = async ({
  firestore,
  collectionName,
  dryRun,
  nowMs,
}) => {
  const summary = {
    collection: collectionName,
    candidatesScanned: 0,
    expired: 0,
    deleted: 0,
  };
  let lastDoc = null;

  while (true) {
    const query = buildCleanupQuery({
      firestore,
      collectionName,
      lastDoc,
      nowMs,
    });
    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    summary.candidatesScanned += snapshot.size;
    const expiredDocs = snapshot.docs.filter((doc) => {
      const retryAtMs = resolveAuthCooldownRetryAtMs(doc.data() || {});
      if (retryAtMs <= 0 || retryAtMs > nowMs) {
        return false;
      }
      summary.expired += 1;
      return true;
    });
    if (!dryRun) {
      summary.deleted += await deleteDocuments(firestore, expiredDocs);
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) {
      break;
    }
  }

  return summary;
};

async function main(argv = process.argv.slice(2)) {
  const { dryRun } = parseArgs(argv);
  const { admin, cleanupAdmin, initAdmin } = require("./_admin");
  if (!initAdmin(argv)) {
    throw new Error("Failed to initialize Admin SDK.");
  }

  try {
    const firestore = admin.firestore();
    const nowMs = Date.now();
    const collections = [];
    for (const collectionName of AUTH_COOLDOWN_COLLECTIONS) {
      collections.push(
        await cleanupCollection({
          firestore,
          collectionName,
          dryRun,
          nowMs,
        }),
      );
    }
    console.log("Auth cooldown cleanup summary:");
    console.log(JSON.stringify({ dryRun, collections }, null, 2));
  } finally {
    await cleanupAdmin();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  AUTH_COOLDOWN_COLLECTIONS,
  PAGE_SIZE,
  buildCleanupQuery,
  cleanupCollection,
  deleteDocuments,
  main,
  parseArgs,
};
