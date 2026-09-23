import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import { authJsonResponse, getAuthCorsHeaders } from "./authHttp.ts";
import {
  EVENT_OPERATION_TIMEOUT_MS,
  type EventParticipationDependencies,
} from "./eventParticipation.ts";
import type { WorkerExecutionContext } from "./sessionAuth.ts";
import type { EventGameplayRepository } from "./eventRepository.ts";
import { EventWritesDisabled, assertEventWritesAllowed } from "./eventD1.ts";
import { createEventMutationRepository } from "./eventMutationRepository.ts";
import { readBoundedJson } from "./http.ts";
import {
  EVENT_CONTROL_TIMEOUT_MS,
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
import {
  eventRoutes,
  type EventRequestBody,
  type EventRoute,
  type PreparedEventRoute,
} from "./eventRouteDefinitions.ts";

export const EVENT_PATHS = new Set(eventRoutes.keys());

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

async function prepareEventRoute(
  request: Request,
  route: EventRoute,
): Promise<PreparedEventRoute> {
  let body: Record<string, unknown> | null;
  try {
    body = toRecord(await readBoundedJson(request));
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  return route.prepare(body);
}

export async function readEventBody(
  request: Request,
  pathname: string,
): Promise<EventRequestBody> {
  const route =
    eventRoutes.get(pathname) || eventRoutes.get("/events/participants/remove");
  if (!route)
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  return (await prepareEventRoute(request, route)).body;
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
      const route = eventRoutes.get(pathname);
      if (!route) {
        throw new AuthApiFailure(404, "not-found", "not-found");
      }
      const isParticipationPath = route.kind === "participation";
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
      const prepared = await prepareEventRoute(request, route);
      const schedule = (work: Promise<void>) => ctx.waitUntil(work);
      const repository = createEventMutationRepository(env, {
        eventRepository: dependencies.repository,
        schedule,
      });
      const response = await prepared.execute({
        env,
        identity,
        repository,
        participation: { ...dependencies.participation, signal },
        control: { ...dependencies.control, repository, signal },
      });
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
