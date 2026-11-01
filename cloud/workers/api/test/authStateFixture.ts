import {
  parseAuthIntent,
  parseXRedirectFlow,
  type AuthIntentRecord,
  type XRedirectFlow,
} from "../src/authStateRecords.ts";

export function authIntentFixture(
  overrides: Record<string, unknown> = {},
): AuthIntentRecord {
  const createdAtMs =
    typeof overrides.createdAtMs === "number"
      ? overrides.createdAtMs
      : 1_000_000;
  return parseAuthIntent({
    dataEpoch: 1,
    status: "created",
    consumedAtMs: null,
    consumedByOpId: null,
    cancelledAtMs: null,
    createdAtMs,
    expiresAtMs: createdAtMs + 1_000_000,
    intentId: "abcdefghijklmnopqrstuvwx",
    method: "x",
    nonce: "nonce",
    state: "state",
    uid: "login-uid",
    ...overrides,
  });
}

export function xFlowFixture(
  overrides: Record<string, unknown> = {},
): XRedirectFlow {
  const status = overrides.status ?? "created";
  const createdAtMs =
    typeof overrides.createdAtMs === "number" ? overrides.createdAtMs : 900_000;
  const activeAtMs = Math.max(
    createdAtMs,
    typeof overrides.processingStartedAtMs === "number"
      ? overrides.processingStartedAtMs
      : createdAtMs,
  );
  const identity = status === "verified" || status === "completed";
  return parseXRedirectFlow({
    dataEpoch: 1,
    callbackUri: "https://api.mons.link/auth/x/callback",
    codeChallenge: "challenge",
    codeVerifier: "verifier",
    completedAtMs: status === "completed" ? createdAtMs : null,
    consentSource: "settings",
    createdAtMs,
    errorCode:
      status === "failed"
        ? "x-oauth-access-denied"
        : status === "cancelled"
          ? "application-data-reset"
          : null,
    expiresAtMs: createdAtMs + 600_000,
    flowId: "abcdefghijklmnopqrstuvwx",
    intentId: "abcdefghijklmnopqrstuvwx",
    method: "x",
    processingStartedAtMs: status === "processing" ? activeAtMs : null,
    result:
      status === "completed" ? { profileId: "profile-a", opId: "op-a" } : null,
    returnUrl: "https://mons.link/settings?tab=identity",
    revision: 1,
    status,
    uid: "login-uid",
    updatedAtMs: activeAtMs,
    xUserId: identity ? "2244994945" : null,
    xUsername: identity ? "mons" : null,
    ...overrides,
  });
}
