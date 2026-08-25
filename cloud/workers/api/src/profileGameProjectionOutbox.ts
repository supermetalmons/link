import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import { PROFILE_GAME_PROJECTION_SCHEMA_VERSION } from "./profileGameProjectionTasks.ts";

export const AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT =
  "profileGameProjectionOutbox/automatch";
export const AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_ROOT =
  "profileGameProjectionLocks/automatch";

export type AutomatchProfileGameProjectionOutbox = {
  lastQueuedAtMs: number;
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

export function buildAutomatchProfileGameProjectionOutboxUpdates(input: {
  inviteId: string;
  requestId: string;
  timestamp: unknown;
}): Record<string, unknown> {
  return {
    [getAutomatchProfileGameProjectionOutboxPath(input.inviteId)]: {
      schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
      status: "pending",
      requestId: input.requestId,
      sourceUpdatedAtMs: input.timestamp,
      lastQueuedAtMs: input.timestamp,
    },
  };
}

export function parseAutomatchProfileGameProjectionOutbox(
  value: unknown,
): AutomatchProfileGameProjectionOutbox | null {
  const record = toRecord(value);
  const sourceUpdatedAtMs = record?.sourceUpdatedAtMs;
  const lastQueuedAtMs = record?.lastQueuedAtMs;
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
        sourceUpdatedAtMs: Math.floor(sourceUpdatedAtMs),
        lastQueuedAtMs: Math.floor(lastQueuedAtMs),
      }
    : null;
}
