import {
  isAuthVerificationResponse,
  isLinkedAuthMethodsResponse,
  isAuthIntentResponse,
  type AppleAuthVerificationRequest,
  type AuthMethodUnlinkRequest,
  type AuthVerificationResponse,
  type AuthIntentResponse,
  type AuthMethodKey,
  type EthereumAuthVerificationRequest,
  type LinkedAuthMethodsResponse,
  type SolanaAuthVerificationRequest,
  type XAuthCompletionRequest,
} from "@mons/shared/auth";
import {
  isXRedirectStartResponse,
  type XRedirectStartRequest,
  type XRedirectStartResponse,
} from "@mons/shared/x-redirect";

const AUTH_API_ROOT = "https://api.mons.link";
const AUTH_API_TIMEOUT_MS = 15_000;
const PROFILE_CLAIM_SYNC_TIMEOUT_MS = 30_000;
const AUTH_MUTATION_TIMEOUT_MS = 60_000;
const AUTH_API_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type AuthTokenProvider = ((forceRefresh: boolean) => Promise<string>) & {
  readonly assertCurrentUser?: () => void;
};

export type AuthSessionBoundResult<T> = {
  readonly read: () => T;
};

type AuthTokenUser = {
  readonly uid: string;
  getIdToken(forceRefresh?: boolean): Promise<string>;
};

type AuthMutationRequest =
  | AppleAuthVerificationRequest
  | AuthMethodUnlinkRequest
  | EthereumAuthVerificationRequest
  | SolanaAuthVerificationRequest
  | XAuthCompletionRequest;

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

export function createUserBoundAuthTokenProvider(
  user: AuthTokenUser,
  getCurrentUser: () => AuthTokenUser | null,
): AuthTokenProvider & { readonly assertCurrentUser: () => void } {
  const uid = user.uid;
  const assertCurrentUser = (): void => {
    const currentUser = getCurrentUser();
    if (currentUser !== user || currentUser.uid !== uid) {
      throw new AuthApiError("unauthenticated", "authentication-changed");
    }
  };
  return Object.assign(
    async (forceRefresh: boolean) => {
      assertCurrentUser();
      const token = await user.getIdToken(forceRefresh);
      assertCurrentUser();
      return token;
    },
    { assertCurrentUser },
  );
}

export function bindAuthSessionResult<T>(
  value: T,
  assertCurrentUser: () => void,
): AuthSessionBoundResult<T> {
  return {
    read: () => {
      assertCurrentUser();
      return value;
    },
  };
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
  timeoutMs = AUTH_API_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new AuthApiError("unavailable", "Auth request timed out."));
    }, timeoutMs);
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
        tokenProvider.assertCurrentUser?.();
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
        tokenProvider.assertCurrentUser?.();
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

function authMutationRequest<T>(
  path: string,
  request: AuthMutationRequest,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
): Promise<T> {
  return authRequest(
    path,
    { method: "POST", body: JSON.stringify(request) },
    tokenProvider,
    validate,
    AUTH_MUTATION_TIMEOUT_MS,
  );
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

export function syncProfileClaimViaApi(
  tokenProvider: AuthTokenProvider,
): Promise<LinkedAuthMethodsResponse> {
  return authRequest(
    "/auth/profile-claim/sync",
    { method: "POST", body: JSON.stringify({}) },
    tokenProvider,
    isLinkedAuthMethodsResponse,
    PROFILE_CLAIM_SYNC_TIMEOUT_MS,
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

export function verifySolanaAddressViaApi(
  request: SolanaAuthVerificationRequest,
  tokenProvider: AuthTokenProvider,
): Promise<AuthVerificationResponse> {
  return authMutationRequest(
    "/auth/methods/sol/verify",
    request,
    tokenProvider,
    isAuthVerificationResponse,
  );
}

export function verifyEthereumAddressViaApi(
  request: EthereumAuthVerificationRequest,
  tokenProvider: AuthTokenProvider,
): Promise<AuthVerificationResponse> {
  return authMutationRequest(
    "/auth/methods/eth/verify",
    request,
    tokenProvider,
    isAuthVerificationResponse,
  );
}

export function verifyAppleTokenViaApi(
  request: AppleAuthVerificationRequest,
  tokenProvider: AuthTokenProvider,
): Promise<AuthVerificationResponse> {
  return authMutationRequest(
    "/auth/methods/apple/verify",
    request,
    tokenProvider,
    isAuthVerificationResponse,
  );
}

export function completeXRedirectAuthViaApi(
  request: XAuthCompletionRequest,
  tokenProvider: AuthTokenProvider,
): Promise<AuthVerificationResponse> {
  return authMutationRequest(
    "/auth/x/flows/complete",
    request,
    tokenProvider,
    isAuthVerificationResponse,
  );
}

export function unlinkAuthMethodViaApi(
  method: AuthMethodKey,
  tokenProvider: AuthTokenProvider,
): Promise<LinkedAuthMethodsResponse> {
  const request: AuthMethodUnlinkRequest = {
    method,
    opId: crypto.randomUUID(),
  };
  return authMutationRequest(
    "/auth/methods/unlink",
    request,
    tokenProvider,
    isLinkedAuthMethodsResponse,
  );
}
