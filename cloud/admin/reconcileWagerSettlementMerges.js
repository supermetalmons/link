#!/usr/bin/env node

"use strict";

const { MATERIAL_KEYS } = require("@mons/shared/mining");
const {
  MAX_PROFILE_MERGE_TARGET_HOPS,
} = require("../functions/profileMergeTargets");
const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  cleanupAdmin,
  initAdmin,
} = require("./_admin");

const DEFAULT_LIMIT = 20;
const MAX_INCOMING_MERGE_TARGETS = 100;
const MAX_LIMIT = 100;
const RECONCILIATION_VERSION = 1;
const USAGE =
  "Usage: node cloud/admin/reconcileWagerSettlementMerges.js [--project <id>] [--database-url <url>] ([--after <operation-id>] [--limit <1-100>] | --resolve <operation-id> [--winner <included|lost>] [--loser <included|lost>]) [--dry-run | --execute]";

const cleanString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const isSafeFirestoreDocumentId = (value) => {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    (value.startsWith("__") && value.endsWith("__"))
  ) {
    return false;
  }
  try {
    encodeURIComponent(value);
  } catch {
    return false;
  }
  return new TextEncoder().encode(value).byteLength <= 1_500;
};

const readSafeFirestoreDocumentId = (value, message) => {
  if (!isSafeFirestoreDocumentId(value)) {
    throw new Error(message);
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
  const adminArgs = [];
  const decisions = {};
  let after = "";
  let dryRun = true;
  let limit = DEFAULT_LIMIT;
  let operationId = "";
  const valueFlags = new Set();
  let modeSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--execute") {
      if (modeSet) {
        throw new TypeError(USAGE);
      }
      modeSet = true;
      dryRun = arg === "--dry-run";
      continue;
    }
    if (
      arg !== "--after" &&
      arg !== "--database-url" &&
      arg !== "--loser" &&
      arg !== "--limit" &&
      arg !== "--project" &&
      arg !== "--resolve" &&
      arg !== "--winner"
    ) {
      throw new TypeError(USAGE);
    }
    if (valueFlags.has(arg)) {
      throw new TypeError(USAGE);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError(USAGE);
    }
    valueFlags.add(arg);
    index += 1;
    if (arg === "--after") {
      after = readSafeFirestoreDocumentId(value, USAGE);
    } else if (arg === "--limit") {
      limit = readPositiveInteger(value, MAX_LIMIT);
    } else if (arg === "--resolve") {
      operationId = readSafeFirestoreDocumentId(value, USAGE);
    } else if (arg === "--winner" || arg === "--loser") {
      if (value !== "included" && value !== "lost") {
        throw new TypeError(USAGE);
      }
      decisions[arg.slice(2)] = value;
    } else {
      adminArgs.push(arg, value);
    }
  }
  if (operationId) {
    if (
      valueFlags.has("--after") ||
      valueFlags.has("--limit") ||
      Object.keys(decisions).length === 0
    ) {
      throw new TypeError(USAGE);
    }
    return { adminArgs, decisions, dryRun, operationId };
  }
  if (Object.keys(decisions).length > 0) {
    throw new TypeError(USAGE);
  }
  return { adminArgs, after, dryRun, limit };
};

const timestampParts = (value) => {
  const seconds = value?.seconds;
  const nanoseconds = value?.nanoseconds;
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(nanoseconds) ||
    nanoseconds < 0 ||
    nanoseconds >= 1_000_000_000
  ) {
    throw new Error("wager-merge-reconciliation-timestamp-invalid");
  }
  return { nanoseconds, seconds };
};

const compareTimestamps = (left, right) => {
  const leftParts = timestampParts(left);
  const rightParts = timestampParts(right);
  if (leftParts.seconds !== rightParts.seconds) {
    return leftParts.seconds < rightParts.seconds ? -1 : 1;
  }
  if (leftParts.nanoseconds === rightParts.nanoseconds) {
    return 0;
  }
  return leftParts.nanoseconds < rightParts.nanoseconds ? -1 : 1;
};

