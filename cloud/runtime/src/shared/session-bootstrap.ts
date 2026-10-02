import type { ReadGameBootstrapResponse } from "./game-bootstrap.js";
import type { SessionTokenResponse } from "./session-auth.js";
import type { EventSnapshotSeed } from "./events.js";
import type { ProfileLookupResponse } from "./profiles.js";
import { normalizeRecordKey } from "./ids.js";
import {
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isReadGameBootstrapResponse,
} from "./game-bootstrap.js";
import { selectInviteMatch } from "./rematches.js";
import { isProfileLookupResponse } from "./profiles.js";
import {
  isEventSnapshotSeed,
  MAX_EVENT_READ_RESPONSE_BYTES,
} from "./events.js";

export type SessionIdentityBootstrap =
  ProfileLookupResponse | { ok: false; status: 409 | 503 };

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

const SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES: number =
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES + 16_384;
const SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS = 25_000;
const SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES: number =
  MAX_EVENT_READ_RESPONSE_BYTES + 16_384;
const SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES = 65_536;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

function isSessionBootstrapTarget(
  value: unknown,
): value is SessionBootstrapTarget {
  return (
    record(value) &&
    exactKeys(value, ["inviteId", "selection"]) &&
    typeof value.inviteId === "string" &&
    normalizeRecordKey(value.inviteId) === value.inviteId &&
    (value.selection === "current" || value.selection === "approved")
  );
}

function isSessionBootstrapFailure(
  value: unknown,
): value is SessionBootstrapFailure {
  return (
    record(value) &&
    exactKeys(
      value,
      Object.hasOwn(value, "retryAfterMs")
        ? ["ok", "status", "retryAfterMs"]
        : ["ok", "status"],
    ) &&
    value.ok === false &&
    ([403, 404, 409, 429, 503] as readonly unknown[]).includes(value.status) &&
    (!Object.hasOwn(value, "retryAfterMs") ||
      (Number.isSafeInteger(value.retryAfterMs) &&
        (value.retryAfterMs as number) >= 0))
  );
}

function isSessionBootstrap(value: unknown): value is SessionBootstrap {
  if (
    !record(value) ||
    !exactKeys(value, ["inviteId", "selection", "result"]) ||
    !isSessionBootstrapTarget({
      inviteId: value.inviteId,
      selection: value.selection,
    })
  )
    return false;
  if (isSessionBootstrapFailure(value.result)) return true;
  if (
    !isReadGameBootstrapResponse(value.result) ||
    value.result.metadata.inviteId !== value.inviteId
  )
    return false;
  const selected = selectInviteMatch(
    value.inviteId,
    value.result.metadata,
    value.result.viewer.actorUid,
    { preferApproved: value.selection === "approved" },
  );
  return (
    selected.matchId === value.result.match.matchId &&
    selected.hasPendingProposal === value.result.hasPendingProposal
  );
}

function isSessionIdentityBootstrap(
  value: unknown,
): value is SessionIdentityBootstrap {
  return (
    isProfileLookupResponse(value) ||
    (record(value) &&
      exactKeys(value, ["ok", "status"]) &&
      value.ok === false &&
      ([409, 503] as readonly unknown[]).includes(value.status))
  );
}

function isSessionEventBootstrapTarget(
  value: unknown,
): value is SessionEventBootstrapTarget {
  return (
    record(value) &&
    exactKeys(value, ["eventId"]) &&
    typeof value.eventId === "string" &&
    normalizeRecordKey(value.eventId) === value.eventId
  );
}

function isSessionEventBootstrap(
  value: unknown,
): value is SessionEventBootstrap {
  return (
    record(value) &&
    exactKeys(value, ["eventId", "result"]) &&
    isSessionEventBootstrapTarget({ eventId: value.eventId }) &&
    (isSessionBootstrapFailure(value.result) ||
      (isEventSnapshotSeed(value.result) &&
        value.result.snapshot.eventId === value.eventId))
  );
}

export {
  SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES,
  SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES,
  SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isSessionIdentityBootstrap,
  isSessionBootstrapTarget,
  isSessionBootstrapFailure,
  isSessionBootstrap,
  isSessionEventBootstrapTarget,
  isSessionEventBootstrap,
};
