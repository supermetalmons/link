import {
  normalizeMatchSnapshot,
  type GameSessionMatch,
} from "@mons/shared/game-sessions";
import {
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  isMatchSyncSnapshot,
  type MatchSyncSnapshot,
} from "@mons/shared/match-sync";
import {
  parseInviteMatchIndex,
  parseRematchIndices,
} from "@mons/shared/rematches";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { InviteMetadataReadResult } from "./inviteMetadata.ts";

export type MatchSyncMetadata = Extract<
  InviteMetadataReadResult,
  { status: "ok" }
>;

export type MatchSyncReadResult =
  | { status: "ok"; snapshot: MatchSyncSnapshot; metadata: MatchSyncMetadata }
  | { status: "missing" | "invalid" };

export function isRegisteredSyncMatch(
  metadata: MatchSyncMetadata,
  matchId: string,
): boolean {
  if (matchId !== matchId.trim() || !isSafeRecordKey(matchId)) return false;
  const index = parseInviteMatchIndex(metadata.snapshot.inviteId, matchId);
  return (
    index !== null &&
    (index === 0 ||
      parseRematchIndices(metadata.snapshot.hostRematches).includes(index) ||
      parseRematchIndices(metadata.snapshot.guestRematches).includes(index))
  );
}

function normalizeSourceMatch(value: unknown): GameSessionMatch | null {
  if (value === null) return null;
  const match = normalizeMatchSnapshot(value);
  if (!match) throw new Error("match-sync-source-invalid");
  return match;
}

export function createMatchSyncSnapshot(
  metadata: MatchSyncMetadata,
  matchId: string,
  hostValue: unknown,
  guestValue: unknown,
): MatchSyncSnapshot {
  const snapshot: MatchSyncSnapshot = {
    inviteId: metadata.snapshot.inviteId,
    matchId,
    revision: 0,
    hostPlayerId: metadata.snapshot.hostId,
    guestPlayerId: metadata.snapshot.guestId,
    hostMatch: normalizeSourceMatch(hostValue),
    guestMatch:
      metadata.snapshot.guestId === null
        ? null
        : normalizeSourceMatch(guestValue),
  };
  assertMatchSyncEnvelope(snapshot);
  return snapshot;
}

export function assertMatchSyncEnvelope(snapshot: MatchSyncSnapshot): void {
  if (
    !isMatchSyncSnapshot(snapshot) ||
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: "snapshot",
        snapshot,
      }),
    ).byteLength > MATCH_SYNC_MAX_MESSAGE_BYTES
  ) {
    throw new Error("match-sync-snapshot-invalid");
  }
}
