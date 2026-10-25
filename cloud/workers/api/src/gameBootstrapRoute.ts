import type { ApiQuery, ApiParameters } from "@mons/shared/api-contracts";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  GameBootstrapRateLimitFailure,
  readAuthenticatedGameBootstrap,
  type GameBootstrapDependencies,
} from "./gameBootstrap.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { createRequestTiming } from "./requestTiming.ts";
import {
  verifySessionRequest,
  type SessionIdentity,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";
const GAME_BOOTSTRAP_ROUTE_PATTERN = /^\/invites\/([^/]+)\/bootstrap$/;

export type GameBootstrapRouteDependencies = GameBootstrapDependencies & {
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<SessionIdentity>;
  now?: () => number;
  logFailure?: () => void;
};

export function isGameBootstrapPath(pathname: string): boolean {
  return GAME_BOOTSTRAP_ROUTE_PATTERN.test(pathname);
}

function readRoute(
  request: Request,
): ApiParameters<"GET /invites/:inviteId/bootstrap"> & {
  preferApproved: boolean;
} {
  const url = new URL(request.url);
  const match = GAME_BOOTSTRAP_ROUTE_PATTERN.exec(url.pathname);
  let inviteId = "";
  try {
    inviteId = match ? decodeURIComponent(match[1]) : "";
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-invite-id");
  }
  const selection =
    url.searchParams.get(
      "selection" satisfies keyof ApiQuery<"GET /invites/:inviteId/bootstrap">,
    ) ??
    ("current" satisfies NonNullable<
      ApiQuery<"GET /invites/:inviteId/bootstrap">["selection"]
    >);
  if (
    !isSafeRecordKey(inviteId) ||
    inviteId !== inviteId.trim() ||
    url.searchParams.size > 1 ||
    (url.searchParams.size === 1 &&
      !url.searchParams.has(
        "selection" satisfies keyof ApiQuery<"GET /invites/:inviteId/bootstrap">,
      )) ||
    (selection !==
      ("current" satisfies NonNullable<
        ApiQuery<"GET /invites/:inviteId/bootstrap">["selection"]
      >) &&
      selection !==
        ("approved" satisfies NonNullable<
          ApiQuery<"GET /invites/:inviteId/bootstrap">["selection"]
        >))
  ) {
    throw new AuthApiFailure(
      400,
      "invalid-argument",
      "invalid-bootstrap-request",
    );
  }
  return {
    inviteId,
    preferApproved:
      selection ===
      ("approved" satisfies NonNullable<
        ApiQuery<"GET /invites/:inviteId/bootstrap">["selection"]
      >),
  };
}

export async function handleGameBootstrapRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: GameBootstrapRouteDependencies = {},
): Promise<Response> {
  const now = dependencies.now || Date.now;
  const timing = createRequestTiming({ now, repeated: "sum" });
  const { finish } = timing;
  const measure = async <T>(
    name: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    request.signal.throwIfAborted();
    return timing.measure(name, async () => {
      const value = await work();
      request.signal.throwIfAborted();
      return value;
    });
  };
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = {
      ...getAuthCorsHeaders(request),
      "Access-Control-Expose-Headers": "Retry-After, Server-Timing",
    };
    const origin = corsHeaders["Access-Control-Allow-Origin"];
    if (origin) corsHeaders["Timing-Allow-Origin"] = origin;
    const { inviteId, preferApproved } = readRoute(request);
    if (request.method === "OPTIONS")
      return finish(authPreflightResponse(corsHeaders));
    if (request.method !== "GET") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    const identity = await measure("auth", () =>
      (dependencies.verifyIdentity || verifySessionRequest)(request, env, ctx),
    );
    const body = await readAuthenticatedGameBootstrap(
      {
        inviteId,
        selection: preferApproved
          ? ("approved" satisfies NonNullable<
              ApiQuery<"GET /invites/:inviteId/bootstrap">["selection"]
            >)
          : ("current" satisfies NonNullable<
              ApiQuery<"GET /invites/:inviteId/bootstrap">["selection"]
            >),
        identity,
        signal: request.signal,
      },
      env,
      { ...dependencies, measure },
    );
    return finish(
      authJsonResponse<"GET /invites/:inviteId/bootstrap", 200>(
        body,
        200,
        corsHeaders,
      ),
    );
  } catch (error) {
    if (error instanceof GameBootstrapRateLimitFailure)
      corsHeaders["Retry-After"] = String(error.retryAfterMs / 1000);
    if (error instanceof AuthApiFailure)
      return finish(authErrorResponse(error, corsHeaders));
    (
      dependencies.logFailure ||
      (() => console.error({ event: "game_bootstrap_failure" }))
    )();
    return finish(
      authErrorResponse(
        new AuthApiFailure(503, "unavailable", "game-bootstrap-unavailable"),
        corsHeaders,
      ),
    );
  }
}
