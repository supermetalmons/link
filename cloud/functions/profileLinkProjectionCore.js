"use strict";

const { createInviteCandidatesFromMatchId } = require("@mons/shared/rematches");
const { normalizeString } = require("./events/gameProjectionModel");

const PROFILE_LINK_CATCHUP_MAX_INVITES = 20;
const PROFILE_LINK_CATCHUP_MAX_INVITES_WITH_CLEANUP = 1;
const PROFILE_LINK_CATCHUP_CONCURRENCY = 3;
const PROFILE_LINK_CATCHUP_TIMEOUT_MS = 50000;

const processWithConcurrency = async (
  items,
  concurrency,
  worker,
  shouldContinue,
) => {
  if (items.length === 0) {
    return;
  }
  let index = 0;
  let failure = null;
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (!failure && (!shouldContinue || shouldContinue())) {
        const currentIndex = index;
        index += 1;
        if (currentIndex >= items.length) {
          return;
        }
        try {
          await worker(items[currentIndex], currentIndex);
        } catch (error) {
          failure ||= error;
        }
      }
    },
  );
  await Promise.all(runners);
  if (failure) {
    throw failure;
  }
};

const createProfileLinkProjectionCore = ({
  logger = console,
  now = Date.now,
  recomputeInviteProjection,
  repository,
  resolveInviteIdFromMatchId: resolveInviteIdOverride,
  withInviteProjectionLock,
}) => {
  if (
    !repository ||
    typeof recomputeInviteProjection !== "function" ||
    typeof withInviteProjectionLock !== "function"
  ) {
    throw new TypeError("profile link projection dependencies are required");
  }

  const readInviteExists = async (inviteId, cache) => {
    const normalizedInviteId = normalizeString(inviteId);
    if (!normalizedInviteId) {
      return false;
    }
    if (cache.has(normalizedInviteId)) {
      return await cache.get(normalizedInviteId);
    }
    const pending = repository.inviteExists(normalizedInviteId);
    cache.set(normalizedInviteId, pending);
    const exists = await pending;
    cache.set(normalizedInviteId, exists);
    return exists;
  };

  const resolveInviteId = async (matchId, cache) => {
    if (resolveInviteIdOverride) {
      return resolveInviteIdOverride(matchId, { inviteExistenceCache: cache });
    }
    const normalizedMatchId = normalizeString(matchId);
    if (!normalizedMatchId) {
      return null;
    }
    if (await readInviteExists(normalizedMatchId, cache)) {
      return normalizedMatchId;
    }
    const existing = [];
    for (const candidate of createInviteCandidatesFromMatchId(
      normalizedMatchId,
    )) {
      if (await readInviteExists(candidate, cache)) {
        existing.push(candidate);
      }
    }
    if (existing.length > 1) {
      logger.error("projector:match-resolver:multiple-candidates", {
        matchId: normalizedMatchId,
        candidates: existing,
      });
      return null;
    }
    return existing[0] || null;
  };

  const processProfileLinkCatchup = async ({
    cleanupProfileIds = [],
    loginUid,
    matchCursor,
    profileId: eventProfileId,
    sourceUpdatedAtMs,
  }) => {
    const normalizedLoginUid = normalizeString(loginUid);
    const normalizedEventProfileId = normalizeString(eventProfileId);
    if (!normalizedLoginUid || !normalizedEventProfileId) {
      throw new TypeError("invalid profile link projection input");
    }
    const eventTimestampMs =
      Number.isSafeInteger(sourceUpdatedAtMs) && sourceUpdatedAtMs >= 0
        ? sourceUpdatedAtMs
        : now();
    const observedProfileIds = new Set(
      cleanupProfileIds.map(normalizeString).filter(Boolean),
    );
    observedProfileIds.add(normalizedEventProfileId);
    const ownership = await repository.readProfileOwnershipSnapshot({
      loginUids: [normalizedLoginUid],
      profileIds: [],
    });
    if (
      !ownership ||
      !(ownership.profileIdByLoginUid instanceof Map) ||
      !ownership.profileIdByLoginUid.has(normalizedLoginUid)
    ) {
      throw new TypeError("invalid projection ownership snapshot");
    }
    const profileId = normalizeString(
      ownership.profileIdByLoginUid.get(normalizedLoginUid),
    );
    if (!profileId) {
      return null;
    }
    observedProfileIds.add(profileId);
    const cleanupIds = Array.from(observedProfileIds);
    const matchLimit =
      cleanupIds.length > 1
        ? PROFILE_LINK_CATCHUP_MAX_INVITES_WITH_CLEANUP
        : PROFILE_LINK_CATCHUP_MAX_INVITES;
    const normalizedMatchCursor = normalizeString(matchCursor) || "";
    const allMatchIds =
      (await repository.getMatchIds(normalizedLoginUid)) || [];
    const startedAt = now();
    const shouldContinue = () =>
      now() - startedAt < PROFILE_LINK_CATCHUP_TIMEOUT_MS;
    const pageMatchIds = allMatchIds
      .filter((matchId) => matchId > normalizedMatchCursor)
      .sort();
    const matchIds = pageMatchIds.slice(0, matchLimit);
    const inviteExistenceCache = new Map();
    const inviteIds = [];
    const inviteSet = new Set();
    let lastScannedMatchId = null;
    let matchIdsScanned = 0;
    let hasMoreMatches = pageMatchIds.length > matchIds.length;
    for (const matchId of matchIds) {
      if (!shouldContinue()) {
        hasMoreMatches = true;
        break;
      }
      const inviteId = await resolveInviteId(matchId, inviteExistenceCache);
      lastScannedMatchId = matchId;
      matchIdsScanned += 1;
      if (inviteId && !inviteSet.has(inviteId)) {
        inviteSet.add(inviteId);
        inviteIds.push(inviteId);
      }
    }
    if (matchIdsScanned < matchIds.length) {
      hasMoreMatches = true;
    }
    if (hasMoreMatches && !lastScannedMatchId) {
      throw new Error("projector:profile-link-catchup-no-progress");
    }

    let attempted = 0;
    let processed = 0;
    let failed = 0;
    await processWithConcurrency(
      inviteIds,
      PROFILE_LINK_CATCHUP_CONCURRENCY,
      async (inviteId) => {
        if (!shouldContinue()) {
          return;
        }
        attempted += 1;
        try {
          const result = await withInviteProjectionLock(inviteId, () =>
            recomputeInviteProjection(inviteId, "profile-link-catchup", {
              cleanupProfileIds: cleanupIds,
              eventTimestampMs,
              preserveListSortAt: true,
            }),
          );
          const unresolvedOwnerIsSafe = Boolean(
            result?.sourceCleanupSafe === false &&
            result.blockedReason === "unresolved-owner-profile" &&
            Array.isArray(result.ownerProfileIds) &&
            result.ownerProfileIds.some(
              (ownerProfileId) => normalizeString(ownerProfileId) === profileId,
            ) &&
            cleanupIds.every(
              (cleanupProfileId) =>
                normalizeString(cleanupProfileId) === profileId,
            ),
          );
          if (result?.sourceCleanupSafe === false && !unresolvedOwnerIsSafe) {
            throw new Error(
              `projector:profile-link-catchup-blocked:${result.blockedReason || "source-cleanup-unsafe"}`,
            );
          }
          processed += 1;
        } catch (error) {
          failed += 1;
          logger.error("projector:profile-link-catchup:recompute-failed", {
            loginUid: normalizedLoginUid,
            profileId,
            inviteId,
            error: error?.message || error,
          });
        }
      },
      shouldContinue,
    );
    if (attempted !== inviteIds.length || failed > 0) {
      throw new Error("projector:profile-link-catchup-incomplete");
    }

    const summary = {
      loginUid: normalizedLoginUid,
      profileId,
      eventProfileId: normalizedEventProfileId,
      matchIdsScanned,
      inviteIdsResolved: inviteIds.length,
      processed,
      failed,
      didTimeout: !shouldContinue(),
      didHitInviteCap: hasMoreMatches,
      nextMatchCursor: hasMoreMatches ? lastScannedMatchId : null,
      elapsedMs: now() - startedAt,
    };
    logger.info("projector:profile-link-catchup:done", summary);
    return summary;
  };

  return {
    processProfileLinkCatchup,
    resolveInviteIdFromMatchId: resolveInviteId,
  };
};

module.exports = {
  PROFILE_LINK_CATCHUP_CONCURRENCY,
  PROFILE_LINK_CATCHUP_MAX_INVITES,
  PROFILE_LINK_CATCHUP_MAX_INVITES_WITH_CLEANUP,
  PROFILE_LINK_CATCHUP_TIMEOUT_MS,
  createProfileLinkProjectionCore,
  processWithConcurrency,
};
