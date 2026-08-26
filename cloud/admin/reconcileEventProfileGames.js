#!/usr/bin/env node

"use strict";

const { isSafeFirebaseKey } = require("@mons/shared/ids");
const { NAVIGATION_SORT_BUCKETS } = require("@mons/shared/navigation");
const {
  buildProjectionFingerprint,
  getOwnerProfileIds,
} = require("../functions/events/eventProjectionModel");
const {
  resolveProfileMergeTargetPath,
} = require("../functions/profileMergeTargets");

const SAMPLE_SCAN_LIMIT = 100;
const WAIT_INTERVAL_MS = 5_000;
const WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const USAGE =
  "Usage: node cloud/admin/reconcileEventProfileGames.js (--sample | --event-id <id>) [--project <id>] [--database-url <url>] [--dry-run | --execute [--wait]]";

const parseArgs = (argv) => {
  let dryRun = true;
  let eventId = "";
  let sample = false;
  let wait = false;
  let modeSet = false;
  const adminArgs = [];
  const valueFlags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project" || arg === "--database-url") {
      const value = argv[++index];
      if (valueFlags.has(arg) || !value || value.startsWith("--")) {
        throw new TypeError(USAGE);
      }
      valueFlags.add(arg);
      adminArgs.push(arg, value);
      continue;
    }
    if (arg === "--event-id") {
      const value = argv[++index];
      if (
        eventId ||
        !value ||
        value.startsWith("--") ||
        !isSafeFirebaseKey(value)
      ) {
        throw new TypeError(USAGE);
      }
      eventId = value;
      continue;
    }
    if (arg === "--sample") {
      if (sample) {
        throw new TypeError(USAGE);
      }
      sample = true;
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
    if (arg === "--wait") {
      if (wait) {
        throw new TypeError(USAGE);
      }
      wait = true;
      continue;
    }
    throw new TypeError(USAGE);
  }

  if (sample === Boolean(eventId) || (wait && dryRun)) {
    throw new TypeError(USAGE);
  }
  return { adminArgs, dryRun, eventId, sample, wait };
};

const toRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;

const ownerProfileIds = (event) =>
  getOwnerProfileIds(toRecord(event)?.participants || {}).filter(
    (profileId) =>
      typeof profileId === "string" && isSafeFirebaseKey(profileId),
  );

const selectSampleEvent = async (database) => {
  let cursor = "";
  while (true) {
    let query = database.ref("events").orderByKey();
    if (cursor) {
      query = query.startAt(cursor);
    }
    const snapshot = await query
      .limitToFirst(SAMPLE_SCAN_LIMIT + (cursor ? 1 : 0))
      .once("value");
    const entries = [];
    snapshot.forEach((child) => {
      if (child.key !== cursor) {
        entries.push([child.key, child.val()]);
      }
      return false;
    });
    for (const [eventId, event] of entries) {
      if (isSafeFirebaseKey(eventId) && ownerProfileIds(event).length > 0) {
        return { eventId, event };
      }
    }
    if (entries.length < SAMPLE_SCAN_LIMIT) {
      throw new Error("No valid event with projection owners was found.");
    }
    cursor = entries[entries.length - 1][0];
  }
};

const readSelectedEvent = async (database, eventId) => {
  const snapshot = await database.ref(`events/${eventId}`).once("value");
  const event = toRecord(snapshot.val());
  if (!event) {
    throw new Error(`Event ${eventId} was not found.`);
  }
  return { eventId, event };
};

const writeRecoveryOutbox = async ({
  database,
  eventId,
  profileIds,
  requestId,
}) => {
  const path = `profileGameProjectionOutbox/event/${eventId}`;
  const result = await database.ref(path).transaction(
    (current) => {
      const record = toRecord(current) || {};
      const cleanup = Object.fromEntries(
        Object.entries(toRecord(record.cleanupOwnerProfileIds) || {}).filter(
          ([profileId, included]) =>
            isSafeFirebaseKey(profileId) && included === true,
        ),
      );
      for (const profileId of profileIds) {
        cleanup[profileId] = true;
      }
      return {
        ...record,
        schemaVersion: 1,
        status: "pending",
        requestId,
        lastQueuedAtMs: 0,
        reason: null,
        deadAtMs: null,
        cleanupOwnerProfileIds: cleanup,
      };
    },
    undefined,
    false,
  );
  if (!result.committed) {
    throw new Error("Event profile-game recovery marker was not committed.");
  }
};