const parseLedger = (snapshot) => {
  const data = snapshot.data() || {};
  if (data.profileMergeReconciliationVersion !== undefined) {
    if (data.profileMergeReconciliationVersion !== RECONCILIATION_VERSION) {
      throw new Error("wager-merge-reconciliation-version-unsupported");
    }
    const resolutions = {};
    for (const side of ["Winner", "Loser"]) {
      const value = data[`profileMerge${side}Resolution`];
      if (value === undefined) {
        continue;
      }
      if (value !== "included" && value !== "lost") {
        throw new Error("wager-merge-reconciliation-resolution-invalid");
      }
      resolutions[side.toLowerCase()] = value;
    }
    return { reconciled: true, resolutions };
  }
  const readRepairedProfileId = (side) => {
    const version = data[`profileMerge${side}RepairVersion`];
    if (version === undefined) {
      return "";
    }
    const profileId = readSafeFirestoreDocumentId(
      data[`profileMerge${side}CanonicalProfileId`],
      "wager-merge-reconciliation-profile-id-invalid",
    );
    if (version !== RECONCILIATION_VERSION) {
      throw new Error("wager-merge-reconciliation-version-unsupported");
    }
    return profileId;
  };
  const operationId = readSafeFirestoreDocumentId(
    data.operationId,
    `Invalid wager settlement ledger: ${snapshot.id}`,
  );
  const winnerProfileId = readSafeFirestoreDocumentId(
    data.winnerProfileId,
    `Invalid wager settlement ledger: ${snapshot.id}`,
  );
  const loserProfileId = readSafeFirestoreDocumentId(
    data.loserProfileId,
    `Invalid wager settlement ledger: ${snapshot.id}`,
  );
  const material = cleanString(data.material);
  const count = data.count;
  if (
    operationId !== snapshot.id ||
    !cleanString(data.fingerprint) ||
    !MATERIAL_KEYS.includes(material) ||
    !Number.isSafeInteger(count) ||
    count <= 0
  ) {
    throw new Error(`Invalid wager settlement ledger: ${snapshot.id}`);
  }
  timestampParts(snapshot.createTime);
  return {
    reconciled: false,
    count,
    loserProfileId,
    loserRepairedProfileId: readRepairedProfileId("Loser"),
    material,
    operationId,
    winnerProfileId,
    winnerRepairedProfileId: readRepairedProfileId("Winner"),
  };
};

const resolveMergeSide = async ({
  firestore,
  ledgerCreateTime,
  incomingMarkerSnapshots,
  markerSnapshots,
  profileId,
  repairedProfileId,
  transaction,
}) => {
  if (repairedProfileId) {
    return {
      canonicalProfileId: repairedProfileId,
      repairRequired: false,
      repaired: true,
      reviewRequired: false,
    };
  }
  let currentProfileId = profileId;
  let firstMarker = null;
  let followedTargets = 0;
  const visited = new Set();
  while (true) {
    if (visited.has(currentProfileId)) {
      throw new Error("profile-merge-target-cycle");
    }
    visited.add(currentProfileId);
    let marker = markerSnapshots.get(currentProfileId);
    if (!marker) {
      marker = await transaction.get(
        firestore.collection("profileMergeTargets").doc(currentProfileId),
      );
      markerSnapshots.set(currentProfileId, marker);
    }
    if (!marker.exists) {
      if (!firstMarker) {
        let incoming = incomingMarkerSnapshots.get(profileId);
        if (!incoming) {
          incoming = await transaction.get(
            firestore
              .collection("profileMergeTargets")
              .where("targetProfileId", "==", profileId)
              .limit(MAX_INCOMING_MERGE_TARGETS + 1),
          );
          incomingMarkerSnapshots.set(profileId, incoming);
        }
        if (incoming.docs.length > MAX_INCOMING_MERGE_TARGETS) {
          throw new Error(`Too many incoming profile merges: ${profileId}`);
        }
        return {
          canonicalProfileId: currentProfileId,
          repairRequired: false,
          repaired: false,
          reviewRequired: incoming.docs.some(
            (snapshot) =>
              compareTimestamps(ledgerCreateTime, snapshot.createTime) <= 0,
          ),
        };
      }
      const commitOrder = compareTimestamps(
        ledgerCreateTime,
        firstMarker.createTime,
      );
      return {
        canonicalProfileId: currentProfileId,
        repairRequired: commitOrder > 0,
        repaired: false,
        reviewRequired: commitOrder <= 0,
      };
    }
    if (!firstMarker) {
      firstMarker = marker;
    }
    const targetProfileId = readSafeFirestoreDocumentId(
      marker.data()?.targetProfileId,
      `Invalid merge target: ${currentProfileId}`,
    );
    followedTargets += 1;
    if (followedTargets > MAX_PROFILE_MERGE_TARGET_HOPS) {
      throw new Error("profile-merge-target-depth-exceeded");
    }
    currentProfileId = targetProfileId;
  }
};

