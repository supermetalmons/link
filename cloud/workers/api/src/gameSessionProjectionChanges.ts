import type {
  SessionTimestamp,
  ProfileProjectionRequest,
} from "../../../runtime/gameSessionChanges.js";
import type { GameSessionChange } from "./gameSessionContracts.ts";
import type { HistoricalMatchDescriptor } from "./historicalMatches.ts";
import { AUTOMATCH_PROFILE_GAME_PROJECTION_SCHEMA_VERSION } from "./profileGameProjectionTasks.ts";

export function requestAutomatchProfileProjection(input: {
  inviteId: string;
  requestId: string;
  reason?: string;
  timestamp: SessionTimestamp;
  historicalMatches?: HistoricalMatchDescriptor[];
  merge?: boolean;
}): GameSessionChange[] {
  const value: ProfileProjectionRequest = {
    schemaVersion: AUTOMATCH_PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
    status: "pending",
    requestId: input.requestId,
    reason:
      typeof input.reason === "string" && input.reason.trim()
        ? input.reason.trim()
        : "automatch-queue",
    sourceUpdatedAtMs: input.timestamp,
    lastQueuedAtMs: input.timestamp,
    historicalMatches: {},
    archiveRetry: null,
  };
  return input.merge
    ? [
        {
          kind: "profile-outbox-merge",
          inviteId: input.inviteId,
          value,
          historicalMatches: Object.fromEntries(
            (input.historicalMatches || []).map((descriptor) => [
              descriptor.matchId,
              {
                finalizedAtMs: descriptor.finalizedAtMs,
                guestPlayerId: descriptor.guestPlayerId,
                hostPlayerId: descriptor.hostPlayerId,
                source: descriptor.source,
                retryNotBeforeMs: descriptor.retryNotBeforeMs ?? null,
              },
            ]),
          ),
        },
      ]
    : [{ kind: "profile-outbox", inviteId: input.inviteId, value }];
}
