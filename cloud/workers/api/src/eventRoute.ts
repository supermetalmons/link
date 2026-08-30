import {
  isToggleEventPrizeSelectionRequest,
  type ToggleEventPrizeSelectionRequest,
} from "@mons/shared/event-prizes";
import {
  isCreateEventRequest,
  isDisqualifyEventMatchWinnersRequest,
  isJoinEventRequest,
  isPostponeEventStartRequest,
  isRemoveEventParticipantRequest,
  isSyncEventStateRequest,
  type CreateEventRequest,
  type DisqualifyEventMatchWinnersRequest,
  type JoinEventRequest,
  type PostponeEventStartRequest,
  type RemoveEventParticipantRequest,
  type SyncEventStateRequest,
} from "@mons/shared/events";
import { normalizeFirebaseKey } from "@mons/shared/ids";
import {
  AuthApiFailure,
  authErrorResponse,
  isProfileWritesDisabledFailure,
} from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  EVENT_OPERATION_TIMEOUT_MS,
  joinEvent,
  removeEventParticipant,
  toggleEventPrizeSelection,
  type EventParticipationDependencies,
} from "./eventParticipation.ts";
import {
  verifyFirebaseRequest,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { createEventTelegramProjectionRepository } from "./eventTelegramProjectionProducer.ts";
import { createEventProfileGameProjectionRepository } from "./eventProfileGameProjectionProducer.ts";
import { readBoundedJson } from "./http.ts";
import {
  createEvent,
  disqualifyEventMatchWinners,
  EVENT_CONTROL_TIMEOUT_MS,
  postponeEventStart,
  syncEventState,
  type EventControlDependencies,
} from "./eventOperations.ts";
import { assertProfileMutationAllowed } from "./profileCanonicalActivation.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

export const EVENT_PATHS = new Set([
  "/events/create",
  "/events/matches/winners/disqualify",
  "/events/participants/join",
  "/events/participants/remove",
  "/events/prize-selections/toggle",
  "/events/start/postpone",
  "/events/state/sync",
]);

export type EventRouteDependencies = {
  control?: EventControlDependencies;
  participation?: EventParticipationDependencies;
  repository?: GameplayRepository;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<RequestIdentity>;
  logFailure?: (kind: string) => void;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function readEventBody(
  request: Request,
  pathname: string,
): Promise<
  | CreateEventRequest
  | DisqualifyEventMatchWinnersRequest
  | JoinEventRequest
  | PostponeEventStartRequest
  | RemoveEventParticipantRequest
  | SyncEventStateRequest
  | ToggleEventPrizeSelectionRequest
> {
  let body: Record<string, unknown> | null;
  try {
    body = toRecord(await readBoundedJson(request));
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  if (pathname === "/events/participants/join") {
    if (!isJoinEventRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return { eventId: normalizeFirebaseKey(body.eventId) || "" };
  }
  if (pathname === "/events/create") {
    if (!isCreateEventRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/events/start/postpone") {
    if (!isPostponeEventStartRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/events/matches/winners/disqualify") {
    if (!isDisqualifyEventMatchWinnersRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/events/state/sync") {
    if (!isSyncEventStateRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/events/prize-selections/toggle") {
    if (!isToggleEventPrizeSelectionRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (!isRemoveEventParticipantRequest(body)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  return {
    eventId: normalizeFirebaseKey(body.eventId) || "",
    participantProfileId: normalizeFirebaseKey(body.participantProfileId) || "",
  };
}

export async function handleEventRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: EventRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") {
      return authPreflightResponse(corsHeaders);
    }
    if (request.method !== "POST") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    const pathname = new URL(request.url).pathname;
    if (!EVENT_PATHS.has(pathname)) {
      throw new AuthApiFailure(404, "not-found", "not-found");
    }
    const isParticipationPath =
      pathname === "/events/participants/join" ||
      pathname === "/events/participants/remove" ||
      pathname === "/events/prize-selections/toggle";
    const signal = isParticipationPath
      ? dependencies.participation?.signal ||
        AbortSignal.timeout(EVENT_OPERATION_TIMEOUT_MS)
      : dependencies.control?.signal ||
        AbortSignal.timeout(EVENT_CONTROL_TIMEOUT_MS);
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    await assertProfileMutationAllowed(env);
    const body = await readEventBody(request, pathname);
    const schedule = (work: Promise<void>) => ctx.waitUntil(work);
    const repository = createEventProfileGameProjectionRepository(
      env,
      createEventTelegramProjectionRepository(
        env,
        dependencies.repository || createGameplayRepository(env),
        { schedule },
      ),
      { schedule },
    );
    const participation = {
      ...dependencies.participation,
      signal,
    };
    let operation: Promise<unknown>;
    if (pathname === "/events/participants/join") {
      if (!isJoinEventRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      operation = joinEvent(identity, body, repository, participation);
    } else if (pathname === "/events/participants/remove") {
      if (!isRemoveEventParticipantRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      operation = removeEventParticipant(
        identity,
        body,
        repository,
        participation,
      );
    } else if (pathname === "/events/prize-selections/toggle") {
      if (!isToggleEventPrizeSelectionRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      operation = toggleEventPrizeSelection(
        identity,
        body,
        repository,
        participation,
      );
    } else if (pathname === "/events/create") {
      if (!isCreateEventRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      operation = createEvent(env, identity, body, {
        ...dependencies.control,
        repository,
        signal,
      });
    } else if (pathname === "/events/start/postpone") {
      if (!isPostponeEventStartRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      operation = postponeEventStart(env, identity, body, {
        ...dependencies.control,
        repository,
        signal,
      });
    } else if (pathname === "/events/matches/winners/disqualify") {
      if (!isDisqualifyEventMatchWinnersRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      operation = disqualifyEventMatchWinners(env, identity, body, {
        ...dependencies.control,
        repository,
        signal,
      });
    } else {
      if (!isSyncEventStateRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      operation = syncEventState(env, identity, body, {
        ...dependencies.control,
        repository,
        signal,
      });
    }
    ctx.waitUntil(
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    const response = await operation;
    return authJsonResponse(response, 200, corsHeaders);
  } catch (error) {
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(503, "unavailable", "event-service-unavailable");
    if (failure.status >= 500 && !isProfileWritesDisabledFailure(failure)) {
      (
        dependencies.logFailure ||
        ((kind) =>
          console.error(
            JSON.stringify({ event: "event_service_failure", kind }),
          ))
      )(failure.message);
    }
    return authErrorResponse(failure, corsHeaders);
  }
}
