const admin = require("./firebaseAdmin");
const { onValueWritten } = require("firebase-functions/v2/database");
const {
  NAVIGATION_SORT_BUCKETS: SORT_BUCKETS,
} = require("@mons/shared/navigation");
const NAVIGATION_PARTICIPANT_PREVIEW_LIMIT = 6;
const MAX_BATCH_WRITES = 450;
const MAX_TIMESTAMP_MS = 253402300799999;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const normalizeFiniteNumberOrNull = (value) => {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const normalized = Math.floor(numeric);
  return normalized > 0 ? normalized : null;
};

const toTimestamp = (millis) => {
  const normalized =
    typeof millis === "number" && Number.isFinite(millis)
      ? Math.floor(millis)
      : Date.now();
  return admin.firestore.Timestamp.fromMillis(Math.max(1, normalized));
};

const mapEventStatusToNavigationStatus = (status) => {
  if (status === "active") {
    return "active";
  }
  if (status === "ended") {
    return "ended";
  }
  if (status === "dismissed") {
    return "dismissed";
  }
  return "waiting";
};

const getListSortAtMs = (eventData, status) => {
  if (status === "active") {
    const startedAtMs =
      typeof eventData.startedAtMs === "number"
        ? Math.floor(eventData.startedAtMs)
        : typeof eventData.startAtMs === "number"
          ? Math.floor(eventData.startAtMs)
          : typeof eventData.createdAtMs === "number"
            ? Math.floor(eventData.createdAtMs)
            : null;
    if (startedAtMs && Number.isFinite(startedAtMs) && startedAtMs > 0) {
      return startedAtMs;
    }
    return 1;
  }
  if (status === "ended") {
    return typeof eventData.endedAtMs === "number"
      ? Math.floor(eventData.endedAtMs)
      : typeof eventData.startAtMs === "number"
        ? Math.floor(eventData.startAtMs)
        : typeof eventData.createdAtMs === "number"
          ? Math.floor(eventData.createdAtMs)
          : 1;
  }
  if (status === "dismissed") {
    return typeof eventData.endedAtMs === "number"
      ? Math.floor(eventData.endedAtMs)
      : typeof eventData.startAtMs === "number"
        ? Math.floor(eventData.startAtMs)
        : typeof eventData.createdAtMs === "number"
          ? Math.floor(eventData.createdAtMs)
          : 1;
  }
  const startAtMs =
    typeof eventData.startAtMs === "number"
      ? Math.floor(eventData.startAtMs)
      : null;
  if (startAtMs === null || !Number.isFinite(startAtMs) || startAtMs <= 0) {
    return typeof eventData.createdAtMs === "number"
      ? Math.floor(eventData.createdAtMs)
      : 1;
  }
  return Math.min(MAX_TIMESTAMP_MS, Math.max(1, MAX_TIMESTAMP_MS - startAtMs));
};

const buildProjectionFingerprint = (eventData) => {
  if (!eventData || typeof eventData !== "object") {
    return "null";
  }
  const participants =
    eventData.participants && typeof eventData.participants === "object"
      ? eventData.participants
      : {};
  const status = mapEventStatusToNavigationStatus(
    normalizeString(eventData.status),
  );
  const fullPreviewParticipants = buildPreviewParticipants(participants);
  const participantPreview = fullPreviewParticipants.slice(
    0,
    NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
  );
  const ownerProfileIds = getOwnerProfileIds(participants).sort();
  return JSON.stringify({
    status,
    sortBucket: SORT_BUCKETS[status],
    listSortAtMs: getListSortAtMs(eventData, status),
    startAtMs: normalizeFiniteNumberOrNull(eventData.startAtMs),
    endedAtMs: normalizeFiniteNumberOrNull(eventData.endedAtMs),
    winnerDisplayName: normalizeString(eventData.winnerDisplayName),
    participantCount: fullPreviewParticipants.length,
    participantPreview,
    ownerProfileIds,
  });
};

const buildPreviewParticipants = (participants) => {
  return Object.values(participants || {})
    .filter((participant) => participant && typeof participant === "object")
    .sort((left, right) => {
      const leftJoined =
        typeof left.joinedAtMs === "number" ? left.joinedAtMs : 0;
      const rightJoined =
        typeof right.joinedAtMs === "number" ? right.joinedAtMs : 0;
      return leftJoined - rightJoined;
    })
    .map((participant) => ({
      profileId: normalizeString(participant.profileId),
      displayName: normalizeString(participant.displayName),
      emojiId: normalizeFiniteNumberOrNull(participant.emojiId),
      aura: normalizeString(participant.aura),
    }));
};

const getOwnerProfileIds = (participants) => {
  return Array.from(
    new Set(
      Object.values(participants || {})
        .map((participant) =>
          normalizeString(participant && participant.profileId),
        )
        .filter((value) => !!value),
    ),
  );
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
