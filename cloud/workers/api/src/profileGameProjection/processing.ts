import { createEventLockManagerCore } from "../../../../runtime/events/lockManagerCore.js";
import { HISTORICAL_MATCH_ARCHIVE_VERSION } from "../historicalMatches.ts";
import type { RatingProfileGameProjectionRepository } from "../ratingContracts.ts";
import { isSafeRecordKey } from "../recordKeys.ts";
import {
  parseAutomatchProfileGameProjectionOutbox,
  parseEventProfileGameProjectionOutbox,
} from "../profileGameProjectionOutbox.ts";
import type {
  EventProfileGameProjectionRuntime,
  ProfileGameProjectionRuntime,
} from "../profileGameProjectionRepository.ts";
import {
  PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
  type AutomatchProfileGameProjectionTask,
  type EventProfileGameProjectionTask,
  type ProfileLinkProfileGameProjectionTask,
} from "../profileGameProjectionTasks.ts";
import type {
  ProfileGameProjectionLock,
  ProfileGameProjectionLockStore,
} from "../profileGameProjectionLocksD1.ts";
import {
  archiveHistoricalDescriptor,
  settleHistoricalDescriptor,
  archiveRetryIsPending,
  finishAutomatchProjectionBatch,
} from "./history.ts";
import {
  HISTORICAL_MATCH_ARCHIVE_BATCH_SIZE,
  PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS,
} from "./policy.ts";
import type {
  AutomatchProjectionState,
  EventProfileProjectionState,
  ProfileGameProjectionLogger,
  ProfileLinkProcessingJobs,
  ProfileLinkProjectionResult,
} from "./types.ts";

export function validRatingProjectionRecord(
  operationId: string,
  update: Awaited<
    ReturnType<RatingProfileGameProjectionRepository["readRatingUpdate"]>
  >,
): update is NonNullable<typeof update> & { completedAtMs: number } {
  return Boolean(
    update &&
    update.profileGameProjectionVersion ===
      PROFILE_GAME_PROJECTION_SCHEMA_VERSION &&
    Number.isSafeInteger(update.completedAtMs) &&
    (update.completedAtMs || 0) > 0 &&
    isSafeRecordKey(update.inviteId) &&
    isSafeRecordKey(update.matchId) &&
    operationId === `${update.inviteId}__${update.matchId}`,
  );
}

export async function settleAutomatchProfileGameProjectionOutbox(
  task: AutomatchProfileGameProjectionTask,
  state: AutomatchProjectionState,
): Promise<boolean> {
  const result = await state.transactAutomatchProfileOutbox(
    task.inviteId,
    (current) => {
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return { value: null, decision: "cleared" };
    },
  );
  return result.committed;
}

export async function processAutomatchProfileGameProjection(
  task: AutomatchProfileGameProjectionTask,
  state: AutomatchProjectionState,
  runtime: ProfileGameProjectionRuntime,
  locks: ProfileGameProjectionLockStore,
  ownerId: string = crypto.randomUUID(),
  now: () => number = Date.now,
  logger: ProfileGameProjectionLogger = console,
): Promise<"continued" | "deferred" | "projected" | "stale" | "superseded"> {
  const initialOutbox = parseAutomatchProfileGameProjectionOutbox(
    await state.readAutomatchProfileOutbox(task.inviteId),
  );
  if (!initialOutbox || initialOutbox.requestId !== task.requestId)
    return "stale";
  if (archiveRetryIsPending(initialOutbox, now())) return "deferred";
  const lock: ProfileGameProjectionLock = {
    scope: "invite",
    resourceId: task.inviteId,
    requestId: task.requestId,
  };
  await locks.acquire(lock, ownerId, now());
  try {
    const outbox = parseAutomatchProfileGameProjectionOutbox(
      await state.readAutomatchProfileOutbox(task.inviteId),
    );
    if (!outbox || outbox.requestId !== task.requestId) return "stale";
    if (archiveRetryIsPending(outbox, now())) return "deferred";
    await runtime.recomputeInviteProjection(task.inviteId, outbox.reason, {
      eventTimestampMs: outbox.sourceUpdatedAtMs,
    });
    const batchNowMs = now();
    const descriptors = (outbox.historicalMatches || [])
      .filter(({ retryNotBeforeMs }) => (retryNotBeforeMs || 0) <= batchNowMs)
      .slice(0, HISTORICAL_MATCH_ARCHIVE_BATCH_SIZE);
    let firstArchiveFailure: unknown;
    let archiveFailed = false;
    for (const descriptor of descriptors) {
      try {
        const status = await archiveHistoricalDescriptor(
          descriptor,
          task.inviteId,
          state,
          runtime,
        );
        const retryNotBeforeMs =
          status === "archived"
            ? undefined
            : now() + PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS;
        if (
          !(await settleHistoricalDescriptor(
            task,
            descriptor,
            state,
            retryNotBeforeMs,
          ))
        ) {
          return "superseded";
        }
        if (status !== "archived")
          logger.info(
            JSON.stringify({
              event: "historical_match_archive_descriptor_deferred",
              inviteId: task.inviteId,
              matchId: descriptor.matchId,
              requestId: task.requestId,
              reason: status,
              retryNotBeforeMs,
            }),
          );
      } catch (error) {
        logger.error(
          JSON.stringify({
            event: "historical_match_archive_descriptor_failed",
            inviteId: task.inviteId,
            matchId: descriptor.matchId,
            requestId: task.requestId,
            code: error instanceof Error ? error.message : "unknown",
          }),
        );
        if (!archiveFailed) {
          archiveFailed = true;
          firstArchiveFailure = error;
        }
      }
    }
    if (archiveFailed) throw firstArchiveFailure;
    return await finishAutomatchProjectionBatch(task, state, now());
  } finally {
    await locks.release(lock, ownerId);
  }
}

