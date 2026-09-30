import type {
  RecomputeInviteProjectionOptions,
  RecomputeInviteProjectionResult,
} from "./profileGamesProjectionCore.js";

import { normalizeString } from "./events/gameProjectionModel.js";
export type ProfileLinkProjectionRepository = {
  listMatchesPage(
    loginUid: string,
    afterMatchId: string,
    limit: number,
  ): Promise<{
    entries: Array<{
      matchId: string;
      inviteId: string | null;
      resolution: "resolved" | "missing" | "ambiguous";
    }>;
    hasMore: boolean;
  }>;
  readProfileOwnershipSnapshot(query: {
    loginUids: readonly string[];
    profileIds: readonly string[];
  }): Promise<{
    profileIdByLoginUid: ReadonlyMap<string, string | null>;
  }>;
};
export type ProfileLinkProjectionSummary = {
  loginUid: string;
  profileId: string;
  eventProfileId: string;
  matchIdsScanned: number;
  inviteIdsResolved: number;
  processed: number;
  failed: number;
  didTimeout: boolean;
  didHitInviteCap: boolean;
  elapsedMs: number;
  nextMatchCursor: string | null;
};
type Signature_createProfileLinkProjectionCore = (dependencies: {
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  recomputeInviteProjection(
    inviteId: string,
    reason: string,
    options?: RecomputeInviteProjectionOptions,
  ): Promise<RecomputeInviteProjectionResult>;
  repository: ProfileLinkProjectionRepository;
  withInviteProjectionLock<T>(
    inviteId: string,
    work: () => Promise<T>,
  ): Promise<T>;
}) => {
  processProfileLinkCatchup(input: {
    cleanupProfileIds?: string[];
    loginUid: string;
    matchCursor?: string | null;
    profileId: string;
    sourceUpdatedAtMs?: number;
  }): Promise<ProfileLinkProjectionSummary | null>;
};

const PROFILE_LINK_CATCHUP_MAX_INVITES = 20;
const PROFILE_LINK_CATCHUP_MAX_INVITES_WITH_CLEANUP = 1;
const PROFILE_LINK_CATCHUP_CONCURRENCY = 3;
const PROFILE_LINK_CATCHUP_TIMEOUT_MS = 50000;

const processWithConcurrency = async <T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<unknown>,
  shouldContinue?: () => boolean,
) => {
  if (items.length === 0) {
    return;
  }
  let index = 0;
  let failure: unknown = null;
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

const createProfileLinkProjectionCore: Signature_createProfileLinkProjectionCore =
  ({
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

    const processProfileLinkCatchup: ReturnType<Signature_createProfileLinkProjectionCore>["processProfileLinkCatchup"] =
      async ({
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
          Number.isSafeInteger(sourceUpdatedAtMs) && sourceUpdatedAtMs! >= 0
            ? sourceUpdatedAtMs!
            : now();
        const observedProfileIds = new Set(
          cleanupProfileIds
            .map(normalizeString)
            .filter((value): value is string => Boolean(value)),
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
              ? !normalizeString(entry.inviteId)
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
                    normalizeString(ownerProfileId) === profileId,
                ) &&
                cleanupIds.every(
                  (cleanupProfileId) =>
                    normalizeString(cleanupProfileId) === profileId,
                ),
              );
              if (
                result?.sourceCleanupSafe === false &&
                !unresolvedOwnerIsSafe
              ) {
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
                error:
                  (error as { message?: unknown } | null)?.message || error,
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

export {
  PROFILE_LINK_CATCHUP_CONCURRENCY,
  PROFILE_LINK_CATCHUP_MAX_INVITES,
  PROFILE_LINK_CATCHUP_MAX_INVITES_WITH_CLEANUP,
  PROFILE_LINK_CATCHUP_TIMEOUT_MS,
  createProfileLinkProjectionCore,
  processWithConcurrency,
};
