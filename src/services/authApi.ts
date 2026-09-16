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
import {
  isProfileLookupResponse,
  type ProfileLookupResponse,
} from "@mons/shared/profiles";

import {
  authenticatedJsonRequest,
  type ApiErrorPolicy,
  type AuthTokenProvider,
} from "./apiTransport";

export type { AuthTokenProvider } from "./apiTransport";

const AUTH_API_ROOT = "https://api.mons.link";
const AUTH_API_TIMEOUT_MS = 15_000;
const PROFILE_SYNC_TIMEOUT_MS = 30_000;
const AUTH_MUTATION_TIMEOUT_MS = 60_000;
const AUTH_API_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AuthApiError";
    this.code = code;
    this.details = details;
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

const authErrorPolicy: ApiErrorPolicy = {
  createError: (code, message, details) =>
    new AuthApiError(code, message, details),
  normalizeError: (error) =>
    error instanceof AuthApiError ? error : undefined,
  unavailableMessage: "Auth service is unavailable.",
  timeoutMessage: "Auth request timed out.",
};

async function authRequest<T>(
  path: string,
  init: Omit<RequestInit, "cache" | "headers" | "signal">,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
  timeoutMs = AUTH_API_TIMEOUT_MS,
  maxResponseBytes = AUTH_API_MAX_RESPONSE_BYTES,
): Promise<T> {
  return authenticatedJsonRequest({
    url: `${AUTH_API_ROOT}${path}`,
    createRequestInit: () => init,
    tokenProvider,
    validate,
    timeoutMs,
    maxResponseBytes,
    assertCurrentUser: () => tokenProvider.assertCurrentUser?.(),
    errors: authErrorPolicy,
  });
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

export function syncProfileViaApi(
  tokenProvider: AuthTokenProvider,
): Promise<LinkedAuthMethodsResponse> {
  return authRequest(
    "/auth/profile/sync",
    { method: "POST", body: JSON.stringify({}) },
    tokenProvider,
    isLinkedAuthMethodsResponse,
    PROFILE_SYNC_TIMEOUT_MS,
  );
}

export function getIdentityViaApi(
  tokenProvider: AuthTokenProvider,
): Promise<ProfileLookupResponse> {
  return authRequest(
    "/auth/identity",
    { method: "GET" },
    tokenProvider,
    isProfileLookupResponse,
    AUTH_API_TIMEOUT_MS,
    4 * 1024 * 1024,
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