export async function settleEventProfileGameProjectionOutbox(
  task: EventProfileGameProjectionTask,
  state: EventProfileProjectionState,
): Promise<boolean> {
  const result = await state.transactEventProfileGameProjectionOutbox(
    task.eventId,
    (current) => {
      const outbox = parseEventProfileGameProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return { value: null, decision: "cleared" };
    },
  );
  return result.committed;
}

export async function processEventProfileGameProjection(
  task: EventProfileGameProjectionTask,
  state: EventProfileProjectionState,
  runtime: EventProfileGameProjectionRuntime,
  ownerId: string = crypto.randomUUID(),
  now: () => number = Date.now,
): Promise<"missing" | "projected" | "stale" | "superseded"> {
  const initialOutbox = parseEventProfileGameProjectionOutbox(
    await state.readEventProfileGameProjectionOutbox(task.eventId),
  );
  if (!initialOutbox || initialOutbox.requestId !== task.requestId) {
    return "stale";
  }
  const lockManager = createEventLockManagerCore({
    lockKind: "profile-game-projection",
    createLockId: () => crypto.randomUUID(),
    includeLegacyOwnerId: true,
    transactEventLease: state.transactEventLease,
    now,
  });
  const lock = await lockManager.acquireEventLock(task.eventId, ownerId);
  if (!lock) throw new Error("profile-game-projection-lock-busy");
  const stopHeartbeat = lockManager.startEventLockHeartbeat(lock);
  try {
    const outbox = parseEventProfileGameProjectionOutbox(
      await state.readEventProfileGameProjectionOutbox(task.eventId),
    );
    if (!outbox || outbox.requestId !== task.requestId) {
      return "stale";
    }
    const result = await runtime.reconcileEventProjection(
      task.eventId,
      outbox.cleanupOwnerProfileIds,
      {
        assertCanCommit: async () => {
          if (!(await lockManager.isEventLockStillOwned(lock))) {
            throw new Error("profile-game-projection-lock-lost");
          }
        },
      },
    );
    return (await settleEventProfileGameProjectionOutbox(task, state))
      ? result.status
      : "superseded";
  } finally {
    stopHeartbeat();
    await lockManager.releaseEventLock(lock);
  }
}

