import { createGameVariantHelpers } from "@mons/shared/game-variants";
import {
  buildAutoInviteId,
  pickHostColor,
  randomAlphanumeric,
  type RandomSource,
} from "@mons/shared/ids";
import {
  CONTROLLER_VERSION,
  buildFreshMatchRecord,
} from "@mons/shared/match-protocol";
import {
  isStartAutomatchResponse,
  type StartAutomatchRequest,
  type StartAutomatchResponse,
} from "@mons/shared/navigation";
import * as monsRules from "mons-rules";
import {
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionChanges,
  buildAutomatchTelegramLifecycleChanges,
  buildMatchedAutomatchTelegramChanges,
  buildPendingAutomatchTelegramSource,
} from "../../../runtime/telegram/automatchSource.js";
import {
  AUTOMATCH_WAITING_EMOJI_ID,
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
} from "../../../runtime/telegramDisplay.js";
import { AuthApiFailure } from "./authErrors.ts";
import { isAutomatchQueueSelectionConflict } from "./automatchQueueD1.ts";
import {
  markAutomatchOutcome,
  measureAutomatchPhase,
} from "./automatchTelemetry.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import {
  STATE_SERVER_TIMESTAMP,
  stateIncrement,
} from "./stateCompatibility.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { GameplayProfile } from "./gameplayRepository.ts";
import type { AutomatchRepository } from "./gameplayContracts.ts";
import type { GameSessionMutationLockStore } from "./gameplayCoordinationD1.ts";
import { requestAutomatchProfileProjection } from "./gameSessionProjectionChanges.ts";
import type { GameSessionChange } from "./gameSessionContracts.ts";
import type {
  AutomatchProfileGameProjectionTask,
  ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import type {
  AutomatchTelegramProjectionTask,
  TelegramProjectionTask,
} from "./telegramProjectionTasks.ts";
import {
  GameSessionMutationLeaseReleaseFailure,
  withGameSessionMutationLease,
} from "./gameSessionMutations.ts";
import {
  getLoginProfileId,
  getOwnershipProfile,
  getProfileLoginUids,
  loginsShareProfile,
  profileOwnershipUnavailable,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";

const MAX_AUTOMATCH_RETRY_COUNT = 3;
const MAX_AUTOMATCH_SELECTION_ATTEMPTS = 32;
export const AUTOMATCH_TOTAL_TIMEOUT_MS = 20_000;
const AUTOMATCH_PASSWORD_LENGTH = 15;
const AUTOMATCH_OWNER_LOCK_MIN_RETRY_MS = 25;
const AUTOMATCH_OWNER_LOCK_MAX_RETRY_MS = 1_000;
const AUTOMATCH_UID_LOOKUP_LIMIT = 2;
const AUTOMATCH_OWNER_LOGIN_UID_LIMIT = 512;
const AUTOMATCH_CANCELLATION_RECONCILE_TIMEOUT_MS = 1_000;
const AUTOMATCH_CANCELLATION_RECONCILE_DELAY_MS = 50;
const AUTOMATCH_CANCELLATION_FINAL_READ_TIMEOUT_MS = 250;
const AUTOMATCH_RECEIPT_KIND = "automatch-start";
const gameVariantHelpers = createGameVariantHelpers(monsRules);

type AutomatchDependencies = {
  assertMutationAllowed?: () => Promise<void>;
  createProjectionRequestId?: () => string;
  enqueueProfileGameProjection?: (
    task: ProfileGameProjectionTask,
  ) => Promise<void>;
  enqueueTelegramProjection?: (task: TelegramProjectionTask) => Promise<void>;
  logProfileFailure?: () => void;
  logProfileGameProjectionFailure?: (
    task: AutomatchProfileGameProjectionTask,
  ) => void;
  logProjectionFailure?: (task: AutomatchTelegramProjectionTask) => void;
  mutationLocks: GameSessionMutationLockStore;
  now?: () => number;
  random?: RandomSource;
  signal?: AbortSignal;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export type StartAutomatchOperationRequest = StartAutomatchRequest & {
  operationId: string;
};

export type QueuedAutomatch = {
  data: Record<string, unknown>;
  inviteId: string;
};

export type AutomatchRequesterSnapshot = Readonly<{
  loginUids: readonly string[];
  profile: GameplayProfile | null;
}>;

type SuccessfulStartAutomatchResponse = Extract<
  StartAutomatchResponse,
  { ok: true }
>;

type AutomatchPlanDependencies = Pick<
  AutomatchDependencies,
  "createProjectionRequestId"
>;

type AutomatchPlanInput = {
  requesterUid: string;
  request: StartAutomatchOperationRequest;
  emojiId: GameplayProfile["emoji"];
  aura: string | null;
  name: string;
};

type AutomatchPlan = {
  response: SuccessfulStartAutomatchResponse;
  changes: GameSessionChange[];
  profileGameProjectionTask: AutomatchProfileGameProjectionTask;
  projectionTask: AutomatchTelegramProjectionTask | null;
};

type MatchedAutomatchPlan = AutomatchPlan & {
  inviteChange: Extract<GameSessionChange, { kind: "invite-merge" }>;
};

type AutomatchReceipt = {
  aura: string;
  completedAtMs: number;
  emojiId: number;
  inviteId: string;
  kind: typeof AUTOMATCH_RECEIPT_KIND;
  operationId: string;
  profileProjectionRequestId: string | null;
  requesterUid: string;
  response: SuccessfulStartAutomatchResponse;
  schemaVersion: 1;
  telegramProjection: boolean;
};

export function emptyAutomatchProfile(): GameplayProfile {
  return {
    aura: "",
    emoji: "",
    eth: "",
    profileId: "",
    rating: 0,
    sol: "",
    username: "",
  };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseAutomatchReceipt(value: unknown): AutomatchReceipt | null {
  const receipt = toRecord(value);
  const response = receipt?.response;
  const profileProjectionRequestId =
    receipt?.profileProjectionRequestId ?? null;
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.kind !== AUTOMATCH_RECEIPT_KIND ||
    typeof receipt.completedAtMs !== "number" ||
    !Number.isFinite(receipt.completedAtMs) ||
    typeof receipt.emojiId !== "number" ||
    !Number.isSafeInteger(receipt.emojiId) ||
    typeof receipt.aura !== "string" ||
    typeof receipt.operationId !== "string" ||
    !isSafeRecordKey(receipt.operationId) ||
    typeof receipt.requesterUid !== "string" ||
    !receipt.requesterUid ||
    typeof receipt.inviteId !== "string" ||
    !isSafeRecordKey(receipt.inviteId) ||
    !(
      profileProjectionRequestId === null ||
      (typeof profileProjectionRequestId === "string" &&
        isSafeRecordKey(profileProjectionRequestId))
    ) ||
    typeof receipt.telegramProjection !== "boolean" ||
    !isStartAutomatchResponse(response) ||
    !response.ok ||
    response.inviteId !== receipt.inviteId
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    aura: receipt.aura,
    completedAtMs: Math.floor(receipt.completedAtMs),
    emojiId: receipt.emojiId,
    inviteId: receipt.inviteId,
    kind: AUTOMATCH_RECEIPT_KIND,
    operationId: receipt.operationId,
    profileProjectionRequestId,
    requesterUid: receipt.requesterUid,
    response,
    telegramProjection: receipt.telegramProjection,
  };
}

function buildAutomatchReceiptChanges(
  requesterUid: string,
  request: StartAutomatchOperationRequest,
  response: SuccessfulStartAutomatchResponse,
  profileProjectionRequestId: string | null,
  telegramProjection: boolean,
): GameSessionChange[] {
  const completedAtMs = STATE_SERVER_TIMESTAMP;
  return [
    {
      kind: "mutation-receipt",
      operationId: request.operationId,
      value: {
        schemaVersion: 1,
        aura: request.aura,
        completedAtMs,
        emojiId: request.emojiId,
        inviteId: response.inviteId,
        kind: AUTOMATCH_RECEIPT_KIND,
        operationId: request.operationId,
        profileProjectionRequestId,
        requesterUid,
        response,
        telegramProjection,
      },
      expiration: {
        completedAtMs,
      },
    },
  ];
}

async function readAutomatchReceipt(
  requesterUid: string,
  request: StartAutomatchOperationRequest,
  repository: AutomatchRepository,
  signal?: AbortSignal,
): Promise<AutomatchReceipt | null> {
  const rawReceipt = await measureAutomatchPhase("receipt", () =>
    repository.readMutationReceipt(request.operationId, signal),
  );
  if (rawReceipt === null || rawReceipt === undefined) return null;
  const receipt = parseAutomatchReceipt(rawReceipt);
  if (
    !receipt ||
    receipt.operationId !== request.operationId ||
    receipt.requesterUid !== requesterUid ||
    receipt.emojiId !== request.emojiId ||
    receipt.aura !== request.aura
  ) {
    throw new AuthApiFailure(409, "failed-precondition", "operation-conflict");
  }
  return receipt;
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

export function getFirstQueuedAutomatch(
  value: unknown,
): QueuedAutomatch | null {
  const queue = toRecord(value);
  if (!queue) {
    return null;
  }
  const first = Object.entries(queue)[0];
  if (!first) {
    return null;
  }
  const [inviteId, data] = first;
  return { inviteId, data: toRecord(data) || {} };
}

function getQueuedAutomatchesForUid(
  value: unknown,
  expectedUid: string,
): QueuedAutomatch[] {
  const queue = toRecord(value);
  if (!queue) return [];
  return Object.entries(queue)
    .filter(([, data]) => normalizeString(toRecord(data)?.uid) === expectedUid)
    .sort(([left], [right]) => compareStrings(left, right))
    .slice(0, AUTOMATCH_UID_LOOKUP_LIMIT)
    .map(([inviteId, data]) => ({ inviteId, data: toRecord(data) || {} }));
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

export async function findOwnedQueuedAutomatch(
  loginUids: readonly string[],
  repository: AutomatchRepository,
  signal?: AbortSignal,
): Promise<QueuedAutomatch | null> {
  return (
    (await findOwnedQueuedAutomatches(loginUids, repository, signal))[0] || null
  );
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

export function createAutomatchProjectionTask(
  inviteId: string,
  dependencies: AutomatchPlanDependencies,
  requestId = (
    dependencies.createProjectionRequestId || (() => crypto.randomUUID())
  )(),
): AutomatchTelegramProjectionTask {
  return {
    kind: "automatch-telegram-projection",
    inviteId,
    requestId,
  };
}

export function createAutomatchProfileGameProjectionTask(
  inviteId: string,
  dependencies: AutomatchPlanDependencies,
): AutomatchProfileGameProjectionTask {
  return {
    kind: "automatch-profile-game-projection",
    inviteId,
    requestId: (
      dependencies.createProjectionRequestId || (() => crypto.randomUUID())
    )(),
  };
}

export async function enqueueAutomatchProjection(
  task: AutomatchTelegramProjectionTask,
  dependencies: AutomatchDependencies,
): Promise<void> {
  if (!dependencies.enqueueTelegramProjection) {
    return;
  }
  try {
    await dependencies.enqueueTelegramProjection(task);
  } catch {
    (
      dependencies.logProjectionFailure ||
      ((failedTask) =>
        console.error(
          JSON.stringify({
            event: "automatch_telegram_projection_enqueue_failed",
            inviteId: failedTask.inviteId,
          }),
        ))
    )(task);
  }
}

export async function enqueueAutomatchProfileGameProjection(
  task: AutomatchProfileGameProjectionTask,
  dependencies: AutomatchDependencies,
): Promise<void> {
  if (!dependencies.enqueueProfileGameProjection) {
    return;
  }
  try {
    await dependencies.enqueueProfileGameProjection(task);
  } catch {
    (
      dependencies.logProfileGameProjectionFailure ||
      ((failedTask) =>
        console.error(
          JSON.stringify({
            event: "automatch_profile_game_projection_enqueue_failed",
            inviteId: failedTask.inviteId,
          }),
        ))
    )(task);
  }
}

async function enqueueAutomatchProjections(
  telegramTask: AutomatchTelegramProjectionTask | null,
  profileTask: AutomatchProfileGameProjectionTask,
  dependencies: AutomatchDependencies,
): Promise<void> {
  if (telegramTask) {
    await enqueueAutomatchProjection(telegramTask, dependencies);
  }
  await enqueueAutomatchProfileGameProjection(profileTask, dependencies);
}

async function replayAutomatchReceipt(
  receipt: AutomatchReceipt,
  dependencies: AutomatchDependencies,
): Promise<StartAutomatchResponse> {
  markAutomatchOutcome("replay");
  if (receipt.profileProjectionRequestId) {
    await enqueueAutomatchProjections(
      receipt.telegramProjection
        ? createAutomatchProjectionTask(
            receipt.inviteId,
            dependencies,
            receipt.profileProjectionRequestId,
          )
        : null,
      {
        kind: "automatch-profile-game-projection",
        inviteId: receipt.inviteId,
        requestId: receipt.profileProjectionRequestId,
      },
      dependencies,
    );
  }
  return receipt.response;
}

function automatchTimestamp(value: unknown): number {
  return Math.floor(finiteNumber(value));
}

function automatchTelegramDeliveryVersion(value: unknown): number | null {
  return value === TELEGRAM_AUTOMATCH_VERSION
    ? TELEGRAM_AUTOMATCH_VERSION
    : null;
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
    const invite = toRecord(inviteValue);
    return Boolean(
      queueValue === null &&
      normalizeString(invite?.hostId) === expectedUid &&
      !normalizeString(invite?.guestId) &&
      invite?.automatchStateHint === "canceled" &&
      typeof invite.automatchCanceledAt === "number" &&
      Number.isFinite(invite.automatchCanceledAt) &&
      normalizeString(toRecord(outboxRequestId)?.requestId) === requestId,
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
        const currentGuestId = currentInvite?.guestId;
        const currentHostId = currentInvite?.hostId;
        const currentQueue = toRecord(currentQueueValue);
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

function profileOrFallback(
  profile: GameplayProfile | null,
  request: StartAutomatchRequest,
): GameplayProfile {
  return (
    profile || {
      ...emptyAutomatchProfile(),
      aura: request.aura,
      emoji: request.emojiId,
    }
  );
}

function matchedAutomatchResponse(
  inviteId: string,
): SuccessfulStartAutomatchResponse {
  return {
    ok: true,
    inviteId,
    mode: "matched",
    matchedImmediately: true,
  };
}

function pendingAutomatchResponse(
  inviteId: string,
): SuccessfulStartAutomatchResponse {
  return {
    ok: true,
    inviteId,
    mode: "pending",
    matchedImmediately: false,
  };
}

function readAutomatchOperationIds(value: unknown): Record<string, string> {
  const operationIds = toRecord(value);
  if (!operationIds) return {};
  const valid: [string, string][] = [];
  for (const [uid, operationId] of Object.entries(operationIds)) {
    if (
      isSafeRecordKey(uid) &&
      typeof operationId === "string" &&
      isSafeRecordKey(operationId)
    ) {
      valid.push([uid, operationId]);
    }
  }
  return Object.fromEntries(valid);
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
  let response: SuccessfulStartAutomatchResponse | null = null;
  let patchAttempted = false;
  try {
    await withGameSessionMutationLease(
      inviteId,
      request.operationId,
      dependencies.mutationLocks,
      async () => {
        const [queueValue, inviteValue] = await Promise.all([
          repository.readAutomatchEntry(inviteId, signal),
          repository.readInviteMetadata(inviteId, signal),
        ]);
        const queueUid = normalizeString(toRecord(queueValue)?.uid);
        const invite = toRecord(inviteValue);
        const hostId = normalizeString(invite?.hostId);
        const guestId = normalizeString(invite?.guestId);
        if (!invite || !owned.has(hostId)) return;
        if (guestId) {
          response = matchedAutomatchResponse(inviteId);
        } else if (
          queueUid &&
          owned.has(queueUid) &&
          hostId === queueUid &&
          invite.automatchStateHint !== "canceled"
        ) {
          response = pendingAutomatchResponse(inviteId);
        } else {
          return;
        }
        await dependencies.assertMutationAllowed?.();
        patchAttempted = true;
        await repository.commitSessionChanges(
          [
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
          signal,
        );
      },
    );
  } catch (error) {
    if (!response || !patchAttempted) throw error;
    const didCommit =
      (error instanceof GameSessionMutationLeaseReleaseFailure &&
        error.workCompleted) ||
      (await didCommitAutomatchReceipt(
        identity.uid,
        request,
        response,
        repository,
      ));
    if (!didCommit) {
      throw error;
    }
  }
  return response;
}

function buildPendingAutomatchPlan(
  {
    requesterUid,
    request,
    profile,
    emojiId,
    aura,
    name,
    random,
  }: AutomatchPlanInput & {
    profile: GameplayProfile;
    random: RandomSource;
  },
  dependencies: AutomatchPlanDependencies,
): AutomatchPlan {
  const inviteId = buildAutoInviteId(random);
  const password = randomAlphanumeric(AUTOMATCH_PASSWORD_LENGTH, random);
  const hostColor = pickHostColor(random);
  const matchSeed = gameVariantHelpers.buildRandomGameSeed(random);
  const timestamp = STATE_SERVER_TIMESTAMP;
  const match = buildFreshMatchRecord({
    color: hostColor,
    emojiId,
    aura,
    seed: matchSeed,
  });
  const waitingText = `${name} is looking for a match https://mons.link ${getTelegramEmojiTag(AUTOMATCH_WAITING_EMOJI_ID)}`;
  const canceledText = `<i>${name} canceled an automatch</i>`;
  const response: SuccessfulStartAutomatchResponse = {
    ok: true,
    inviteId,
    mode: "pending",
    matchedImmediately: false,
  };
  const profileGameProjectionTask = createAutomatchProfileGameProjectionTask(
    inviteId,
    dependencies,
  );
  const projectionTask = createAutomatchProjectionTask(
    inviteId,
    dependencies,
    profileGameProjectionTask.requestId,
  );
  const changes: GameSessionChange[] = [
    {
      kind: "match-create",
      playerId: requesterUid,
      matchId: inviteId,
      value: match,
    },
    {
      kind: "automatch-entry",
      inviteId,
      value: {
        uid: requesterUid,
        rating: profile.rating,
        timestamp,
        username: profile.username,
        ethAddress: profile.eth,
        solAddress: profile.sol,
        profileId: profile.profileId,
        hostColor,
        password,
        emojiId,
        gameVariant: matchSeed.gameVariant,
        telegramDeliveryVersion: TELEGRAM_AUTOMATCH_VERSION,
      },
    },
    {
      kind: "invite-merge",
      inviteId,
      value: {
        version: CONTROLLER_VERSION,
        hostId: requesterUid,
        hostColor,
        guestId: null,
        password,
        automatchStateHint: "pending",
        automatchCanceledAt: null,
        automatchOperationIds: {
          [requesterUid]: request.operationId,
        },
        telegramDeliveryVersion: TELEGRAM_AUTOMATCH_VERSION,
      },
    },
    {
      kind: "telegram-source",
      inviteId,
      value: buildPendingAutomatchTelegramSource({
        inviteId,
        waitingText,
        canceledText,
        timestamp,
      }),
    },
    ...buildAutomatchTelegramProjectionChanges({
      inviteId,
      requestId: projectionTask.requestId,
      timestamp,
    }),
    ...requestAutomatchProfileProjection({
      inviteId,
      requestId: profileGameProjectionTask.requestId,
      timestamp,
    }),
    ...buildAutomatchReceiptChanges(
      requesterUid,
      request,
      response,
      profileGameProjectionTask.requestId,
      true,
    ),
  ];
  return { response, changes, profileGameProjectionTask, projectionTask };
}

function buildMatchedAutomatchPlan(
  {
    requesterUid,
    request,
    queued,
    existingUid,
    emojiId,
    aura,
    name,
  }: AutomatchPlanInput & {
    queued: QueuedAutomatch;
    existingUid: string;
  },
  dependencies: AutomatchPlanDependencies,
): MatchedAutomatchPlan {
  const matchSeed = gameVariantHelpers.buildGameSeedForStoredVariant(
    queued.data.gameVariant,
  );
  const hostColor = normalizeString(queued.data.hostColor);
  const existingPlayerName = getDisplayNameFromAddress(
    queued.data.username,
    queued.data.ethAddress,
    queued.data.solAddress,
    finiteNumber(queued.data.rating),
    queued.data.emojiId,
  );
  const usesTelegramDeliveryV2 =
    queued.data.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION;
  const invite: Record<string, unknown> = {
    version: CONTROLLER_VERSION,
    hostId: existingUid,
    hostColor,
    guestId: requesterUid,
    password: normalizeString(queued.data.password),
    automatchStateHint: "matched",
    automatchCanceledAt: null,
    automatchOperationIds: {
      [requesterUid]: request.operationId,
    },
    ...(usesTelegramDeliveryV2
      ? { telegramDeliveryVersion: TELEGRAM_AUTOMATCH_VERSION }
      : {}),
  };
  const match = buildFreshMatchRecord({
    color: hostColor === "white" ? "black" : "white",
    emojiId,
    aura,
    seed: matchSeed,
  });
  const matchedText = `${existingPlayerName} vs. ${name} https://mons.link/${queued.inviteId}`;
  const inviteChange: MatchedAutomatchPlan["inviteChange"] = {
    kind: "invite-merge",
    inviteId: queued.inviteId,
    value: invite,
  };
  const changes: GameSessionChange[] = [
    { kind: "automatch-entry", inviteId: queued.inviteId, value: null },
    inviteChange,
    {
      kind: "match-create",
      playerId: requesterUid,
      matchId: queued.inviteId,
      value: match,
    },
  ];
  const matchedResponse = matchedAutomatchResponse(queued.inviteId);
  const profileGameProjectionTask = createAutomatchProfileGameProjectionTask(
    queued.inviteId,
    dependencies,
  );
  const projectionTask = usesTelegramDeliveryV2
    ? createAutomatchProjectionTask(
        queued.inviteId,
        dependencies,
        profileGameProjectionTask.requestId,
      )
    : null;
  changes.push(
    ...requestAutomatchProfileProjection({
      inviteId: queued.inviteId,
      requestId: profileGameProjectionTask.requestId,
      timestamp: STATE_SERVER_TIMESTAMP,
    }),
  );
  if (usesTelegramDeliveryV2) {
    changes.push(
      ...buildMatchedAutomatchTelegramChanges({
        inviteId: queued.inviteId,
        matchedText,
        timestamp: STATE_SERVER_TIMESTAMP,
        generation: stateIncrement(1),
      }),
    );
    changes.push(
      ...buildAutomatchTelegramProjectionChanges({
        inviteId: queued.inviteId,
        requestId: projectionTask?.requestId || "",
        timestamp: STATE_SERVER_TIMESTAMP,
      }),
    );
  }
  changes.push(
    ...buildAutomatchReceiptChanges(
      requesterUid,
      request,
      matchedResponse,
      profileGameProjectionTask.requestId,
      usesTelegramDeliveryV2,
    ),
  );
  return {
    response: matchedResponse,
    changes,
    profileGameProjectionTask,
    projectionTask,
    inviteChange,
  };
}

async function attemptAutomatch(
  identity: RequestIdentity,
  request: StartAutomatchOperationRequest,
  requester: AutomatchRequesterSnapshot,
  repository: AutomatchRepository,
  random: RandomSource,
  signal: AbortSignal,
  retryCount: number,
  dependencies: AutomatchDependencies,
): Promise<StartAutomatchResponse> {
  if (signal.aborted) {
    throw new Error("automatch-operation-timeout");
  }
  if (retryCount > MAX_AUTOMATCH_RETRY_COUNT) {
    return { ok: false };
  }

  const queued = getFirstQueuedAutomatch(
    await measureAutomatchPhase("selection", () =>
      repository.readFirstAutomatchEntry(signal),
    ),
  );
  let profile = profileOrFallback(requester.profile, request);
  const existingUid = queued ? normalizeString(queued.data.uid) : "";
  if (queued && existingUid !== identity.uid) {
    const pairOwnership = await measureAutomatchPhase("ownership", () =>
      requireProfileOwnershipSnapshot(repository, {
        loginUids: [identity.uid, existingUid],
        profileIds: [],
      }),
    );
    const existingProfileId = getLoginProfileId(pairOwnership, existingUid);
    const existingLoginUids = existingProfileId
      ? getProfileLoginUids(pairOwnership, existingProfileId)
      : [existingUid];
    if (existingLoginUids.length > AUTOMATCH_OWNER_LOGIN_UID_LIMIT) {
      throw profileOwnershipUnavailable();
    }
    const existingSurvivor = await convergeOwnedQueuedAutomatches(
      existingLoginUids,
      repository,
      signal,
      dependencies,
    );
    if (!existingSurvivor) {
      return attemptAutomatch(
        identity,
        request,
        requester,
        repository,
        random,
        signal,
        retryCount + 1,
        dependencies,
      );
    }
    if (loginsShareProfile(pairOwnership, identity.uid, existingUid)) {
      const existing = await persistExistingAutomatchReceipt(
        identity,
        request,
        existingSurvivor.inviteId,
        existingLoginUids,
        repository,
        signal,
        dependencies,
      );
      if (existing) return existing;
      return attemptAutomatch(
        identity,
        request,
        requester,
        repository,
        random,
        signal,
        retryCount + 1,
        dependencies,
      );
    }
    if (existingSurvivor.inviteId !== queued.inviteId) {
      return attemptAutomatch(
        identity,
        request,
        requester,
        repository,
        random,
        signal,
        retryCount + 1,
        dependencies,
      );
    }
    const profileId = getLoginProfileId(pairOwnership, identity.uid);
    profile = profileOrFallback(
      profileId
        ? getOwnershipProfile(pairOwnership, profileId)?.profile || null
        : null,
      request,
    );
  }
  const hasProfile = profile.profileId !== "";
  const emojiId = hasProfile ? profile.emoji : request.emojiId;
  const aura = (hasProfile ? profile.aura : request.aura) || null;
  const name = getDisplayNameFromAddress(
    profile.username,
    profile.eth,
    profile.sol,
    profile.rating,
    emojiId,
  );

  if (!queued) {
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
        dependencies,
      );
    const inviteId = response.inviteId;
    let patchAttempted = false;
    try {
      await withGameSessionMutationLease(
        inviteId,
        profileGameProjectionTask.requestId,
        dependencies.mutationLocks,
        async () => {
          await dependencies.assertMutationAllowed?.();
          patchAttempted = true;
          await repository.commitSessionChanges(changes, signal);
        },
      );
    } catch (error) {
      if (isAutomatchQueueSelectionConflict(error)) throw error;
      const didCommit =
        (error instanceof GameSessionMutationLeaseReleaseFailure &&
          error.workCompleted) ||
        (patchAttempted &&
          (await didCommitAutomatchReceipt(
            identity.uid,
            request,
            response,
            repository,
          )));
      if (!didCommit) {
        throw error;
      }
      await enqueueAutomatchProjections(
        projectionTask,
        profileGameProjectionTask,
        dependencies,
      );
      markAutomatchOutcome("pending");
      return response;
    }
    await enqueueAutomatchProjections(
      projectionTask,
      profileGameProjectionTask,
      dependencies,
    );
    markAutomatchOutcome("pending");
    return response;
  }

  if (existingUid === identity.uid) {
    const existing = await persistExistingAutomatchReceipt(
      identity,
      request,
      queued.inviteId,
      [identity.uid],
      repository,
      signal,
      dependencies,
    );
    if (existing) return existing;
    return attemptAutomatch(
      identity,
      request,
      requester,
      repository,
      random,
      signal,
      retryCount + 1,
      dependencies,
    );
  }

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
    dependencies,
  );
  let matchResult: "matched" | "stale" = "stale";
  let patchAttempted = false;
  try {
    matchResult = await withGameSessionMutationLease(
      queued.inviteId,
      profileGameProjectionTask.requestId,
      dependencies.mutationLocks,
      async () => {
        const [currentQueueValue, currentInviteValue] = await Promise.all([
          repository.readAutomatchEntry(queued.inviteId, signal),
          repository.readInviteMetadata(queued.inviteId, signal),
        ]);
        const currentInvite = toRecord(currentInviteValue);
        if (
          normalizeString(toRecord(currentQueueValue)?.uid) !== existingUid ||
          normalizeString(currentInvite?.hostId) !== existingUid ||
          normalizeString(currentInvite?.guestId)
        ) {
          return "stale" as const;
        }
        inviteChange.value = {
          ...inviteChange.value,
          automatchOperationIds: {
            ...readAutomatchOperationIds(currentInvite?.automatchOperationIds),
            [identity.uid]: request.operationId,
          },
        };
        await dependencies.assertMutationAllowed?.();
        patchAttempted = true;
        await repository.commitSessionChanges(changes, signal);
        return "matched" as const;
      },
    );
  } catch (patchFailure) {
    if (isAutomatchQueueSelectionConflict(patchFailure)) throw patchFailure;
    if (!patchAttempted) {
      throw patchFailure;
    }
    const isReleaseFailure =
      patchFailure instanceof GameSessionMutationLeaseReleaseFailure;
    const didCommit =
      (isReleaseFailure && patchFailure.workCompleted) ||
      (await didCommitAutomatchReceipt(
        identity.uid,
        request,
        matchedResponse,
        repository,
      ));
    if (!didCommit) {
      throw patchFailure;
    }
    matchResult = "matched";
  }
  if (matchResult === "stale") {
    return attemptAutomatch(
      identity,
      request,
      requester,
      repository,
      random,
      signal,
      retryCount + 1,
      dependencies,
    );
  }
  await enqueueAutomatchProjections(
    projectionTask,
    profileGameProjectionTask,
    dependencies,
  );
  markAutomatchOutcome("matched");
  return matchedResponse;
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
      return attemptAutomatch(
        identity,
        request,
        requester,
        repository,
        dependencies.random || secureRandom,
        signal,
        0,
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

export type { AutomatchDependencies };
