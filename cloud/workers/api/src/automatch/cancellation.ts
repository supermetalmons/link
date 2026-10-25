import {
  inviteProjectionState,
  inviteTrimmedParticipants,
} from "@mons/shared/invite-records";
import {
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionChanges,
  buildAutomatchTelegramLifecycleChanges,
} from "../../../../runtime/telegram/automatchSource.js";
import type { AutomatchRepository } from "../gameplayContracts.ts";
import type { GameSessionChange } from "../gameSessionContracts.ts";
import { requestAutomatchProfileProjection } from "../gameSessionProjectionChanges.ts";
import {
  GameSessionMutationLeaseReleaseFailure,
  withGameSessionMutationLease,
} from "../gameSessionMutationRunner.ts";
import {
  STATE_SERVER_TIMESTAMP,
  stateIncrement,
} from "../stateCompatibility.ts";
import {
  AUTOMATCH_CANCELLATION_RECONCILE_TIMEOUT_MS,
  AUTOMATCH_TOTAL_TIMEOUT_MS,
} from "./policy.ts";
import {
  createAutomatchProfileGameProjectionTask,
  createAutomatchProjectionTask,
  enqueueAutomatchProjections,
} from "./projections.ts";
import type { AutomatchDependencies, QueuedAutomatch } from "./types.ts";

const AUTOMATCH_CANCELLATION_RECONCILE_DELAY_MS = 50;
const AUTOMATCH_CANCELLATION_FINAL_READ_TIMEOUT_MS = 250;

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number {
  const parsed =
    typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function automatchTimestamp(value: unknown): number {
  return Math.floor(finiteNumber(value));
}

export function automatchTelegramDeliveryVersion(
  value: unknown,
): number | null {
  return value === TELEGRAM_AUTOMATCH_VERSION
    ? TELEGRAM_AUTOMATCH_VERSION
    : null;
}

async function readAutomatchCancellationProof(
  inviteId: string,
  expectedUid: string,
  requestId: string,
  repository: AutomatchRepository,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const [queueValue, inviteValue, outboxRequestId] = await Promise.all([
      repository.readAutomatchEntry(inviteId, signal),
      repository.readInviteMetadata(inviteId, signal),
      repository.readAutomatchProfileOutbox(inviteId, signal),
    ]);
    const invite = inviteProjectionState(inviteValue);
    return Boolean(
      queueValue.isNull &&
      normalizeString(invite?.hostId) === expectedUid &&
      !normalizeString(invite?.guestId) &&
      invite?.automatchStateHint === "canceled" &&
      typeof invite.automatchCanceledAt === "number" &&
      Number.isFinite(invite.automatchCanceledAt) &&
      outboxRequestId.matchesCancellationRequest(requestId),
    );
  } catch {
    return false;
  }
}

async function didCommitAutomatchCancellation(
  inviteId: string,
  expectedUid: string,
  requestId: string,
  repository: AutomatchRepository,
  signal: AbortSignal,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): Promise<boolean> {
  for (
    let elapsedMs = 0;
    elapsedMs < AUTOMATCH_CANCELLATION_RECONCILE_TIMEOUT_MS;
    elapsedMs += AUTOMATCH_CANCELLATION_RECONCILE_DELAY_MS
  ) {
    if (
      await readAutomatchCancellationProof(
        inviteId,
        expectedUid,
        requestId,
        repository,
        signal,
      )
    ) {
      return true;
    }
    try {
      await wait(AUTOMATCH_CANCELLATION_RECONCILE_DELAY_MS, signal);
    } catch {
      break;
    }
  }
  return readAutomatchCancellationProof(
    inviteId,
    expectedUid,
    requestId,
    repository,
    AbortSignal.timeout(AUTOMATCH_CANCELLATION_FINAL_READ_TIMEOUT_MS),
  );
}

