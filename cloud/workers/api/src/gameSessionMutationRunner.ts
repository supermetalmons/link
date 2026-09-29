import {
  isCreateInviteResponse,
  isEndRematchResponse,
  isEnsureMatchResponse,
  isJoinInviteResponse,
  isProposeRematchResponse,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type EndRematchRequest,
  type EndRematchResponse,
  type EnsureMatchRequest,
  type EnsureMatchResponse,
  type JoinInviteRequest,
  type JoinInviteResponse,
  type ProposeRematchRequest,
  type ProposeRematchResponse,
} from "@mons/shared/game-sessions";
import { AuthApiFailure } from "./authErrors.ts";
import type { AutomatchPersistence } from "./automatchPersistence.ts";
import type { GameSessionChange } from "./gameSessionContracts.ts";
import { requestAutomatchProfileProjection } from "./gameSessionProjectionChanges.ts";
import type { GameSessionRepository } from "./gameplayContracts.ts";
import {
  GameSessionMutationLockFailure,
  type GameSessionMutationLockStore,
} from "./gameplayCoordinationD1.ts";
import type { HistoricalMatchDescriptor } from "./historicalMatches.ts";
import type {
  AutomatchProfileGameProjectionTask,
  ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import { STATE_SERVER_TIMESTAMP } from "./stateCompatibility.ts";

const GAME_SESSION_MUTATION_RECEIPT_ROOT = "gameplayMutationReceipts";
const GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT =
  "gameplayMutationReceiptExpirations";
const GAME_SESSION_MUTATION_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const GAME_SESSION_MUTATION_RECEIPT_SWEEP_LIMIT = 1000;

type GameSessionMutationKind =
  | "invite-create"
  | "invite-join"
  | "match-ensure"
  | "rematch-end"
  | "rematch-propose";

type GameSessionResponse =
  | CreateInviteResponse
  | EndRematchResponse
  | EnsureMatchResponse
  | JoinInviteResponse
  | ProposeRematchResponse;

type GameSessionRequest =
  | CreateInviteRequest
  | EndRematchRequest
  | EnsureMatchRequest
  | JoinInviteRequest
  | ProposeRematchRequest;

type GameSessionMutationReceipt = {
  completedAtMs: number;
  fingerprint: string;
  inviteId: string;
  kind: GameSessionMutationKind;
  operationId: string;
  projectionRequestId: string | null;
  requesterUid: string;
  response: GameSessionResponse;
  schemaVersion: 1;
};

type GameSessionMutationOutcome<T extends GameSessionResponse> = {
  historicalMatches?: HistoricalMatchDescriptor[];
  projectReason?: string;
  response: T;
  changes?: GameSessionChange[];
};

export type GameSessionMutationRunnerDependencies = {
  assertMutationAllowed?: () => Promise<void>;
  createOwnerId?: () => string;
  enqueueProfileGameProjection?: (
    task: ProfileGameProjectionTask,
  ) => Promise<void>;
  logger?: Pick<Console, "error" | "info">;
  mutationLocks: GameSessionMutationLockStore;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failedPrecondition(message: string): AuthApiFailure {
  return new AuthApiFailure(409, "failed-precondition", message);
}

async function mutationFingerprint(
  kind: GameSessionMutationKind,
  request: GameSessionRequest,
  requesterUid: string,
): Promise<string> {
  const presentation =
    "emojiId" in request ? [request.emojiId, request.aura] : [null, null];
  const matchId = "matchId" in request ? request.matchId : null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        kind,
        request.operationId,
        request.inviteId,
        matchId,
        requesterUid,
        ...presentation,
      ]),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseReceipt(value: unknown): GameSessionMutationReceipt | null {
  const record = toRecord(value);
  const response = record?.response;
  if (
    record?.schemaVersion !== 1 ||
    typeof record.completedAtMs !== "number" ||
    !Number.isFinite(record.completedAtMs) ||
    typeof record.fingerprint !== "string" ||
    typeof record.inviteId !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.operationId !== "string" ||
    typeof record.requesterUid !== "string" ||
    !record.requesterUid ||
    !(
      record.projectionRequestId === null ||
      typeof record.projectionRequestId === "string"
    ) ||
    !(
      isCreateInviteResponse(response) ||
      isJoinInviteResponse(response) ||
      isProposeRematchResponse(response) ||
      isEndRematchResponse(response) ||
      isEnsureMatchResponse(response)
    )
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    completedAtMs: Math.floor(record.completedAtMs),
    fingerprint: record.fingerprint,
    inviteId: record.inviteId,
    kind: record.kind as GameSessionMutationKind,
    operationId: record.operationId,
    projectionRequestId: record.projectionRequestId,
    requesterUid: record.requesterUid,
    response,
  };
}

async function dispatchProjection(
  inviteId: string,
  requestId: string,
  dependencies: GameSessionMutationRunnerDependencies,
): Promise<void> {
  if (!dependencies.enqueueProfileGameProjection) {
    return;
  }
  const task: AutomatchProfileGameProjectionTask = {
    kind: "automatch-profile-game-projection",
    inviteId,
    requestId,
  };
  try {
    await dependencies.enqueueProfileGameProjection(task);
  } catch {
    (dependencies.logger || console).error(
      JSON.stringify({
        event: "game_session_projection_enqueue_failed",
        inviteId,
        requestId,
      }),
    );
  }
}

export async function acquireGameSessionMutationLease(
  lockId: string,
  operationId: string,
  ownerId: string,
  store: GameSessionMutationLockStore,
  nowMs: number,
): Promise<void> {
  try {
    await store.acquire({ lockId, operationId }, ownerId, nowMs);
  } catch (error) {
    if (
      error instanceof GameSessionMutationLockFailure &&
      error.operation === "busy"
    ) {
      throw new AuthApiFailure(409, "aborted", "invite-busy");
    }
    throw error;
  }
}

export async function enforceGameSessionMutationRateLimit(
  rateLimiter: RateLimit,
  uid: string,
): Promise<void> {
  let outcome: RateLimitOutcome;
  try {
    outcome = await rateLimiter.limit({ key: `game-session:${uid}` });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "rate-limit-unavailable");
  }
  if (!outcome.success) {
    throw new AuthApiFailure(
      429,
      "resource-exhausted",
      "Too many game session attempts.",
    );
  }
}

