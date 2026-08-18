import {
  isAuthIntentResponse,
  isLinkedAuthMethodsResponse,
  type AuthIntentResponse,
  type AuthMethodKey,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import {
  isXRedirectStartResponse,
  type XRedirectStartRequest,
  type XRedirectStartResponse,
} from "@mons/shared/x-redirect";

const AUTH_API_ROOT = "https://api.mons.link";
const AUTH_API_TIMEOUT_MS = 15_000;
const AUTH_API_MAX_RESPONSE_BYTES = 64 * 1024;

export type AuthTokenProvider = (forceRefresh: boolean) => Promise<string>;

export class AuthApiError extends Error {
  readonly code: string;
  readonly customData?: { details: unknown };
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AuthApiError";
    this.code = code;
    this.details = details;
    if (details !== undefined) {
      this.customData = { details };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > AUTH_API_MAX_RESPONSE_BYTES
  ) {
    cancelBody(response);
    throw new AuthApiError("unavailable", "Auth service is unavailable.");
  }
  if (!response.body) {
    throw new AuthApiError("unavailable", "Auth service is unavailable.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > AUTH_API_MAX_RESPONSE_BYTES) {
        throw new Error("oversized-response");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join("")) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new AuthApiError("unavailable", "Auth service is unavailable.");
  }
}

function apiError(payload: unknown, status: number): AuthApiError {
  const value = isRecord(payload) ? payload : {};
  const code =
    typeof value.error === "string" && value.error.trim()
      ? value.error.trim()
      : status === 401
        ? "unauthenticated"
        : "unavailable";
  const message =
    typeof value.message === "string" && value.message.trim()
      ? value.message.trim()
      : "Auth service is unavailable.";
  return new AuthApiError(code, message, value.details);
}

async function authRequest<T>(
  path: string,
  init: Omit<RequestInit, "cache" | "headers" | "signal">,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new AuthApiError("unavailable", "Auth request timed out."));
    }, AUTH_API_TIMEOUT_MS);
  });
  const run = async (): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await tokenProvider(attempt === 1);
        if (controller.signal.aborted) {
          throw new AuthApiError("unavailable", "Auth request timed out.");
        }
        const headers = new Headers({
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        });
        if (init.body !== undefined) {
          headers.set("Content-Type", "application/json");
        }
        const response = await fetch(`${AUTH_API_ROOT}${path}`, {
          ...init,
          headers,
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401 && attempt === 0) {
          cancelBody(response);
          continue;
        }
        const payload = await readBoundedJson(response);
        if (!response.ok) {
          throw apiError(payload, response.status);
        }
        if (!validate(payload)) {
          throw new AuthApiError("unavailable", "Auth service is unavailable.");
        }
        return payload;
      } catch (error) {
        if (error instanceof AuthApiError) {
          throw error;
        }
        throw new AuthApiError("unavailable", "Auth service is unavailable.");
      }
    }
    throw new AuthApiError("unauthenticated", "authentication-required");
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export function beginAuthIntentViaApi(
  method: AuthMethodKey,
  tokenProvider: AuthTokenProvider,
): Promise<AuthIntentResponse> {
  return authRequest(
    "/auth/intents",
    { method: "POST", body: JSON.stringify({ method }) },
    tokenProvider,
    isAuthIntentResponse,
  );
}

export function getLinkedAuthMethodsViaApi(
  tokenProvider: AuthTokenProvider,
): Promise<LinkedAuthMethodsResponse> {
  return authRequest(
    "/auth/methods",
    { method: "GET" },
    tokenProvider,
    isLinkedAuthMethodsResponse,
  );
}

export function beginXRedirectAuthViaApi(
  request: XRedirectStartRequest,
  tokenProvider: AuthTokenProvider,
): Promise<XRedirectStartResponse> {
  return authRequest(
    "/auth/x/flows",
    { method: "POST", body: JSON.stringify(request) },
    tokenProvider,
    isXRedirectStartResponse,
  );
}
