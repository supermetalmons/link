import type { EventPrizeAssignmentRecord } from "../../../../runtime/eventReads.js";
import {
  getEventPrizeDefinition,
  isEventPrizeAssignmentWireRecord,
  isEventPrizeStandard,
} from "@mons/shared/event-prizes";
import { createEventLockManagerCore } from "../../../../runtime/events/lockManagerCore.js";
import {
  createD1AuthRecoveryPrizeStore,
  type AuthRecoveryPrizeStore,
} from "../eventRepository.ts";
import { isCanonicalLoginUid } from "../recordKeys.ts";
import { cleanString } from "../authPolicy.ts";
import {
  createProfileLinkCatchupStore,
  type ProfileLinkCatchupStore,
} from "../profileLinkCatchupD1.ts";
import {
  commitProfileGameProjectionWrites,
  getProfileGameProjections,
  listProfileGameProjectionPage,
} from "../profileGamesD1.ts";
import {
  createD1EventPrizeWithdrawalStore,
  type EventPrizeWithdrawalStore,
} from "../eventPrizeWithdrawalD1.ts";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
  readCanonicalAuthRecoveryJob,
} from "../profileCanonicalD1.ts";
import { readCanonicalRecoveryFinalizationSnapshot } from "../profileCanonical/recoverySnapshot.ts";
import { dispatchProfileLinkCatchupForOwner } from "./dispatch.ts";
import {
  canonicalRecoveryJob,
  canonicalRecoveryValue,
  mutateCanonicalRecoveryJob,
  record,
  removeCanonicalAuthRecoveryLoginUid,
  type AuthRecoveryJob,
  type AuthRecoveryOutcome,
  type CanonicalRecoveryJob,
} from "./jobs.ts";

export const MERGE_GAME_FINALIZE_DELAY_MS = 60 * 1_000;
export const MERGE_PRIZE_RECOVERY_PAGE_SIZE = 20;
const LOGIN_RECOVERY_PAGE_SIZE = 20;
const AUTH_RECOVERY_EVENT_PRIZE_OWNER_UID = "auth-recovery-worker";
const AUTH_RECOVERY_PRIZE_OPERATION_TIMEOUT_MS = 20_000;

export type AuthRecoveryDependencies = {
  catchupStore?: ProfileLinkCatchupStore;
  buildPrizeCopy?: typeof buildPrizeCopy;
  d1?: D1Database;
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  profileDb?: D1Database;
  prizeOperationTimeoutMs?: number;
  prizeStore?: AuthRecoveryPrizeStore;
  signal?: AbortSignal;
  withdrawalDb?: D1Database;
  withdrawalStore?: Pick<EventPrizeWithdrawalStore, "get">;
};

function timestampMillis(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : 0;
}

