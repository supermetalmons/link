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
