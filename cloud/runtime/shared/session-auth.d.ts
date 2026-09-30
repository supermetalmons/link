// Generated from src/shared/session-auth.ts. Run npm run generate:runtime.
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
export type SessionCapability = {
  sessionId: string;
  secret: string;
};
declare const SESSION_ACCESS_TOKEN_TTL_SECONDS = 300;
declare const SESSION_ANONYMOUS_PATH = "/auth/session/anonymous";
declare const SESSION_REFRESH_PATH = "/auth/session/refresh";
declare const SESSION_LOGOUT_PATH = "/auth/session/logout";
declare const SESSION_PATHS: readonly string[];
declare const isSessionId: (value: unknown) => value is string;
declare const isSessionSecret: (value: unknown) => value is string;
declare function isSessionCreateRequest(
  value: unknown,
): value is SessionCreateRequest;
declare function isSessionTokenResponse(
  value: unknown,
): value is SessionTokenResponse;
declare const buildSessionRefreshToken: (
  sessionId: string,
  secret: string,
) => string;
declare const buildSessionRevokeToken: (
  sessionId: string,
  secret: string,
) => string;
declare function parseSessionCapability(
  value: unknown,
  kind: "refresh" | "revoke",
): SessionCapability | null;
export {
  SESSION_ACCESS_TOKEN_TTL_SECONDS,
  SESSION_ANONYMOUS_PATH,
  SESSION_REFRESH_PATH,
  SESSION_LOGOUT_PATH,
  SESSION_PATHS,
  isSessionId,
  isSessionSecret,
  isSessionCreateRequest,
  isSessionTokenResponse,
  buildSessionRefreshToken,
  buildSessionRevokeToken,
  parseSessionCapability,
};