function mergeFreshness(fields: Record<string, unknown>): number {
  return Math.max(
    timestampMillis(fields.updatedAt),
    timestampMillis(fields.listSortAt),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "";
}

function isSamePrizeAssignment(value: unknown, expected: unknown): boolean {
  const current = record(value);
  const assignment = record(expected);
  return (
    current.eventId === assignment.eventId &&
    current.profileId === assignment.profileId &&
    current.place === assignment.place &&
    current.prizeId === assignment.prizeId &&
    current.assignedAtMs === assignment.assignedAtMs
  );
}

function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function buildPrizeCopy(
  sourceProfileId: string,
  targetProfileId: string,
  eventId: string,
  value: unknown,
): EventPrizeAssignmentRecord | null {
  const normalizedEventId = cleanString(eventId);
  if (
    !isEventPrizeAssignmentWireRecord(value) ||
    value.eventId !== normalizedEventId ||
    value.profileId !== sourceProfileId
  ) {
    return null;
  }
  return {
    ...value,
    profileId: targetProfileId,
  };
}

function isCompletedPrizeWithdrawal(
  value: unknown,
  eventId: string,
  prizeId: string,
): boolean {
  const withdrawal = record(value);
  const definition = getEventPrizeDefinition(eventId, prizeId);
  const assetAddress = cleanString(definition?.assetAddress);
  const expectedStandard = cleanString(definition?.standard);
  const recordedStandard = cleanString(withdrawal.assetStandard);
  const standardMatches =
    (isEventPrizeStandard(recordedStandard) &&
      recordedStandard === expectedStandard) ||
    (!recordedStandard && expectedStandard === "core");
  return (
    Boolean(assetAddress) &&
    withdrawal.status === "completed" &&
    standardMatches &&
    cleanString(withdrawal.eventId) === eventId &&
    cleanString(withdrawal.prizeId) === prizeId &&
    cleanString(withdrawal.assetAddress) === assetAddress
  );
}

function createCanonicalAuthRecoveryService(
  env: Env,
  dependencies: AuthRecoveryDependencies = {},
) {
  const db = dependencies.profileDb || env.PROFILE_DB;
  const catchupStore =
    dependencies.catchupStore || createProfileLinkCatchupStore(db);
  const prizeStore =
    dependencies.prizeStore || createD1AuthRecoveryPrizeStore(env.EVENT_DB);
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const prizeOperationTimeoutMs =
    Number.isSafeInteger(dependencies.prizeOperationTimeoutMs) &&
    Number(dependencies.prizeOperationTimeoutMs) > 0
      ? Math.min(
          Number(dependencies.prizeOperationTimeoutMs),
          AUTH_RECOVERY_PRIZE_OPERATION_TIMEOUT_MS,
        )
      : AUTH_RECOVERY_PRIZE_OPERATION_TIMEOUT_MS;
  const profileGamesDb = dependencies.d1 || env.PROFILE_GAMES_DB;
  const withdrawalDb =
    dependencies.withdrawalDb || env.EVENT_PRIZE_WITHDRAWALS_DB;
  const withdrawals =
    dependencies.withdrawalStore ||
    createD1EventPrizeWithdrawalStore(withdrawalDb, { now });

  const copyPrize = async (
    sourceProfileId: string,
    targetProfileId: string,
    eventId: string,
  ): Promise<void> => {
    const signal = withTimeoutSignal(
      dependencies.signal,
      prizeOperationTimeoutMs,
    );
    const prizeLockManager = createEventLockManagerCore({
      createLockId: () => crypto.randomUUID(),
      now,
      transactEventLease: (key, updater) =>
        prizeStore.transactEventLease(key, updater, signal),
      releaseTransactEventLease: (key, updater) =>
        prizeStore.transactEventLease(key, updater),
    });
    const lock = await prizeLockManager.acquireEventLock(
      eventId,
      AUTH_RECOVERY_EVENT_PRIZE_OWNER_UID,
    );
    if (!lock) throw new Error("auth-recovery-prize-lock-busy");
    const stopHeartbeat = prizeLockManager.startEventLockHeartbeat(lock);
    try {
      const sourceAssignment = await prizeStore.readProfileEventPrizeAssignment(
        sourceProfileId,
        eventId,
        signal,
      );
      const assignment = (dependencies.buildPrizeCopy || buildPrizeCopy)(
        sourceProfileId,
        targetProfileId,
        eventId,
        sourceAssignment,
      );
      if (!assignment) throw new Error("auth-recovery-prize-invalid");
      const prizeId = cleanString(assignment.prizeId);
      const lockGuard = prizeLockManager.getEventLockGuard(lock);
      const transactTarget = (
        updater: Parameters<
          AuthRecoveryPrizeStore["transactStoredProfileEventPrizeWithEventLease"]
        >[2],
      ) =>
        prizeStore.transactStoredProfileEventPrizeWithEventLease(
          targetProfileId,
          eventId,
          updater,
          lockGuard,
          signal,
        );
      const assertPrizeLockOwned = async (): Promise<void> => {
        if (!(await prizeLockManager.isEventLockStillOwned(lock))) {
          throw new Error("auth-recovery-prize-lock-lost");
        }
      };
      const removeIfCompleted = async (): Promise<boolean> => {
        if (!prizeId) return false;
        const withdrawal = await withdrawals.get(eventId, prizeId);
        if (!isCompletedPrizeWithdrawal(withdrawal, eventId, prizeId)) {
          return false;
        }
        await assertPrizeLockOwned();
        await transactTarget((current) =>
          cleanString(record(current).eventId) === eventId &&
          cleanString(record(current).prizeId) === prizeId
            ? { value: null }
            : { commit: false },
        );
        return true;
      };
      if (await removeIfCompleted()) return;
      await assertPrizeLockOwned();
      await transactTarget((current) => {
        if (current === null || current === undefined) {
          return { value: assignment };
        }
        if (canonicalJson(current) === canonicalJson(assignment)) {
          return { commit: false };
        }
        if (isSamePrizeAssignment(current, assignment)) {
          return { value: assignment };
        }
        throw new Error("auth-recovery-prize-conflict");
      });
      await removeIfCompleted();
    } finally {
      stopHeartbeat();
      await prizeLockManager.releaseEventLock(lock);
    }
  };

  const recoverLogins = async (job: CanonicalRecoveryJob): Promise<boolean> => {
    let progressed = false;
    for (const uid of job.loginUids
      .filter(isCanonicalLoginUid)
      .slice(0, LOGIN_RECOVERY_PAGE_SIZE)) {
      try {
        await dispatchProfileLinkCatchupForOwner(uid, job.profileId, {
          catchupStore,
          enqueueProfileLinkProjection: (task) =>
            env.PROFILE_GAME_PROJECTION_QUEUE.send(task),
          logger,
        });
        const removed = await removeCanonicalAuthRecoveryLoginUid(
          db,
          job.profileId,
          uid,
          now,
        );
        progressed ||= removed;
      } catch {
        logger.error(JSON.stringify({ event: "auth_login_recovery_pending" }));
      }
    }
    return progressed;
  };

  const copyPrizePage = async (
    sourceProfileId: string,
    targetProfileId: string,
    prizeCursor: string | null,
  ): Promise<{
    complete: boolean;
    copied: number;
    nextCursor: string | null;
  }> => {
    const cursor = prizeCursor || "";
    const source = record(
      await prizeStore.listProfileEventPrizeAssignments(
        sourceProfileId,
        {
          ...(cursor ? { startAt: cursor } : {}),
          limit: cursor
            ? MERGE_PRIZE_RECOVERY_PAGE_SIZE + 2
            : MERGE_PRIZE_RECOVERY_PAGE_SIZE + 1,
        },
        dependencies.signal,
      ),
    );
    const remaining = Object.entries(source)
      .filter(([eventId]) => eventId > cursor)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const page = remaining.slice(0, MERGE_PRIZE_RECOVERY_PAGE_SIZE);
    for (const [eventId] of page) {
      await copyPrize(sourceProfileId, targetProfileId, eventId);
    }
    return {
      complete: remaining.length <= page.length,
      copied: page.length,
      nextCursor: page.at(-1)?.[0] || prizeCursor,
    };
  };

  const recoverPrizes = async (
    job: CanonicalRecoveryJob,
    sourceProfileId: string,
  ): Promise<boolean> => {
    const page = await copyPrizePage(
      sourceProfileId,
      job.profileId,
      job.prizeCursor,
    );
    const mutation = await mutateCanonicalRecoveryJob(
      db,
      job.profileId,
      (live) =>
        live.sourceProfileIds[0] === sourceProfileId &&
        live.sourcePhase === "prizes" &&
        live.prizeCursor === job.prizeCursor
          ? {
              ...live,
              sourcePhase: page.complete ? "games" : "prizes",
              prizeCursor: page.nextCursor,
              phaseStartedAtMs: page.complete ? now() : live.phaseStartedAtMs,
              updatedAtMs: now(),
            }
          : undefined,
    );
    return mutation === "updated";
  };

  const recoverGames = async (
    job: CanonicalRecoveryJob,
    sourceProfileId: string,
  ): Promise<boolean> => {
    const sourcePage = await listProfileGameProjectionPage(
      profileGamesDb,
      sourceProfileId,
    );
    if (sourcePage.length > 0) {
      const targets = await getProfileGameProjections(
        profileGamesDb,
        job.profileId,
        sourcePage.map((game) => game.projectionId),
      );
      const writes = sourcePage.flatMap((game) => {
        const current = targets.get(game.projectionId);
        const copy =
          !current || mergeFreshness(game.data) >= mergeFreshness(current.data)
            ? [
                {
                  type: current ? ("update" as const) : ("create" as const),
                  profileId: job.profileId,
                  projectionId: game.projectionId,
                  data: { ...game.data, ownerProfileId: job.profileId },
                  ...(current
                    ? { expectedVersion: current.version }
                    : { requireAbsent: true }),
                },
              ]
            : [];
        return [
          ...copy,
          {
            type: "delete" as const,
            profileId: sourceProfileId,
            projectionId: game.projectionId,
            expectedVersion: game.version,
          },
        ];
      });
      await commitProfileGameProjectionWrites(profileGamesDb, writes);
      const mutation = await mutateCanonicalRecoveryJob(
        db,
        job.profileId,
        (live) =>
          live.sourceProfileIds[0] === sourceProfileId &&
          live.sourcePhase === "games"
            ? { ...live, phaseStartedAtMs: now(), updatedAtMs: now() }
            : undefined,
      );
      return mutation === "updated";
    }
    if (now() - job.phaseStartedAtMs < MERGE_GAME_FINALIZE_DELAY_MS)
      return false;
    const mutation = await mutateCanonicalRecoveryJob(
      db,
      job.profileId,
      (live) =>
        live.sourceProfileIds[0] === sourceProfileId &&
        live.sourcePhase === "games"
          ? {
              ...live,
              sourcePhase: "finalize",
              prizeCursor: null,
              phaseStartedAtMs: now(),
              updatedAtMs: now(),
            }
          : undefined,
    );
    return mutation === "updated";
  };

  const finalizeSource = async (
    job: CanonicalRecoveryJob,
    sourceProfileId: string,
  ): Promise<boolean> => {
    if (
      (await listProfileGameProjectionPage(profileGamesDb, sourceProfileId, 1))
        .length > 0
    ) {
      const mutation = await mutateCanonicalRecoveryJob(
        db,
        job.profileId,
        (live) =>
          live.sourceProfileIds[0] === sourceProfileId &&
          live.sourcePhase === "finalize"
            ? {
                ...live,
                sourcePhase: "games",
                phaseStartedAtMs: now(),
                updatedAtMs: now(),
              }
            : undefined,
      );
      return mutation === "updated";
    }
    const prizePage = await copyPrizePage(
      sourceProfileId,
      job.profileId,
      job.prizeCursor,
    );
    if (!prizePage.complete || prizePage.copied > 0) {
      const mutation = await mutateCanonicalRecoveryJob(
        db,
        job.profileId,
        (live) =>
          live.sourceProfileIds[0] === sourceProfileId &&
          live.sourcePhase === "finalize" &&
          live.prizeCursor === job.prizeCursor
            ? {
                ...live,
                prizeCursor: prizePage.nextCursor,
                updatedAtMs: now(),
              }
            : undefined,
      );
      return mutation === "updated";
    }
    const { target, source, mergePath } =
      await readCanonicalRecoveryFinalizationSnapshot(
        db,
        job.profileId,
        sourceProfileId,
      );
    if (!target.profile || !target.recovery || !mergePath) return false;
    const live = canonicalRecoveryJob(target.recovery);
    const firstTargetProfileId = mergePath[0].targetProfileId;
    const mergeExpectations = mergePath.map((mapping) => ({
      kind: "merge-target" as const,
      sourceProfileId: mapping.sourceProfileId,
      targetProfileId: mapping.targetProfileId,
    }));
    if (
      live.sourceProfileIds[0] !== sourceProfileId ||
      live.sourcePhase !== "finalize" ||
      (source.profile &&
        (source.profile.mergedIntoProfileId !== firstTargetProfileId ||
          source.loginOwners.length > 0))
    ) {
      return false;
    }
    const sourceProfileIds = source.profile
      ? live.sourceProfileIds
      : live.sourceProfileIds.slice(1);
    const updated: AuthRecoveryJob = {
      ...live,
      sourceProfileIds,
      sourcePhase: source.profile
        ? "games"
        : sourceProfileIds.length > 0
          ? "prizes"
          : "finalize",
      prizeCursor: null,
      phaseStartedAtMs: now(),
      updatedAtMs: now(),
    };
    await commitCanonicalPlan(db, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: target.profile.profileId,
          revision: target.profile.revision,
        },
        {
          kind: "auth-recovery-revision",
          profileId: live.profileId,
          revision: live.revision,
        },
        ...mergeExpectations,
        ...(source.profile
          ? ([
              {
                kind: "profile-revision",
                profileId: sourceProfileId,
                revision: source.profile.revision,
              },
            ] as const)
          : []),
      ],
      mutations: [
        ...(source.profile
          ? ([
              {
                kind: "delete-retired-profile",
                profileId: sourceProfileId,
                targetProfileId: firstTargetProfileId,
              },
            ] as const)
          : []),
        {
          kind: "update-auth-recovery",
          value: canonicalRecoveryValue(updated),
        },
      ],
    });
    return true;
  };

  const recoverProfile = async (
    profileId: string,
  ): Promise<AuthRecoveryOutcome> => {
    const recovery = await readCanonicalAuthRecoveryJob(db, profileId);
    if (!recovery) return "done";
    let job = canonicalRecoveryJob(recovery);
    const loginsProgressed = await recoverLogins(job);
    const refreshed = await readCanonicalAuthRecoveryJob(db, profileId);
    if (!refreshed) return "done";
    job = canonicalRecoveryJob(refreshed);
    if (job.loginUids.some(isCanonicalLoginUid))
      return loginsProgressed ? "continued" : "deferred";
    if (job.sourceProfileIds.length === 0) {
      if (job.loginUids.length !== 0) {
        logger.error(JSON.stringify({ event: "auth_recovery_uid_invalid" }));
        return "deferred";
      }
      if (now() - job.updatedAtMs < MERGE_GAME_FINALIZE_DELAY_MS)
        return "deferred";
      const mutation = await mutateCanonicalRecoveryJob(
        db,
        profileId,
        (live) =>
          live.loginUids.length === 0 &&
          live.sourceProfileIds.length === 0 &&
          now() - live.updatedAtMs >= MERGE_GAME_FINALIZE_DELAY_MS
            ? null
            : undefined,
      );
      return mutation === "missing" || mutation === "deleted"
        ? "done"
        : "deferred";
    }
    const sourceProfileId = job.sourceProfileIds[0];
    let progressed = false;
    try {
      if (job.sourcePhase === "prizes") {
        progressed = await recoverPrizes(job, sourceProfileId);
      } else if (job.sourcePhase === "games") {
        progressed = await recoverGames(job, sourceProfileId);
      } else {
        progressed = await finalizeSource(job, sourceProfileId);
      }
    } catch (error) {
      if (!(error instanceof CanonicalProfileConflict)) {
        logger.error(
          JSON.stringify({
            event:
              error instanceof Error &&
              error.message === "auth-recovery-prize-conflict"
                ? "auth_recovery_prize_conflict"
                : "auth_recovery_pending",
          }),
        );
      }
    }
    const remaining = await readCanonicalAuthRecoveryJob(db, profileId);
    if (!remaining) return "done";
    if (
      remaining.loginUids.length === 0 &&
      remaining.sourceProfileIds.length === 0 &&
      now() - remaining.updatedAtMs < MERGE_GAME_FINALIZE_DELAY_MS
    )
      return "deferred";
    return progressed ? "continued" : "deferred";
  };

  return { recoverProfile };
}

export function createAuthRecoveryService(
  env: Env,
  dependencies: AuthRecoveryDependencies = {},
) {
  return createCanonicalAuthRecoveryService(env, dependencies);
}
