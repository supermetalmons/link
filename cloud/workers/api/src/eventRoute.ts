import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
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
import { normalizeRecordKey } from "@mons/shared/ids";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import { authJsonResponse, getAuthCorsHeaders } from "./authHttp.ts";
import {
  EVENT_OPERATION_TIMEOUT_MS,
  joinEvent,
  removeEventParticipant,
  toggleEventPrizeSelection,
  type EventParticipationDependencies,
} from "./eventParticipation.ts";
import type { WorkerExecutionContext } from "./sessionAuth.ts";
import type { EventGameplayRepository } from "./eventRepository.ts";
import { EventWritesDisabled, assertEventWritesAllowed } from "./eventD1.ts";
import { createEventMutationRepository } from "./eventMutationRepository.ts";
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
import { authenticatedPost } from "./authenticatedPost.ts";
import {
  isBoundedEventResponse,
  readOptionalEventSnapshotSeed,
  type EventSnapshotSeedDependencies,
} from "./eventSnapshotResponse.ts";

export const EVENT_PATHS = new Set([
  "/events/create",
  "/events/matches/winners/disqualify",
  "/events/participants/join",
  "/events/participants/remove",
  "/events/prize-selections/toggle",
  "/events/start/postpone",
  "/events/state/sync",
]);

export type EventRouteDependencies = EventSnapshotSeedDependencies & {
  assertEventWrites?: () => Promise<void>;
  control?: EventControlDependencies;
  participation?: EventParticipationDependencies;
  repository?: EventGameplayRepository;
  verifyIdentity?: (
    request: Request,
    env: Env,
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
    return { eventId: normalizeRecordKey(body.eventId) || "" };
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
    eventId: normalizeRecordKey(body.eventId) || "",
    participantProfileId: normalizeRecordKey(body.participantProfileId) || "",
  };
}

export async function handleEventRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: EventRouteDependencies = {},
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (request.method !== "POST" || !EVENT_PATHS.has(pathname))
    return handleEventRequest(request, env, ctx, dependencies);
  try {
    await requireActiveDurableMatchState(env.PROFILE_GAMES_DB);
    return await handleEventRequest(request, env, ctx, dependencies);
  } catch {
    let headers: Record<string, string> = { Vary: "Origin" };
    try {
      headers = getAuthCorsHeaders(request);
    } catch {}
    return authErrorResponse(
      new AuthApiFailure(503, "unavailable", "match-state-writes-disabled"),
      { ...headers, "Retry-After": "60" },
    );
  }
}

async function handleEventRequest(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: EventRouteDependencies = {},
): Promise<Response> {
  return authenticatedPost(
    request,
    env,
    ctx,
    {
      failureMessage: "event-service-unavailable",
      failureEvent: "event_service_failure",
      logFailure: dependencies.logFailure,
      verifyIdentity: dependencies.verifyIdentity,
      errorResponse: (error, corsHeaders) =>
        error instanceof EventWritesDisabled
          ? authJsonResponse(
              {
                ok: false,
                error: "unavailable",
                message: "event-writes-disabled",
              },
              503,
              { ...corsHeaders, "Retry-After": "60" },
            )
          : null,
    },
    async ({ pathname, corsHeaders, authenticate }) => {
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
      const identity = await authenticate();
      if (dependencies.assertEventWrites) {
        await dependencies.assertEventWrites();
      } else if (!dependencies.verifyIdentity) {
        await assertEventWritesAllowed(env.EVENT_DB);
      }
      await assertProfileMutationAllowed(env);
      const body = await readEventBody(request, pathname);
      const schedule = (work: Promise<void>) => ctx.waitUntil(work);
      const repository = createEventMutationRepository(env, {
        eventRepository: dependencies.repository,
        schedule,
      });
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
      const response = await operation;
      const value = toRecord(response);
      const params = new URL(request.url).searchParams;
      if (
        !isParticipationPath &&
        params.getAll("eventSnapshot").length === 1 &&
        params.get("eventSnapshot") === "v1" &&
        value?.ok === true &&
        value.skipped !== true &&
        typeof value.eventId === "string"
      ) {
        const enrichmentStartedAt = Date.now();
        const eventSnapshot = await readOptionalEventSnapshotSeed(
          env,
          value.eventId,
          AbortSignal.any([signal, request.signal]),
          dependencies,
        );
        corsHeaders["Server-Timing"] =
          `event_snapshot;dur=${Date.now() - enrichmentStartedAt}`;
        corsHeaders["Access-Control-Expose-Headers"] = "Server-Timing";
        const origin = corsHeaders["Access-Control-Allow-Origin"];
        if (origin) corsHeaders["Timing-Allow-Origin"] = origin;
        if (eventSnapshot) {
          const enriched = { ...value, eventSnapshot };
          if (isBoundedEventResponse(enriched))
            return authJsonResponse(enriched, 200, corsHeaders);
        }
      }
      return authJsonResponse(response, 200, corsHeaders);
    },
  );
}
