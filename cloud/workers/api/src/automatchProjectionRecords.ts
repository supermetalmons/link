import {
  isAutomatchProfileOutboxRecord,
  isAutomatchTelegramOutboxRecord,
  type AutomatchProfileOutboxRecord,
  type AutomatchTelegramOutboxRecord,
  type AutomatchTelegramSourceRecord,
} from "../../../runtime/automatchRecords.js";
import type { AutomatchOutboxClaimSnapshot } from "./automatchD1/types.ts";
import type { AutomatchTelegramProjectionTask } from "./telegramProjectionTasks.ts";
import type { AutomatchProfileGameProjectionTask } from "./profileGameProjectionTasks.ts";
import {
  inviteTelegramFingerprint,
  type InviteDocument,
} from "@mons/shared/invite-records";
import {
  buildAutomatchTelegramProjection,
  mergeRatingResultFragment,
  type AutomatchTelegramProjection,
} from "../../../runtime/telegram/projectionCore.js";
import type { RawGameSessionPort } from "./gameSessionContracts.ts";
import type { HistoricalMatchDescriptor } from "./historicalMatches.ts";
import { parseAutomatchProfileGameProjectionOutbox } from "./profileGameProjectionOutbox.ts";
import type { RatingUpdateData } from "./ratingContracts.ts";
import { parseAutomatchTelegramProjectionOutbox } from "./telegramProjectionOutbox.ts";

export type AutomatchTelegramSourceSnapshot = {
  project(invite: InviteDocument | null): AutomatchTelegramProjection | null;
  fingerprint(invite: InviteDocument | null): string;
};
export type AutomatchTelegramOutboxSnapshot = {
  value: ReturnType<typeof parseAutomatchTelegramProjectionOutbox>;
};
export type AutomatchProfileOutboxSnapshot = {
  value: ReturnType<typeof parseAutomatchProfileGameProjectionOutbox>;
  matchesCancellationRequest(requestId: string): boolean;
};
export type AutomatchTelegramRatingResultInput = Pick<
  RatingUpdateData,
  | "telegramDeliveryVersion"
  | "status"
  | "isEventMatch"
  | "eventOwned"
  | "eventId"
  | "inviteId"
  | "matchId"
  | "updateRatingMessage"
  | "completedAtMs"
>;
export function createAutomatchTelegramSourceSnapshot(
  inviteId: string,
  source: AutomatchTelegramSourceRecord | null,
): AutomatchTelegramSourceSnapshot {
  return {
    project: (inviteData) =>
      buildAutomatchTelegramProjection({ inviteId, source, inviteData }),
    fingerprint: (invite) => inviteTelegramFingerprint(source, invite),
  };
}
export function createAutomatchTelegramOutboxSnapshot(
  source: AutomatchTelegramOutboxRecord | null,
): AutomatchTelegramOutboxSnapshot {
  return { value: parseAutomatchTelegramProjectionOutbox(source) };
}
export function createAutomatchProfileOutboxSnapshot(
  source: AutomatchProfileOutboxRecord | null,
): AutomatchProfileOutboxSnapshot {
  return {
    value: parseAutomatchProfileGameProjectionOutbox(source),
    matchesCancellationRequest: (requestId) =>
      source?.status === "pending" && source.requestId === requestId,
  };
}
export type InvalidAutomatchSweepResult =
  | { kind: "changed" }
  | { kind: "removed" }
  | { kind: "repaired"; task: AutomatchProfileGameProjectionTask };
