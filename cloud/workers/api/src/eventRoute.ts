import {
  isJoinEventRequest,
  isRemoveEventParticipantRequest,
  type JoinEventRequest,
  type RemoveEventParticipantRequest,
} from "@mons/shared/events";
import { normalizeFirebaseKey } from "@mons/shared/ids";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  EVENT_OPERATION_TIMEOUT_MS,
  joinEvent,
  removeEventParticipant,
  type EventParticipationDependencies,
} from "./eventParticipation.ts";
import {
  verifyFirebaseRequest,
  type FirebaseIdentity,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { readBoundedJson } from "./http.ts";

export const EVENT_PATHS = new Set([
  "/events/participants/join",
  "/events/participants/remove",
]);

export type EventRouteDependencies = {
  participation?: EventParticipationDependencies;
  repository?: GameplayRepository;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<FirebaseIdentity>;
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
): Promise<JoinEventRequest | RemoveEventParticipantRequest> {
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
    const signal =
      dependencies.participation?.signal ||
      AbortSignal.timeout(EVENT_OPERATION_TIMEOUT_MS);
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    const body = await readEventBody(request, pathname);
    const repository = dependencies.repository || createGameplayRepository(env);
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
    } else {
      if (!isRemoveEventParticipantRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      operation = removeEventParticipant(
        identity,
        body,
        repository,
        participation,
      );
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
        : new AuthApiFailure(
            503,
            "unavailable",
            "event-participation-service-unavailable",
          );
    if (failure.status >= 500) {
      (
        dependencies.logFailure ||
        ((kind) =>
          console.error(
            JSON.stringify({ event: "event_participation_failure", kind }),
          ))
      )(failure.message);
    }
    return authErrorResponse(failure, corsHeaders);
  }
}
