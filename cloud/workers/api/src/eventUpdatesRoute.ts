import { EVENT_UPDATES_SOCKET_PROTOCOL } from "@mons/shared/events";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
  isAllowedAuthOrigin,
} from "./authHttp.ts";
import { readInviteSocketToken } from "./inviteSocketAuth.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  verifySessionRequest,
  type SessionIdentity,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";
import { socketSessionHeaders } from "./socketSession.ts";

const EVENT_UPDATES_ROUTE_PATTERN = /^\/events\/([^/]+)\/socket$/;

export type EventUpdatesRouteDependencies = {
  room?: { fetch(request: Request): Promise<Response> };
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<SessionIdentity>;
};

export function isEventUpdatesPath(pathname: string): boolean {
  return EVENT_UPDATES_ROUTE_PATTERN.test(pathname);
}

export async function handleEventUpdatesRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: EventUpdatesRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") return authPreflightResponse(corsHeaders);
    if (request.method !== "GET")
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    const url = new URL(request.url);
    const match = EVENT_UPDATES_ROUTE_PATTERN.exec(url.pathname);
    let eventId = "";
    try {
      eventId = match ? decodeURIComponent(match[1]!) : "";
    } catch {}
    if (!isSafeRecordKey(eventId) || eventId !== eventId.trim() || url.search)
      throw new AuthApiFailure(400, "invalid-argument", "invalid-event-id");
    const origin = request.headers.get("Origin");
    if (!origin || !isAllowedAuthOrigin(origin))
      throw new AuthApiFailure(403, "permission-denied", "origin-not-allowed");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return authJsonResponse(
        { ok: false, error: "websocket-upgrade-required" },
        426,
        corsHeaders,
      );
    const token = readInviteSocketToken(
      request,
      EVENT_UPDATES_SOCKET_PROTOCOL,
      "invalid-event-updates-auth",
    );
    if (!token)
      throw new AuthApiFailure(
        401,
        "unauthenticated",
        "authentication-required",
      );
    const identity = await (
      dependencies.verifyIdentity || verifySessionRequest
    )(
      new Request(request.url, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      ctx,
    );
    const limited = await env.REACTION_RATE_LIMITER.limit({
      key: `event-connect:identity:${identity.uid}`,
    });
    if (!limited.success)
      return authJsonResponse(
        { ok: false, error: "resource-exhausted", message: "rate-limited" },
        429,
        { ...corsHeaders, "Retry-After": "60" },
      );
    const room = dependencies.room || env.EVENT_UPDATES.getByName(eventId);
    return await room.fetch(
      new Request("https://events.internal/events/socket", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": EVENT_UPDATES_SOCKET_PROTOCOL,
          "X-Mons-Event-Id": encodeURIComponent(eventId),
          "X-Mons-Event-User": encodeURIComponent(identity.uid),
          "X-Mons-Event-IP":
            request.headers.get("CF-Connecting-IP")?.trim() || "unknown",
          ...socketSessionHeaders(identity),
        },
      }),
    );
  } catch (error) {
    return authErrorResponse(
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(503, "unavailable", "event-updates-unavailable"),
      corsHeaders,
    );
  }
}
