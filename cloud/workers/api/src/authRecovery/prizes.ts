import type { EventPrizeAssignmentRecord } from "../../../../runtime/eventReads.js";
import {
  withdrawalIdentity,
  withdrawalStatus,
  type WithdrawalDocument,
} from "../../../../runtime/eventPrizes/records.js";
import {
  getEventPrizeDefinition,
  isEventPrizeAssignmentWireRecord,
  isEventPrizeStandard,
} from "@mons/shared/event-prizes";
import {
  createEventLockManagerCore,
  withEventLease,
} from "../../../../runtime/events/lockManagerCore.js";
import type { AuthRecoveryPrizeStore } from "../eventRepository.ts";
import type { EventPrizeWithdrawalStore } from "../eventPrizeWithdrawalD1.ts";
import { cleanString } from "../authPolicy.ts";
import { canonicalAuthRecoveryJson as canonicalJson } from "../canonicalJson.ts";
import {
  mutateCanonicalRecoveryJob,
  record,
  type CanonicalRecoveryJob,
} from "./jobs.ts";
import {
  AUTH_RECOVERY_EVENT_PRIZE_OWNER_UID,
  MERGE_PRIZE_RECOVERY_PAGE_SIZE,
} from "./policy.ts";

export type PrizeRecoveryOptions = {
  buildPrizeCopy?: typeof buildPrizeCopy;
  signal?: AbortSignal;
};

export type PrizeCopyPage = (
  sourceProfileId: string,
  targetProfileId: string,
  prizeCursor: string | null,
) => Promise<{
  complete: boolean;
  copied: number;
  nextCursor: string | null;
}>;

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
  value: WithdrawalDocument | null,
  eventId: string,
  prizeId: string,
): boolean {
  const withdrawal = withdrawalIdentity(value);
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
    withdrawalStatus(value) === "completed" &&
    standardMatches &&
    cleanString(withdrawal.eventId) === eventId &&
    cleanString(withdrawal.prizeId) === prizeId &&
    cleanString(withdrawal.assetAddress) === assetAddress
  );
}

export function createPrizeRecovery({
  db,
  prizeStore,
  withdrawals,
  now,
  prizeOperationTimeoutMs,
  options,
}: {
  db: D1Database;
  prizeStore: AuthRecoveryPrizeStore;
  withdrawals: Pick<EventPrizeWithdrawalStore, "get">;
  now: () => number;
  prizeOperationTimeoutMs: number;
  options: PrizeRecoveryOptions;
}) {
  const copyPrize = async (
    sourceProfileId: string,
    targetProfileId: string,
    eventId: string,
  ): Promise<void> => {
    const signal = withTimeoutSignal(options.signal, prizeOperationTimeoutMs);
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
    return withEventLease(prizeLockManager, lock, async () => {
      const sourceAssignment = await prizeStore.readProfileEventPrizeAssignment(
        sourceProfileId,
        eventId,
        signal,
      );
      const assignment = (options.buildPrizeCopy || buildPrizeCopy)(
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
    });
  };

  const copyPrizePage: PrizeCopyPage = async (
    sourceProfileId,
    targetProfileId,
    prizeCursor,
  ) => {
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
        options.signal,
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

  return { copyPrizePage, recoverPrizes };
}
