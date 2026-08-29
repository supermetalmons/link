"use strict";

const {
  orderProfileMergeCleanupIds,
  resolveProfileMergeTargetPath,
} = require("./profileMergeTargets");
const { deriveLatestMatchId } = require("@mons/shared/rematches");
const { inferAutomatchStateHint } = require("@mons/shared/navigation");
const { isAutoInviteId } = require("@mons/shared/ids");
const {
  PROJECTOR_SCHEMA_VERSION,
  deriveProjectionStatus,
  fingerprintForProjection,
  getEmojiId,
  getNavigationSortBucket,
  getOwnerContext,
  getOwnerProfileIds,
  getProfileDisplayName,
  getProfileEmoji,
  normalizeString,
  pickListSortMillis,
  readEventTimestampMs,
  readTimestampMillis,
  shouldProjectInvite,
} = require("./events/gameProjectionModel");

const READ_RETRY_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 25;

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

const readExistingProjectionDocuments = async ({
  attempts = READ_RETRY_ATTEMPTS,
  inviteId,
  profileIds,
  readDocument,
  reason,
  retryDelayMs = READ_RETRY_DELAY_MS,
  logger = console,
  wait = delay,
}) => {
  const results = await Promise.allSettled(
    profileIds.map(async (profileId) => {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return { profileId, snapshot: await readDocument(profileId) };
        } catch (error) {
          if (attempt >= attempts) {
            throw error;
          }
          await wait(retryDelayMs);
        }
      }
      throw new Error("projector:existing-doc-read-retry-exhausted");
    }),
  );
  const documents = [];
  let failure = null;
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failure ||= result.reason;
      logger.error("projector:existing-doc-read-failed", {
        inviteId,
        ownerProfileId: profileIds[index],
        reason,
        error:
          result.reason && result.reason.message
            ? result.reason.message
            : result.reason,
      });
      return;
    }
    if (result.value.snapshot.exists) {
      documents.push(result.value);
    }
  });
  if (failure) {
    throw failure;
  }
  return documents;
};

const buildResolvedProfile = (profilePath) => {
  const profileId = profilePath[profilePath.length - 1] || null;
  return profileId
    ? {
        cleanupProfileIds: Array.from(new Set(profilePath)),
        profileId,
      }
    : { cleanupProfileIds: [], profileId: null };
};

