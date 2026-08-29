"use strict";

const {
  NAVIGATION_SORT_BUCKETS: SORT_BUCKETS,
} = require("@mons/shared/navigation");
const { resolveProfileMergeTargetPath } = require("./profileMergeTargets");
const {
  NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
  buildPreviewParticipants,
  buildProjectionFingerprint,
  getListSortAtMs,
  getOwnerProfileIds,
  mapEventStatusToNavigationStatus,
  normalizeString,
} = require("./events/eventProjectionModel");

const EVENT_PROJECTION_RECONCILE_ATTEMPTS = 3;
const PROFILE_PATH_RESOLVE_CONCURRENCY = 10;
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

  const resolveProfilePath = (profileId) =>
    resolveProfileMergeTargetPath({
      profileId,
      readMergeTarget: (candidateProfileId) =>
        readWithRetries(() => repository.getMergeTarget(candidateProfileId)),
    });

  const resolveProfilePaths = async (profileIds) => {
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
          paths.set(profileId, await resolveProfilePath(profileId));
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

  const verifyCurrentOwnerProfiles = async (profileIds) => {
    for (
      let index = 0;
      index < profileIds.length;
      index += PROFILE_PATH_RESOLVE_CONCURRENCY
    ) {
      const ids = profileIds.slice(
        index,
        index + PROFILE_PATH_RESOLVE_CONCURRENCY,
      );
      const profiles = await Promise.all(
        ids.map((profileId) =>
          readWithRetries(() => repository.getProfile(profileId)),
        ),
      );
      const missingIndex = profiles.findIndex((profile) => !profile);
      if (missingIndex >= 0) {
        throw new Error(`projector:event-owner-missing:${ids[missingIndex]}`);
      }
      const retiredIndex = profiles.findIndex((profile) =>
        normalizeString(profile?.data?.mergedIntoProfileId),
      );
      if (retiredIndex >= 0) {
        throw new Error(`projector:event-owner-retired:${ids[retiredIndex]}`);
      }
    }
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
    const rawOwnerProfileIds = getOwnerProfileIds(participants);
    const normalizedCleanupOwnerProfileIds = Array.from(
      new Set(cleanupOwnerProfileIds.map(normalizeString).filter(Boolean)),
    );
    const resolvedPaths = await resolveProfilePaths([
      ...rawOwnerProfileIds,
      ...normalizedCleanupOwnerProfileIds,
    ]);
    const pathsFor = (profileIds) =>
      profileIds.map(
        (profileId) => resolvedPaths.get(profileId) || [profileId],
      );
    const { afterOwnerProfileIds, allOwnerProfileIds } =
      buildEventProjectionOwnerPlan({
        afterOwnerPaths: pathsFor(rawOwnerProfileIds),
        cleanupOwnerPaths: pathsFor(normalizedCleanupOwnerProfileIds),
        rawAfterOwnerProfileIds: rawOwnerProfileIds,
      });
    await verifyCurrentOwnerProfiles(afterOwnerProfileIds);

    const status = mapEventStatusToNavigationStatus(
      normalizeString(eventData?.status),
    );
    const previewParticipants = buildPreviewParticipants(participants);
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
    let liveData = await readWithRetries(() => repository.getEvent(eventId));
    for (
      let attempt = 0;
      attempt < EVENT_PROJECTION_RECONCILE_ATTEMPTS;
      attempt += 1
    ) {
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
      const confirmedData = await readWithRetries(() =>
        repository.getEvent(eventId),
      );
      if (
        buildProjectionFingerprint(confirmedData) ===
        buildProjectionFingerprint(liveData)
      ) {
        return {
          ...result,
          status: confirmedData === null ? "missing" : "projected",
        };
      }
      liveData = confirmedData;
    }
    throw new Error("projector:event-reconcile-exhausted");
  };

  return {
    projectEvent,
    reconcileEventProjection,
    resolveProfilePaths,
  };
};

const buildEventProjectionOwnerPlan = ({
  afterOwnerPaths,
  beforeOwnerPaths = [],
  cleanupOwnerPaths = [],
  rawAfterOwnerProfileIds,
  rawBeforeOwnerProfileIds = [],
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
  return {
    afterOwnerProfileIds,
    allOwnerProfileIds: [
      ...afterOwnerProfileIds,
      ...allProfileIds.filter((profileId) => !currentOwnerIds.has(profileId)),
    ],
  };
};

module.exports = {
  EVENT_PROJECTION_RECONCILE_ATTEMPTS,
  PROFILE_PATH_RESOLVE_CONCURRENCY,
  READ_RETRY_ATTEMPTS,
  READ_RETRY_DELAY_MS,
  buildEventProjectionOwnerPlan,
  createEventProfileGameProjectionCore,
};