export async function processProfileLinkProfileGameProjection(
  task: ProfileLinkProfileGameProjectionTask,
  jobs: ProfileLinkProcessingJobs,
  process: (input: {
    cleanupProfileIds: string[];
    loginUid: string;
    matchCursor: string | null;
    profileId: string;
    sourceUpdatedAtMs: number;
    withInviteProjectionLock<T>(
      inviteId: string,
      work: () => Promise<T>,
    ): Promise<T>;
  }) => Promise<ProfileLinkProjectionResult | null>,
  locks: ProfileGameProjectionLockStore,
  ownerId: string = crypto.randomUUID(),
  now: () => number = Date.now,
): Promise<"continued" | "missing" | "projected" | "stale" | "superseded"> {
  const initialJob = await jobs.read(task.loginUid);
  if (!initialJob || initialJob.requestId !== task.requestId) {
    return "stale";
  }
  const lock: ProfileGameProjectionLock = {
    scope: "profile-link",
    resourceId: task.loginUid,
    requestId: task.requestId,
  };
  await locks.acquire(lock, ownerId, now());
  try {
    const job = await jobs.read(task.loginUid);
    if (!job || job.requestId !== task.requestId) {
      return "stale";
    }
    const projection = await process({
      cleanupProfileIds: job.cleanupProfileIds,
      loginUid: task.loginUid,
      matchCursor: job.matchCursor,
      profileId: job.profileId,
      sourceUpdatedAtMs: job.sourceUpdatedAtMs,
      withInviteProjectionLock: async (inviteId, work) => {
        const inviteOwnerId = crypto.randomUUID();
        const inviteLock: ProfileGameProjectionLock = {
          scope: "invite",
          resourceId: inviteId,
        };
        await locks.acquire(inviteLock, inviteOwnerId, now());
        try {
          return await work();
        } finally {
          await locks.release(inviteLock, inviteOwnerId);
        }
      },
    });
    if (!projection) {
      return (await jobs.settleMissing(
        task.loginUid,
        task.requestId,
        job.matchCursor,
      ))
        ? "missing"
        : "superseded";
    }
    if (projection.didHitInviteCap && !projection.nextMatchCursor) {
      throw new Error("profile-link-profile-game-projection-no-progress");
    }
    if (projection.nextMatchCursor) {
      const continued = await jobs.advance(
        task.loginUid,
        task.requestId,
        job.matchCursor,
        projection.nextMatchCursor,
        now(),
      );
      return continued ? "continued" : "superseded";
    }
    return (await jobs.settle(task.loginUid, task.requestId, job.matchCursor))
      ? "projected"
      : "superseded";
  } finally {
    await locks.release(lock, ownerId);
  }
}

export async function processRatingProfileGameProjection(
  operationId: string,
  rating: RatingProfileGameProjectionRepository,
  runtime: ProfileGameProjectionRuntime,
  now: () => number,
  locks: ProfileGameProjectionLockStore,
  ownerId: string = crypto.randomUUID(),
): Promise<"dead" | "done" | "stale"> {
  const update = await rating.readRatingUpdate(operationId);
  if (!update || update.profileGameProjectionState !== "pending") {
    return "stale";
  }
  if (!validRatingProjectionRecord(operationId, update)) {
    await rating.markRatingProfileGameProjection(
      operationId,
      "dead",
      now(),
      "invalid-record",
    );
    return "dead";
  }
  if (
    update.historicalMatchArchiveVersion !== undefined &&
    update.historicalMatchArchiveVersion !== HISTORICAL_MATCH_ARCHIVE_VERSION
  ) {
    throw new Error("historical-match-archive-version-unsupported");
  }
  if (
    update.historicalMatchArchiveVersion === HISTORICAL_MATCH_ARCHIVE_VERSION &&
    !update.historicalMatchPair
  ) {
    throw new Error("historical-match-pair-missing");
  }
  const lock: ProfileGameProjectionLock = {
    scope: "invite",
    resourceId: update.inviteId,
  };
  await locks.acquire(lock, ownerId, now());
  try {
    if (update.status !== "done") {
      throw new Error("profile-game-projection-rating-pending");
    }
    await runtime.recomputeInviteProjection(
      update.inviteId,
      "invite-match-rating-updated",
      {
        eventTimestampMs: update.completedAtMs,
        latestMatchIdHint: update.matchId,
      },
    );
    if (update.historicalMatchPair) {
      if (!runtime.archiveHistoricalMatch) {
        throw new Error("historical-match-archive-unavailable");
      }
      await runtime.archiveHistoricalMatch({
        finalizedAtMs: update.completedAtMs,
        inviteId: update.inviteId,
        pair: update.historicalMatchPair,
        source: "rating",
      });
    }
  } finally {
    await locks.release(lock, ownerId);
  }
  await rating.markRatingProfileGameProjection(operationId, "done", now());
  return "done";
}
