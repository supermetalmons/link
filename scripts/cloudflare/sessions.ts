import { randomBytes, randomUUID } from "node:crypto";
import {
  isSessionTokenResponse,
  type SessionCreateRequest,
  type SessionTokenResponse,
} from "@mons/shared/session-auth";

export type ToolSession = SessionTokenResponse & {
  refreshToken: string;
  revokeToken: string;
};

export class SessionRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "SessionRequestError";
    this.retryable = retryable;
  }
}

export function createSessionRequest(): SessionCreateRequest {
  return {
    sessionId: randomUUID(),
    refreshSecret: randomBytes(32).toString("base64url"),
    revokeSecret: randomBytes(32).toString("base64url"),
  };
}

async function sessionRequest(
  baseUrl: string,
  path: string,
  fetcher: typeof fetch,
  token?: string,
  body?: SessionCreateRequest,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/auth/session/${path}`, {
      method: "POST",
      headers: {
        Origin: "https://mons.link",
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SessionRequestError(
      `Cloudflare session ${path} request failed.`,
      true,
    );
  }
  if (path === "logout" && response.status === 204) {
    await response.body?.cancel();
    return null;
  }
  if (path === "logout" || response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new SessionRequestError(
      `Cloudflare session ${path} returned ${response.status}.`,
      response.status >= 500,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) throw new Error("Oversized session response.");
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("Cloudflare session response was invalid.");
  } finally {
    reader.releaseLock();
  }
}

export async function createToolSession(
  baseUrl: string,
  fetcher: typeof fetch,
  creation?: SessionCreateRequest,
): Promise<ToolSession> {
  const input = creation || createSessionRequest();
  try {
    const value = await sessionRequest(
      baseUrl,
      "anonymous",
      fetcher,
      undefined,
      input,
    );
    if (!isSessionTokenResponse(value) || value.sessionId !== input.sessionId) {
      throw new Error("Cloudflare session creation response was invalid.");
    }
    return {
      ...value,
      refreshToken: `mrs1.${input.sessionId}.${input.refreshSecret}`,
      revokeToken: `mrv1.${input.sessionId}.${input.revokeSecret}`,
    };
  } catch (error) {
    if (!creation) {
      await revokeToolSession(
        baseUrl,
        `mrv1.${input.sessionId}.${input.revokeSecret}`,
        fetcher,
      );
    }
    throw error;
  }
}

export async function refreshToolSession(
  baseUrl: string,
  session: Pick<ToolSession, "uid" | "sessionId" | "refreshToken">,
  fetcher: typeof fetch,
): Promise<SessionTokenResponse> {
  const value = await sessionRequest(
    baseUrl,
    "refresh",
    fetcher,
    session.refreshToken,
  );
  if (
    !isSessionTokenResponse(value) ||
    value.uid !== session.uid ||
    value.sessionId !== session.sessionId
  ) {
    throw new Error("Cloudflare refresh identity did not match.");
  }
  return value;
}

export async function revokeToolSession(
  baseUrl: string,
  revokeToken: string,
  fetcher: typeof fetch,
): Promise<void> {
  await sessionRequest(baseUrl, "logout", fetcher, revokeToken);
}
