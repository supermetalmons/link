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

const SESSION_ACCESS_TOKEN_TTL_SECONDS = 300;
const SESSION_ANONYMOUS_PATH = "/auth/session/anonymous";
const SESSION_REFRESH_PATH = "/auth/session/refresh";
const SESSION_LOGOUT_PATH = "/auth/session/logout";
const SESSION_PATHS: readonly string[] = Object.freeze([
  SESSION_ANONYMOUS_PATH,
  SESSION_REFRESH_PATH,
  SESSION_LOGOUT_PATH,
]);
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
};
const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && SESSION_ID_PATTERN.test(value);
const isSessionSecret = (value: unknown): value is string =>
  typeof value === "string" && SESSION_SECRET_PATTERN.test(value);

function isSessionCreateRequest(value: unknown): value is SessionCreateRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sessionId", "refreshSecret", "revokeSecret"]) &&
    isSessionId(value.sessionId) &&
    isSessionSecret(value.refreshSecret) &&
    isSessionSecret(value.revokeSecret) &&
    value.refreshSecret !== value.revokeSecret
  );
}

function isSessionTokenResponse(value: unknown): value is SessionTokenResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "ok",
      "uid",
      "sessionId",
      "accessToken",
      "accessExpiresAtMs",
    ]) &&
    value.ok === true &&
    typeof value.uid === "string" &&
    /^[A-Za-z0-9]{28}$/.test(value.uid) &&
    isSessionId(value.sessionId) &&
    typeof value.accessToken === "string" &&
    value.accessToken.length <= 2048 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      value.accessToken,
    ) &&
    Number.isSafeInteger(value.accessExpiresAtMs) &&
    (value.accessExpiresAtMs as number) > 0
  );
}

function buildCapability(prefix: string, sessionId: string, secret: string) {
  if (!isSessionId(sessionId) || !isSessionSecret(secret)) {
    throw new TypeError("invalid-session-capability");
  }
  return `${prefix}.${sessionId}.${secret}`;
}

const buildSessionRefreshToken = (sessionId: string, secret: string): string =>
  buildCapability("mrs1", sessionId, secret);
const buildSessionRevokeToken = (sessionId: string, secret: string): string =>
  buildCapability("mrv1", sessionId, secret);

function parseSessionCapability(
  value: unknown,
  kind: "refresh" | "revoke",
): SessionCapability | null {
  if (typeof value !== "string" || value.length !== 85) return null;
  const [prefix, sessionId, secret] = value.split(".");
  if (
    (kind !== "refresh" && kind !== "revoke") ||
    prefix !== (kind === "refresh" ? "mrs1" : "mrv1") ||
    !isSessionId(sessionId) ||
    !isSessionSecret(secret)
  ) {
    return null;
  }
  return { sessionId, secret };
}

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
