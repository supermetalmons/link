import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import { PROFILE_GAME_PROJECTION_SCHEMA_VERSION } from "./profileGameProjectionTasks.ts";

export const AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT =
  "profileGameProjectionOutbox/automatch";
export const AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_ROOT =
  "profileGameProjectionLocks/automatch";
export const EVENT_PROFILE_GAME_PROJECTION_OUTBOX_ROOT =
  "profileGameProjectionOutbox/event";
export const EVENT_PROFILE_GAME_PROJECTION_LOCK_ROOT =
  "profileGameProjectionLocks/event";
export const PROFILE_LINK_PROFILE_GAME_PROJECTION_OUTBOX_ROOT =
  "profileGameProjectionOutbox/profile";
export const PROFILE_LINK_PROFILE_GAME_PROJECTION_LOCK_ROOT =
  "profileGameProjectionLocks/profile";

export type AutomatchProfileGameProjectionOutbox = {
  lastQueuedAtMs: number;
  reason: string;
  requestId: string;
  schemaVersion: number;
  sourceUpdatedAtMs: number;
  status: "pending";
};

export type EventProfileGameProjectionOutbox = {
  cleanupOwnerProfileIds: string[];
  lastQueuedAtMs: number;
  requestId: string;
  schemaVersion: number;
  status: "pending";
};

