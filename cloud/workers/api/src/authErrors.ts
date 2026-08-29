export type AuthErrorCode =
  | "aborted"
  | "deadline-exceeded"
  | "failed-precondition"
  | "internal"
  | "invalid-argument"
  | "method-not-allowed"
  | "not-found"
  | "permission-denied"
  | "resource-exhausted"
  | "unauthenticated"
  | "unavailable";

export const PROFILE_WRITES_RETRY_AFTER_SECONDS = 60;

export class AuthApiFailure extends Error {
  readonly code: AuthErrorCode;
  readonly details?: unknown;
  readonly status: number;

  constructor(
    status: number,
    code: AuthErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ProfileWritesDisabledFailure extends AuthApiFailure {
  readonly profileWritesDisabled = true;

  constructor() {
    super(503, "unavailable", "profile-writes-disabled");
  }
}

export function isProfileWritesDisabledFailure(
  error: unknown,
): error is ProfileWritesDisabledFailure {
  return error instanceof ProfileWritesDisabledFailure;
}

export function authErrorResponse(
  error: AuthApiFailure,
  headers: HeadersInit,
): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }),
    {
      status: error.status,
      headers: {
        ...headers,
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        ...(error instanceof ProfileWritesDisabledFailure
          ? {
              "Retry-After": String(PROFILE_WRITES_RETRY_AFTER_SECONDS),
            }
          : {}),
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export function toAuthApiFailure(error: unknown): AuthApiFailure {
  return error instanceof AuthApiFailure
    ? error
    : new AuthApiFailure(503, "unavailable", "auth-service-unavailable");
}