export async function refreshGameSessionMutationLease(
  lockId: string,
  operationId: string,
  ownerId: string,
  store: GameSessionMutationLockStore,
  nowMs: number,
): Promise<void> {
  try {
    await store.refresh({ lockId, operationId }, ownerId, nowMs);
  } catch (error) {
    if (
      error instanceof GameSessionMutationLockFailure &&
      error.operation === "lost"
    ) {
      throw new AuthApiFailure(409, "aborted", "invite-lease-lost");
    }
    throw error;
  }
}

export async function releaseGameSessionMutationLease(
  lockId: string,
  operationId: string,
  ownerId: string,
  store: GameSessionMutationLockStore,
): Promise<void> {
  await store.release({ lockId, operationId }, ownerId);
}

export class GameSessionMutationLeaseReleaseFailure extends GameSessionMutationLockFailure {
  readonly workCompleted: boolean;
  readonly workError: unknown;

  constructor(
    releaseError: unknown,
    workError: unknown,
    workCompleted: boolean,
  ) {
    super("release", releaseError);
    this.workCompleted = workCompleted;
    this.workError = workError;
  }
}

function leaseErrorCode(error: unknown): string {
  if (error instanceof GameSessionMutationLockFailure) {
    return error.operation;
  }
  if (error instanceof AuthApiFailure) {
    return error.code;
  }
  return "unknown";
}

export async function withGameSessionMutationLease<T>(
  lockId: string,
  operationId: string,
  store: GameSessionMutationLockStore,
  work: (refresh: () => Promise<void>) => Promise<T>,
  dependencies: Pick<
    GameSessionMutationRunnerDependencies,
    "createOwnerId" | "logger" | "now" | "wait"
  > & { acquireRetryTimeoutMs?: number } = {},
): Promise<T> {
  const ownerId = (dependencies.createOwnerId || (() => crypto.randomUUID()))();
  const now = dependencies.now || Date.now;
  const retryTimeoutMs = dependencies.acquireRetryTimeoutMs || 0;
  const retryDeadlineMs = now() + retryTimeoutMs;
  const wait =
    dependencies.wait ||
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let retryDelayMs = 100;
  let waitedMs = 0;
  while (true) {
    try {
      await acquireGameSessionMutationLease(
        lockId,
        operationId,
        ownerId,
        store,
        now(),
      );
      break;
    } catch (error) {
      const remainingMs = Math.min(
        retryTimeoutMs - waitedMs,
        retryDeadlineMs - now(),
      );
      if (
        !(error instanceof AuthApiFailure) ||
        error.message !== "invite-busy" ||
        remainingMs <= 0
      ) {
        throw error;
      }
      const delayMs = Math.min(retryDelayMs, remainingMs);
      await wait(delayMs);
      waitedMs += delayMs;
      retryDelayMs = Math.min(1_000, retryDelayMs * 2);
    }
  }
  let workCompleted = false;
  let value: T | undefined;
  let workError: unknown;
  try {
    value = await work(() =>
      refreshGameSessionMutationLease(
        lockId,
        operationId,
        ownerId,
        store,
        now(),
      ),
    );
    workCompleted = true;
  } catch (error) {
    workError = error;
  }
  try {
    await releaseGameSessionMutationLease(lockId, operationId, ownerId, store);
  } catch (releaseError) {
    (dependencies.logger || console).error(
      JSON.stringify({
        event: "game_session_mutation_lock_release_failed",
        inviteId: lockId,
        operationId,
        releaseCode: leaseErrorCode(releaseError),
        workCode: workCompleted ? "none" : leaseErrorCode(workError),
      }),
    );
    throw new GameSessionMutationLeaseReleaseFailure(
      releaseError,
      workCompleted ? undefined : workError,
      workCompleted,
    );
  }
  if (!workCompleted) throw workError;
  return value as T;
}

