// Generated from src/profileGamesProjectionCore.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readExistingProjectionRecords =
  exports.createProfileGamesProjectionCore =
  exports.buildResolvedProfile =
  exports.buildInviteProjectionOwnerPlan =
  exports.READ_RETRY_DELAY_MS =
  exports.READ_RETRY_ATTEMPTS =
    void 0;
const stateCompatibility_js_1 = require("./stateCompatibility.js");
const profileMergeTargets_js_1 = require("./profileMergeTargets.js");
const rematches_1 = require("@mons/shared/rematches");
const navigation_1 = require("@mons/shared/navigation");
const ids_1 = require("@mons/shared/ids");
const gameProjectionModel_js_1 = require("./events/gameProjectionModel.js");
const READ_RETRY_ATTEMPTS = 2;
exports.READ_RETRY_ATTEMPTS = READ_RETRY_ATTEMPTS;
const READ_RETRY_DELAY_MS = 25;
exports.READ_RETRY_DELAY_MS = READ_RETRY_DELAY_MS;
const delay = async (ms) => {
  const safeDelay = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  if (safeDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, safeDelay));
  }
};
const readWithRetries = async (
  read,
  attempts = READ_RETRY_ATTEMPTS,
  retryDelayMs = READ_RETRY_DELAY_MS,
  wait = delay,
) => {
  let failure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      failure = error;
      if (attempt < attempts) {
        await wait(retryDelayMs);
      }
    }
  }
  throw failure;
};
const readExistingProjectionRecords = async ({
  attempts = READ_RETRY_ATTEMPTS,
  inviteId,
  profileIds,
  readRecords,
  reason,
  retryDelayMs = READ_RETRY_DELAY_MS,
  logger = console,
  wait = delay,
}) => {
  const uniqueProfileIds = [...new Set(profileIds)];
  if (uniqueProfileIds.length === 0) return [];
  let projections;
  try {
    projections = await readWithRetries(
      () => readRecords(uniqueProfileIds),
      attempts,
      retryDelayMs,
      wait,
    );
  } catch (error) {
    logger.error("projector:existing-doc-read-failed", {
      inviteId,
      ownerProfileIds: uniqueProfileIds,
      reason,
      error: error && error.message ? error.message : error,
    });
    throw error;
  }
  return uniqueProfileIds.flatMap((profileId) => {
    const projection = projections.get(profileId);
    return projection
      ? [
          {
            profileId,
            data: projection.data,
            version: projection.version,
          },
        ]
      : [];
  });
};
exports.readExistingProjectionRecords = readExistingProjectionRecords;
const buildResolvedProfile = (profilePath) => {
  const profileId = profilePath[profilePath.length - 1] || null;
  return profileId
    ? {
        cleanupProfileIds: Array.from(new Set(profilePath)),
        profileId,
      }
    : { cleanupProfileIds: [], profileId: null };
};
exports.buildResolvedProfile = buildResolvedProfile;
const buildInviteProjectionOwnerPlan = (
  hostProfile,
  guestProfile,
  cleanupProfileIds = [],
) => {
  const ownerProfileIds = (0, gameProjectionModel_js_1.getOwnerProfileIds)(
    hostProfile.profileId,
    guestProfile.profileId,
  );
  return {
    cleanupProfileIds: (0,
    profileMergeTargets_js_1.orderProfileMergeCleanupIds)(
      [
        ...hostProfile.cleanupProfileIds,
        ...guestProfile.cleanupProfileIds,
        ...cleanupProfileIds,
        ...ownerProfileIds,
      ],
      ownerProfileIds,
    ),
    ownerProfileIds,
  };
};
exports.buildInviteProjectionOwnerPlan = buildInviteProjectionOwnerPlan;
const getStoredProjectionOwnerRole = (profileId, data) => {
  const ownerRole = (0, gameProjectionModel_js_1.normalizeString)(
    data && data.ownerRole,
  );
  if (ownerRole === "host" || ownerRole === "guest") {
    return ownerRole;
  }
  const ownerProfileId =
    (0, gameProjectionModel_js_1.normalizeString)(
      data && data.ownerProfileId,
    ) || profileId;
  if (
    ownerProfileId ===
    (0, gameProjectionModel_js_1.normalizeString)(data && data.hostProfileId)
  ) {
    return "host";
  }
  if (
    ownerProfileId ===
    (0, gameProjectionModel_js_1.normalizeString)(data && data.guestProfileId)
  ) {
    return "guest";
  }
  return null;
};
const findFreshestSourceProjectionData = ({
  existingRecords,
  ownerContext,
  ownerProfileId,
  requiresResolvedOpponentEmoji,
}) => {
  let freshest = null;
  let freshestMs = Number.NEGATIVE_INFINITY;
  for (const existing of existingRecords) {
    if (existing.profileId === ownerProfileId) {
      continue;
    }
    const data = existing.data;
    const storedOwnerLoginId = (0, gameProjectionModel_js_1.normalizeString)(
      data.ownerLoginId,
    );
    const ownerLoginId = (0, gameProjectionModel_js_1.normalizeString)(
      ownerContext.ownerLoginId,
    );
    if (
      storedOwnerLoginId &&
      ownerLoginId &&
      storedOwnerLoginId !== ownerLoginId
    ) {
      continue;
    }
    if (
      (!storedOwnerLoginId || !ownerLoginId) &&
      getStoredProjectionOwnerRole(existing.profileId, data) !==
        ownerContext.ownerRole
    ) {
      continue;
    }
    if (
      requiresResolvedOpponentEmoji &&
      (0, gameProjectionModel_js_1.getEmojiId)(
        data.opponentEmoji ?? data.opponentEmojiId,
      ) === null
    ) {
      continue;
    }
    const freshnessMs = [
      data.updatedAt,
      data.lastEventAt,
      data.listSortAt,
      data.createdAt,
    ].reduce((current, value) => {
      const millis = (0, gameProjectionModel_js_1.readTimestampMillis)(value);
      return Number.isFinite(millis) ? Math.max(current, millis) : current;
    }, Number.NEGATIVE_INFINITY);
    if (!freshest || freshnessMs > freshestMs) {
      freshest = data;
      freshestMs = freshnessMs;
    }
  }
  return freshest;
};
const createProfileGamesProjectionCore = ({
  logger = console,
  repository,
  wait = delay,
}) => {
  if (!repository) {
    throw new TypeError("profile games projection dependencies are required");
  }
  const toTimestampMillis = (value) => {
    const millis = (0, gameProjectionModel_js_1.readTimestampMillis)(value);
    if (millis === null) {
      throw new TypeError("invalid projection timestamp");
    }
    return Math.max(1, millis);
  };
  const retry = (read) => readWithRetries(read, undefined, undefined, wait);
  const resolveProfileForLogin = (ownership, loginUid) => {
    const normalizedLoginUid = (0, gameProjectionModel_js_1.normalizeString)(
      loginUid,
    );
    if (!normalizedLoginUid) {
      return { cleanupProfileIds: [], profileId: null };
    }
    if (
      !ownership ||
      !(ownership.profileIdByLoginUid instanceof Map) ||
      !ownership.profileIdByLoginUid.has(normalizedLoginUid)
    ) {
      throw new TypeError("invalid projection ownership snapshot");
    }
    const profileId = (0, gameProjectionModel_js_1.normalizeString)(
      ownership.profileIdByLoginUid.get(normalizedLoginUid),
    );
    if (!profileId) {
      return { cleanupProfileIds: [], profileId: null };
    }
    return buildResolvedProfile([profileId]);
  };
  const readProfileSummary = (ownership, profileId) => {
    const normalizedProfileId = (0, gameProjectionModel_js_1.normalizeString)(
      profileId,
    );
    if (!normalizedProfileId) {
      return null;
    }
    if (
      !ownership ||
      !(ownership.profileDataById instanceof Map) ||
      !ownership.profileDataById.has(normalizedProfileId)
    ) {
      throw new TypeError("invalid projection ownership snapshot");
    }
    const profileData = ownership.profileDataById.get(normalizedProfileId);
    return profileData
      ? {
          name: (0, gameProjectionModel_js_1.getProfileDisplayName)(
            profileData,
          ),
          emoji: (0, gameProjectionModel_js_1.getProfileEmoji)(profileData),
        }
      : null;
  };
  const readLoginSummaryFromMatches = async (
    loginUid,
    latestMatchId,
    inviteId,
    presentationCache,
  ) => {
    const normalizedLoginUid = (0, gameProjectionModel_js_1.normalizeString)(
      loginUid,
    );
    if (!normalizedLoginUid || !repository.readMatchPresentation) {
      return null;
    }
    const normalizedLatestMatchId = (0,
    gameProjectionModel_js_1.normalizeString)(latestMatchId);
    const normalizedInviteId = (0, gameProjectionModel_js_1.normalizeString)(
      inviteId,
    );
    const candidateMatchIds = Array.from(
      new Set(
        [normalizedLatestMatchId, normalizedInviteId].filter((value) =>
          Boolean(value),
        ),
      ),
    );
    for (const candidateMatchId of candidateMatchIds) {
      try {
        if (!presentationCache.has(candidateMatchId)) {
          const snapshot = await retry(() =>
            repository.readMatchPresentation(
              normalizedInviteId,
              candidateMatchId,
            ),
          );
          presentationCache.set(candidateMatchId, snapshot);
        }
        const snapshot = presentationCache.get(candidateMatchId);
        const emoji = Object.hasOwn(snapshot.players, normalizedLoginUid)
          ? (0, gameProjectionModel_js_1.getEmojiId)(
              snapshot.players[normalizedLoginUid].emojiId,
            )
          : null;
        if (emoji !== null) {
          return { name: null, emoji };
        }
      } catch (error) {
        logger.error("projector:login-summary-read-failed", {
          loginUid: normalizedLoginUid,
          matchId: candidateMatchId,
          attempts: READ_RETRY_ATTEMPTS,
          error: error && error.message ? error.message : error,
        });
        throw error;
      }
    }
    return null;
  };
  const recomputeInviteProjection = async (inviteId, reason, options = {}) => {
    const normalizedInviteId = (0, gameProjectionModel_js_1.normalizeString)(
      inviteId,
    );
    if (!normalizedInviteId) {
      return {
        ok: false,
        inviteId: inviteId || null,
        reason,
        skipped: true,
        skipReason: "invalid-invite-id",
        sourceCleanupSafe: false,
        blockedReason: "invalid-invite-id",
      };
    }
    const nowMs = (0, gameProjectionModel_js_1.readEventTimestampMs)(options);
    const [inviteData, automatchData] = await Promise.all([
      retry(() => repository.readInviteMetadata(normalizedInviteId)),
      retry(() => repository.readAutomatchEntry(normalizedInviteId)),
    ]);
    const hostLoginId = (0, gameProjectionModel_js_1.normalizeString)(
      inviteData && inviteData.hostId,
    );
    const guestLoginId = (0, gameProjectionModel_js_1.normalizeString)(
      inviteData && inviteData.guestId,
    );
    const loginUids = Array.from(
      new Set([hostLoginId, guestLoginId].filter((value) => Boolean(value))),
    );
    let ownership;
    try {
      ownership = await repository.readProfileOwnershipSnapshot({
        loginUids,
        profileIds: [],
      });
    } catch (error) {
      logger.error("projector:profile-resolve:profile-read-failed", {
        loginUids,
        attempts: 1,
        error: error && error.message ? error.message : error,
      });
      throw error;
    }
    const hostProfile = resolveProfileForLogin(ownership, hostLoginId);
    const guestProfile = resolveProfileForLogin(ownership, guestLoginId);
    const hostProfileId = hostProfile.profileId;
    const guestProfileId = guestProfile.profileId;
    const { cleanupProfileIds, ownerProfileIds } =
      buildInviteProjectionOwnerPlan(
        hostProfile,
        guestProfile,
        options.cleanupProfileIds,
      );
    const automatchStateHint = (0, navigation_1.inferAutomatchStateHint)({
      inviteId: normalizedInviteId,
      queueValue: automatchData,
      hasGuest: !!guestLoginId,
      storedStateHint: inviteData ? inviteData.automatchStateHint : null,
    });
    const latestMatchId = (0, rematches_1.deriveLatestMatchId)(
      normalizedInviteId,
      inviteData,
      options.latestMatchIdHint || null,
    );
    const latestMatchRatingCompleted =
      (0, gameProjectionModel_js_1.isEventOwnedInvite)(inviteData) &&
      latestMatchId
        ? await retry(() =>
            repository.hasCompletedRatingUpdate(
              normalizedInviteId,
              latestMatchId,
            ),
          )
        : false;
    const status = (0, gameProjectionModel_js_1.deriveProjectionStatus)({
      inviteId: normalizedInviteId,
      inviteData,
      automatchStateHint,
      latestMatchRatingCompleted,
    });
    const shouldProject = (0, gameProjectionModel_js_1.shouldProjectInvite)({
      inviteId: normalizedInviteId,
      inviteData,
      automatchStateHint,
    });
    const sortBucket = (0, gameProjectionModel_js_1.getNavigationSortBucket)(
      status,
    );
    const matchPresentationCache = new Map();
    const existingRecords = await readExistingProjectionRecords({
      inviteId: normalizedInviteId,
      profileIds: cleanupProfileIds,
      readRecords: (profileIds) =>
        repository.getProjections(profileIds, normalizedInviteId),
      reason,
      logger,
      wait,
    });
    const existingRecordsByOwnerProfileId = new Map(
      existingRecords.map((entry) => [entry.profileId, entry]),
    );
    const ownerSet = new Set(ownerProfileIds);
    const hasUnresolvedOwner = Boolean(
      shouldProject &&
      (ownerProfileIds.length === 0 ||
        !hostLoginId ||
        !hostProfileId ||
        (guestLoginId && !guestProfileId)),
    );
    let sourceCleanupSafe = !hasUnresolvedOwner;
    let blockedReason = hasUnresolvedOwner ? "unresolved-owner-profile" : null;
    const writes = [];
    let setCount = 0;
    let deleteCount = 0;
    let skippedCount = 0;
    if (!shouldProject || ownerProfileIds.length === 0) {
      if (sourceCleanupSafe) {
        for (const existing of existingRecords) {
          writes.push({
            type: "delete",
            profileId: existing.profileId,
            inviteId: normalizedInviteId,
          });
          deleteCount += 1;
        }
      }
      if (writes.length > 0) {
        await repository.commitProjectionWrites(writes);
      }
      return {
        ok: true,
        inviteId: normalizedInviteId,
        reason,
        shouldProject,
        ownerProfileIds,
        sourceCleanupSafe,
        ...(blockedReason ? { blockedReason } : {}),
        writes: 0,
        deletes: deleteCount,
        skipped: 0,
      };
    }
    const commonProjection = {
      schemaVersion: gameProjectionModel_js_1.PROJECTOR_SCHEMA_VERSION,
      projectorVersion: gameProjectionModel_js_1.PROJECTOR_SCHEMA_VERSION,
      source: stateCompatibility_js_1.PROFILE_GAME_PROJECTION_SOURCE,
      entityType: "game",
      inviteId: normalizedInviteId,
      kind: (0, ids_1.isAutoInviteId)(normalizedInviteId) ? "auto" : "direct",
      hostLoginId,
      guestLoginId,
      hostProfileId,
      guestProfileId,
      status,
      sortBucket,
      isPendingAutomatch: status === "pending",
      automatchStateHint,
      automatchCanceledAt:
        typeof (inviteData && inviteData.automatchCanceledAt) === "number"
          ? inviteData.automatchCanceledAt
          : null,
      latestMatchId,
    };
    for (const ownerProfileId of ownerProfileIds) {
      const ownerContext = (0, gameProjectionModel_js_1.getOwnerContext)({
        ownerProfileId,
        hostProfileId,
        guestProfileId,
        hostLoginId,
        guestLoginId,
      });
      const existingRecord =
        existingRecordsByOwnerProfileId.get(ownerProfileId);
      const existingData = existingRecord ? existingRecord.data : null;
      const requiresResolvedOpponentEmoji =
        status === "active" || status === "ended";
      const sourceProjectionData = findFreshestSourceProjectionData({
        existingRecords,
        ownerContext,
        ownerProfileId,
        requiresResolvedOpponentEmoji,
      });
      const opponentProfileSummary = ownerContext.opponentProfileId
        ? readProfileSummary(ownership, ownerContext.opponentProfileId)
        : null;
      const existingOpponentName = (0,
      gameProjectionModel_js_1.normalizeString)(
        existingData
          ? (existingData.opponentName ?? existingData.opponentDisplayName)
          : null,
      );
      const sourceOpponentName = (0, gameProjectionModel_js_1.normalizeString)(
        sourceProjectionData
          ? (sourceProjectionData.opponentName ??
              sourceProjectionData.opponentDisplayName)
          : null,
      );
      const opponentName =
        opponentProfileSummary &&
        typeof opponentProfileSummary.name === "string"
          ? opponentProfileSummary.name
          : existingOpponentName || sourceOpponentName;
      const opponentEmojiFromProfile =
        opponentProfileSummary &&
        opponentProfileSummary.emoji !== null &&
        opponentProfileSummary.emoji !== undefined
          ? opponentProfileSummary.emoji
          : null;
      let opponentEmojiFromLogin = null;
      if (opponentEmojiFromProfile === null && ownerContext.opponentLoginId) {
        const summary = await readLoginSummaryFromMatches(
          ownerContext.opponentLoginId,
          latestMatchId,
          normalizedInviteId,
          matchPresentationCache,
        );
        opponentEmojiFromLogin =
          summary && summary.emoji !== null && summary.emoji !== undefined
            ? summary.emoji
            : null;
      }
      const existingOpponentEmoji = (0, gameProjectionModel_js_1.getEmojiId)(
        existingData
          ? (existingData.opponentEmoji ?? existingData.opponentEmojiId)
          : null,
      );
      const sourceOpponentEmoji = (0, gameProjectionModel_js_1.getEmojiId)(
        sourceProjectionData
          ? (sourceProjectionData.opponentEmoji ??
              sourceProjectionData.opponentEmojiId)
          : null,
      );
      const opponentEmoji =
        opponentEmojiFromProfile !== null
          ? opponentEmojiFromProfile
          : opponentEmojiFromLogin !== null
            ? opponentEmojiFromLogin
            : existingOpponentEmoji !== null
              ? existingOpponentEmoji
              : sourceOpponentEmoji;
      if (requiresResolvedOpponentEmoji && opponentEmoji === null) {
        sourceCleanupSafe = false;
        blockedReason = "unresolved-opponent-emoji";
        skippedCount += 1;
        continue;
      }
      const projectionFingerprintPayload = {
        schemaVersion: gameProjectionModel_js_1.PROJECTOR_SCHEMA_VERSION,
        inviteId: normalizedInviteId,
        ownerProfileId,
        kind: commonProjection.kind,
        hostLoginId,
        guestLoginId,
        hostProfileId,
        guestProfileId,
        status,
        sortBucket,
        isPendingAutomatch: commonProjection.isPendingAutomatch,
        automatchStateHint,
        automatchCanceledAt: commonProjection.automatchCanceledAt,
        latestMatchId,
        ownerRole: ownerContext.ownerRole,
        ownerLoginId: ownerContext.ownerLoginId,
        opponentProfileId: ownerContext.opponentProfileId,
        opponentLoginId: ownerContext.opponentLoginId,
        opponentName,
        opponentEmoji,
      };
      const nextFingerprint = (0,
      gameProjectionModel_js_1.fingerprintForProjection)(
        projectionFingerprintPayload,
      );
      const previousFingerprint =
        existingData && typeof existingData.lastEventFingerprint === "string"
          ? existingData.lastEventFingerprint
          : null;
      if (previousFingerprint === nextFingerprint) {
        skippedCount += 1;
        continue;
      }
      const canonicalListSortMs = existingData
        ? (0, gameProjectionModel_js_1.readTimestampMillis)(
            existingData.listSortAt,
          )
        : null;
      const sourceListSortMs = (0,
      gameProjectionModel_js_1.readTimestampMillis)(
        sourceProjectionData && sourceProjectionData.listSortAt,
      );
      const existingListSortMs = Number.isFinite(canonicalListSortMs)
        ? canonicalListSortMs
        : sourceListSortMs;
      const nextListSortMs = (0, gameProjectionModel_js_1.pickListSortMillis)({
        options,
        status,
        automatchData: automatchData,
        nowMs,
        existingListSortMs,
      });
      const existingCreatedAt =
        (0, gameProjectionModel_js_1.readTimestampMillis)(
          existingData && existingData.createdAt,
        ) ??
        (0, gameProjectionModel_js_1.readTimestampMillis)(
          sourceProjectionData && sourceProjectionData.createdAt,
        );
      const existingEndedAt =
        (0, gameProjectionModel_js_1.readTimestampMillis)(
          existingData && existingData.endedAt,
        ) ??
        (0, gameProjectionModel_js_1.readTimestampMillis)(
          sourceProjectionData && sourceProjectionData.endedAt,
        );
      const projectionData = {
        ...commonProjection,
        ownerProfileId,
        ownerRole: ownerContext.ownerRole,
        ownerLoginId: ownerContext.ownerLoginId,
        opponentProfileId: ownerContext.opponentProfileId,
        opponentLoginId: ownerContext.opponentLoginId,
        opponentName,
        opponentDisplayName: opponentName,
        opponentEmoji,
        opponentEmojiId: opponentEmoji,
        listSortAt: toTimestampMillis(nextListSortMs),
        createdAt:
          existingCreatedAt === null
            ? toTimestampMillis(nowMs)
            : toTimestampMillis(existingCreatedAt),
        updatedAt: toTimestampMillis(nowMs),
        endedAt:
          status === "ended"
            ? existingEndedAt === null
              ? toTimestampMillis(nowMs)
              : toTimestampMillis(existingEndedAt)
            : null,
        lastEventFingerprint: nextFingerprint,
        lastEventType:
          (0, gameProjectionModel_js_1.normalizeString)(reason) || null,
        lastEventReason:
          (0, gameProjectionModel_js_1.normalizeString)(reason) || null,
        lastEventAt: toTimestampMillis(nowMs),
      };
      const type =
        options.preserveListSortAt === true
          ? existingRecord
            ? "update"
            : "create"
          : "merge";
      writes.push({
        type,
        profileId: ownerProfileId,
        inviteId: normalizedInviteId,
        data: projectionData,
        ...(type === "update"
          ? { expectedVersion: existingRecord.version }
          : {}),
      });
      setCount += 1;
    }
    if (sourceCleanupSafe) {
      for (const existing of existingRecords) {
        if (!ownerSet.has(existing.profileId)) {
          writes.push({
            type: "delete",
            profileId: existing.profileId,
            inviteId: normalizedInviteId,
          });
          deleteCount += 1;
        }
      }
    }
    if (writes.length > 0) {
      await repository.commitProjectionWrites(writes);
    }
    return {
      ok: true,
      inviteId: normalizedInviteId,
      reason,
      shouldProject,
      ownerProfileIds,
      sourceCleanupSafe,
      ...(blockedReason ? { blockedReason } : {}),
      writes: setCount,
      deletes: deleteCount,
      skipped: skippedCount,
    };
  };
  return { recomputeInviteProjection };
};
exports.createProfileGamesProjectionCore = createProfileGamesProjectionCore;
