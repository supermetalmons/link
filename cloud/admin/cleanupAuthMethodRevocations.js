#!/usr/bin/env node

const { resolveAuthCooldownRetryAtMs } = require("@mons/shared/auth");
const AUTH_COOLDOWN_COLLECTIONS = [
  "authMethodRevocations",
  "authProfileMethodCooldowns",
];
const PAGE_SIZE = 400;
const USAGE =
  "Usage: node cloud/admin/cleanupAuthMethodRevocations.js [--project <id>] [--database-url <url>] [--dry-run | --execute] [--scan-legacy]";

const parseArgs = (argv) => {
  let dryRun = true;
  let modeSet = false;
  let scanLegacy = false;
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
    if (arg === "--scan-legacy") {
      if (scanLegacy) {
        throw new TypeError(USAGE);
      }
      scanLegacy = true;
      continue;
    }
    throw new TypeError(USAGE);
  }

  return { dryRun, scanLegacy };
};

const resolveRetryAtMs = resolveAuthCooldownRetryAtMs;

const classifyRetryAtMs = (retryAtMs, nowMs) => {
  if (retryAtMs <= 0) {
    return "unknown";
  }
  return retryAtMs > nowMs ? "active" : "expired";
};

const classifyCooldown = (docData, nowMs) =>
  classifyRetryAtMs(resolveRetryAtMs(docData), nowMs);

const hasCanonicalRetryAtMs = (docData) => {
  const retryAtMs = docData && docData.retryAtMs;
  return Number.isSafeInteger(retryAtMs) && retryAtMs > 0;
};

const applyCooldownMutations = async (
  firestore,
  expiredDocs,
  normalizations,
) => {
  if (expiredDocs.length === 0 && normalizations.length === 0) {
    return { deleted: 0, normalized: 0 };
  }
  const batch = firestore.batch();
  expiredDocs.forEach((doc) => {
    batch.delete(doc.ref, { lastUpdateTime: doc.updateTime });
  });
  normalizations.forEach(({ doc, retryAtMs }) => {
    batch.update(doc.ref, { retryAtMs }, { lastUpdateTime: doc.updateTime });
  });
  await batch.commit();
  return {
    deleted: expiredDocs.length,
    normalized: normalizations.length,
  };
};

const deleteDocuments = async (firestore, docs) => {
  const { deleted } = await applyCooldownMutations(firestore, docs, []);
  return deleted;
};

const buildCleanupQuery = ({
  firestore,
  collectionName,
  documentIdField,
  lastDoc,
  nowMs,
  scanLegacy,
}) => {
  let query = firestore.collection(collectionName);
  query = scanLegacy
    ? query.orderBy(documentIdField)
    : query.where("retryAtMs", "<=", nowMs).orderBy("retryAtMs");
  if (lastDoc) {
    query = query.startAfter(lastDoc);
  }
  return query.limit(PAGE_SIZE);
};

const cleanupCollection = async ({
  firestore,
  collectionName,
  documentIdField,
  dryRun,
  nowMs,
  scanLegacy = false,
}) => {
  const summary = {
    collection: collectionName,
    mode: scanLegacy ? "legacy-compatible" : "canonical",
    candidatesScanned: 0,
    expired: 0,
    deleted: 0,
    activeSkipped: 0,
    unknownSkipped: 0,
    normalizable: 0,
    normalized: 0,
  };
  let lastDoc = null;

  while (true) {
    const query = buildCleanupQuery({
      firestore,
      collectionName,
      documentIdField,
      lastDoc,
      nowMs,
      scanLegacy,
    });
    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    summary.candidatesScanned += snapshot.size;
    const expiredDocs = [];
    const normalizations = [];
    snapshot.docs.forEach((doc) => {
      const docData = doc.data() || {};
      const retryAtMs = resolveRetryAtMs(docData);
      const classification = classifyRetryAtMs(retryAtMs, nowMs);
      if (classification === "expired") {
        summary.expired += 1;
        expiredDocs.push(doc);
      } else if (classification === "active") {
        summary.activeSkipped += 1;
        if (scanLegacy && !hasCanonicalRetryAtMs(docData)) {
          summary.normalizable += 1;
          normalizations.push({ doc, retryAtMs });
        }
      } else {
        summary.unknownSkipped += 1;
      }
    });
    if (!dryRun) {
      const mutationResult = await applyCooldownMutations(
        firestore,
        expiredDocs,
        normalizations,
      );
      summary.deleted += mutationResult.deleted;
      summary.normalized += mutationResult.normalized;
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) {
      break;
    }
  }

  return summary;
};

async function main(argv = process.argv.slice(2)) {
  const { dryRun, scanLegacy } = parseArgs(argv);
  const { admin, cleanupAdmin, initAdmin } = require("./_admin");
  if (!initAdmin(argv)) {
    throw new Error("Failed to initialize Admin SDK.");
  }

  try {
    const firestore = admin.firestore();
    const documentIdField = admin.firestore.FieldPath.documentId();
    const nowMs = Date.now();
    const collections = [];
    for (const collectionName of AUTH_COOLDOWN_COLLECTIONS) {
      collections.push(
        await cleanupCollection({
          firestore,
          collectionName,
          documentIdField,
          dryRun,
          nowMs,
          scanLegacy,
        }),
      );
    }
    console.log("Auth cooldown cleanup summary:");
    console.log(JSON.stringify({ dryRun, scanLegacy, collections }, null, 2));
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
  applyCooldownMutations,
  buildCleanupQuery,
  classifyCooldown,
  cleanupCollection,
  deleteDocuments,
  hasCanonicalRetryAtMs,
  main,
  parseArgs,
  resolveRetryAtMs,
};