export function createAutomatchProjectionCommands(
  raw: Pick<
    RawGameSessionPort,
    | "transactAutomatchTelegramSource"
    | "transactAutomatchTelegramOutbox"
    | "transactAutomatchProfileOutbox"
  >,
) {
  return {
    async repairInvalidAutomatchProfileOutbox(
      inviteId: string,
      _nowMs: number,
      _createRequestId: () => string,
    ): Promise<InvalidAutomatchSweepResult> {
      await raw.transactAutomatchProfileOutbox(inviteId, (current) => {
        if (current !== null && !isAutomatchProfileOutboxRecord(current))
          throw new Error("invalid-canonical-profile-outbox");
        return { commit: false, decision: "changed" };
      });
      return { kind: "changed" };
    },
    async repairInvalidAutomatchTelegramOutbox(
      inviteId: string,
      _nowMs: number,
    ): Promise<void> {
      await raw.transactAutomatchTelegramOutbox(inviteId, (current) => {
        if (current !== null && !isAutomatchTelegramOutboxRecord(current))
          throw new Error("invalid-canonical-telegram-outbox");
        return { commit: false, decision: "changed" };
      });
    },
    async mergeAutomatchTelegramRatingResult(
      inviteId: string,
      update: AutomatchTelegramRatingResultInput,
      signal?: AbortSignal,
    ): Promise<"inserted" | "duplicate" | "skipped"> {
      let reason: "inserted" | "duplicate" | "skipped" = "skipped";
      await raw.transactAutomatchTelegramSource(
        inviteId,
        (source) => {
          const result = mergeRatingResultFragment(source, update);
          reason = result.reason;
          return result.changed
            ? { value: result.source, decision: reason }
            : { commit: false, decision: reason };
        },
        signal,
      );
      return reason;
    },
    async markAutomatchTelegramOutboxDead(
      inviteId: string,
      requestId: string,
      reason: string,
      now: () => number,
      signal?: AbortSignal,
    ): Promise<boolean> {
      const result = await raw.transactAutomatchTelegramOutbox(
        inviteId,
        (current) =>
          current?.status === "pending" && current.requestId === requestId
            ? {
                value: {
                  schemaVersion: 2,
                  status: "dead",
                  requestId,
                  reason,
                  updatedAtMs: null,
                  deadAtMs: now(),
                },
                decision: "dead",
              }
            : { commit: false, decision: "stale" },
        signal,
      );
      return result.committed;
    },
    async settleAutomatchHistoricalDescriptor(
      inviteId: string,
      requestId: string,
      expected: HistoricalMatchDescriptor,
      retryNotBeforeMs?: number,
      signal?: AbortSignal,
    ): Promise<boolean> {
      const result = await raw.transactAutomatchProfileOutbox(
        inviteId,
        (current) => {
          if (current?.status !== "pending" || current.requestId !== requestId)
            return { commit: false, decision: "superseded" };
          const stored = current.historicalMatches[expected.matchId];
          if (
            !stored ||
            stored.finalizedAtMs !== expected.finalizedAtMs ||
            stored.hostPlayerId !== expected.hostPlayerId ||
            stored.guestPlayerId !== expected.guestPlayerId ||
            stored.source !== expected.source ||
            stored.retryNotBeforeMs !== (expected.retryNotBeforeMs ?? null)
          )
            return { commit: false, decision: "changed" };
          const historicalMatches = { ...current.historicalMatches };
          if (retryNotBeforeMs === undefined)
            delete historicalMatches[expected.matchId];
          else
            historicalMatches[expected.matchId] = {
              ...stored,
              retryNotBeforeMs,
            };
          return {
            value: { ...current, historicalMatches },
            decision: retryNotBeforeMs === undefined ? "settled" : "deferred",
          };
        },
        signal,
      );
      return result.committed;
    },
  };
}
export type AutomatchProjectionCommands = ReturnType<
  typeof createAutomatchProjectionCommands
>;

export type AutomatchProfileRecoveryCandidate = {
  lastQueuedAtMs: number;
  task: AutomatchProfileGameProjectionTask;
  snapshot?: AutomatchOutboxClaimSnapshot<"profileGameProjectionOutbox/automatch">;
};

export type AutomatchProfileRecoveryEntry =
  | { kind: "candidate"; value: AutomatchProfileRecoveryCandidate }
  | { inviteId: string; kind: "invalid" };

export function readAutomatchProfileRecoveryEntries(
  value: Record<string, AutomatchProfileOutboxRecord | null> | null,
  snapshots?: ReadonlyMap<
    string,
    AutomatchOutboxClaimSnapshot<"profileGameProjectionOutbox/automatch">
  >,
): AutomatchProfileRecoveryEntry[] {
  const records = value ?? {};
  return Object.entries(records).flatMap(
    ([inviteId, raw]): AutomatchProfileRecoveryEntry[] => {
      if (raw === null || raw.status !== "pending") return [];
      const outbox = parseAutomatchProfileGameProjectionOutbox(raw);
      const snapshot = snapshots?.get(inviteId);
      return outbox
        ? [
            {
              kind: "candidate",
              value: {
                ...(snapshot ? { snapshot } : {}),
                lastQueuedAtMs: outbox.lastQueuedAtMs,
                task: {
                  kind: "automatch-profile-game-projection",
                  inviteId,
                  requestId: outbox.requestId,
                },
              },
            },
          ]
        : [{ inviteId, kind: "invalid" }];
    },
  );
}

export type AutomatchTelegramRecoveryCandidate = {
  task: AutomatchTelegramProjectionTask;
  updatedAtMs: number;
  snapshot?: AutomatchOutboxClaimSnapshot<"telegramProjectionOutbox/automatch">;
};

export type AutomatchTelegramRecoveryEntry =
  | { kind: "candidate"; value: AutomatchTelegramRecoveryCandidate }
  | { inviteId: string; kind: "invalid" };

export function readAutomatchTelegramRecoveryEntries(
  value: Record<string, AutomatchTelegramOutboxRecord | null> | null,
  snapshots?: ReadonlyMap<
    string,
    AutomatchOutboxClaimSnapshot<"telegramProjectionOutbox/automatch">
  >,
): AutomatchTelegramRecoveryEntry[] {
  const records = value ?? {};
  return Object.entries(records).flatMap(([inviteId, raw]) => {
    if (raw === null || raw.status !== "pending") return [];
    const outbox = parseAutomatchTelegramProjectionOutbox(raw);
    const snapshot = snapshots?.get(inviteId);
    return [
      outbox
        ? {
            kind: "candidate" as const,
            value: {
              ...(snapshot ? { snapshot } : {}),
              task: {
                kind: "automatch-telegram-projection" as const,
                inviteId,
                requestId: outbox.requestId,
              },
              updatedAtMs: outbox.updatedAtMs,
            },
          }
        : { kind: "invalid" as const, inviteId },
    ];
  });
}
