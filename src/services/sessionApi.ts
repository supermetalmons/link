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
import {
  isSessionBootstrap,
  isSessionBootstrapTarget,
  isSessionEventBootstrap,
  isSessionEventBootstrapTarget,
  SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES,
  SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES,
  SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  type SessionBootstrap,
  type SessionBootstrapTarget,
  type SessionEventBootstrap,
  type SessionEventBootstrapTarget,
} from "@mons/shared/session-bootstrap";

export type { SessionTokenResponse } from "@mons/shared/session-auth";
export type SessionTokenResult = SessionTokenResponse & {
  accessDeadlineMs: number;
};
export type SessionTokenReadResult = SessionTokenResult & {
  gameBootstrap?: SessionBootstrap;
  eventBootstrap?: SessionEventBootstrap;
};
type SessionReadTarget = SessionBootstrapTarget | SessionEventBootstrapTarget;

export class SessionApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionApiError";
    this.code = code;
  }
}

async function request(
  path: string,
  options: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = signal ? null : setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://api.mons.link${path}`, {
      ...options,
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: signal ?? controller.signal,
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
    if (timer !== null) clearTimeout(timer);
  }
}

async function tokenResponse(
  response: Response,
  sessionId: string,
  startedAt: number,
  target?: SessionReadTarget,
  signal?: AbortSignal,
  deadline?: number,
): Promise<SessionTokenReadResult> {
  try {
    const maxBytes = target
      ? "eventId" in target
        ? SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES
        : SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES
      : 16_384;
    const assertActive = () => {
      if (
        signal?.aborted ||
        (deadline !== undefined && performance.now() >= deadline)
      )
        throw new Error();
    };
    assertActive();
    if (
      Number(response.headers.get("Content-Length")) > maxBytes ||
      !response.body
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error();
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let body = "";
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    const timer = signal ? null : setTimeout(cancel, 15_000);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        assertActive();
        const { done, value } = await reader.read();
        assertActive();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error();
        body += decoder.decode(value, { stream: true });
      }
      const value: unknown = JSON.parse(body + decoder.decode());
      let token = value;
      let gameBootstrap: SessionBootstrap | undefined;
      let eventBootstrap: SessionEventBootstrap | undefined;
      if (
        target &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        if ("eventId" in target) {
          const { eventBootstrap: optionalEvent, ...tokenFields } =
            value as Record<string, unknown>;
          token = tokenFields;
          if (
            isSessionEventBootstrap(optionalEvent) &&
            optionalEvent.eventId === target.eventId
          )
            eventBootstrap = optionalEvent;
        } else {
          const { gameBootstrap: optionalGame, ...tokenFields } =
            value as Record<string, unknown>;
          token = tokenFields;
          if (
            isSessionBootstrap(optionalGame) &&
            optionalGame.inviteId === target.inviteId &&
            optionalGame.selection === target.selection
          )
            gameBootstrap = optionalGame;
        }
      }
      if (!isSessionTokenResponse(token) || token.sessionId !== sessionId)
        throw new Error();
      const encodedClaims = token.accessToken
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
        claims.exp * 1000 !== token.accessExpiresAtMs
      )
        throw new Error();
      const accessDeadlineMs =
        startedAt + (claims.exp - claims.iat) * 1000 - 1000;
      if (accessDeadlineMs <= performance.now()) throw new Error();
      return {
        ...token,
        accessDeadlineMs,
        ...(gameBootstrap ? { gameBootstrap } : {}),
        ...(eventBootstrap ? { eventBootstrap } : {}),
      };
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      cancel();
      reader.releaseLock();
    }
  } catch {
    void response.body?.cancel().catch(() => undefined);
    throw new SessionApiError(
      "unavailable",
      "Invalid session response. Try again.",
    );
  }
}

async function requestToken(
  path: string,
  options: RequestInit,
  sessionId: string,
  target?: SessionReadTarget,
): Promise<SessionTokenReadResult> {
  const startedAt = performance.now();
  if (!target)
    return tokenResponse(await request(path, options), sessionId, startedAt);
  if (
    !isSessionBootstrapTarget(target) &&
    !isSessionEventBootstrapTarget(target)
  )
    throw new SessionApiError("unavailable", "Invalid initial data request.");
  const query = new URLSearchParams(
    "eventId" in target
      ? { bootstrapEventId: target.eventId }
      : {
          bootstrapInviteId: target.inviteId,
          bootstrapSelection: target.selection,
        },
  );
  const controller = new AbortController();
  const deadline = startedAt + SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new SessionApiError(
          "unavailable",
          "Session service is unavailable. Try again.",
        ),
      );
    }, SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS);
  });
  const run = async () => {
    const response = await request(
      `${path}?${query}`,
      options,
      controller.signal,
    );
    if (controller.signal.aborted || performance.now() >= deadline) {
      void response.body?.cancel().catch(() => undefined);
      throw new SessionApiError(
        "unavailable",
        "Session service is unavailable. Try again.",
      );
    }
    return tokenResponse(
      response,
      sessionId,
      startedAt,
      target,
      controller.signal,
      deadline,
    );
  };
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export const sessionApi = {
  create: async (
    session: StoredSession,
    target?: SessionReadTarget,
  ): Promise<SessionTokenReadResult> => {
    return requestToken(
      SESSION_ANONYMOUS_PATH,
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sessionId: session.sessionId,
          refreshSecret: session.refreshSecret,
          revokeSecret: session.revokeSecret,
        }),
      },
      session.sessionId,
      target,
    );
  },
  refresh: async (
    session: StoredSession,
    target?: SessionReadTarget,
  ): Promise<SessionTokenReadResult> => {
    return requestToken(
      SESSION_REFRESH_PATH,
      {
        headers: {
          Authorization: `Bearer ${buildSessionRefreshToken(session.sessionId, session.refreshSecret)}`,
          Accept: "application/json",
        },
      },
      session.sessionId,
      target,
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
