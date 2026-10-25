import {
  readInviteDocument,
  inviteTrimmedParticipants,
  inviteProjectionState,
  mergeInviteAutomatchOperation,
} from "@mons/shared/invite-records";
import {
  emptyAutomatchEntryFields,
  type AutomatchEntryRead,
} from "../../../runtime/automatchRecords.js";
import type { RandomSource } from "@mons/shared/ids";
import type { StartAutomatchResponse } from "@mons/shared/navigation";
import {
  automatchTelegramDeliveryVersion,
  automatchTimestamp,
  cancelQueuedAutomatch,
} from "./automatch/cancellation.ts";
import { commitAutomatchWithLease } from "./automatch/commit.ts";
import {
  buildMatchedAutomatchPlan,
  buildPendingAutomatchPlan,
  matchedAutomatchResponse,
  pendingAutomatchResponse,
} from "./automatch/plans.ts";
import {
  AUTOMATCH_CANCELLATION_RECONCILE_TIMEOUT_MS,
  AUTOMATCH_OWNER_LOGIN_UID_LIMIT,
  AUTOMATCH_TOTAL_TIMEOUT_MS,
} from "./automatch/policy.ts";
import { enqueueAutomatchProjections } from "./automatch/projections.ts";
import {
  buildAutomatchReceiptChanges,
  buildAutomatchReplayTasks,
  matchesAutomatchReceiptRequest,
} from "./automatch/receipts.ts";
import { selectAutomatchAttempt } from "./automatch/selection.ts";
import type {
  AutomatchDependencies,
  AutomatchReceipt,
  AutomatchRequesterSnapshot,
  QueuedAutomatch,
  StartAutomatchOperationRequest,
  SuccessfulStartAutomatchResponse,
} from "./automatch/types.ts";
import { AuthApiFailure } from "./authErrors.ts";
import { isAutomatchQueueSelectionConflict } from "./automatchQueueD1.ts";
import {
  markAutomatchOutcome,
  measureAutomatchPhase,
} from "./automatchTelemetry.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import type { AutomatchRepository } from "./gameplayContracts.ts";
import {
  GameSessionMutationLeaseReleaseFailure,
  withGameSessionMutationLease,
} from "./gameSessionMutationRunner.ts";
import {
  getLoginProfileId,
  getOwnershipProfile,
  getProfileLoginUids,
  profileOwnershipUnavailable,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";

export { cancelQueuedAutomatch } from "./automatch/cancellation.ts";
export { AUTOMATCH_TOTAL_TIMEOUT_MS } from "./automatch/policy.ts";
export { getFirstQueuedAutomatch } from "./automatch/selection.ts";
export {
  createAutomatchProfileGameProjectionTask,
  createAutomatchProjectionTask,
  enqueueAutomatchProfileGameProjection,
  enqueueAutomatchProjection,
} from "./automatch/projections.ts";

const MAX_AUTOMATCH_RETRY_COUNT = 3;
const MAX_AUTOMATCH_SELECTION_ATTEMPTS = 32;
const AUTOMATCH_OWNER_LOCK_MIN_RETRY_MS = 25;
const AUTOMATCH_OWNER_LOCK_MAX_RETRY_MS = 1_000;
const AUTOMATCH_UID_LOOKUP_LIMIT = 2;

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function readAutomatchReceipt(
  requesterUid: string,
  request: StartAutomatchOperationRequest,
  repository: AutomatchRepository,
  signal?: AbortSignal,
): Promise<AutomatchReceipt | null> {
  const result = await measureAutomatchPhase("receipt", () =>
    repository.readAutomatchReceipt(request.operationId, signal),
  );
  if (result.kind === "missing") return null;
  if (
    result.kind === "invalid" ||
    !matchesAutomatchReceiptRequest(result.value, requesterUid, request)
  ) {
    throw new AuthApiFailure(409, "failed-precondition", "operation-conflict");
  }
  return result.value;
}

function finiteNumber(value: unknown): number {
  const parsed =
    typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareQueuedAutomatches(
  left: QueuedAutomatch,
  right: QueuedAutomatch,
): number {
  return (
    finiteNumber(right.data.timestamp) - finiteNumber(left.data.timestamp) ||
    compareStrings(left.inviteId, right.inviteId)
  );
}

function getQueuedAutomatchesForUid(
  value: Record<string, AutomatchEntryRead> | null,
  expectedUid: string,
): QueuedAutomatch[] {
  const queue = value;
  if (!queue) return [];
  return Object.entries(queue)
    .filter(([, data]) => normalizeString(data.record?.uid) === expectedUid)
    .sort(([left], [right]) => compareStrings(left, right))
    .slice(0, AUTOMATCH_UID_LOOKUP_LIMIT)
    .map(([inviteId, data]) => ({
      inviteId,
      data: data.record || emptyAutomatchEntryFields(),
    }));
}

async function readQueuedAutomatchesByUid(
  uid: string,
  repository: AutomatchRepository,
  signal?: AbortSignal,
): Promise<QueuedAutomatch[]> {
  return getQueuedAutomatchesForUid(
    await repository.listAutomatchEntriesByLogin(
      uid,
      AUTOMATCH_UID_LOOKUP_LIMIT,
      signal,
    ),
    uid,
  );
}

export async function findOwnedQueuedAutomatches(
  loginUids: readonly string[],
  repository: AutomatchRepository,
  signal?: AbortSignal,
): Promise<QueuedAutomatch[]> {
  const uniqueLoginUids = Array.from(new Set(loginUids));
  const persistence = repository.automatchPersistence;
  const stored = await persistence.readQueuedByLogins(uniqueLoginUids, signal);
  signal?.throwIfAborted();
  return uniqueLoginUids
    .flatMap((uid) => getQueuedAutomatchesForUid(stored, uid))
    .sort(compareQueuedAutomatches);
}

async function didClearOwnedQueuedAutomatches(
  loginUids: readonly string[],
  repository: AutomatchRepository,
): Promise<boolean> {
  try {
    const queued = await findOwnedQueuedAutomatches(
      loginUids,
      repository,
      AbortSignal.timeout(AUTOMATCH_TOTAL_TIMEOUT_MS),
    );
    return queued.length === 0;
  } catch {
    return false;
  }
}

export async function readAutomatchRequesterSnapshot(
  uid: string,
  repository: AutomatchRepository,
  logFailure: () => void = () => undefined,
): Promise<AutomatchRequesterSnapshot> {
  let ownership: ProfileOwnershipSnapshot;
  try {
    ownership = await measureAutomatchPhase("ownership", () =>
      requireProfileOwnershipSnapshot(repository, {
        loginUids: [uid],
        profileIds: [],
      }),
    );
  } catch (error) {
    logFailure();
    throw error;
  }
  const profileId = getLoginProfileId(ownership, uid);
  if (!profileId) {
    return Object.freeze({ loginUids: Object.freeze([uid]), profile: null });
  }
  const loginUids = [...getProfileLoginUids(ownership, profileId)].sort(
    compareStrings,
  );
  if (loginUids.length > AUTOMATCH_OWNER_LOGIN_UID_LIMIT) {
    logFailure();
    throw profileOwnershipUnavailable();
  }
  return Object.freeze({
    loginUids: Object.freeze(loginUids),
    profile: getOwnershipProfile(ownership, profileId)?.profile || null,
  });
}

async function automatchOwnerLockId(owner: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(owner),
  );
  return `automatch-owner-${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function automatchOperationLockId(operationId: string): string {
  return `automatch-operation-${operationId}`;
}

function secureRandom(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

async function replayAutomatchReceipt(
  receipt: AutomatchReceipt,
  dependencies: AutomatchDependencies,
): Promise<StartAutomatchResponse> {
  markAutomatchOutcome("replay");
  const tasks = buildAutomatchReplayTasks(receipt);
  if (tasks) {
    await enqueueAutomatchProjections(
      tasks.projectionTask,
      tasks.profileGameProjectionTask,
      dependencies,
    );
  }
  return receipt.response;
}

async function didCommitAutomatchReceipt(
  requesterUid: string,
  request: StartAutomatchOperationRequest,
  expected: SuccessfulStartAutomatchResponse,
  repository: AutomatchRepository,
): Promise<boolean> {
  try {
    const receipt = await readAutomatchReceipt(
      requesterUid,
      request,
      repository,
      AbortSignal.timeout(AUTOMATCH_CANCELLATION_RECONCILE_TIMEOUT_MS),
    );
    return (
      receipt?.response.inviteId === expected.inviteId &&
      receipt.response.mode === expected.mode
    );
  } catch {
    return false;
  }
}

async function convergeOwnedQueuedAutomatches(
  loginUids: readonly string[],
  repository: AutomatchRepository,
  signal: AbortSignal,
  dependencies: AutomatchDependencies,
): Promise<QueuedAutomatch | null> {
  let cancellationAttempts = 0;
  while (true) {
    signal.throwIfAborted();
    const queued = await findOwnedQueuedAutomatches(
      loginUids,
      repository,
      signal,
    );
    const survivor = queued[0] || null;
    if (queued.length <= 1) return survivor;
    for (const candidate of queued) {
      if (candidate.inviteId === survivor?.inviteId) continue;
      if (cancellationAttempts >= AUTOMATCH_OWNER_LOGIN_UID_LIMIT) {
        throw profileOwnershipUnavailable();
      }
      cancellationAttempts += 1;
      signal.throwIfAborted();
      await cancelQueuedAutomatch(candidate, repository, dependencies, signal);
    }
  }
}

async function withAutomatchOwnerLease<T>(
  requester: AutomatchRequesterSnapshot,
  uid: string,
  repository: AutomatchRepository,
  signal: AbortSignal,
  dependencies: AutomatchDependencies,
  work: () => Promise<T>,
): Promise<T> {
  await repository.automatchPersistence.recoverLogins(
    requester.loginUids,
    signal,
  );
  const lockId = await automatchOwnerLockId(
    requester.profile ? `profile:${requester.profile.profileId}` : `uid:${uid}`,
  );
  const wait =
    dependencies.wait ||
    ((milliseconds: number) => scheduler.wait(milliseconds, { signal }));
  const now = dependencies.now || Date.now;
  const lockDeadlineMs = now() + AUTOMATCH_TOTAL_TIMEOUT_MS;
  let contentionAttempts = 0;
  while (true) {
    const completed: { done: boolean; value?: T } = { done: false };
    try {
      return await withGameSessionMutationLease(
        lockId,
        crypto.randomUUID(),
        dependencies.mutationLocks,
        async () => {
          const value = await work();
          completed.value = value;
          completed.done = true;
          return value;
        },
        { now },
      );
    } catch (error) {
      if (
        error instanceof GameSessionMutationLeaseReleaseFailure &&
        error.workCompleted &&
        completed.done
      ) {
        return completed.value as T;
      }
      const retryDelayMs = Math.min(
        AUTOMATCH_OWNER_LOCK_MAX_RETRY_MS,
        AUTOMATCH_OWNER_LOCK_MIN_RETRY_MS * 2 ** contentionAttempts,
      );
      if (
        !(error instanceof AuthApiFailure) ||
        error.status !== 409 ||
        error.message !== "invite-busy" ||
        signal.aborted ||
        now() + retryDelayMs >= lockDeadlineMs
      ) {
        throw error;
      }
      contentionAttempts += 1;
      await wait(
        retryDelayMs + Math.floor(retryDelayMs * 0.25 * secureRandom()),
      );
    }
  }
}

export async function cancelOwnedQueuedAutomatches(
  uid: string,
  repository: AutomatchRepository,
  dependencies: AutomatchDependencies,
): Promise<boolean> {
  const signal =
    dependencies.signal || AbortSignal.timeout(AUTOMATCH_TOTAL_TIMEOUT_MS);
  const directQueues = await readQueuedAutomatchesByUid(
    uid,
    repository,
    signal,
  );
  let requester: AutomatchRequesterSnapshot;
  try {
    requester = await readAutomatchRequesterSnapshot(uid, repository);
  } catch (error) {
    if (directQueues.length === 0) throw error;
    requester = Object.freeze({
      loginUids: Object.freeze([uid]),
      profile: null,
    });
  }
  return withAutomatchOwnerLease(
    requester,
    uid,
    repository,
    signal,
    dependencies,
    async () => {
      let canceledAny = false;
      let attempts = 0;
      let lastPassFullyCanceled = false;
      let previousBlockedSignature = "";
      while (true) {
        let queued: QueuedAutomatch[];
        try {
          queued = await findOwnedQueuedAutomatches(
            requester.loginUids,
            repository,
            signal,
          );
        } catch (error) {
          if (
            lastPassFullyCanceled &&
            signal.aborted &&
            (await didClearOwnedQueuedAutomatches(
              requester.loginUids,
              repository,
            ))
          ) {
            return canceledAny;
          }
          throw error;
        }
        lastPassFullyCanceled = false;
        if (queued.length === 0) return canceledAny;
        let allCandidatesCanceled = true;
        let madeProgress = false;
        for (const candidate of queued) {
          if (attempts >= AUTOMATCH_OWNER_LOGIN_UID_LIMIT) {
            throw profileOwnershipUnavailable();
          }
          attempts += 1;
          const canceled = await cancelQueuedAutomatch(
            candidate,
            repository,
            dependencies,
            signal,
          );
          if (canceled) {
            canceledAny = true;
            madeProgress = true;
          } else {
            allCandidatesCanceled = false;
          }
        }
        if (madeProgress) {
          if (queued.length === 1) return true;
          previousBlockedSignature = "";
          lastPassFullyCanceled = allCandidatesCanceled;
          continue;
        }
        const blockedSignature = JSON.stringify(
          queued.map((candidate) => [
            candidate.inviteId,
            normalizeString(candidate.data.uid),
            automatchTimestamp(candidate.data.timestamp),
            automatchTelegramDeliveryVersion(
              candidate.data.telegramDeliveryVersion,
            ),
          ]),
        );
        if (blockedSignature === previousBlockedSignature) return canceledAny;
        previousBlockedSignature = blockedSignature;
      }
    },
  );
}

async function persistExistingAutomatchReceipt(
  identity: RequestIdentity,
  request: StartAutomatchOperationRequest,
  inviteId: string,
  ownerUids: readonly string[],
  repository: AutomatchRepository,
  signal: AbortSignal,
  dependencies: AutomatchDependencies,
): Promise<SuccessfulStartAutomatchResponse | null> {
  const owned = new Set(ownerUids);
  return commitAutomatchWithLease(
    {
      inviteId,
      leaseOperationId: request.operationId,
      selectionConflict: "reconcile",
      prepare: async () => {
        const [queueValue, inviteValue] = await Promise.all([
          repository.readAutomatchEntry(inviteId, signal),
          repository.readInviteMetadata(inviteId, signal),
        ]);
        const queueUid = normalizeString(queueValue.record?.uid);
        const invite = readInviteDocument(inviteValue);
        const { hostId, guestId } = inviteTrimmedParticipants(invite);
        if (!invite || !owned.has(hostId)) return null;
        let response: SuccessfulStartAutomatchResponse;
        if (guestId) {
          response = matchedAutomatchResponse(inviteId);
        } else if (
          queueUid &&
          owned.has(queueUid) &&
          hostId === queueUid &&
          inviteProjectionState(invite).automatchStateHint !== "canceled"
        ) {
          response = pendingAutomatchResponse(inviteId);
        } else {
          return null;
        }
        return {
          response,
          changes: [
            ...buildAutomatchReceiptChanges(
              identity.uid,
              request,
              response,
              null,
              false,
            ),
            {
              kind: "invite-operation",
              inviteId,
              loginUid: identity.uid,
              operationId: request.operationId,
            },
          ],
        };
      },
      commit: (changes) => repository.commitSessionChanges(changes, signal),
      reconcile: (response) =>
        didCommitAutomatchReceipt(identity.uid, request, response, repository),
    },
    dependencies,
  );
}

async function runAutomatchCandidateAttempts(
  identity: RequestIdentity,
  request: StartAutomatchOperationRequest,
  requester: AutomatchRequesterSnapshot,
  repository: AutomatchRepository,
  random: RandomSource,
  signal: AbortSignal,
  dependencies: AutomatchDependencies,
): Promise<StartAutomatchResponse> {
  for (let retryCount = 0; ; retryCount++) {
    if (signal.aborted) {
      throw new Error("automatch-operation-timeout");
    }
    if (retryCount > MAX_AUTOMATCH_RETRY_COUNT) {
      return { ok: false };
    }

    const selection = await selectAutomatchAttempt(
      { requesterUid: identity.uid, request, requester, signal },
      {
        repository,
        convergeOwnedQueues: (loginUids, selectionSignal) =>
          convergeOwnedQueuedAutomatches(
            loginUids,
            repository,
            selectionSignal,
            dependencies,
          ),
      },
    );
    if (selection.kind === "reselect") continue;
    if (selection.kind === "reuse-owned") {
      const existing = await persistExistingAutomatchReceipt(
        identity,
        request,
        selection.inviteId,
        selection.ownerUids,
        repository,
        signal,
        dependencies,
      );
      if (existing) return existing;
      continue;
    }

    if (selection.kind === "create-pending") {
      const {
        profile,
        display: { emojiId, aura, name },
      } = selection;
      const { response, changes, profileGameProjectionTask, projectionTask } =
        buildPendingAutomatchPlan(
          {
            requesterUid: identity.uid,
            request,
            profile,
            emojiId,
            aura,
            name,
            random,
          },
          dependencies.createProjectionRequestId || (() => crypto.randomUUID()),
        );
      await commitAutomatchWithLease(
        {
          inviteId: response.inviteId,
          leaseOperationId: profileGameProjectionTask.requestId,
          selectionConflict: "rethrow",
          prepare: async () => ({ response, changes }),
          commit: (changes) => repository.commitSessionChanges(changes, signal),
          reconcile: (expected) =>
            didCommitAutomatchReceipt(
              identity.uid,
              request,
              expected,
              repository,
            ),
        },
        dependencies,
      );
      await enqueueAutomatchProjections(
        projectionTask,
        profileGameProjectionTask,
        dependencies,
      );
      markAutomatchOutcome("pending");
      return response;
    }

    const {
      queued,
      existingUid,
      display: { emojiId, aura, name },
    } = selection;
    const {
      response: matchedResponse,
      changes,
      profileGameProjectionTask,
      projectionTask,
      inviteChange,
    } = buildMatchedAutomatchPlan(
      {
        requesterUid: identity.uid,
        request,
        queued,
        existingUid,
        emojiId,
        aura,
        name,
      },
      dependencies.createProjectionRequestId || (() => crypto.randomUUID()),
    );
    const matchResult = await commitAutomatchWithLease(
      {
        inviteId: queued.inviteId,
        leaseOperationId: profileGameProjectionTask.requestId,
        selectionConflict: "rethrow",
        prepare: async () => {
          const [currentQueueValue, currentInviteValue] = await Promise.all([
            repository.readAutomatchEntry(queued.inviteId, signal),
            repository.readInviteMetadata(queued.inviteId, signal),
          ]);
          const currentInvite = readInviteDocument(currentInviteValue);
          const participants = inviteTrimmedParticipants(currentInvite);
          if (
            normalizeString(currentQueueValue.record?.uid) !== existingUid ||
            participants.hostId !== existingUid ||
            participants.guestId
          ) {
            return null;
          }
          inviteChange.value = mergeInviteAutomatchOperation(
            inviteChange.value,
            currentInvite,
            identity.uid,
            request.operationId,
          );
          return { response: matchedResponse, changes };
        },
        commit: (changes) => repository.commitSessionChanges(changes, signal),
        reconcile: (response) =>
          didCommitAutomatchReceipt(
            identity.uid,
            request,
            response,
            repository,
          ),
      },
      dependencies,
    );
    if (!matchResult) continue;
    await enqueueAutomatchProjections(
      projectionTask,
      profileGameProjectionTask,
      dependencies,
    );
    markAutomatchOutcome("matched");
    return matchedResponse;
  }
}

async function startAutomatchForCurrentOwner(
  identity: RequestIdentity,
  request: StartAutomatchOperationRequest,
  repository: AutomatchRepository,
  signal: AbortSignal,
  dependencies: AutomatchDependencies,
): Promise<StartAutomatchResponse> {
  const requester = await readAutomatchRequesterSnapshot(
    identity.uid,
    repository,
    dependencies.logProfileFailure ||
      (() =>
        console.error(
          JSON.stringify({ event: "automatch_profile_read_failure" }),
        )),
  );
  return withAutomatchOwnerLease(
    requester,
    identity.uid,
    repository,
    signal,
    dependencies,
    async () => {
      const receipt = await readAutomatchReceipt(
        identity.uid,
        request,
        repository,
        signal,
      );
      if (receipt) {
        return replayAutomatchReceipt(receipt, dependencies);
      }
      const ownedSurvivor = await convergeOwnedQueuedAutomatches(
        requester.loginUids,
        repository,
        signal,
        dependencies,
      );
      if (ownedSurvivor) {
        const existing = await persistExistingAutomatchReceipt(
          identity,
          request,
          ownedSurvivor.inviteId,
          requester.loginUids,
          repository,
          signal,
          dependencies,
        );
        if (existing) return existing;
      }
      return runAutomatchCandidateAttempts(
        identity,
        request,
        requester,
        repository,
        dependencies.random || secureRandom,
        signal,
        dependencies,
      );
    },
  );
}

export async function startAutomatch(
  identity: RequestIdentity,
  request: StartAutomatchOperationRequest,
  repository: AutomatchRepository,
  dependencies: AutomatchDependencies,
): Promise<StartAutomatchResponse> {
  const signal =
    dependencies.signal || AbortSignal.timeout(AUTOMATCH_TOTAL_TIMEOUT_MS);
  if (signal.aborted) {
    return { ok: false };
  }
  const existingReceipt = await readAutomatchReceipt(
    identity.uid,
    request,
    repository,
    signal,
  );
  if (existingReceipt) {
    return replayAutomatchReceipt(existingReceipt, dependencies);
  }
  let completedResponse: StartAutomatchResponse | undefined;
  try {
    return await withGameSessionMutationLease(
      automatchOperationLockId(request.operationId),
      request.operationId,
      dependencies.mutationLocks,
      async () => {
        for (
          let attempt = 0;
          attempt < MAX_AUTOMATCH_SELECTION_ATTEMPTS;
          attempt++
        ) {
          signal.throwIfAborted();
          try {
            const receipt = await readAutomatchReceipt(
              identity.uid,
              request,
              repository,
              signal,
            );
            completedResponse = receipt
              ? await replayAutomatchReceipt(receipt, dependencies)
              : await startAutomatchForCurrentOwner(
                  identity,
                  request,
                  repository,
                  signal,
                  dependencies,
                );
            if (completedResponse.ok)
              markAutomatchOutcome(completedResponse.mode);
            return completedResponse;
          } catch (error) {
            if (
              !isAutomatchQueueSelectionConflict(error) ||
              attempt + 1 === MAX_AUTOMATCH_SELECTION_ATTEMPTS
            )
              throw error;
            signal.throwIfAborted();
            const delay = Math.max(
              1,
              Math.floor(
                Math.min(5 * 2 ** attempt, 50) * (0.5 + secureRandom() / 2),
              ),
            );
            await (dependencies.wait
              ? dependencies.wait(delay, signal)
              : scheduler.wait(delay, { signal }));
          }
        }
        throw new Error("automatch-selection-attempts-exhausted");
      },
    );
  } catch (error) {
    if (
      error instanceof GameSessionMutationLeaseReleaseFailure &&
      error.workCompleted &&
      completedResponse
    ) {
      return completedResponse;
    }
    throw error;
  }
}

export { emptyAutomatchProfile } from "./automatch/plans.ts";
export type {
  AutomatchDependencies,
  AutomatchRequesterSnapshot,
  QueuedAutomatch,
  StartAutomatchOperationRequest,
} from "./automatch/types.ts";
