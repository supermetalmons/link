import type { StoredSession, SessionRevocation } from "../session/sessionStore";
import {
  SESSION_ANONYMOUS_PATH,
  SESSION_REFRESH_PATH,
  SESSION_LOGOUT_PATH,
  buildSessionRefreshToken,
  buildSessionRevokeToken,
  isSessionTokenResponse,
  SESSION_ACCESS_TOKEN_TTL_SECONDS,
  type SessionTokenResponse,
} from "@mons/shared/session-auth";

export type { SessionTokenResponse } from "@mons/shared/session-auth";
export type SessionTokenResult = SessionTokenResponse & {
  accessDeadlineMs: number;
};

export class SessionApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionApiError";
    this.code = code;
  }
}

async function request(path: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://api.mons.link${path}`, {
      ...options,
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new SessionApiError(
        response.status === 401 ? "session-revoked" : "unavailable",
        response.status === 401
          ? "Your session has ended. Sign in again."
          : "Session service is unavailable. Try again.",
      );
    }
    return response;
  } catch (error) {
    if (error instanceof SessionApiError) throw error;
    throw new SessionApiError(
      "unavailable",
      "Session service is unavailable. Try again.",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function tokenResponse(
  response: Response,
  sessionId: string,
  startedAt: number,
): Promise<SessionTokenResult> {
  try {
    if (
      Number(response.headers.get("Content-Length")) > 16_384 ||
      !response.body
    )
      throw new Error();
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let body = "";
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
    }, 15_000);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16_384) throw new Error();
        body += decoder.decode(value, { stream: true });
      }
      const value: unknown = JSON.parse(body + decoder.decode());
      if (!isSessionTokenResponse(value) || value.sessionId !== sessionId)
        throw new Error();
      const encodedClaims = value.accessToken
        .split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const claims = JSON.parse(atob(encodedClaims)) as {
        iat?: unknown;
        exp?: unknown;
      };
      if (
        !claims ||
        typeof claims.iat !== "number" ||
        typeof claims.exp !== "number" ||
        !Number.isSafeInteger(claims.iat) ||
        !Number.isSafeInteger(claims.exp) ||
        claims.iat <= 0 ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > SESSION_ACCESS_TOKEN_TTL_SECONDS ||
        claims.exp * 1000 !== value.accessExpiresAtMs
      )
        throw new Error();
      const accessDeadlineMs =
        startedAt + (claims.exp - claims.iat) * 1000 - 1000;
      if (accessDeadlineMs <= performance.now()) throw new Error();
      return { ...value, accessDeadlineMs };
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch {
    throw new SessionApiError(
      "unavailable",
      "Invalid session response. Try again.",
    );
  }
}

export const sessionApi = {
  create: async (session: StoredSession): Promise<SessionTokenResult> => {
    const startedAt = performance.now();
    return tokenResponse(
      await request(SESSION_ANONYMOUS_PATH, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sessionId: session.sessionId,
          refreshSecret: session.refreshSecret,
          revokeSecret: session.revokeSecret,
        }),
      }),
      session.sessionId,
      startedAt,
    );
  },
  refresh: async (session: StoredSession): Promise<SessionTokenResult> => {
    const startedAt = performance.now();
    return tokenResponse(
      await request(SESSION_REFRESH_PATH, {
        headers: {
          Authorization: `Bearer ${buildSessionRefreshToken(session.sessionId, session.refreshSecret)}`,
          Accept: "application/json",
        },
      }),
      session.sessionId,
      startedAt,
    );
  },
  revoke: async (session: SessionRevocation): Promise<void> => {
    const response = await request(SESSION_LOGOUT_PATH, {
      headers: {
        Authorization: `Bearer ${buildSessionRevokeToken(session.sessionId, session.revokeSecret)}`,
      },
    });
    void response.body?.cancel().catch(() => undefined);
    if (response.status !== 204) {
      throw new SessionApiError(
        "unavailable",
        "Invalid session revocation response. Try again.",
      );
    }
  },
};
