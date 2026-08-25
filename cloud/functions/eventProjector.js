const admin = require("./firebaseAdmin");
const { onValueWritten } = require("firebase-functions/v2/database");
const {
  PROFILE_MERGE_TARGETS_COLLECTION,
  resolveProfileMergeTargetPath,
} = require("./profileMergeTargets");
const {
  NAVIGATION_SORT_BUCKETS: SORT_BUCKETS,
} = require("@mons/shared/navigation");
const {
  NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
  buildPreviewParticipants,
  buildProjectionFingerprint,
  getListSortAtMs,
  getOwnerProfileIds,
  mapEventStatusToNavigationStatus,
  normalizeString,
} = require("./events/eventProjectionModel");
const MAX_BATCH_WRITES = 450;
const EVENT_PROJECTION_RECONCILE_ATTEMPTS = 3;
const PROFILE_PATH_RESOLVE_CONCURRENCY = 10;
const READ_RETRY_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 25;

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const readWithRetries = async (read) => {
  let failure = null;
  for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      failure = error;
      if (attempt < READ_RETRY_ATTEMPTS) {
        await delay(READ_RETRY_DELAY_MS);
      }
    }
  }
  throw failure;
};

const toTimestamp = (millis) => {
  const normalized =
    typeof millis === "number" && Number.isFinite(millis)
      ? Math.floor(millis)
      : Date.now();
  return admin.firestore.Timestamp.fromMillis(Math.max(1, normalized));
};

const resolveProfilePath = (firestore, profileId) =>
  resolveProfileMergeTargetPath({
    profileId,
    readMergeTarget: async (candidateProfileId) => {
      const snapshot = await readWithRetries(() =>
        firestore
          .collection(PROFILE_MERGE_TARGETS_COLLECTION)
          .doc(candidateProfileId)
          .get(),
      );
      return snapshot.exists ? snapshot.data() : null;
    },
  });

const resolveProfilePaths = async (firestore, profileIds) => {
  const ids = Array.from(new Set(profileIds));
  const paths = new Map();
  let index = 0;
  const workers = Array.from(
    { length: Math.min(PROFILE_PATH_RESOLVE_CONCURRENCY, ids.length) },
    async () => {
      while (index < ids.length) {
        const currentIndex = index;
        index += 1;
        const profileId = ids[currentIndex];
        paths.set(profileId, await resolveProfilePath(firestore, profileId));
      }
    },
  );
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    throw failure.reason;
  }
  return paths;
};

const buildEventProjectionOwnerPlan = ({
  afterOwnerPaths,
  beforeOwnerPaths,
  cleanupOwnerPaths = [],
  rawAfterOwnerProfileIds,
  rawBeforeOwnerProfileIds,
}) => {
  const afterOwnerProfileIds = Array.from(
    new Set(
      afterOwnerPaths
        .map((profileIds) => profileIds[profileIds.length - 1])
        .filter(Boolean),
    ),
  );
  const allProfileIds = Array.from(
    new Set(
      [
        ...rawBeforeOwnerProfileIds,
        ...rawAfterOwnerProfileIds,
        ...beforeOwnerPaths.flat(),
        ...afterOwnerPaths.flat(),
        ...cleanupOwnerPaths.flat(),
      ]
        .map(normalizeString)
        .filter(Boolean),
    ),
  );
  const currentOwnerIds = new Set(afterOwnerProfileIds);
  const allOwnerProfileIds = [
    ...afterOwnerProfileIds,
    ...allProfileIds.filter((profileId) => !currentOwnerIds.has(profileId)),
  ];
  return { afterOwnerProfileIds, allOwnerProfileIds };
};

const verifyCurrentOwnerProfiles = async (firestore, profileIds) => {
  for (
    let index = 0;
    index < profileIds.length;
    index += PROFILE_PATH_RESOLVE_CONCURRENCY
  ) {
    const ids = profileIds.slice(
      index,
      index + PROFILE_PATH_RESOLVE_CONCURRENCY,
    );
    const snapshots = await Promise.all(
      ids.map((profileId) =>
        readWithRetries(() =>
          firestore.collection("users").doc(profileId).get(),
        ),
      ),
    );
    const missingIndex = snapshots.findIndex((snapshot) => !snapshot.exists);
    if (missingIndex >= 0) {
      throw new Error(`projector:event-owner-missing:${ids[missingIndex]}`);
    }
    const retiredIndex = snapshots.findIndex((snapshot) =>
      normalizeString((snapshot.data?.() || {}).mergedIntoProfileId),
    );
    if (retiredIndex >= 0) {
      throw new Error(`projector:event-owner-retired:${ids[retiredIndex]}`);
    }
  }
};

