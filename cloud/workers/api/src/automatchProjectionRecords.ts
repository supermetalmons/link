import type { ProfileProjectionRequest } from "../../../runtime/gameSessionChanges.js";
import type { HistoricalMatchDescriptorWrite } from "../../../runtime/automatchRecords.js";
import type { AutomatchOutboxClaimSnapshot } from "./automatchD1/types.ts";
import type { AutomatchTelegramProjectionTask } from "./telegramProjectionTasks.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
  type AutomatchProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import {
  inviteTelegramFingerprint,
  type InviteDocument,
} from "@mons/shared/invite-records";
import {
  buildAutomatchTelegramProjection,
  retainAutomatchTelegramSource,
  mergeRatingResultFragment,
  type AutomatchTelegramProjection,
} from "../../../runtime/telegram/projectionCore.js";
import type { RawGameSessionPort } from "./gameSessionContracts.ts";
import type { HistoricalMatchDescriptor } from "./historicalMatches.ts";
import {
  parseAutomatchProfileGameProjectionOutbox,
  salvageHistoricalMatchDescriptors,
} from "./profileGameProjectionOutbox.ts";
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

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createAutomatchTelegramSourceSnapshot(
  inviteId: string,
  raw: unknown,
): AutomatchTelegramSourceSnapshot {
  return {
    project: (inviteData) =>
      buildAutomatchTelegramProjection({
        inviteId,
        source: retainAutomatchTelegramSource(toRecord(raw)),
        inviteData,
      }),
    fingerprint: (invite) => inviteTelegramFingerprint(raw, invite),
  };
}

export function createAutomatchTelegramOutboxSnapshot(
  raw: unknown,
): AutomatchTelegramOutboxSnapshot {
  return { value: parseAutomatchTelegramProjectionOutbox(raw) };
}

