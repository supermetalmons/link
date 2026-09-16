import {
  isSessionCreateRequest,
  parseSessionCapability,
  SESSION_ANONYMOUS_PATH,
  SESSION_LOGOUT_PATH,
  SESSION_REFRESH_PATH,
  type SessionCapability,
  type SessionTokenResponse,
} from "@mons/shared/session-auth";
import {
  SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES,
  SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES,
  type SessionBootstrapTarget,
  type SessionEventBootstrapTarget,
} from "@mons/shared/session-bootstrap";
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
import {
  readSessionBootstrap,
  readSessionBootstrapTarget,
  readSessionEventBootstrap,
  type SessionBootstrapDependencies,
} from "./sessionBootstrap.ts";

export type SessionRouteDependencies = {
  now?: () => number;
  repository?: SessionRepository;
  bootstrap?: SessionBootstrapDependencies;
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
  const now = dependencies.now || Date.now;
  const startedAt = now();
  const timings = new Map<string, number>();
  let target: SessionBootstrapTarget | SessionEventBootstrapTarget | null =
    null;
  let headers: Record<string, string> = { Vary: "Origin" };
  const measure = async <T>(
    name: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const started = now();
    try {
      return await work();
    } finally {
      timings.set(
        name,
        (timings.get(name) ?? 0) + Math.max(0, now() - started),
      );
    }
  };
  const finish = (response: Response): Response => {
    if (!target) return response;
    timings.set("total", Math.max(0, now() - startedAt));
    response.headers.set(
      "Server-Timing",
      Array.from(
        timings,
        ([name, duration]) => `${name};dur=${duration.toFixed(1)}`,
      ).join(", "),
    );
    return response;
  };
  const tokenResponse = async (
    session: SessionTokenResponse,
  ): Promise<Response> => {
    if (!target) return authJsonResponse(session, 200, headers);
    if ("eventId" in target) {
      const eventTarget = target;
      let eventBootstrap = await measure("event_snapshot", () =>
        readSessionEventBootstrap(
          request,
          eventTarget,
          env,
          dependencies.bootstrap,
        ),
      );
      if (
        new TextEncoder().encode(JSON.stringify({ ...session, eventBootstrap }))
          .byteLength > SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES
      )
        eventBootstrap = { ...eventTarget, result: { ok: false, status: 503 } };
      return finish(
        authJsonResponse({ ...session, eventBootstrap }, 200, headers),
      );
    }
    let gameBootstrap = await readSessionBootstrap(
      request,
      target,
      session,
      env,
      {
        ...dependencies.bootstrap,
        measure,
      },
    );
    if (
      new TextEncoder().encode(JSON.stringify({ ...session, gameBootstrap }))
        .byteLength > SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES
    )
      gameBootstrap = { ...target, result: { ok: false, status: 503 } };
    return finish(
      authJsonResponse({ ...session, gameBootstrap }, 200, headers),
    );
  };
  try {
    headers = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") return authPreflightResponse(headers);
    if (request.method !== "POST")
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    target = readSessionBootstrapTarget(request);
    if (target) {
      headers["Access-Control-Expose-Headers"] = "Retry-After, Server-Timing";
      const origin = headers["Access-Control-Allow-Origin"];
      if (origin) headers["Timing-Allow-Origin"] = origin;
    }
    const pathname = new URL(request.url).pathname;
    const nowMs = now();
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
      return finish(
        authErrorResponse(
          new AuthApiFailure(429, "resource-exhausted", "rate-limit-exceeded"),
          { ...headers, "Retry-After": "60" },
        ),
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
      return await tokenResponse(
        await measure("session", async () =>
          issueSessionAccessToken(
            await repository.create(value, nowMs),
            env,
            nowMs,
          ),
        ),
      );
    }
    if (pathname === SESSION_REFRESH_PATH) {
      return await tokenResponse(
        await measure("session", async () =>
          issueSessionAccessToken(await repository.refresh(proof!), env, nowMs),
        ),
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
    return finish(
      authErrorResponse(
        error instanceof AuthApiFailure
          ? error
          : new AuthApiFailure(503, "unavailable", "session-auth-unavailable"),
        headers,
      ),
    );
  }
}
