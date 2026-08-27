import {
  isCreateEventResponse,
  isDisqualifyEventMatchWinnersResponse,
  isPostponeEventStartResponse,
  isSyncEventStateResponse,
  type CreateEventRequest,
  type CreateEventResponse,
  type DisqualifyEventMatchWinnersRequest,
  type DisqualifyEventMatchWinnersResponse,
  type PostponeEventStartRequest,
  type PostponeEventStartResponse,
  type SyncEventStateRequest,
  type SyncEventStateResponse,
} from "@mons/shared/events";
import { createEventRuntime } from "../../../functions/events.js";
import { createEventLockManagerCore } from "../../../functions/events/lockManagerCore.js";
import { AuthApiFailure, type AuthErrorCode } from "./authErrors.ts";
import type { FirebaseIdentity } from "./firebaseAuth.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  buildEventProgressPlan,
  createEventAdminAdapter,
  ensureEventProgressWorkflow,
} from "./eventProgress.ts";
import { createD1EventPrizeWithdrawalReader } from "./eventPrizeWithdrawalD1.ts";
import { createProfileEventPrizeOwnerResolver } from "./profileEventPrizeOwner.ts";

export const EVENT_CONTROL_TIMEOUT_MS = 30_000;

export type EventControlDependencies = {
  now?: () => number;
  random?: () => number;
  repository?: GameplayRepository;
  resolveProfileEventPrizeOwnerId?: (input: {
    eventId: string;
    profileId: string;
  }) => Promise<string>;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
};

function secureRandom(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

function statusForCode(code: string): number {
  if (code === "unauthenticated") {
    return 401;
  }
  if (code === "permission-denied") {
    return 403;
  }
  if (code === "invalid-argument") {
    return 400;
  }
  if (code === "not-found") {
    return 404;
  }
  if (code === "aborted" || code === "failed-precondition") {
    return 409;
  }
  return 503;
}

function isAuthErrorCode(value: string): value is AuthErrorCode {
  return [
    "aborted",
    "deadline-exceeded",
    "failed-precondition",
    "internal",
    "invalid-argument",
    "not-found",
    "permission-denied",
    "resource-exhausted",
    "unauthenticated",
    "unavailable",
  ].includes(value);
}

export function toEventApiFailure(error: unknown): AuthApiFailure {
  if (error instanceof AuthApiFailure) {
    return error;
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (isAuthErrorCode(code)) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "event-service-unavailable";
      return new AuthApiFailure(statusForCode(code), code, message);
    }
  }
  return new AuthApiFailure(503, "unavailable", "event-service-unavailable");
}

function createRuntime(
  env: Env,
  identity: FirebaseIdentity,
  dependencies: EventControlDependencies,
) {
  const signal =
    dependencies.signal || AbortSignal.timeout(EVENT_CONTROL_TIMEOUT_MS);
  const repository =
    dependencies.repository ||
    createGameplayRepository(env, { timeoutMs: EVENT_CONTROL_TIMEOUT_MS });
  const resolveProfileEventPrizeOwnerId =
    dependencies.resolveProfileEventPrizeOwnerId ||
    createProfileEventPrizeOwnerResolver(env, {
      rtdb: repository,
      signal,
    });
  const lockManager = createEventLockManagerCore({
    createLockId: () => crypto.randomUUID(),
    transactPath: (path, updater) =>
      repository.transactRtdbPath(path, updater, signal),
    releaseTransactPath: (path, updater) =>
      repository.transactRtdbPath(path, updater),
    sleep:
      dependencies.sleep ||
      ((milliseconds) => scheduler.wait(milliseconds, { signal })),
    logger: {
      error: (_message, error) => {
        console.error(
          JSON.stringify({
            event: "event_control_lock_failure",
            kind: error instanceof Error ? error.name : typeof error,
          }),
        );
      },
    },
  });
  return createEventRuntime({
    admin: createEventAdminAdapter(repository, signal),
    enqueueEventProgressTask: async ({
      eventId,
      sourceKey,
      reason,
      scheduleTimeMs,
    }) => {
      const plan = await buildEventProgressPlan(
        {
          eventId,
          sourceKey,
          reason,
          runAtMs: scheduleTimeMs ?? null,
        },
        (dependencies.now || Date.now)(),
      );
      await ensureEventProgressWorkflow(env.EVENT_PROGRESS_WORKFLOW, plan);
      return { outboxId: plan.outboxId, outbox: plan.outbox };
    },
    eventLockManager: lockManager,
    getProfileByLoginId: async (uid) => {
      if (uid !== identity.uid) {
        throw new AuthApiFailure(403, "permission-denied", "permission-denied");
      }
      return (
        (await repository.getGameplayProfile(uid, identity.idToken, signal)) ||
        {}
      );
    },
    readEventPrizeWithdrawals: createD1EventPrizeWithdrawalReader(
      env.EVENT_PRIZE_WITHDRAWALS_DB,
    ),
    resolveProfileEventPrizeOwnerId,
    now: dependencies.now,
    random: dependencies.random || secureRandom,
    sleep:
      dependencies.sleep ||
      ((milliseconds) => scheduler.wait(milliseconds, { signal })),
  });
}

