// Generated from src/shared/session-bootstrap.ts. Run npm run generate:runtime.
import type { ReadGameBootstrapResponse } from "./game-bootstrap.js";
import type { SessionTokenResponse } from "./session-auth.js";
import type { EventSnapshotSeed } from "./events.js";
import type { ProfileLookupResponse } from "./profiles.js";
export type SessionIdentityBootstrap =
  | ProfileLookupResponse
  | {
      ok: false;
      status: 409 | 503;
    };
export type SessionBootstrapTarget = {
  inviteId: string;
  selection: "current" | "approved";
};
export type SessionBootstrapFailure = {
  ok: false;
  status: 403 | 404 | 409 | 429 | 503;
  retryAfterMs?: number;
};
export type SessionBootstrapResult =
  ReadGameBootstrapResponse | SessionBootstrapFailure;
export type SessionBootstrap = SessionBootstrapTarget & {
  result: SessionBootstrapResult;
};
export type SessionBootstrapResponse = SessionTokenResponse & {
  gameBootstrap: SessionBootstrap;
  identityBootstrap?: SessionIdentityBootstrap;
};
export type SessionEventBootstrapTarget = {
  eventId: string;
};
export type SessionEventBootstrap = SessionEventBootstrapTarget & {
  result: EventSnapshotSeed | SessionBootstrapFailure;
};
export type SessionEventBootstrapResponse = SessionTokenResponse & {
  eventBootstrap: SessionEventBootstrap;
  identityBootstrap?: SessionIdentityBootstrap;
};
declare const SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES: number;
declare const SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS = 25000;
declare const SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES: number;
declare const SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES = 65536;
declare function isSessionBootstrapTarget(
  value: unknown,
): value is SessionBootstrapTarget;
declare function isSessionBootstrapFailure(
  value: unknown,
): value is SessionBootstrapFailure;
declare function isSessionBootstrap(value: unknown): value is SessionBootstrap;
declare function isSessionBootstrapResponse(
  value: unknown,
): value is SessionBootstrapResponse;
declare function isSessionIdentityBootstrap(
  value: unknown,
): value is SessionIdentityBootstrap;
declare function isSessionEventBootstrapTarget(
  value: unknown,
): value is SessionEventBootstrapTarget;
declare function isSessionEventBootstrap(
  value: unknown,
): value is SessionEventBootstrap;
declare function isSessionEventBootstrapResponse(
  value: unknown,
): value is SessionEventBootstrapResponse;
export {
  SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES,
  SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES,
  SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isSessionIdentityBootstrap,
  isSessionBootstrapTarget,
  isSessionBootstrapFailure,
  isSessionBootstrap,
  isSessionBootstrapResponse,
  isSessionEventBootstrapTarget,
  isSessionEventBootstrap,
  isSessionEventBootstrapResponse,
};
