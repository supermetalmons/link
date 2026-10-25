// Generated from src/eventProfileGameProjectionCore.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEventProfileGameProjectionCore =
  exports.READ_RETRY_DELAY_MS =
  exports.READ_RETRY_ATTEMPTS =
    void 0;
const profileGameProjectionRecords_js_1 = require("./profileGameProjectionRecords.js");
const documents_js_1 = require("./events/documents.js");
const navigation_1 = require("@mons/shared/navigation");
const ownership_js_1 = require("./events/ownership.js");
const eventProjectionModel_js_1 = require("./events/eventProjectionModel.js");
const READ_RETRY_ATTEMPTS = 2;
exports.READ_RETRY_ATTEMPTS = READ_RETRY_ATTEMPTS;
const READ_RETRY_DELAY_MS = 25;
exports.READ_RETRY_DELAY_MS = READ_RETRY_DELAY_MS;
const defaultWait = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
const createEventProfileGameProjectionCore = ({
  now = Date.now,
  prepareEventProjection,
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
    (0, documents_js_1.plainEventParticipantEntries)(participants).map(
      ([key, participant]) => {
        const value = (0, documents_js_1.eventParticipantState)(participant);
        return {
          key: (0, eventProjectionModel_js_1.normalizeString)(key),
          loginUid: (0, eventProjectionModel_js_1.normalizeString)(
            value.loginUid,
          ),
          participant,
          profileId:
            (0, eventProjectionModel_js_1.normalizeString)(value.profileId) ||
            (0, eventProjectionModel_js_1.normalizeString)(key),
        };
      },
    );
  const readOwnershipPlan = async (participants, cleanupOwnerProfileIds) => {
    const entries = participantEntries(participants);
    const cleanupProfileIds = Array.from(
      new Set(
        cleanupOwnerProfileIds
          .map(eventProjectionModel_js_1.normalizeString)
          .filter((value) => Boolean(value)),
      ),
    );
    const loginUids = Array.from(
      new Set(
        entries
          .map(({ loginUid }) => loginUid)
          .filter((value) => Boolean(value)),
      ),
    );
    const storedProfileIds = Array.from(
      new Set(
        [
          ...entries.flatMap(({ key, profileId }) => [key, profileId]),
          ...cleanupProfileIds,
        ].filter((value) => Boolean(value)),
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
      throw (0, ownership_js_1.profileOwnershipUnavailable)();
    }
    const ownerProfileIds = (0, ownership_js_1.resolveOwnedProfileReferences)(
      ownership,
      entries.map(({ loginUid, profileId }) => ({ loginUid, profileId })),
    );
    const canonicalParticipants = {};
    entries.forEach((entry, index) => {
      const ownerProfileId = ownerProfileIds[index];
      canonicalParticipants[ownerProfileId] = (0,
      documents_js_1.copyEventParticipant)(entry.participant, {
        profileId: ownerProfileId,
      });
    });
    const allProfileIds = new Set([
      ...entries.flatMap(({ key, profileId }) => [key, profileId]),
      ...cleanupProfileIds,
      ...ownerProfileIds,
    ]);
    for (const profileId of storedProfileIds) {
      const canonicalProfileId = (0, ownership_js_1.getCanonicalProfileId)(
        ownership,
        profileId,
      );
      if (canonicalProfileId) allProfileIds.add(canonicalProfileId);
    }
    const currentOwnerIds = new Set(ownerProfileIds);
    return {
      allOwnerProfileIds: [
        ...ownerProfileIds,
        ...Array.from(allProfileIds).filter((profileId) =>
          Boolean(profileId && !currentOwnerIds.has(profileId)),
        ),
      ],
      canonicalParticipants: (0,
      documents_js_1.createEventParticipantsDocument)(canonicalParticipants),
      ownerProfileIds,
    };
  };
  const projectEvent = async (
    eventId,
    eventData,
    cleanupOwnerProfileIds = [],
    options = {},
  ) => {
    const assertCanCommit = options.assertCanCommit;
    const sourceFence = options.sourceFence;
    if (
      assertCanCommit !== undefined &&
      typeof assertCanCommit !== "function"
    ) {
      throw new TypeError("event projection commit guard must be a function");
    }
    if (
      sourceFence !== undefined &&
      (!sourceFence ||
        typeof sourceFence !== "object" ||
        Array.isArray(sourceFence) ||
        sourceFence.eventId !== eventId ||
        !Number.isSafeInteger(sourceFence.generation) ||
        sourceFence.generation < 1)
    ) {
      throw new TypeError("event projection source fence is invalid");
    }
    const participants =
      (0, documents_js_1.eventParticipants)(eventData) ||
      (0, documents_js_1.createEventParticipantsDocument)();
    const normalizedCleanupOwnerProfileIds = Array.from(
      new Set(
        cleanupOwnerProfileIds
          .map(eventProjectionModel_js_1.normalizeString)
          .filter((value) => Boolean(value)),
      ),
    );
    const {
      allOwnerProfileIds,
      canonicalParticipants,
      ownerProfileIds: afterOwnerProfileIds,
    } = await readOwnershipPlan(participants, normalizedCleanupOwnerProfileIds);
    const status = (0,
    eventProjectionModel_js_1.mapEventStatusToNavigationStatus)(
      (0, eventProjectionModel_js_1.normalizeString)(
        (0, documents_js_1.eventState)(eventData).status,
      ),
    );
    const previewParticipants = (0,
    eventProjectionModel_js_1.buildPreviewParticipants)(canonicalParticipants);
    const currentOwnerIds = new Set(afterOwnerProfileIds);
    const writes = [];
    if (eventData) {
      for (const ownerProfileId of afterOwnerProfileIds) {
        writes.push({
          type: "merge",
          profileId: ownerProfileId,
          eventId,
          data: (0, profileGameProjectionRecords_js_1.createEventProjection)({
            schemaVersion: 1,
            source: "event-projector",
            entityType: "event",
            id: `event_${eventId}`,
            eventId,
            status,
            sortBucket: navigation_1.NAVIGATION_SORT_BUCKETS[status],
            listSortAt: toTimestampMillis(
              (0, eventProjectionModel_js_1.getListSortAtMs)(eventData, status),
            ),
            ownerProfileId,
            startAt:
              typeof (0, documents_js_1.eventState)(eventData).startAtMs ===
              "number"
                ? toTimestampMillis(
                    (0, documents_js_1.eventState)(eventData).startAtMs,
                  )
                : null,
            updatedAt: toTimestampMillis(
              typeof (0, documents_js_1.eventState)(eventData).updatedAtMs ===
                "number"
                ? (0, documents_js_1.eventState)(eventData).updatedAtMs
                : now(),
            ),
            endedAt:
              typeof (0, documents_js_1.eventState)(eventData).endedAtMs ===
              "number"
                ? toTimestampMillis(
                    (0, documents_js_1.eventState)(eventData).endedAtMs,
                  )
                : null,
            participantCount: previewParticipants.length,
            participantPreview: previewParticipants.slice(
              0,
              eventProjectionModel_js_1.NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
            ),
            winnerDisplayName: (0, eventProjectionModel_js_1.normalizeString)(
              (0, documents_js_1.eventState)(eventData).winnerDisplayName,
            ),
          }),
        });
      }
    }
    for (const profileId of allOwnerProfileIds) {
      if (!eventData || !currentOwnerIds.has(profileId)) {
        writes.push({ type: "delete", profileId, eventId });
      }
    }
    if (assertCanCommit) {
      await assertCanCommit();
    }
    await repository.commitProjectionWrites(writes, sourceFence);
    return {
      deleted: writes.filter((write) => write.type === "delete").length,
      ownerProfileIds: afterOwnerProfileIds,
      written: writes.filter((write) => write.type !== "delete").length,
    };
  };
  const reconcileEventProjection = async (
    eventId,
    cleanupOwnerProfileIds = [],
    options = {},
  ) => {
    const cleanupIds = new Set(
      cleanupOwnerProfileIds
        .map(eventProjectionModel_js_1.normalizeString)
        .filter((value) => Boolean(value)),
    );
    const liveData = await readWithRetries(async () => {
      const event = await repository.getEvent(eventId);
      if (event && prepareEventProjection) {
        await prepareEventProjection(eventId, event);
      }
      return event;
    });
    (0, eventProjectionModel_js_1.getOwnerProfileIds)(
      (0, documents_js_1.eventParticipants)(liveData) ||
        (0, documents_js_1.createEventParticipantsDocument)(),
    ).forEach((profileId) => cleanupIds.add(profileId));
    const result = await projectEvent(
      eventId,
      liveData,
      Array.from(cleanupIds),
      options,
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
exports.createEventProfileGameProjectionCore =
  createEventProfileGameProjectionCore;
