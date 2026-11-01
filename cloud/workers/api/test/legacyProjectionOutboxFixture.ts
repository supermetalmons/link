import { isSafeRecordKey } from "../src/recordKeys.ts";
import {
  AUTOMATCH_PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
  PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
} from "../src/profileGameProjectionTasks.ts";
import type { HistoricalMatchDescriptor } from "../src/historicalMatches.ts";
export * from "../src/profileGameProjectionOutbox.ts";

export const AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT =
  "profileGameProjectionOutbox/automatch";
export const EVENT_PROFILE_GAME_PROJECTION_OUTBOX_ROOT =
  "profileGameProjectionOutbox/event";
export const EVENT_PROFILE_GAME_PROJECTION_LOCK_ROOT =
  "profileGameProjectionLocks/event";

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
      schemaVersion: AUTOMATCH_PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
      historicalMatches: {},
      archiveRetry: null,
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
    [`${outboxPath}/schemaVersion`]:
      AUTOMATCH_PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
    [`${outboxPath}/archiveRetry`]: null,
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
      retryNotBeforeMs: descriptor.retryNotBeforeMs ?? null,
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
    !isSafeRecordKey(input.eventId) ||
    !isSafeRecordKey(input.requestId) ||
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
    if (!isSafeRecordKey(profileId)) {
      throw new TypeError("invalid event projection cleanup profile id");
    }
    updates[`${outboxPath}/cleanupOwnerProfileIds/${profileId}`] = true;
  }
  return updates;
}
