import { WAGER_FROZEN_READ_PATH } from "@mons/shared/wagers";
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
  verifySessionRequest,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";
import {
  GameSessionMutationLockFailure,
  MatchTimerStartStoreFailure,
} from "./gameplayCoordinationD1.ts";
import { createEventGameplayRepository } from "./eventRepository.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import { MatchStateD1Failure } from "./matchStateD1.ts";
import { enforceWagerOutcomeRateLimit } from "./wagerOutcome.ts";
import { assertProfileMutationAllowed } from "./profileCanonicalActivation.ts";
import {
  createWagerReservationRuntime,
  WagerClientUpdateRequired,
} from "./wagerReservationRuntime.ts";
import {
  automatchRoutes,
  readAutomatchOperationId,
} from "./gameplayRoutes/automatch.ts";
import { sessionRoutes } from "./gameplayRoutes/sessions.ts";
import { matchRoutes } from "./gameplayRoutes/matches.ts";
import { navigationRoutes } from "./gameplayRoutes/navigation.ts";
import { ratingRoutes } from "./gameplayRoutes/ratings.ts";
import { wagerRoutes } from "./gameplayRoutes/wagers.ts";
import {
  invalidRequest,
  prepareGameplayRoute,
  type GameplayRoute,
} from "./gameplayRoutes/definition.ts";
import type { GameplayRouteDependencies } from "./gameplayRoutes/runtime.ts";

export type { GameplayRouteDependencies } from "./gameplayRoutes/runtime.ts";
export { cancelAutomatch } from "./gameplayRoutes/automatch.ts";
export {
  removeNavigationGame,
  resolveProfileId,
} from "./gameplayRoutes/navigation.ts";
export { MAX_RECORD_KEY_BYTES, isSafeRecordKey } from "./recordKeys.ts";

const gameplayRoutes: ReadonlyMap<string, GameplayRoute> = new Map(
  [
    ...automatchRoutes,
    ...sessionRoutes,
    ...matchRoutes,
    ...navigationRoutes,
    ...ratingRoutes,
    ...wagerRoutes,
  ].map((route) => [route.path, route]),
);

export const GAMEPLAY_PATHS = new Set(gameplayRoutes.keys());

export async function readGameplayBody(
  request: Request,
  pathname: string,
): Promise<Record<string, unknown>> {
  const fallbackPath = pathname.startsWith("/wagers/proposals/")
    ? "/wagers/proposals/accept"
    : "/navigation/games/remove";
  const route =
    gameplayRoutes.get(pathname) || gameplayRoutes.get(fallbackPath);
  if (!route) throw invalidRequest();
  return (await prepareGameplayRoute(request, route)).body;
}

export async function handleGameplayRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: GameplayRouteDependencies = {},
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (
    request.method !== "POST" ||
    gameplayRoutes.get(pathname)?.readOnly ||
    !GAMEPLAY_PATHS.has(pathname)
  )
    return handleGameplayRequest(request, env, ctx, dependencies);
  try {
    await requireActiveDurableMatchState(env.PROFILE_GAMES_DB);
    return await handleGameplayRequest(request, env, ctx, dependencies);
  } catch (error) {
    let headers: Record<string, string> = { Vary: "Origin" };
    try {
      headers = getAuthCorsHeaders(request);
    } catch {}
    return authErrorResponse(
      new AuthApiFailure(
        503,
        "unavailable",
        error instanceof MatchStateD1Failure
          ? error.message
          : "gameplay-service-unavailable",
      ),
      { ...headers, "Retry-After": "60" },
    );
  }
}

async function handleGameplayRequest(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: GameplayRouteDependencies = {},
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
    const route = gameplayRoutes.get(pathname);
    if (!route) {
      throw new AuthApiFailure(404, "not-found", "not-found");
    }
    const identity = await (
      dependencies.verifyIdentity || verifySessionRequest
    )(request, env, ctx);
    const repository =
      dependencies.repository || createEventGameplayRepository(env);
    const isWagerMutation =
      pathname.startsWith("/wagers/") && pathname !== WAGER_FROZEN_READ_PATH;
    const reservations =
      isWagerMutation || pathname === WAGER_FROZEN_READ_PATH
        ? dependencies.wagerReservations ||
          createWagerReservationRuntime(env, repository)
        : null;
    if (isWagerMutation) await reservations?.assertClientVersion(request);
    const automatchOperationId =
      pathname === "/automatch/start"
        ? readAutomatchOperationId(request)
        : null;
    if (!route.readOnly) {
      await assertProfileMutationAllowed(env);
    }
    if (pathname === "/wagers/outcomes/resolve") {
      await enforceWagerOutcomeRateLimit(env.AUTH_RATE_LIMITER, identity.uid);
    }
    const prepared = await prepareGameplayRoute(request, route);
    const response = await prepared.execute({
      request,
      env,
      ctx,
      dependencies,
      pathname,
      identity,
      repository,
      reservations,
      automatchOperationId,
    });
    return authJsonResponse(response, 200, corsHeaders);
  } catch (error) {
    if (error instanceof WagerClientUpdateRequired) {
      return authJsonResponse(
        {
          ok: false,
          error: "client-update-required",
          message: error.message,
        },
        409,
        corsHeaders,
      );
    }
    if (
      error instanceof GameSessionMutationLockFailure ||
      error instanceof MatchTimerStartStoreFailure
    ) {
      (
        dependencies.logCoordinationFailure ||
        ((record) =>
          console.error(
            JSON.stringify({
              event: "gameplay_coordination_failure",
              ...record,
            }),
          ))
      )({
        operation: error.operation,
        store:
          error instanceof GameSessionMutationLockFailure
            ? "mutation-lock"
            : "timer-start",
      });
    }
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(
            503,
            "unavailable",
            "gameplay-service-unavailable",
          );
    if (failure.status >= 500 && !isProfileWritesDisabledFailure(failure)) {
      (
        dependencies.logFailure ||
        ((kind) =>
          console.error(
            JSON.stringify({ event: "gameplay_route_failure", kind }),
          ))
      )(failure.message);
    }
    return authErrorResponse(failure, corsHeaders);
  }
}
