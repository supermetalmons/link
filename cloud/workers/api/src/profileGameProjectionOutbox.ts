import {
  isAutomatchProfileOutboxRecord,
  type AutomatchProfileOutboxRecord,
} from "../../../runtime/automatchRecords.js";
import { isEventProjectionPending } from "../../../runtime/eventProjectionOutboxRecords.js";
import type { HistoricalMatchDescriptor } from "./historicalMatches.ts";

export type AutomatchProfileGameProjectionOutbox = Omit<
  Extract<AutomatchProfileOutboxRecord, { status: "pending" }>,
  "historicalMatches"
> & { historicalMatches: HistoricalMatchDescriptor[] };

export type EventProfileGameProjectionOutbox = {
  cleanupOwnerProfileIds: string[];
  lastQueuedAtMs: number;
  requestId: string;
  schemaVersion: number;
  status: "pending";
};

export function parseAutomatchProfileGameProjectionOutbox(
  value: unknown,
): AutomatchProfileGameProjectionOutbox | null {
  if (!isAutomatchProfileOutboxRecord(value) || value.status !== "pending")
    return null;
  return {
    ...value,
    historicalMatches: Object.entries(value.historicalMatches).map(
      ([matchId, descriptor]) => ({
        matchId,
        finalizedAtMs: descriptor.finalizedAtMs,
        hostPlayerId: descriptor.hostPlayerId,
        guestPlayerId: descriptor.guestPlayerId,
        source: descriptor.source,
        ...(descriptor.retryNotBeforeMs === null
          ? {}
          : { retryNotBeforeMs: descriptor.retryNotBeforeMs }),
      }),
    ),
  };
}

export function parseEventProfileGameProjectionOutbox(
  value: unknown,
): EventProfileGameProjectionOutbox | null {
  if (!isEventProjectionPending("profile-game", value)) return null;
  return {
    schemaVersion: value.schemaVersion,
    status: "pending",
    requestId: value.requestId,
    lastQueuedAtMs: value.lastQueuedAtMs,
    cleanupOwnerProfileIds: Object.keys(value.cleanupOwnerProfileIds ?? {}),
  };
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
