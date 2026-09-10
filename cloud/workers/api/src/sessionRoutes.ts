import {
  isSessionCreateRequest,
  parseSessionCapability,
  SESSION_ANONYMOUS_PATH,
  SESSION_LOGOUT_PATH,
  SESSION_REFRESH_PATH,
  type SessionCapability,
} from "@mons/shared/session-auth";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import { readBoundedJson } from "./http.ts";
import { issueSessionAccessToken } from "./sessionAuth.ts";
import {
  createSessionRepository,
  type SessionRepository,
} from "./sessionD1.ts";

export type SessionRouteDependencies = {
  now?: () => number;
  repository?: SessionRepository;
};

function capability(
  request: Request,
  kind: "refresh" | "revoke",
): SessionCapability {
  const authorization = request.headers.get("Authorization") || "";
  const value =
    authorization.length <= 92
      ? authorization.match(/^Bearer (\S+)$/)?.[1]
      : null;
  const parsed = parseSessionCapability(value, kind);
  if (!parsed)
    throw new AuthApiFailure(
      401,
      "unauthenticated",
      "invalid-session-capability",
    );
  return parsed;
}

export async function handleSessionRoute(
  request: Request,
  env: Env,
  dependencies: SessionRouteDependencies = {},
): Promise<Response> {
  let headers: Record<string, string> = { Vary: "Origin" };
  try {
    headers = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") return authPreflightResponse(headers);
    if (request.method !== "POST")
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    const pathname = new URL(request.url).pathname;
    const nowMs = (dependencies.now || Date.now)();
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const proof =
      pathname === SESSION_REFRESH_PATH
        ? capability(request, "refresh")
        : pathname === SESSION_LOGOUT_PATH
          ? capability(request, "revoke")
          : null;
    const admission = await env.AUTH_RATE_LIMITER.limit({
      key:
        pathname === SESSION_REFRESH_PATH
          ? `session:refresh:${proof!.sessionId}`
          : `session:allocate:ip:${ip}`,
    });
    if (!admission.success) {
      return authErrorResponse(
        new AuthApiFailure(429, "resource-exhausted", "rate-limit-exceeded"),
        { ...headers, "Retry-After": "60" },
      );
    }
    const repository =
      dependencies.repository || createSessionRepository(env.AUTH_STATE_DB);
    if (pathname === SESSION_ANONYMOUS_PATH) {
      const contentType = request.headers
        .get("Content-Type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        throw new AuthApiFailure(
          400,
          "invalid-argument",
          "invalid-session-request",
        );
      }
      let value: unknown;
      try {
        value = await readBoundedJson(request, 1024);
      } catch {
        throw new AuthApiFailure(
          400,
          "invalid-argument",
          "invalid-session-request",
        );
      }
      if (!isSessionCreateRequest(value))
        throw new AuthApiFailure(
          400,
          "invalid-argument",
          "invalid-session-request",
        );
      const session = await repository.create(value, nowMs);
      return authJsonResponse(
        await issueSessionAccessToken(session, env, nowMs),
        200,
        headers,
      );
    }
    if (pathname === SESSION_REFRESH_PATH) {
      const session = await repository.refresh(proof!);
      return authJsonResponse(
        await issueSessionAccessToken(session, env, nowMs),
        200,
        headers,
      );
    }
    if (pathname === SESSION_LOGOUT_PATH) {
      await repository.revoke(proof!, nowMs);
      return new Response(null, {
        status: 204,
        headers: { ...headers, "Cache-Control": "no-store" },
      });
    }
    throw new AuthApiFailure(404, "not-found", "not-found");
  } catch (error) {
    return authErrorResponse(
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(503, "unavailable", "session-auth-unavailable"),
      headers,
    );
  }
}
