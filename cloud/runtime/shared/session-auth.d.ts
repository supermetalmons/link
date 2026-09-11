export const SESSION_ACCESS_TOKEN_TTL_SECONDS: 300;
export const SESSION_ANONYMOUS_PATH: "/auth/session/anonymous";
export const SESSION_REFRESH_PATH: "/auth/session/refresh";
export const SESSION_LOGOUT_PATH: "/auth/session/logout";
export const SESSION_PATHS: readonly string[];

export type SessionCreateRequest = {
  sessionId: string;
  refreshSecret: string;
  revokeSecret: string;
};

export type SessionTokenResponse = {
  ok: true;
  uid: string;
  sessionId: string;
  accessToken: string;
  accessExpiresAtMs: number;
};

export type SessionCapability = { sessionId: string; secret: string };

export function isSessionId(value: unknown): value is string;
export function isSessionSecret(value: unknown): value is string;
export function isSessionCreateRequest(
  value: unknown,
): value is SessionCreateRequest;
export function isSessionTokenResponse(
  value: unknown,
): value is SessionTokenResponse;
export function buildSessionRefreshToken(
  sessionId: string,
  secret: string,
): string;
export function buildSessionRevokeToken(
  sessionId: string,
  secret: string,
): string;
export function parseSessionCapability(
  value: unknown,
  kind: "refresh" | "revoke",
): SessionCapability | null;
