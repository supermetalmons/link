import { readGameplayMatchPair } from "../gameplayMatchReads.ts";
import {
  buildHistoricalMatchPair,
  classifyTransitionHistoricalMatchPair,
  type HistoricalMatchDescriptor,
} from "../historicalMatches.ts";
import {
  parseAutomatchProfileGameProjectionOutbox,
  type AutomatchProfileGameProjectionOutbox,
} from "../profileGameProjectionOutbox.ts";
import type { AutomatchProfileGameProjectionTask } from "../profileGameProjectionTasks.ts";
import type { ProfileGameProjectionRuntime } from "../profileGameProjectionRepository.ts";
import type { AutomatchProjectionState } from "./types.ts";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function archiveHistoricalDescriptor(
  descriptor: HistoricalMatchDescriptor,
  inviteId: string,
  state: AutomatchProjectionState,
  runtime: ProfileGameProjectionRuntime,
): Promise<"archived" | "unready" | "unavailable"> {
  const alreadyArchived = runtime.hasHistoricalMatch
    ? await runtime.hasHistoricalMatch(inviteId, descriptor.matchId)
    : false;
  let hostMatch: unknown;
  let guestMatch: unknown;
  try {
    [hostMatch, guestMatch] = await readGameplayMatchPair(state, {
      inviteId,
      matchId: descriptor.matchId,
      playerId: descriptor.hostPlayerId,
      opponentId: descriptor.guestPlayerId,
    });
  } catch (error) {
    if (alreadyArchived) return "archived";
    throw error;
  }
  if (hostMatch == null && guestMatch == null && alreadyArchived)
    return "archived";
  const input = {
    matchId: descriptor.matchId,
    hostPlayerId: descriptor.hostPlayerId,
    guestPlayerId: descriptor.guestPlayerId,
    hostMatch,
    guestMatch,
  };
  const result =
    descriptor.source === "transition"
      ? classifyTransitionHistoricalMatchPair(input)
      : { status: "ready" as const, pair: buildHistoricalMatchPair(input) };
  if (result.status !== "ready") return result.status;
  const pair = result.pair;
  if (!pair) return "unavailable";
  if (!runtime.archiveHistoricalMatch) {
    throw new Error("historical-match-archive-unavailable");
  }
  await runtime.archiveHistoricalMatch({
    finalizedAtMs: descriptor.finalizedAtMs,
    inviteId,
    pair,
    source: descriptor.source,
  });
  return "archived";
}

export async function settleHistoricalDescriptor(
  task: AutomatchProfileGameProjectionTask,
  descriptor: HistoricalMatchDescriptor,
  state: AutomatchProjectionState,
  retryNotBeforeMs?: number,
): Promise<boolean> {
  const result = await state.transactAutomatchProfileOutbox(
    task.inviteId,
    (current) => {
      const record = toRecord(current);
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (!record || !outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "superseded" };
      }
      const historicalMatches = {
        ...(toRecord(record.historicalMatches) || {}),
      };
      const stored = outbox.historicalMatches?.find(
        ({ matchId }) => matchId === descriptor.matchId,
      );
      if (
        !stored ||
        stored.finalizedAtMs !== descriptor.finalizedAtMs ||
        stored.hostPlayerId !== descriptor.hostPlayerId ||
        stored.guestPlayerId !== descriptor.guestPlayerId ||
        stored.source !== descriptor.source ||
        stored.retryNotBeforeMs !== descriptor.retryNotBeforeMs
      ) {
        return { commit: false, decision: "changed" };
      }
      if (retryNotBeforeMs === undefined)
        delete historicalMatches[descriptor.matchId];
      else
        historicalMatches[descriptor.matchId] = {
          ...toRecord(historicalMatches[descriptor.matchId]),
          retryNotBeforeMs,
        };
      const next = { ...record };
      if (Object.keys(historicalMatches).length > 0) {
        next.historicalMatches = historicalMatches;
      } else {
        delete next.historicalMatches;
      }
      return {
        value: next,
        decision: retryNotBeforeMs === undefined ? "settled" : "deferred",
      };
    },
  );
  return result.committed;
}

export function archiveRetryIsPending(
  outbox: AutomatchProfileGameProjectionOutbox,
  nowMs: number,
): boolean {
  const retry = outbox.archiveRetry;
  const descriptors = outbox.historicalMatches || [];
  return Boolean(
    retry &&
    retry.requestId === outbox.requestId &&
    retry.notBeforeMs > nowMs &&
    descriptors.length > 0 &&
    descriptors.every(
      ({ retryNotBeforeMs }) =>
        retryNotBeforeMs !== undefined && retryNotBeforeMs >= retry.notBeforeMs,
    ),
  );
}

export async function finishAutomatchProjectionBatch(
  task: AutomatchProfileGameProjectionTask,
  state: AutomatchProjectionState,
  nowMs: number,
): Promise<"continued" | "deferred" | "projected" | "superseded"> {
  return state.finishAutomatchProfileOutbox(
    task.inviteId,
    task.requestId,
    nowMs,
  );
}