const buildDeltas = (ledger, winner, loser) => {
  const values = new Map();
  const add = (profileId, count) => {
    values.set(profileId, (values.get(profileId) || 0) + count);
  };
  if (winner.repairRequired) {
    add(winner.canonicalProfileId, ledger.count);
  }
  if (loser.repairRequired) {
    add(loser.canonicalProfileId, -ledger.count);
  }
  return Array.from(values, ([profileId, count]) => ({ profileId, count }))
    .filter((entry) => entry.count !== 0)
    .sort((left, right) => left.profileId.localeCompare(right.profileId));
};

const applyManualDecision = (sideName, side, decisions) => {
  const decision = decisions?.[sideName];
  if (!side.reviewRequired) {
    if (decision !== undefined) {
      throw new Error(`Unexpected ${sideName} resolution decision`);
    }
    return side;
  }
  if (decision === undefined) {
    throw new Error(`Missing ${sideName} resolution decision`);
  }
  if (decision !== "included" && decision !== "lost") {
    throw new Error(`Invalid ${sideName} resolution decision`);
  }
  return {
    ...side,
    repairRequired: decision === "lost",
    reviewRequired: false,
  };
};

const hasExactDecisions = (expected, actual) => {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  return (
    expectedKeys.length === actualKeys.length &&
    expectedKeys.every(
      (key, index) =>
        key === actualKeys[index] && expected[key] === actual[key],
    )
  );
};

const reconcileWagerSettlementDocument = async (
  { decisions, dryRun, firestore, ledgerRef },
  { increment = admin.firestore.FieldValue.increment } = {},
) =>
  firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ledgerRef);
    if (!snapshot.exists) {
      if (decisions !== undefined) {
        throw new Error(`Missing wager settlement ledger: ${ledgerRef.id}`);
      }
      return { action: "missing", operationId: ledgerRef.id };
    }
    const ledger = parseLedger(snapshot);
    if (ledger.reconciled) {
      if (
        decisions !== undefined &&
        !hasExactDecisions(ledger.resolutions, decisions)
      ) {
        throw new Error("Wager settlement resolution decision mismatch");
      }
      return { action: "already-reconciled", operationId: snapshot.id };
    }
    const markerSnapshots = new Map();
    const incomingMarkerSnapshots = new Map();
    let winner = await resolveMergeSide({
      firestore,
      ledgerCreateTime: snapshot.createTime,
      incomingMarkerSnapshots,
      markerSnapshots,
      profileId: ledger.winnerProfileId,
      repairedProfileId: ledger.winnerRepairedProfileId,
      transaction,
    });
    let loser = await resolveMergeSide({
      firestore,
      ledgerCreateTime: snapshot.createTime,
      incomingMarkerSnapshots,
      markerSnapshots,
      profileId: ledger.loserProfileId,
      repairedProfileId: ledger.loserRepairedProfileId,
      transaction,
    });
    const manualResolution = decisions !== undefined;
    if (manualResolution) {
      const reviewRequired = winner.reviewRequired || loser.reviewRequired;
      if (!reviewRequired) {
        throw new Error("Wager settlement does not require manual resolution");
      }
      winner = applyManualDecision("winner", winner, decisions);
      loser = applyManualDecision("loser", loser, decisions);
    }
    const deltas = buildDeltas(ledger, winner, loser);
    const repairRequired = winner.repairRequired || loser.repairRequired;
    const reviewRequired = winner.reviewRequired || loser.reviewRequired;
    const profiles = new Map();
    const repairProfileIds = new Set([
      ...(winner.repairRequired ? [winner.canonicalProfileId] : []),
      ...(loser.repairRequired ? [loser.canonicalProfileId] : []),
    ]);
    for (const profileId of repairProfileIds) {
      const ref = firestore.collection("users").doc(profileId);
      const profile = await transaction.get(ref);
      if (!profile.exists) {
        throw new Error(`Missing canonical profile: ${profileId}`);
      }
      profiles.set(profileId, { ref, snapshot: profile });
    }
    for (const delta of deltas) {
      const profile = profiles.get(delta.profileId).snapshot;
      const data = profile.data() || {};
      const current = data.mining?.materials?.[ledger.material] ?? 0;
      if (
        !Number.isSafeInteger(current) ||
        current < 0 ||
        !Number.isSafeInteger(current + delta.count) ||
        current + delta.count < 0
      ) {
        throw new Error(`Unsafe canonical balance repair: ${delta.profileId}`);
      }
    }
    if (!dryRun) {
      for (const delta of deltas) {
        transaction.update(profiles.get(delta.profileId).ref, {
          [`mining.materials.${ledger.material}`]: increment(delta.count),
        });
      }
      const ledgerPatch = {};
      if (manualResolution) {
        if (decisions.winner !== undefined) {
          ledgerPatch.profileMergeWinnerResolution = decisions.winner;
        }
        if (decisions.loser !== undefined) {
          ledgerPatch.profileMergeLoserResolution = decisions.loser;
        }
      }
      if (winner.repairRequired) {
        ledgerPatch.profileMergeWinnerCanonicalProfileId =
          winner.canonicalProfileId;
        ledgerPatch.profileMergeWinnerRepairVersion = RECONCILIATION_VERSION;
      }
      if (loser.repairRequired) {
        ledgerPatch.profileMergeLoserCanonicalProfileId =
          loser.canonicalProfileId;
        ledgerPatch.profileMergeLoserRepairVersion = RECONCILIATION_VERSION;
      }
      if (!reviewRequired) {
        Object.assign(ledgerPatch, {
          profileMergeLoserCanonicalProfileId: loser.canonicalProfileId,
          profileMergeLoserRepaired: loser.repaired || loser.repairRequired,
          profileMergeReconciliationVersion: RECONCILIATION_VERSION,
          profileMergeWinnerCanonicalProfileId: winner.canonicalProfileId,
          profileMergeWinnerRepaired: winner.repaired || winner.repairRequired,
        });
      }
      if (Object.keys(ledgerPatch).length > 0) {
        transaction.update(ledgerRef, ledgerPatch);
      }
    }
    const action = manualResolution
      ? dryRun
        ? "would-resolve"
        : "resolved"
      : reviewRequired
        ? repairRequired
          ? dryRun
            ? "would-partially-repair"
            : "partially-repaired"
          : "manual-review"
        : repairRequired
          ? dryRun
            ? "would-repair"
            : "repaired"
          : dryRun
            ? "would-verify"
            : "verified";
    return {
      action,
      deltas,
      loser,
      operationId: ledger.operationId,
      winner,
    };
  });