export async function runGameSessionMutation<T extends GameSessionResponse>(
  kind: GameSessionMutationKind,
  requesterUid: string,
  request: GameSessionRequest,
  repository: Pick<
    GameSessionRepository,
    "readMutationReceipt" | "commitSessionChanges"
  >,
  validateResponse: (value: unknown) => value is T,
  build: () => Promise<GameSessionMutationOutcome<T>>,
  dependencies: GameSessionMutationRunnerDependencies,
  { acquireRetryTimeoutMs }: { acquireRetryTimeoutMs?: number } = {},
): Promise<T> {
  const fingerprint = await mutationFingerprint(kind, request, requesterUid);
  const outcome = await withGameSessionMutationLease(
    request.inviteId,
    request.operationId,
    dependencies.mutationLocks,
    async (refresh) => {
      const rawReceipt = await repository.readMutationReceipt(
        request.operationId,
      );
      const existing = parseReceipt(rawReceipt);
      if (rawReceipt !== null && rawReceipt !== undefined && !existing) {
        throw failedPrecondition("operation-conflict");
      }
      if (existing) {
        if (
          existing.kind !== kind ||
          existing.inviteId !== request.inviteId ||
          existing.requesterUid !== requesterUid ||
          existing.fingerprint !== fingerprint ||
          !validateResponse(existing.response)
        ) {
          throw failedPrecondition("operation-conflict");
        }
        return {
          response: existing.response,
          projectionRequestId: existing.projectionRequestId,
        };
      }
      const outcome = await build();
      const projectionRequestId = outcome.projectReason
        ? request.operationId
        : null;
      const changes: GameSessionChange[] = [
        ...(outcome.changes || []),
        {
          kind: "mutation-receipt",
          operationId: request.operationId,
          value: {
            schemaVersion: 1,
            operationId: request.operationId,
            kind,
            inviteId: request.inviteId,
            fingerprint,
            projectionRequestId,
            requesterUid,
            response: outcome.response,
            completedAtMs: STATE_SERVER_TIMESTAMP,
          },
          expiration: { completedAtMs: STATE_SERVER_TIMESTAMP },
        },
      ];
      if (outcome.projectReason) {
        changes.push(
          ...requestAutomatchProfileProjection({
            historicalMatches: outcome.historicalMatches,
            inviteId: request.inviteId,
            reason: outcome.projectReason,
            requestId: request.operationId,
            timestamp: STATE_SERVER_TIMESTAMP,
            merge: true,
          }),
        );
      }
      await dependencies.assertMutationAllowed?.();
      await refresh();
      await repository.commitSessionChanges(changes);
      return { response: outcome.response, projectionRequestId };
    },
    {
      ...dependencies,
      acquireRetryTimeoutMs,
    },
  );
  if (outcome.projectionRequestId) {
    await dispatchProjection(
      request.inviteId,
      outcome.projectionRequestId,
      dependencies,
    );
  }
  return outcome.response;
}

export async function sweepGameSessionMutationReceipts(
  persistence: Pick<AutomatchPersistence, "expireReceipts">,
  { now = Date.now }: { now?: () => number } = {},
): Promise<number> {
  const cutoff = now() - GAME_SESSION_MUTATION_RECEIPT_RETENTION_MS;
  return persistence.expireReceipts(
    cutoff,
    GAME_SESSION_MUTATION_RECEIPT_SWEEP_LIMIT,
  );
}

export {
  GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT,
  GAME_SESSION_MUTATION_RECEIPT_RETENTION_MS,
  GAME_SESSION_MUTATION_RECEIPT_ROOT,
  GAME_SESSION_MUTATION_RECEIPT_SWEEP_LIMIT,
};
