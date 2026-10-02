import {
  createEventGameplayRepository,
  type EventGameplayRepository,
} from "./eventRepository.ts";
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
import { AuthApiFailure, type AuthErrorCode } from "./authErrors.ts";
import { createGameplayRepository } from "./gameplayRepository.ts";
import { buildEventProgressPlan } from "./eventProgressCodec.ts";
import { ensureEventProgressWorkflow } from "./eventProgressDispatch.ts";
import { createWorkerEventRuntime } from "./workerEventRuntime.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

export const EVENT_CONTROL_TIMEOUT_MS = 30_000;

export type EventControlDependencies = {
  now?: () => number;
  random?: () => number;
  repository?: EventGameplayRepository;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
};

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

function createRuntime(env: Env, dependencies: EventControlDependencies) {
  const signal =
    dependencies.signal || AbortSignal.timeout(EVENT_CONTROL_TIMEOUT_MS);
  const repository =
    dependencies.repository ||
    createEventGameplayRepository(env, createGameplayRepository(env));
  return createWorkerEventRuntime({
    repository,
    signal,
    withdrawalDb: env.EVENT_PRIZE_WITHDRAWALS_DB,
    lockFailureEvent: "event_control_lock_failure",
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
      await ensureEventProgressWorkflow(env, plan);
      return { outboxId: plan.outboxId, outbox: plan.outbox };
    },
    now: dependencies.now,
    random: dependencies.random,
    sleep: dependencies.sleep,
  });
}

function runtimeRequest(
  identity: RequestIdentity,
  data: Record<string, unknown>,
) {
  return {
    auth: { uid: identity.uid },
    data,
  };
}

async function enforceEventSyncRateLimit(
  rateLimiter: RateLimit,
  uid: string,
  eventId: string,
): Promise<void> {
  let outcome: RateLimitOutcome;
  try {
    outcome = await rateLimiter.limit({ key: `event-sync:${uid}:${eventId}` });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "rate-limit-unavailable");
  }
  if (!outcome.success) {
    throw new AuthApiFailure(
      429,
      "resource-exhausted",
      "Too many event sync attempts.",
    );
  }
}

export async function createEvent(
  env: Env,
  identity: RequestIdentity,
  request: CreateEventRequest,
  dependencies: EventControlDependencies = {},
): Promise<CreateEventResponse> {
  try {
    const response = await createRuntime(env, dependencies).createEvent(
      runtimeRequest(identity, request),
    );
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
  identity: RequestIdentity,
  request: PostponeEventStartRequest,
  dependencies: EventControlDependencies = {},
): Promise<PostponeEventStartResponse> {
  try {
    const response = await createRuntime(env, dependencies).postponeEventStart(
      runtimeRequest(identity, request),
    );
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
  identity: RequestIdentity,
  request: DisqualifyEventMatchWinnersRequest,
  dependencies: EventControlDependencies = {},
): Promise<DisqualifyEventMatchWinnersResponse> {
  try {
    const response = await createRuntime(
      env,
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
  identity: RequestIdentity,
  request: SyncEventStateRequest,
  dependencies: EventControlDependencies = {},
): Promise<SyncEventStateResponse> {
  try {
    const eventId = request.eventId.trim();
    await enforceEventSyncRateLimit(
      env.AUTH_RATE_LIMITER,
      identity.uid,
      eventId,
    );
    const response = await createRuntime(env, dependencies).syncEventState(
      runtimeRequest(identity, { ...request, eventId }),
    );
    if (!isSyncEventStateResponse(response)) {
      throw new AuthApiFailure(503, "unavailable", "event-service-unavailable");
    }
    return response;
  } catch (error) {
    throw toEventApiFailure(error);
  }
}