export function createAutomatchProfileOutboxSnapshot(
  raw: unknown,
): AutomatchProfileOutboxSnapshot {
  return {
    value: parseAutomatchProfileGameProjectionOutbox(raw),
    matchesCancellationRequest(requestId) {
      const value = toRecord(raw)?.requestId;
      return (typeof value === "string" ? value.trim() : "") === requestId;
    },
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
      nowMs: number,
      createRequestId: () => string,
    ): Promise<InvalidAutomatchSweepResult> {
      const safeInviteId = isSafeRecordKey(inviteId);
      const requestId = safeInviteId ? createRequestId() : "";
      const result = await raw.transactAutomatchProfileOutbox(
        inviteId,
        (current) => {
          const record = toRecord(current);
          if (
            current === null ||
            current === undefined ||
            (record &&
              parseAutomatchProfileGameProjectionOutbox(current) &&
              isSafeRecordKey(inviteId))
          ) {
            return { commit: false, decision: "changed" };
          }
          if (!safeInviteId) {
            return { value: null, decision: "removed-invalid" };
          }
          const sourceUpdatedAtMs = record?.sourceUpdatedAtMs;
          const historicalMatches = salvageHistoricalMatchDescriptors(current);
          return {
            value: {
              schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
              status: "pending",
              requestId,
              reason:
                typeof record?.reason === "string" && record.reason.trim()
                  ? record.reason.trim()
                  : "automatch-queue",
              sourceUpdatedAtMs:
                typeof sourceUpdatedAtMs === "number" &&
                Number.isFinite(sourceUpdatedAtMs) &&
                sourceUpdatedAtMs >= 0
                  ? Math.floor(sourceUpdatedAtMs)
                  : nowMs,
              lastQueuedAtMs: nowMs,
              ...(historicalMatches.length > 0
                ? {
                    historicalMatches: Object.fromEntries(
                      historicalMatches.map((descriptor) => [
                        descriptor.matchId,
                        {
                          finalizedAtMs: descriptor.finalizedAtMs,
                          guestPlayerId: descriptor.guestPlayerId,
                          hostPlayerId: descriptor.hostPlayerId,
                          source: descriptor.source,
                          ...(descriptor.retryNotBeforeMs === undefined
                            ? {}
                            : {
                                retryNotBeforeMs: descriptor.retryNotBeforeMs,
                              }),
                        },
                      ]),
                    ),
                  }
                : {}),
            } satisfies ProfileProjectionRequest & {
              historicalMatches?: Record<
                string,
                HistoricalMatchDescriptorWrite
              >;
            },
            decision: "repaired-invalid",
          };
        },
      );
      if (!result.committed) {
        return { kind: "changed" };
      }
      return safeInviteId
        ? {
            kind: "repaired",
            task: {
              kind: "automatch-profile-game-projection",
              inviteId,
              requestId,
            },
          }
        : { kind: "removed" };
    },
    async repairInvalidAutomatchTelegramOutbox(
      inviteId: string,
      nowMs: number,
    ): Promise<void> {
      await raw.transactAutomatchTelegramOutbox(inviteId, (current) => {
        const record = toRecord(current);
        const updatedAtMs = record?.updatedAtMs;
        if (
          !record ||
          (parseAutomatchTelegramProjectionOutbox(current) &&
            isSafeRecordKey(inviteId)) ||
          typeof updatedAtMs !== "number" ||
          !Number.isFinite(updatedAtMs) ||
          updatedAtMs > nowMs
        ) {
          return { commit: false, decision: "changed" };
        }
        return {
          value: {
            ...record,
            status: "dead",
            reason: "invalid-record",
            updatedAtMs: null,
            deadAtMs: nowMs,
          },
          decision: "dead",
        };
      });
    },
    async mergeAutomatchTelegramRatingResult(
      inviteId: string,
      update: AutomatchTelegramRatingResultInput,
      signal?: AbortSignal,
    ): Promise<"inserted" | "duplicate" | "skipped"> {
      let mergeReason: "inserted" | "duplicate" | "skipped" = "skipped";
      await raw.transactAutomatchTelegramSource(
        inviteId,
        (source) => {
          const merged = mergeRatingResultFragment(
            retainAutomatchTelegramSource(source),
            update,
          );
          mergeReason = merged.reason;
          return merged.changed
            ? { value: merged.source, decision: merged.reason }
            : { commit: false, decision: merged.reason };
        },
        signal,
      );
      return mergeReason;
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
        (current) => {
          const record = toRecord(current);
          if (record?.requestId !== requestId) {
            return { commit: false, decision: "stale" };
          }
          return {
            value: {
              ...record,
              status: "dead",
              reason,
              updatedAtMs: null,
              deadAtMs: now(),
            },
            decision: "dead",
          };
        },
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
          const record = toRecord(current);
          const outbox = parseAutomatchProfileGameProjectionOutbox(current);
          if (!record || !outbox || outbox.requestId !== requestId) {
            return { commit: false, decision: "superseded" };
          }
          const historicalMatches = {
            ...(toRecord(record.historicalMatches) || {}),
          };
          const stored = outbox.historicalMatches?.find(
            ({ matchId }) => matchId === expected.matchId,
          );
          if (
            !stored ||
            stored.finalizedAtMs !== expected.finalizedAtMs ||
            stored.hostPlayerId !== expected.hostPlayerId ||
            stored.guestPlayerId !== expected.guestPlayerId ||
            stored.source !== expected.source ||
            stored.retryNotBeforeMs !== expected.retryNotBeforeMs
          ) {
            return { commit: false, decision: "changed" };
          }
          if (retryNotBeforeMs === undefined)
            delete historicalMatches[expected.matchId];
          else
            historicalMatches[expected.matchId] = {
              ...toRecord(historicalMatches[expected.matchId]),
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
  value: unknown,
  snapshots?: ReadonlyMap<
    string,
    AutomatchOutboxClaimSnapshot<"profileGameProjectionOutbox/automatch">
  >,
): AutomatchProfileRecoveryEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([inviteId, raw]) => {
    const outbox = parseAutomatchProfileGameProjectionOutbox(raw);
    const snapshot = snapshots?.get(inviteId);
    return outbox && isSafeRecordKey(inviteId)
      ? {
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
        }
      : { inviteId, kind: "invalid" };
  });
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
  value: unknown,
  snapshots?: ReadonlyMap<
    string,
    AutomatchOutboxClaimSnapshot<"telegramProjectionOutbox/automatch">
  >,
): AutomatchTelegramRecoveryEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).flatMap(([inviteId, raw]) => {
    const outbox = parseAutomatchTelegramProjectionOutbox(raw);
    const snapshot = snapshots?.get(inviteId);
    return [
      outbox && isSafeRecordKey(inviteId)
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