async function projectEvent(eventId, beforeData, afterData, options = {}) {
  const firestore = admin.firestore();
  const docId = `event_${eventId}`;
  const beforeParticipants =
    beforeData &&
    beforeData.participants &&
    typeof beforeData.participants === "object"
      ? beforeData.participants
      : {};
  const afterParticipants =
    afterData &&
    afterData.participants &&
    typeof afterData.participants === "object"
      ? afterData.participants
      : {};
  const rawBeforeOwnerProfileIds = getOwnerProfileIds(beforeParticipants);
  const rawAfterOwnerProfileIds = getOwnerProfileIds(afterParticipants);
  const cleanupOwnerProfileIds = Array.from(
    new Set(
      (options.cleanupOwnerProfileIds || [])
        .map(normalizeString)
        .filter(Boolean),
    ),
  );
  const resolvedPaths = await resolveProfilePaths(firestore, [
    ...rawBeforeOwnerProfileIds,
    ...rawAfterOwnerProfileIds,
    ...cleanupOwnerProfileIds,
  ]);
  const pathsFor = (profileIds) =>
    profileIds.map((profileId) => resolvedPaths.get(profileId) || [profileId]);
  const beforeOwnerPaths = pathsFor(rawBeforeOwnerProfileIds);
  const afterOwnerPaths = pathsFor(rawAfterOwnerProfileIds);
  const cleanupOwnerPaths = pathsFor(cleanupOwnerProfileIds);
  const { afterOwnerProfileIds, allOwnerProfileIds } =
    buildEventProjectionOwnerPlan({
      afterOwnerPaths,
      beforeOwnerPaths,
      cleanupOwnerPaths,
      rawAfterOwnerProfileIds,
      rawBeforeOwnerProfileIds,
    });
  await verifyCurrentOwnerProfiles(firestore, afterOwnerProfileIds);
  const status = mapEventStatusToNavigationStatus(
    normalizeString(afterData && afterData.status),
  );
  const previewParticipants = buildPreviewParticipants(afterParticipants);

  let batch = firestore.batch();
  let writesCount = 0;
  const commitBatchIfNeeded = async (force = false) => {
    if (!force && writesCount < MAX_BATCH_WRITES) {
      return;
    }
    if (writesCount <= 0) {
      return;
    }
    await batch.commit();
    batch = firestore.batch();
    writesCount = 0;
  };

  for (const ownerProfileId of allOwnerProfileIds) {
    const ref = firestore
      .collection("users")
      .doc(ownerProfileId)
      .collection("games")
      .doc(docId);
    if (!afterData || !afterOwnerProfileIds.includes(ownerProfileId)) {
      batch.delete(ref);
      writesCount += 1;
      await commitBatchIfNeeded();
      continue;
    }

    const payload = {
      schemaVersion: 1,
      source: "event-projector",
      entityType: "event",
      id: docId,
      eventId,
      status,
      sortBucket: SORT_BUCKETS[status],
      listSortAt: toTimestamp(getListSortAtMs(afterData, status)),
      ownerProfileId,
      startAt:
        typeof afterData.startAtMs === "number"
          ? toTimestamp(afterData.startAtMs)
          : null,
      updatedAt: toTimestamp(
        typeof afterData.updatedAtMs === "number"
          ? afterData.updatedAtMs
          : Date.now(),
      ),
      endedAt:
        typeof afterData.endedAtMs === "number"
          ? toTimestamp(afterData.endedAtMs)
          : null,
      participantCount: previewParticipants.length,
      participantPreview: previewParticipants.slice(
        0,
        NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
      ),
      winnerDisplayName: normalizeString(afterData.winnerDisplayName),
    };

    batch.set(ref, payload, { merge: true });
    writesCount += 1;
    await commitBatchIfNeeded();
  }

  await commitBatchIfNeeded(true);
}

const reconcileLiveEventProjection = async (
  eventId,
  beforeData,
  afterData,
  dependencies = {},
) => {
  const readLiveEvent =
    dependencies.readLiveEvent ||
    (async () => {
      const liveSnapshot = await readWithRetries(() =>
        admin.database().ref(`events/${eventId}`).once("value"),
      );
      return liveSnapshot.exists() ? liveSnapshot.val() : null;
    });
  const projectEventImpl = dependencies.projectEvent || projectEvent;
  const cleanupOwnerProfileIds = new Set([
    ...getOwnerProfileIds(
      beforeData && typeof beforeData.participants === "object"
        ? beforeData.participants
        : {},
    ),
    ...getOwnerProfileIds(
      afterData && typeof afterData.participants === "object"
        ? afterData.participants
        : {},
    ),
  ]);
  let liveData = await readLiveEvent(eventId);
  for (
    let attempt = 0;
    attempt < EVENT_PROJECTION_RECONCILE_ATTEMPTS;
    attempt += 1
  ) {
    getOwnerProfileIds(
      liveData && typeof liveData.participants === "object"
        ? liveData.participants
        : {},
    ).forEach((profileId) => cleanupOwnerProfileIds.add(profileId));
    await projectEventImpl(eventId, beforeData, liveData, {
      cleanupOwnerProfileIds: Array.from(cleanupOwnerProfileIds),
    });
    const confirmedData = await readLiveEvent(eventId);
    if (
      buildProjectionFingerprint(confirmedData) ===
      buildProjectionFingerprint(liveData)
    ) {
      return;
    }
    liveData = confirmedData;
  }
  throw new Error("projector:event-reconcile-exhausted");
};

const onEventWritten = onValueWritten(
  {
    ref: "/events/{eventId}",
    maxInstances: 10,
    concurrency: 40,
    memory: "256MiB",
    cpu: 1,
    retry: true,
  },
  async (event) => {
    const eventId = normalizeString(event.params.eventId);
    if (!eventId) {
      return;
    }
    const beforeData = event.data.before.exists()
      ? event.data.before.val()
      : null;
    const afterData = event.data.after.exists() ? event.data.after.val() : null;
    const beforeFingerprint = buildProjectionFingerprint(beforeData);
    const afterFingerprint = buildProjectionFingerprint(afterData);
    if (beforeFingerprint === afterFingerprint) {
      return;
    }
    await reconcileLiveEventProjection(eventId, beforeData, afterData);
  },
);

module.exports = {
  buildEventProjectionOwnerPlan,
  onEventWritten,
  projectEvent,
  reconcileLiveEventProjection,
  resolveProfilePaths,
};
