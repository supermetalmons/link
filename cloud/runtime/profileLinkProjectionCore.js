// Generated from src/profileLinkProjectionCore.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processWithConcurrency =
  exports.createProfileLinkProjectionCore =
  exports.PROFILE_LINK_CATCHUP_TIMEOUT_MS =
  exports.PROFILE_LINK_CATCHUP_MAX_INVITES_WITH_CLEANUP =
  exports.PROFILE_LINK_CATCHUP_MAX_INVITES =
  exports.PROFILE_LINK_CATCHUP_CONCURRENCY =
    void 0;
const gameProjectionModel_js_1 = require("./events/gameProjectionModel.js");
const PROFILE_LINK_CATCHUP_MAX_INVITES = 20;
exports.PROFILE_LINK_CATCHUP_MAX_INVITES = PROFILE_LINK_CATCHUP_MAX_INVITES;
const PROFILE_LINK_CATCHUP_MAX_INVITES_WITH_CLEANUP = 1;
exports.PROFILE_LINK_CATCHUP_MAX_INVITES_WITH_CLEANUP =
  PROFILE_LINK_CATCHUP_MAX_INVITES_WITH_CLEANUP;
const PROFILE_LINK_CATCHUP_CONCURRENCY = 3;
exports.PROFILE_LINK_CATCHUP_CONCURRENCY = PROFILE_LINK_CATCHUP_CONCURRENCY;
const PROFILE_LINK_CATCHUP_TIMEOUT_MS = 50000;
exports.PROFILE_LINK_CATCHUP_TIMEOUT_MS = PROFILE_LINK_CATCHUP_TIMEOUT_MS;
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
exports.processWithConcurrency = processWithConcurrency;
const createProfileLinkProjectionCore = ({
  logger = console,
  now = Date.now,
  recomputeInviteProjection,
  repository,
  withInviteProjectionLock,
}) => {
  if (
    !repository ||
    typeof repository.listMatchesPage !== "function" ||
    typeof recomputeInviteProjection !== "function" ||
    typeof withInviteProjectionLock !== "function"
  ) {
    throw new TypeError("profile link projection dependencies are required");
  }
  const processProfileLinkCatchup = async ({
    cleanupProfileIds = [],
    loginUid,
    matchCursor,
    profileId: eventProfileId,
    sourceUpdatedAtMs,
  }) => {
    const normalizedLoginUid = (0, gameProjectionModel_js_1.normalizeString)(
      loginUid,
    );
    const normalizedEventProfileId = (0,
    gameProjectionModel_js_1.normalizeString)(eventProfileId);
    if (!normalizedLoginUid || !normalizedEventProfileId) {
      throw new TypeError("invalid profile link projection input");
    }
    const eventTimestampMs =
      Number.isSafeInteger(sourceUpdatedAtMs) && sourceUpdatedAtMs >= 0
        ? sourceUpdatedAtMs
        : now();
    const observedProfileIds = new Set(
      cleanupProfileIds
        .map(gameProjectionModel_js_1.normalizeString)
        .filter((value) => Boolean(value)),
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
    const profileId = (0, gameProjectionModel_js_1.normalizeString)(
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
    const normalizedMatchCursor =
      (0, gameProjectionModel_js_1.normalizeString)(matchCursor) || "";
    const page = await repository.listMatchesPage(
      normalizedLoginUid,
      normalizedMatchCursor,
      matchLimit,
    );
    if (
      !page ||
      !Array.isArray(page.entries) ||
      page.entries.length > matchLimit ||
      typeof page.hasMore !== "boolean"
    ) {
      throw new Error("projector:profile-link-catchup-invalid-page");
    }
    let previousMatchId = normalizedMatchCursor;
    for (const entry of page.entries) {
      if (
        !entry ||
        typeof entry.matchId !== "string" ||
        entry.matchId <= previousMatchId ||
        (entry.resolution === "resolved"
          ? !(0, gameProjectionModel_js_1.normalizeString)(entry.inviteId)
          : !["missing", "ambiguous"].includes(entry.resolution) ||
            entry.inviteId !== null)
      ) {
        throw new Error("projector:profile-link-catchup-invalid-page");
      }
      previousMatchId = entry.matchId;
    }
    const startedAt = now();
    const shouldContinue = () =>
      now() - startedAt < PROFILE_LINK_CATCHUP_TIMEOUT_MS;
    const inviteIds = [];
    const inviteSet = new Set();
    let lastScannedMatchId = null;
    let matchIdsScanned = 0;
    let hasMoreMatches = page.hasMore;
    for (const { matchId, inviteId } of page.entries) {
      if (!shouldContinue()) {
        hasMoreMatches = true;
        break;
      }
      lastScannedMatchId = matchId;
      matchIdsScanned += 1;
      if (inviteId && !inviteSet.has(inviteId)) {
        inviteSet.add(inviteId);
        inviteIds.push(inviteId);
      }
    }
    if (matchIdsScanned < page.entries.length) {
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
              (ownerProfileId) =>
                (0, gameProjectionModel_js_1.normalizeString)(
                  ownerProfileId,
                ) === profileId,
            ) &&
            cleanupIds.every(
              (cleanupProfileId) =>
                (0, gameProjectionModel_js_1.normalizeString)(
                  cleanupProfileId,
                ) === profileId,
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
  };
};
exports.createProfileLinkProjectionCore = createProfileLinkProjectionCore;
