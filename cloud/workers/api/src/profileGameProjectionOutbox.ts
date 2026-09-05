import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import { PROFILE_GAME_PROJECTION_SCHEMA_VERSION } from "./profileGameProjectionTasks.ts";
import type { HistoricalMatchDescriptor } from "./historicalMatches.ts";

export const AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT =
  "profileGameProjectionOutbox/automatch";
export const EVENT_PROFILE_GAME_PROJECTION_OUTBOX_ROOT =
  "profileGameProjectionOutbox/event";
export const EVENT_PROFILE_GAME_PROJECTION_LOCK_ROOT =
  "profileGameProjectionLocks/event";

export type AutomatchProfileGameProjectionOutbox = {
  historicalMatches?: HistoricalMatchDescriptor[];
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

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function salvageHistoricalMatchDescriptors(
  value: unknown,
): HistoricalMatchDescriptor[] {
  const entries = Object.entries(
    toRecord(toRecord(value)?.historicalMatches) || {},
  );
  return entries.flatMap(([matchId, raw]) => {
    const record = toRecord(raw);
    const finalizedAtMs = record?.finalizedAtMs;
    const hostPlayerId = record?.hostPlayerId;
    const guestPlayerId = record?.guestPlayerId;
    const source = record?.source;
    return isSafeFirebaseKey(matchId) &&
      typeof hostPlayerId === "string" &&
      isSafeFirebaseKey(hostPlayerId) &&
      typeof guestPlayerId === "string" &&
      isSafeFirebaseKey(guestPlayerId) &&
      guestPlayerId !== hostPlayerId &&
      typeof finalizedAtMs === "number" &&
      Number.isSafeInteger(finalizedAtMs) &&
      finalizedAtMs >= 0 &&
      (source === "rating" || source === "transition" || source === "backfill")
      ? [
          {
            matchId,
            hostPlayerId,
            guestPlayerId,
            finalizedAtMs,
            source,
          },
        ]
      : [];
  });
}

export function getAutomatchProfileGameProjectionOutboxPath(
  inviteId: string,
): string {
  return `${AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT}/${inviteId}`;
}

export function getEventProfileGameProjectionOutboxPath(
  eventId: string,
): string {
  return `${EVENT_PROFILE_GAME_PROJECTION_OUTBOX_ROOT}/${eventId}`;
}

export function getEventProfileGameProjectionLockPath(eventId: string): string {
  return `${EVENT_PROFILE_GAME_PROJECTION_LOCK_ROOT}/${eventId}`;
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

export function buildAutomatchProfileGameProjectionOutboxMergeUpdates(input: {
  historicalMatches?: HistoricalMatchDescriptor[];
  inviteId: string;
  reason?: string;
  requestId: string;
  timestamp: unknown;
}): Record<string, unknown> {
  const outboxPath = getAutomatchProfileGameProjectionOutboxPath(
    input.inviteId,
  );
  const updates: Record<string, unknown> = {
    [`${outboxPath}/schemaVersion`]: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
    [`${outboxPath}/status`]: "pending",
    [`${outboxPath}/requestId`]: input.requestId,
    [`${outboxPath}/reason`]:
      typeof input.reason === "string" && input.reason.trim()
        ? input.reason.trim()
        : "automatch-queue",
    [`${outboxPath}/sourceUpdatedAtMs`]: input.timestamp,
    [`${outboxPath}/lastQueuedAtMs`]: input.timestamp,
  };
  for (const descriptor of input.historicalMatches || []) {
    updates[`${outboxPath}/historicalMatches/${descriptor.matchId}`] = {
      finalizedAtMs: descriptor.finalizedAtMs,
      guestPlayerId: descriptor.guestPlayerId,
      hostPlayerId: descriptor.hostPlayerId,
      source: descriptor.source,
    };
  }
  return updates;
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
  const rawHistoricalMatches =
    record?.historicalMatches === undefined
      ? {}
      : toRecord(record.historicalMatches);
  const historicalMatches = salvageHistoricalMatchDescriptors(record);
  const historicalEntryCount = Object.keys(rawHistoricalMatches || {}).length;
  return record?.schemaVersion === PROFILE_GAME_PROJECTION_SCHEMA_VERSION &&
    record.status === "pending" &&
    typeof record.requestId === "string" &&
    isSafeFirebaseKey(record.requestId) &&
    typeof sourceUpdatedAtMs === "number" &&
    Number.isFinite(sourceUpdatedAtMs) &&
    sourceUpdatedAtMs >= 0 &&
    typeof lastQueuedAtMs === "number" &&
    Number.isFinite(lastQueuedAtMs) &&
    lastQueuedAtMs >= 0 &&
    rawHistoricalMatches !== null &&
    historicalMatches.length === historicalEntryCount
    ? {
        schemaVersion: record.schemaVersion,
        status: record.status,
        requestId: record.requestId,
        reason,
        sourceUpdatedAtMs: Math.floor(sourceUpdatedAtMs),
        lastQueuedAtMs: Math.floor(lastQueuedAtMs),
        ...(historicalMatches.length > 0 ? { historicalMatches } : {}),
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
