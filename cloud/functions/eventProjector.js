const admin = require("./firebaseAdmin");
const { onValueWritten } = require("firebase-functions/v2/database");
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

const toTimestamp = (millis) => {
  const normalized =
    typeof millis === "number" && Number.isFinite(millis)
      ? Math.floor(millis)
      : Date.now();
  return admin.firestore.Timestamp.fromMillis(Math.max(1, normalized));
};

async function projectEvent(eventId, beforeData, afterData) {
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
  const beforeOwnerProfileIds = getOwnerProfileIds(beforeParticipants);
  const afterOwnerProfileIds = getOwnerProfileIds(afterParticipants);
  const allOwnerProfileIds = Array.from(
    new Set([...beforeOwnerProfileIds, ...afterOwnerProfileIds]),
  );
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

const onEventWritten = onValueWritten(
  {
    ref: "/events/{eventId}",
    maxInstances: 10,
    concurrency: 40,
    memory: "256MiB",
    cpu: 1,
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
    await projectEvent(eventId, beforeData, afterData);
  },
);

module.exports = {
  onEventWritten,
};
