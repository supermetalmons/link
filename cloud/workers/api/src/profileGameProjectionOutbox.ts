import { isSafeRecordKey } from "./recordKeys.ts";
import { PROFILE_GAME_PROJECTION_SCHEMA_VERSION } from "./profileGameProjectionTasks.ts";
import type { HistoricalMatchDescriptor } from "./historicalMatches.ts";

export type AutomatchProfileGameProjectionOutbox = {
  archiveRetry?: { requestId: string; notBeforeMs: number };
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
    const retryNotBeforeMs = record?.retryNotBeforeMs;
    return isSafeRecordKey(matchId) &&
      typeof hostPlayerId === "string" &&
      isSafeRecordKey(hostPlayerId) &&
      typeof guestPlayerId === "string" &&
      isSafeRecordKey(guestPlayerId) &&
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
            ...(typeof retryNotBeforeMs === "number" &&
            Number.isSafeInteger(retryNotBeforeMs) &&
            retryNotBeforeMs >= 0
              ? { retryNotBeforeMs }
              : {}),
          },
        ]
      : [];
  });
}

export function parseAutomatchProfileGameProjectionOutbox(
  value: unknown,
): AutomatchProfileGameProjectionOutbox | null {
  const record = toRecord(value);
  const archiveRetry = toRecord(record?.archiveRetry);
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
    isSafeRecordKey(record.requestId) &&
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
        ...(typeof archiveRetry?.requestId === "string" &&
        isSafeRecordKey(archiveRetry.requestId) &&
        typeof archiveRetry.notBeforeMs === "number" &&
        Number.isSafeInteger(archiveRetry.notBeforeMs) &&
        archiveRetry.notBeforeMs >= 0
          ? {
              archiveRetry: {
                requestId: archiveRetry.requestId,
                notBeforeMs: archiveRetry.notBeforeMs,
              },
            }
          : {}),
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
    isSafeRecordKey(record.requestId) &&
    typeof lastQueuedAtMs === "number" &&
    Number.isSafeInteger(lastQueuedAtMs) &&
    lastQueuedAtMs >= 0 &&
    cleanup !== null &&
    cleanupEntries.every(
      ([profileId, included]) =>
        isSafeRecordKey(profileId) && included === true,
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

export type AutomatchProfileOutboxCompletion =
  | { status: "superseded" | "continued" | "projected" }
  | {
      status: "deferred";
      archiveRetry: { requestId: string; notBeforeMs: number };
    };

export function decideAutomatchProfileOutboxCompletion(
  current: unknown,
  requestId: string,
  nowMs: number,
): AutomatchProfileOutboxCompletion {
  const outbox = parseAutomatchProfileGameProjectionOutbox(current);
  if (!outbox || outbox.requestId !== requestId)
    return { status: "superseded" };
  const descriptors = outbox.historicalMatches || [];
  if (descriptors.length === 0) return { status: "projected" };
  if (
    descriptors.some(({ retryNotBeforeMs }) => (retryNotBeforeMs || 0) <= nowMs)
  )
    return { status: "continued" };
  return {
    status: "deferred",
    archiveRetry: {
      requestId,
      notBeforeMs: Math.min(
        ...descriptors.map(({ retryNotBeforeMs }) => retryNotBeforeMs!),
      ),
    },
  };
}