const waitForSettlement = async ({
  database,
  eventId,
  timeoutMs = WAIT_TIMEOUT_MS,
}) => {
  const path = `profileGameProjectionOutbox/event/${eventId}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await database.ref(path).once("value");
    if (!snapshot.exists()) {
      return;
    }
    const value = toRecord(snapshot.val());
    if (value?.status === "dead") {
      throw new Error("Event profile-game recovery marker was dead-lettered.");
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  throw new Error("Timed out waiting for event profile-game reconciliation.");
};

const resolveCanonicalOwnerIds = async (firestore, profileIds) => {
  const canonicalIds = [];
  for (const profileId of profileIds) {
    const path = await resolveProfileMergeTargetPath({
      profileId,
      readMergeTarget: async (candidateProfileId) => {
        const snapshot = await firestore
          .collection("profileMergeTargets")
          .doc(candidateProfileId)
          .get();
        return snapshot.exists ? snapshot.data() || null : null;
      },
    });
    const canonicalId = path[path.length - 1];
    if (canonicalId && !canonicalIds.includes(canonicalId)) {
      canonicalIds.push(canonicalId);
    }
  }
  return canonicalIds;
};

const timestampMillis = (value) => value?.toMillis?.() ?? null;

const verifyProjection = async ({ database, eventId, firestore }) => {
  const { event } = await readSelectedEvent(database, eventId);
  const profileIds = ownerProfileIds(event);
  const canonicalIds = await resolveCanonicalOwnerIds(firestore, profileIds);
  const expected = JSON.parse(buildProjectionFingerprint(event));
  const projectionSnapshot = await firestore
    .collectionGroup("games")
    .where("eventId", "==", eventId)
    .get();
  const actualOwnerIds = projectionSnapshot.docs
    .map((snapshot) => snapshot.ref.parent.parent?.id || "")
    .filter(Boolean)
    .sort();
  const expectedOwnerIds = [...canonicalIds].sort();
  if (JSON.stringify(actualOwnerIds) !== JSON.stringify(expectedOwnerIds)) {
    throw new Error("Projection owner verification failed.");
  }
  for (const snapshot of projectionSnapshot.docs) {
    const profileId = snapshot.ref.parent.parent?.id || "";
    const data = snapshot.data() || {};
    if (
      !snapshot.exists ||
      data.schemaVersion !== 1 ||
      data.source !== "event-projector" ||
      data.entityType !== "event" ||
      data.id !== `event_${eventId}` ||
      data.eventId !== eventId ||
      data.ownerProfileId !== profileId ||
      data.status !== expected.status ||
      data.sortBucket !== NAVIGATION_SORT_BUCKETS[expected.status] ||
      timestampMillis(data.listSortAt) !== expected.listSortAtMs ||
      timestampMillis(data.startAt) !== expected.startAtMs ||
      timestampMillis(data.endedAt) !== expected.endedAtMs ||
      data.winnerDisplayName !== expected.winnerDisplayName ||
      data.participantCount !== expected.participantCount ||
      JSON.stringify(data.participantPreview) !==
        JSON.stringify(expected.participantPreview)
    ) {
      throw new Error(`Projection verification failed for ${profileId}.`);
    }
  }
  return { ownerProfileIds: canonicalIds, status: expected.status };
};

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const {
    addApplicationDefaultCredentialHelp,
    admin,
    cleanupAdmin,
    initAdmin,
  } = require("./_admin");
  if (!initAdmin(options.adminArgs)) {
    throw new Error("Failed to initialize Admin SDK.");
  }
  try {
    const database = admin.database();
    const selected = options.sample
      ? await selectSampleEvent(database)
      : await readSelectedEvent(database, options.eventId);
    const profileIds = ownerProfileIds(selected.event);
    const summary = {
      dryRun: options.dryRun,
      eventId: selected.eventId,
      ownerProfileIds: profileIds,
    };
    if (options.dryRun) {
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    }
    const firestore = admin.firestore();
    const operationId = crypto.randomUUID();
    const requestId = `manual-${operationId}`;
    const verificationProfileId = `projection-check-${operationId}`;
    const sentinelRef = firestore
      .collection("users")
      .doc(verificationProfileId)
      .collection("games")
      .doc(`event_${selected.eventId}`);
    let sentinelCreated = false;
    try {
      if (options.wait) {
        await sentinelRef.set({
          eventId: selected.eventId,
          ownerProfileId: verificationProfileId,
          source: "verification-sentinel",
        });
        sentinelCreated = true;
      }
      await writeRecoveryOutbox({
        database,
        eventId: selected.eventId,
        profileIds: options.wait
          ? [...profileIds, verificationProfileId]
          : profileIds,
        requestId,
      });
      if (!options.wait) {
        const result = { ...summary, requestId };
        console.log(JSON.stringify(result, null, 2));
        return result;
      }
      await waitForSettlement({ database, eventId: selected.eventId });
      const verification = await verifyProjection({
        database,
        eventId: selected.eventId,
        firestore,
      });
      const result = { ...summary, requestId, verification };
      console.log(JSON.stringify(result, null, 2));
      return result;
    } finally {
      if (sentinelCreated) {
        await sentinelRef.delete();
      }
    }
  } catch (error) {
    throw addApplicationDefaultCredentialHelp(error);
  } finally {
    await cleanupAdmin();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  SAMPLE_SCAN_LIMIT,
  WAIT_INTERVAL_MS,
  WAIT_TIMEOUT_MS,
  main,
  ownerProfileIds,
  parseArgs,
  readSelectedEvent,
  resolveCanonicalOwnerIds,
  selectSampleEvent,
  verifyProjection,
  waitForSettlement,
  writeRecoveryOutbox,
};
