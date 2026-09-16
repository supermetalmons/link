import type { ReadGameBootstrapResponse } from "./game-bootstrap";
import type { SessionTokenResponse } from "./session-auth";
import type { EventSnapshotSeed } from "./events";
import type { ProfileLookupResponse } from "./profiles";

export type SessionIdentityBootstrap =
  ProfileLookupResponse | { ok: false; status: 409 | 503 };

export const SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES: 65536;
export function isSessionIdentityBootstrap(
  value: unknown,
): value is SessionIdentityBootstrap;

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
export type SessionEventBootstrapTarget = { eventId: string };
export type SessionEventBootstrap = SessionEventBootstrapTarget & {
  result: EventSnapshotSeed | SessionBootstrapFailure;
};
export type SessionEventBootstrapResponse = SessionTokenResponse & {
  eventBootstrap: SessionEventBootstrap;
  identityBootstrap?: SessionIdentityBootstrap;
};

export const SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES: number;
export const SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS: 25000;
export const SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES: number;
export function isSessionEventBootstrapTarget(
  value: unknown,
): value is SessionEventBootstrapTarget;
export function isSessionEventBootstrap(
  value: unknown,
): value is SessionEventBootstrap;
export function isSessionEventBootstrapResponse(
  value: unknown,
): value is SessionEventBootstrapResponse;
export function isSessionBootstrapTarget(
  value: unknown,
): value is SessionBootstrapTarget;
export function isSessionBootstrapFailure(
  value: unknown,
): value is SessionBootstrapFailure;
export function isSessionBootstrap(value: unknown): value is SessionBootstrap;
export function isSessionBootstrapResponse(
  value: unknown,
): value is SessionBootstrapResponse;