function runtimeRequest(
  identity: FirebaseIdentity,
  data: Record<string, unknown>,
) {
  return {
    auth: {
      uid: identity.uid,
      token: identity.profileId ? { profileId: identity.profileId } : {},
    },
    data,
  };
}

export async function createEvent(
  env: Env,
  identity: FirebaseIdentity,
  request: CreateEventRequest,
  dependencies: EventControlDependencies = {},
): Promise<CreateEventResponse> {
  try {
    const response = await createRuntime(
      env,
      identity,
      dependencies,
    ).createEvent(runtimeRequest(identity, request));
    if (!isCreateEventResponse(response)) {
      throw new AuthApiFailure(503, "unavailable", "event-service-unavailable");
    }
    return response;
  } catch (error) {
    throw toEventApiFailure(error);
  }
}

export async function postponeEventStart(
  env: Env,
  identity: FirebaseIdentity,
  request: PostponeEventStartRequest,
  dependencies: EventControlDependencies = {},
): Promise<PostponeEventStartResponse> {
  try {
    const response = await createRuntime(
      env,
      identity,
      dependencies,
    ).postponeEventStart(runtimeRequest(identity, request));
    if (!isPostponeEventStartResponse(response)) {
      throw new AuthApiFailure(503, "unavailable", "event-service-unavailable");
    }
    return response;
  } catch (error) {
    throw toEventApiFailure(error);
  }
}

export async function disqualifyEventMatchWinners(
  env: Env,
  identity: FirebaseIdentity,
  request: DisqualifyEventMatchWinnersRequest,
  dependencies: EventControlDependencies = {},
): Promise<DisqualifyEventMatchWinnersResponse> {
  try {
    const response = await createRuntime(
      env,
      identity,
      dependencies,
    ).disqualifyEventMatchWinners(runtimeRequest(identity, request));
    if (!isDisqualifyEventMatchWinnersResponse(response)) {
      throw new AuthApiFailure(503, "unavailable", "event-service-unavailable");
    }
    return response;
  } catch (error) {
    throw toEventApiFailure(error);
  }
}

export async function syncEventState(
  env: Env,
  identity: FirebaseIdentity,
  request: SyncEventStateRequest,
  dependencies: EventControlDependencies = {},
): Promise<SyncEventStateResponse> {
  try {
    const response = await createRuntime(
      env,
      identity,
      dependencies,
    ).syncEventState(runtimeRequest(identity, request));
    if (!isSyncEventStateResponse(response)) {
      throw new AuthApiFailure(503, "unavailable", "event-service-unavailable");
    }
    return response;
  } catch (error) {
    throw toEventApiFailure(error);
  }
}