const reconcileWagerSettlementResolution = async (
  options,
  {
    firestore = admin.firestore(),
    increment = admin.firestore.FieldValue.increment,
  } = {},
) => {
  const operationId = readSafeFirestoreDocumentId(
    options.operationId,
    "wager-merge-reconciliation-operation-id-invalid",
  );
  return {
    dryRun: options.dryRun,
    ...(await reconcileWagerSettlementDocument(
      {
        decisions: options.decisions,
        dryRun: options.dryRun,
        firestore,
        ledgerRef: firestore.collection("wagerSettlements").doc(operationId),
      },
      { increment },
    )),
  };
};

const reconcileWagerSettlementPage = async (
  options,
  {
    documentIdField = admin.firestore.FieldPath.documentId(),
    firestore = admin.firestore(),
    increment = admin.firestore.FieldValue.increment,
  } = {},
) => {
  const after = options.after
    ? readSafeFirestoreDocumentId(
        options.after,
        "wager-merge-reconciliation-cursor-invalid",
      )
    : "";
  let query = firestore
    .collection("wagerSettlements")
    .orderBy(documentIdField)
    .limit(options.limit + 1);
  if (after) {
    query = query.startAfter(after);
  }
  const snapshot = await query.get();
  const candidates = snapshot.docs.slice(0, options.limit);
  const results = [];
  for (const candidate of candidates) {
    results.push(
      await reconcileWagerSettlementDocument(
        {
          dryRun: options.dryRun,
          firestore,
          ledgerRef: candidate.ref,
        },
        { increment },
      ),
    );
  }
  const hasMore = snapshot.docs.length > candidates.length;
  const manualReviewRequired = results.some(
    (result) =>
      result.winner?.reviewRequired === true ||
      result.loser?.reviewRequired === true,
  );
  return {
    dryRun: options.dryRun,
    hasMore,
    manualReviewRequired,
    nextCursor:
      hasMore && candidates.length > 0
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
    const result = options.operationId
      ? await reconcileWagerSettlementResolution(options)
      : await reconcileWagerSettlementPage(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    throw addApplicationDefaultCredentialHelp(error);
  } finally {
    await cleanupAdmin();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_INCOMING_MERGE_TARGETS,
  MAX_LIMIT,
  RECONCILIATION_VERSION,
  buildDeltas,
  compareTimestamps,
  main,
  parseArgs,
  reconcileWagerSettlementDocument,
  reconcileWagerSettlementPage,
  reconcileWagerSettlementResolution,
};