const buildInviteProjectionOwnerPlan = (
  hostProfile,
  guestProfile,
  cleanupProfileIds = [],
) => {
  const ownerProfileIds = getOwnerProfileIds(
    hostProfile.profileId,
    guestProfile.profileId,
  );
  return {
    cleanupProfileIds: orderProfileMergeCleanupIds(
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

const getStoredProjectionOwnerRole = (profileId, data) => {
  const ownerRole = normalizeString(data && data.ownerRole);
  if (ownerRole === "host" || ownerRole === "guest") {
    return ownerRole;
  }
  const ownerProfileId =
    normalizeString(data && data.ownerProfileId) || profileId;
  if (ownerProfileId === normalizeString(data && data.hostProfileId)) {
    return "host";
  }
  if (ownerProfileId === normalizeString(data && data.guestProfileId)) {
    return "guest";
  }
  return null;
};

const findFreshestSourceProjectionData = ({
  existingDocs,
  ownerContext,
  ownerProfileId,
  requiresResolvedOpponentEmoji,
}) => {
  let freshest = null;
  let freshestMs = Number.NEGATIVE_INFINITY;
  for (const existing of existingDocs) {
    if (existing.profileId === ownerProfileId) {
      continue;
    }
    const data = existing.snapshot.data() || {};
    const storedOwnerLoginId = normalizeString(data.ownerLoginId);
    const ownerLoginId = normalizeString(ownerContext.ownerLoginId);
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
      getEmojiId(data.opponentEmoji ?? data.opponentEmojiId) === null
    ) {
      continue;
    }
    const freshnessMs = [
      data.updatedAt,
      data.lastEventAt,
      data.listSortAt,
      data.createdAt,
    ].reduce((current, value) => {
      const millis = readTimestampMillis(value);
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
    const millis = readTimestampMillis(value);
    if (millis === null) {
      throw new TypeError("invalid projection timestamp");
    }
    return Math.max(1, millis);
  };

  const retry = (read) => readWithRetries(read, undefined, undefined, wait);

  const resolveProfileForLogin = async (loginUid) => {
    const normalizedLoginUid = normalizeString(loginUid);
    if (!normalizedLoginUid) {
      return { cleanupProfileIds: [], profileId: null };
    }

    let rawProfileId = null;
    let profileLinkReadError = null;
    let profileQueryReadError = null;
    try {
      rawProfileId = normalizeString(
        await retry(() =>
          repository.getRtdbPath(`players/${normalizedLoginUid}/profile`),
        ),
      );
    } catch (error) {
      profileLinkReadError = error;
      logger.error("projector:profile-resolve:rtdb-read-failed", {
        loginUid: normalizedLoginUid,
        attempts: READ_RETRY_ATTEMPTS,
        error: error && error.message ? error.message : error,
      });
    }
    if (!rawProfileId) {
      try {
        const profile = await retry(() =>
          repository.findProfileByLogin(normalizedLoginUid),
        );
        rawProfileId = profile ? profile.id : null;
      } catch (error) {
        profileQueryReadError = error;
        logger.error("projector:profile-resolve:profile-read-failed", {
          loginUid: normalizedLoginUid,
          attempts: READ_RETRY_ATTEMPTS,
          error: error && error.message ? error.message : error,
        });
      }
    }
    if (!rawProfileId) {
      if (profileQueryReadError || profileLinkReadError) {
        throw profileQueryReadError || profileLinkReadError;
      }
      return { cleanupProfileIds: [], profileId: null };
    }

    const resolvePath = () =>
      resolveProfileMergeTargetPath({
        profileId: rawProfileId,
        readMergeTarget: (profileId) =>
          retry(() => repository.getMergeTarget(profileId)),
      });
    let profilePath = await resolvePath();
    let profileId = profilePath[profilePath.length - 1] || null;
    let profile = profileId
      ? await retry(() => repository.getProfile(profileId))
      : null;
    if (!profile || normalizeString(profile.data.mergedIntoProfileId)) {
      const refreshedPath = await resolvePath();
      profilePath = Array.from(new Set([...profilePath, ...refreshedPath]));
      profileId = refreshedPath[refreshedPath.length - 1] || null;
      profile = profileId
        ? await retry(() => repository.getProfile(profileId))
        : null;
    }
    if (!profile || normalizeString(profile.data.mergedIntoProfileId)) {
      return {
        cleanupProfileIds: Array.from(new Set(profilePath)),
        profileId: null,
      };
    }
    return buildResolvedProfile(profilePath);
  };

  const readProfileSummary = async (profileId) => {
    const normalizedProfileId = normalizeString(profileId);
    if (!normalizedProfileId) {
      return null;
    }
    try {
      const profile = await retry(() =>
        repository.getProfile(normalizedProfileId),
      );
      return profile
        ? {
            name: getProfileDisplayName(profile.data),
            emoji: getProfileEmoji(profile.data),
          }
        : null;
    } catch (error) {
      logger.error("projector:profile-summary-read-failed", {
        profileId: normalizedProfileId,
        attempts: READ_RETRY_ATTEMPTS,
        error: error && error.message ? error.message : error,
      });
      throw error;
    }
  };

  const readLoginSummaryFromRtdbMatches = async (
    loginUid,
    latestMatchId,
    inviteId,
    cache,
  ) => {
    const normalizedLoginUid = normalizeString(loginUid);
    if (!normalizedLoginUid) {
      return null;
    }
    const normalizedLatestMatchId = normalizeString(latestMatchId);
    const normalizedInviteId = normalizeString(inviteId);
    const cacheKey = `${normalizedLoginUid}|${normalizedLatestMatchId || ""}|${normalizedInviteId || ""}`;
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }
    const candidateMatchIds = Array.from(
      new Set([normalizedLatestMatchId, normalizedInviteId].filter(Boolean)),
    );
    for (const candidateMatchId of candidateMatchIds) {
      try {
        const matchData = await retry(() =>
          repository.getRtdbPath(
            `players/${normalizedLoginUid}/matches/${candidateMatchId}`,
          ),
        );
        const emoji = getEmojiId(matchData && matchData.emojiId);
        if (emoji !== null) {
          const summary = { name: null, emoji };
          cache.set(cacheKey, summary);
          return summary;
        }
      } catch (error) {
        logger.error("projector:login-summary-rtdb-read-failed", {
          loginUid: normalizedLoginUid,
          matchId: candidateMatchId,
          attempts: READ_RETRY_ATTEMPTS,
          error: error && error.message ? error.message : error,
        });
        throw error;
      }
    }
    cache.set(cacheKey, null);
    return null;
  };

  const recomputeInviteProjection = async (inviteId, reason, options = {}) => {
    const normalizedInviteId = normalizeString(inviteId);
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

    const nowMs = readEventTimestampMs(options);
    const [inviteData, automatchData] = await Promise.all([
      retry(() => repository.getRtdbPath(`invites/${normalizedInviteId}`)),
      retry(() => repository.getRtdbPath(`automatch/${normalizedInviteId}`)),
    ]);
    const hostLoginId = normalizeString(inviteData && inviteData.hostId);
    const guestLoginId = normalizeString(inviteData && inviteData.guestId);
    const [hostProfile, guestProfile] = await Promise.all([
      resolveProfileForLogin(hostLoginId),
      resolveProfileForLogin(guestLoginId),
    ]);
    const hostProfileId = hostProfile.profileId;
    const guestProfileId = guestProfile.profileId;
    const { cleanupProfileIds, ownerProfileIds } =
      buildInviteProjectionOwnerPlan(
        hostProfile,
        guestProfile,
        options.cleanupProfileIds,
      );
    const automatchStateHint = inferAutomatchStateHint({
      inviteId: normalizedInviteId,
      queueValue: automatchData,
      hasGuest: !!guestLoginId,
      storedStateHint: inviteData ? inviteData.automatchStateHint : null,
    });
    const latestMatchId = deriveLatestMatchId(
      normalizedInviteId,
      inviteData,
      options.latestMatchIdHint || null,
    );
    const status = deriveProjectionStatus({
      inviteId: normalizedInviteId,
      inviteData,
      automatchStateHint,
      latestMatchId,
    });
    const shouldProject = shouldProjectInvite({
      inviteId: normalizedInviteId,
      inviteData,
      automatchStateHint,
    });
    const sortBucket = getNavigationSortBucket(status);
    const loginSummaryCache = new Map();

    const existingDocs = await readExistingProjectionDocuments({
      inviteId: normalizedInviteId,
      profileIds: cleanupProfileIds,
      readDocument: async (profileId) => {
        const projection = await repository.getProjection(
          profileId,
          normalizedInviteId,
        );
        return {
          exists: projection !== null,
          data: () => (projection ? projection.data : null),
          updateTime: projection ? projection.updateTime : "",
        };
      },
      reason,
      logger,
      wait,
    });
    const existingDocsByOwnerProfileId = new Map(
      existingDocs.map((entry) => [entry.profileId, entry.snapshot]),
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
        for (const existing of existingDocs) {
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
      schemaVersion: PROJECTOR_SCHEMA_VERSION,
      projectorVersion: PROJECTOR_SCHEMA_VERSION,
      source: "rtdb-projector",
      entityType: "game",
      inviteId: normalizedInviteId,
      kind: isAutoInviteId(normalizedInviteId) ? "auto" : "direct",
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
      const ownerContext = getOwnerContext({
        ownerProfileId,
        hostProfileId,
        guestProfileId,
        hostLoginId,
        guestLoginId,
      });
      const existingDocSnapshot =
        existingDocsByOwnerProfileId.get(ownerProfileId);
      const existingDocData = existingDocSnapshot
        ? existingDocSnapshot.data()
        : null;
      const requiresResolvedOpponentEmoji =
        status === "active" || status === "ended";
      const sourceProjectionData = findFreshestSourceProjectionData({
        existingDocs,
        ownerContext,
        ownerProfileId,
        requiresResolvedOpponentEmoji,
      });
      const opponentProfileSummary = ownerContext.opponentProfileId
        ? await readProfileSummary(ownerContext.opponentProfileId)
        : null;
      const existingOpponentName = normalizeString(
        existingDocData
          ? (existingDocData.opponentName ??
              existingDocData.opponentDisplayName)
          : null,
      );
      const sourceOpponentName = normalizeString(
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
        const summary = await readLoginSummaryFromRtdbMatches(
          ownerContext.opponentLoginId,
          latestMatchId,
          normalizedInviteId,
          loginSummaryCache,
        );
        opponentEmojiFromLogin =
          summary && summary.emoji !== null && summary.emoji !== undefined
            ? summary.emoji
            : null;
      }
      const existingOpponentEmoji = getEmojiId(
        existingDocData
          ? (existingDocData.opponentEmoji ?? existingDocData.opponentEmojiId)
          : null,
      );
      const sourceOpponentEmoji = getEmojiId(
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
        schemaVersion: PROJECTOR_SCHEMA_VERSION,
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
      const nextFingerprint = fingerprintForProjection(
        projectionFingerprintPayload,
      );
      const previousFingerprint =
        existingDocData &&
        typeof existingDocData.lastEventFingerprint === "string"
          ? existingDocData.lastEventFingerprint
          : null;
      if (previousFingerprint === nextFingerprint) {
        skippedCount += 1;
        continue;
      }

      const canonicalListSortMs = existingDocData
        ? readTimestampMillis(existingDocData.listSortAt)
        : null;
      const sourceListSortMs = readTimestampMillis(
        sourceProjectionData && sourceProjectionData.listSortAt,
      );
      const existingListSortMs = Number.isFinite(canonicalListSortMs)
        ? canonicalListSortMs
        : sourceListSortMs;
      const nextListSortMs = pickListSortMillis({
        options,
        status,
        automatchData,
        nowMs,
        existingListSortMs,
      });
      const existingCreatedAt =
        readTimestampMillis(existingDocData && existingDocData.createdAt) ??
        readTimestampMillis(
          sourceProjectionData && sourceProjectionData.createdAt,
        );
      const existingEndedAt =
        readTimestampMillis(existingDocData && existingDocData.endedAt) ??
        readTimestampMillis(
          sourceProjectionData && sourceProjectionData.endedAt,
        );
      const projectionDocData = {
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
        lastEventType: normalizeString(reason) || null,
        lastEventReason: normalizeString(reason) || null,
        lastEventAt: toTimestampMillis(nowMs),
      };
      writes.push({
        type:
          options.preserveListSortAt === true
            ? existingDocSnapshot
              ? "update"
              : "create"
            : "merge",
        profileId: ownerProfileId,
        inviteId: normalizedInviteId,
        data: projectionDocData,
        updateTime: existingDocSnapshot ? existingDocSnapshot.updateTime : "",
      });
      setCount += 1;
    }

    if (sourceCleanupSafe) {
      for (const existing of existingDocs) {
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

module.exports = {
  READ_RETRY_ATTEMPTS,
  READ_RETRY_DELAY_MS,
  buildInviteProjectionOwnerPlan,
  buildResolvedProfile,
  createProfileGamesProjectionCore,
  readExistingProjectionDocuments,
};
