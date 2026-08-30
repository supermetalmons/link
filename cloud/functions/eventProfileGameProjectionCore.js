"use strict";

const {
  NAVIGATION_SORT_BUCKETS: SORT_BUCKETS,
} = require("@mons/shared/navigation");
const {
  getCanonicalProfileId,
  profileOwnershipUnavailable,
  resolveOwnedProfileReferences,
} = require("./events/ownership");
const {
  NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
  buildPreviewParticipants,
  getListSortAtMs,
  getOwnerProfileIds,
  mapEventStatusToNavigationStatus,
  normalizeString,
} = require("./events/eventProjectionModel");

const READ_RETRY_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 25;

const defaultWait = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const createEventProfileGameProjectionCore = ({
  now = Date.now,
  repository,
  wait = defaultWait,
}) => {
  if (!repository) {
    throw new TypeError(
      "event profile-game projection dependencies are required",
    );
  }

  const toTimestampMillis = (millis) => {
    const normalized =
      typeof millis === "number" && Number.isFinite(millis)
        ? Math.floor(millis)
        : now();
    return Math.max(1, normalized);
  };

  const readWithRetries = async (read) => {
    let failure = null;
    for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await read();
      } catch (error) {
        failure = error;
        if (attempt < READ_RETRY_ATTEMPTS) {
          await wait(READ_RETRY_DELAY_MS);
        }
      }
    }
    throw failure;
  };

  const participantEntries = (participants) =>
    Object.entries(participants).flatMap(([key, value]) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? [
            {
              key: normalizeString(key),
              loginUid: normalizeString(value.loginUid),
              participant: value,
              profileId:
                normalizeString(value.profileId) || normalizeString(key),
            },
          ]
        : [],
    );

  const readOwnershipPlan = async (participants, cleanupOwnerProfileIds) => {
    const entries = participantEntries(participants);
    const cleanupProfileIds = Array.from(
      new Set(cleanupOwnerProfileIds.map(normalizeString).filter(Boolean)),
    );
    const loginUids = Array.from(
      new Set(entries.map(({ loginUid }) => loginUid).filter(Boolean)),
    );
    const storedProfileIds = Array.from(
      new Set(
        [
          ...entries.flatMap(({ key, profileId }) => [key, profileId]),
          ...cleanupProfileIds,
        ].filter(Boolean),
      ),
    );
    const ownership = await repository.readProfileOwnershipSnapshot({
      loginUids,
      profileIds: storedProfileIds,
    });
    if (
      !ownership ||
      !(ownership.loginOwnerByUid instanceof Map) ||
      !(ownership.canonicalProfileIdByProfileId instanceof Map) ||
      loginUids.some((loginUid) => !ownership.loginOwnerByUid.has(loginUid)) ||
      storedProfileIds.some(
        (profileId) => !ownership.canonicalProfileIdByProfileId.has(profileId),
      )
    ) {
      throw profileOwnershipUnavailable();
    }
    const ownerProfileIds = resolveOwnedProfileReferences(
      ownership,
      entries.map(({ loginUid, profileId }) => ({ loginUid, profileId })),
    );
    const canonicalParticipants = {};
    entries.forEach((entry, index) => {
      const ownerProfileId = ownerProfileIds[index];
      canonicalParticipants[ownerProfileId] = {
        ...entry.participant,
        profileId: ownerProfileId,
      };
    });
    const allProfileIds = new Set([
      ...entries.flatMap(({ key, profileId }) => [key, profileId]),
      ...cleanupProfileIds,
      ...ownerProfileIds,
    ]);
    for (const profileId of storedProfileIds) {
      const canonicalProfileId = getCanonicalProfileId(ownership, profileId);
      if (canonicalProfileId) allProfileIds.add(canonicalProfileId);
    }
    const currentOwnerIds = new Set(ownerProfileIds);
    return {
      allOwnerProfileIds: [
        ...ownerProfileIds,
        ...Array.from(allProfileIds).filter(
          (profileId) => profileId && !currentOwnerIds.has(profileId),
        ),
      ],
      canonicalParticipants,
      ownerProfileIds,
    };
  };

  const projectEvent = async (
    eventId,
    eventData,
    cleanupOwnerProfileIds = [],
  ) => {
    const participants =
      eventData?.participants && typeof eventData.participants === "object"
        ? eventData.participants
        : {};
    const normalizedCleanupOwnerProfileIds = Array.from(
      new Set(cleanupOwnerProfileIds.map(normalizeString).filter(Boolean)),
    );
    const {
      allOwnerProfileIds,
      canonicalParticipants,
      ownerProfileIds: afterOwnerProfileIds,
    } = await readOwnershipPlan(participants, normalizedCleanupOwnerProfileIds);

    const status = mapEventStatusToNavigationStatus(
      normalizeString(eventData?.status),
    );
    const previewParticipants = buildPreviewParticipants(canonicalParticipants);
    const currentOwnerIds = new Set(afterOwnerProfileIds);
    const writes = [];
    if (eventData) {
      for (const ownerProfileId of afterOwnerProfileIds) {
        writes.push({
          type: "merge",
          profileId: ownerProfileId,
          eventId,
          data: {
            schemaVersion: 1,
            source: "event-projector",
            entityType: "event",
            id: `event_${eventId}`,
            eventId,
            status,
            sortBucket: SORT_BUCKETS[status],
            listSortAt: toTimestampMillis(getListSortAtMs(eventData, status)),
            ownerProfileId,
            startAt:
              typeof eventData.startAtMs === "number"
                ? toTimestampMillis(eventData.startAtMs)
                : null,
            updatedAt: toTimestampMillis(
              typeof eventData.updatedAtMs === "number"
                ? eventData.updatedAtMs
                : now(),
            ),
            endedAt:
              typeof eventData.endedAtMs === "number"
                ? toTimestampMillis(eventData.endedAtMs)
                : null,
            participantCount: previewParticipants.length,
            participantPreview: previewParticipants.slice(
              0,
              NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
            ),
            winnerDisplayName: normalizeString(eventData.winnerDisplayName),
          },
        });
      }
    }
    for (const profileId of allOwnerProfileIds) {
      if (!eventData || !currentOwnerIds.has(profileId)) {
        writes.push({ type: "delete", profileId, eventId });
      }
    }
    await repository.commitProjectionWrites(writes);
    return {
      deleted: writes.filter((write) => write.type === "delete").length,
      ownerProfileIds: afterOwnerProfileIds,
      written: writes.filter((write) => write.type !== "delete").length,
    };
  };

  const reconcileEventProjection = async (
    eventId,
    cleanupOwnerProfileIds = [],
  ) => {
    const cleanupIds = new Set(
      cleanupOwnerProfileIds.map(normalizeString).filter(Boolean),
    );
    const liveData = await readWithRetries(() => repository.getEvent(eventId));
    getOwnerProfileIds(
      liveData?.participants && typeof liveData.participants === "object"
        ? liveData.participants
        : {},
    ).forEach((profileId) => cleanupIds.add(profileId));
    const result = await projectEvent(
      eventId,
      liveData,
      Array.from(cleanupIds),
    );
    return {
      ...result,
      status: liveData === null ? "missing" : "projected",
    };
  };

  return {
    projectEvent,
    reconcileEventProjection,
  };
};

module.exports = {
  READ_RETRY_ATTEMPTS,
  READ_RETRY_DELAY_MS,
  createEventProfileGameProjectionCore,
};