export async function cancelQueuedAutomatch(
  queued: QueuedAutomatch,
  repository: AutomatchRepository,
  dependencies: AutomatchDependencies,
  signal: AbortSignal = dependencies.signal ||
    AbortSignal.timeout(AUTOMATCH_TOTAL_TIMEOUT_MS),
): Promise<boolean> {
  const expectedUid = normalizeString(queued.data.uid);
  if (!expectedUid) return false;
  const expectedTimestamp = automatchTimestamp(queued.data.timestamp);
  const expectedTelegramDeliveryVersion = automatchTelegramDeliveryVersion(
    queued.data.telegramDeliveryVersion,
  );
  const profileGameProjectionTask = createAutomatchProfileGameProjectionTask(
    queued.inviteId,
    dependencies,
  );
  const projectionTask = expectedTelegramDeliveryVersion
    ? createAutomatchProjectionTask(
        queued.inviteId,
        dependencies,
        profileGameProjectionTask.requestId,
      )
    : null;
  let patchAttempted = false;
  let canceled = false;
  try {
    canceled = await withGameSessionMutationLease(
      queued.inviteId,
      profileGameProjectionTask.requestId,
      dependencies.mutationLocks,
      async () => {
        const [currentQueueValue, currentInvite] = await Promise.all([
          repository.readAutomatchEntry(queued.inviteId, signal),
          repository.readInviteMetadata(queued.inviteId, signal),
        ]);
        const { guestId: currentGuestId, hostId: currentHostId } =
          inviteTrimmedParticipants(currentInvite);
        const currentQueue = currentQueueValue.record;
        const currentUid = normalizeString(currentQueue?.uid);
        if (
          !currentQueue ||
          currentUid !== expectedUid ||
          automatchTimestamp(currentQueue.timestamp) !== expectedTimestamp ||
          automatchTelegramDeliveryVersion(
            currentQueue.telegramDeliveryVersion,
          ) !== expectedTelegramDeliveryVersion ||
          normalizeString(currentGuestId) ||
          normalizeString(currentHostId) !== currentUid
        ) {
          return false;
        }
        const changes: GameSessionChange[] = [
          { kind: "automatch-entry", inviteId: queued.inviteId, value: null },
          {
            kind: "invite-fields",
            inviteId: queued.inviteId,
            value: {
              automatchStateHint: "canceled",
              automatchCanceledAt: STATE_SERVER_TIMESTAMP,
            },
          },
          ...requestAutomatchProfileProjection({
            inviteId: queued.inviteId,
            requestId: profileGameProjectionTask.requestId,
            timestamp: STATE_SERVER_TIMESTAMP,
          }),
        ];
        if (expectedTelegramDeliveryVersion) {
          changes.push(
            ...buildAutomatchTelegramLifecycleChanges({
              inviteId: queued.inviteId,
              lifecycle: "canceled",
              timestamp: STATE_SERVER_TIMESTAMP,
              generation: stateIncrement(1),
            }),
            ...buildAutomatchTelegramProjectionChanges({
              inviteId: queued.inviteId,
              requestId: projectionTask?.requestId || "",
              timestamp: STATE_SERVER_TIMESTAMP,
            }),
          );
        }
        await dependencies.assertMutationAllowed?.();
        patchAttempted = true;
        await repository.commitSessionChanges(changes, signal);
        return true;
      },
    );
  } catch (error) {
    if (!patchAttempted) throw error;
    if (
      !(error instanceof GameSessionMutationLeaseReleaseFailure) ||
      !error.workCompleted
    ) {
      const reconciliationSignal = AbortSignal.timeout(
        AUTOMATCH_CANCELLATION_RECONCILE_TIMEOUT_MS,
      );
      if (
        !(await didCommitAutomatchCancellation(
          queued.inviteId,
          expectedUid,
          profileGameProjectionTask.requestId,
          repository,
          reconciliationSignal,
          dependencies.wait ||
            ((milliseconds, waitSignal) =>
              scheduler.wait(milliseconds, { signal: waitSignal })),
        ))
      ) {
        throw error;
      }
    }
    canceled = true;
    if (error instanceof GameSessionMutationLeaseReleaseFailure) {
      await enqueueAutomatchProjections(
        projectionTask,
        profileGameProjectionTask,
        dependencies,
      );
      return true;
    }
  }
  if (!canceled) return false;
  await enqueueAutomatchProjections(
    projectionTask,
    profileGameProjectionTask,
    dependencies,
  );
  return true;
}