export type ProfileLinkProfileGameProjectionOutbox = {
  cleanupProfileIds: string[];
  lastQueuedAtMs: number;
  matchCursor: string | null;
  profileId: string;
  requestId: string;
  schemaVersion: number;
  sourceUpdatedAtMs: number;
  status: "pending";
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function getAutomatchProfileGameProjectionOutboxPath(
  inviteId: string,
): string {
  return `${AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT}/${inviteId}`;
}

export function getAutomatchProfileGameProjectionLockPath(
  inviteId: string,
): string {
  return `${AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_ROOT}/${inviteId}`;
}

export function getEventProfileGameProjectionOutboxPath(
  eventId: string,
): string {
  return `${EVENT_PROFILE_GAME_PROJECTION_OUTBOX_ROOT}/${eventId}`;
}

export function getEventProfileGameProjectionLockPath(eventId: string): string {
  return `${EVENT_PROFILE_GAME_PROJECTION_LOCK_ROOT}/${eventId}`;
}

export function getProfileLinkProfileGameProjectionOutboxPath(
  loginUid: string,
): string {
  return `${PROFILE_LINK_PROFILE_GAME_PROJECTION_OUTBOX_ROOT}/${loginUid}`;
}

export function getProfileLinkProfileGameProjectionLockPath(
  loginUid: string,
): string {
  return `${PROFILE_LINK_PROFILE_GAME_PROJECTION_LOCK_ROOT}/${loginUid}`;
}

export function buildAutomatchProfileGameProjectionOutboxUpdates(input: {
  inviteId: string;
  reason?: string;
  requestId: string;
  timestamp: unknown;
}): Record<string, unknown> {
  return {
    [getAutomatchProfileGameProjectionOutboxPath(input.inviteId)]: {
      schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
      status: "pending",
      requestId: input.requestId,
      reason:
        typeof input.reason === "string" && input.reason.trim()
          ? input.reason.trim()
          : "automatch-queue",
      sourceUpdatedAtMs: input.timestamp,
      lastQueuedAtMs: input.timestamp,
    },
  };
}

export function buildEventProfileGameProjectionOutboxUpdates(input: {
  cleanupOwnerProfileIds: string[];
  eventId: string;
  requestId: string;
  timestamp: number;
}): Record<string, unknown> {
  if (
    !isSafeFirebaseKey(input.eventId) ||
    !isSafeFirebaseKey(input.requestId) ||
    !Number.isSafeInteger(input.timestamp) ||
    input.timestamp < 0
  ) {
    throw new TypeError("invalid event profile-game projection outbox input");
  }
  const outboxPath = getEventProfileGameProjectionOutboxPath(input.eventId);
  const updates: Record<string, unknown> = {
    [`${outboxPath}/schemaVersion`]: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
    [`${outboxPath}/status`]: "pending",
    [`${outboxPath}/requestId`]: input.requestId,
    [`${outboxPath}/lastQueuedAtMs`]: input.timestamp,
    [`${outboxPath}/reason`]: null,
    [`${outboxPath}/deadAtMs`]: null,
  };
  for (const profileId of new Set(input.cleanupOwnerProfileIds)) {
    if (!isSafeFirebaseKey(profileId)) {
      throw new TypeError("invalid event projection cleanup profile id");
    }
    updates[`${outboxPath}/cleanupOwnerProfileIds/${profileId}`] = true;
  }
  return updates;
}

export function buildProfileLinkProfileGameProjectionOutbox(input: {
  cleanupProfileIds: string[];
  lastQueuedAtMs: number;
  matchCursor?: string | null;
  profileId: string;
  requestId: string;
  sourceUpdatedAtMs: number;
}): Record<string, unknown> {
  if (
    !isSafeFirebaseKey(input.profileId) ||
    !isSafeFirebaseKey(input.requestId) ||
    !Number.isSafeInteger(input.lastQueuedAtMs) ||
    input.lastQueuedAtMs < 0 ||
    (input.matchCursor != null && !isSafeFirebaseKey(input.matchCursor)) ||
    !Number.isSafeInteger(input.sourceUpdatedAtMs) ||
    input.sourceUpdatedAtMs < 0
  ) {
    throw new TypeError("invalid profile link projection outbox input");
  }
  const cleanupProfileIds = Array.from(new Set(input.cleanupProfileIds));
  if (cleanupProfileIds.some((profileId) => !isSafeFirebaseKey(profileId))) {
    throw new TypeError("invalid profile link projection cleanup profile id");
  }
  return {
    schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
    status: "pending",
    requestId: input.requestId,
    profileId: input.profileId,
    cleanupProfileIds: Object.fromEntries(
      cleanupProfileIds.map((profileId) => [profileId, true]),
    ),
    matchCursor: input.matchCursor ?? null,
    sourceUpdatedAtMs: input.sourceUpdatedAtMs,
    lastQueuedAtMs: input.lastQueuedAtMs,
  };
}

export function parseAutomatchProfileGameProjectionOutbox(
  value: unknown,
): AutomatchProfileGameProjectionOutbox | null {
  const record = toRecord(value);
  const sourceUpdatedAtMs = record?.sourceUpdatedAtMs;
  const lastQueuedAtMs = record?.lastQueuedAtMs;
  const reason =
    typeof record?.reason === "string" && record.reason.trim()
      ? record.reason.trim()
      : "automatch-queue";
  return record?.schemaVersion === PROFILE_GAME_PROJECTION_SCHEMA_VERSION &&
    record.status === "pending" &&
    typeof record.requestId === "string" &&
    isSafeFirebaseKey(record.requestId) &&
    typeof sourceUpdatedAtMs === "number" &&
    Number.isFinite(sourceUpdatedAtMs) &&
    sourceUpdatedAtMs >= 0 &&
    typeof lastQueuedAtMs === "number" &&
    Number.isFinite(lastQueuedAtMs) &&
    lastQueuedAtMs >= 0
    ? {
        schemaVersion: record.schemaVersion,
        status: record.status,
        requestId: record.requestId,
        reason,
        sourceUpdatedAtMs: Math.floor(sourceUpdatedAtMs),
        lastQueuedAtMs: Math.floor(lastQueuedAtMs),
      }
    : null;
}

export function parseEventProfileGameProjectionOutbox(
  value: unknown,
): EventProfileGameProjectionOutbox | null {
  const record = toRecord(value);
  const cleanup =
    record?.cleanupOwnerProfileIds === undefined
      ? {}
      : toRecord(record.cleanupOwnerProfileIds);
  const cleanupEntries = cleanup ? Object.entries(cleanup) : [];
  const lastQueuedAtMs = record?.lastQueuedAtMs;
  return record?.schemaVersion === PROFILE_GAME_PROJECTION_SCHEMA_VERSION &&
    record.status === "pending" &&
    typeof record.requestId === "string" &&
    isSafeFirebaseKey(record.requestId) &&
    typeof lastQueuedAtMs === "number" &&
    Number.isSafeInteger(lastQueuedAtMs) &&
    lastQueuedAtMs >= 0 &&
    cleanup !== null &&
    cleanupEntries.every(
      ([profileId, included]) =>
        isSafeFirebaseKey(profileId) && included === true,
    )
    ? {
        schemaVersion: record.schemaVersion,
        status: record.status,
        requestId: record.requestId,
        lastQueuedAtMs,
        cleanupOwnerProfileIds: cleanupEntries.map(([profileId]) => profileId),
      }
    : null;
}

export function parseProfileLinkProfileGameProjectionOutbox(
  value: unknown,
): ProfileLinkProfileGameProjectionOutbox | null {
  const record = toRecord(value);
  const cleanup =
    record?.cleanupProfileIds === undefined
      ? {}
      : toRecord(record.cleanupProfileIds);
  const cleanupEntries = cleanup ? Object.entries(cleanup) : [];
  const sourceUpdatedAtMs = record?.sourceUpdatedAtMs;
  const lastQueuedAtMs = record?.lastQueuedAtMs;
  const matchCursor = record?.matchCursor ?? null;
  return record?.schemaVersion === PROFILE_GAME_PROJECTION_SCHEMA_VERSION &&
    record.status === "pending" &&
    typeof record.requestId === "string" &&
    isSafeFirebaseKey(record.requestId) &&
    typeof record.profileId === "string" &&
    isSafeFirebaseKey(record.profileId) &&
    (matchCursor === null ||
      (typeof matchCursor === "string" && isSafeFirebaseKey(matchCursor))) &&
    cleanup !== null &&
    cleanupEntries.every(
      ([profileId, included]) =>
        isSafeFirebaseKey(profileId) && included === true,
    ) &&
    typeof sourceUpdatedAtMs === "number" &&
    Number.isSafeInteger(sourceUpdatedAtMs) &&
    sourceUpdatedAtMs >= 0 &&
    typeof lastQueuedAtMs === "number" &&
    Number.isSafeInteger(lastQueuedAtMs) &&
    lastQueuedAtMs >= 0
    ? {
        schemaVersion: record.schemaVersion,
        status: record.status,
        requestId: record.requestId,
        profileId: record.profileId,
        cleanupProfileIds: cleanupEntries.map(([profileId]) => profileId),
        matchCursor,
        sourceUpdatedAtMs,
        lastQueuedAtMs,
      }
    : null;
}
