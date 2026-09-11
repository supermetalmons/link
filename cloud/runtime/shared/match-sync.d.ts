import type { GameSessionMatch } from "./game-sessions";

export const MATCH_SYNC_SOCKET_PROTOCOL: "mons-match-sync-v1";
export const MATCH_SYNC_MAX_MESSAGE_BYTES: number;
export const MATCH_SYNC_REFRESH_MS: 1000;

export type MatchSyncSnapshot = {
  inviteId: string;
  matchId: string;
  revision: number;
  hostPlayerId: string;
  guestPlayerId: string | null;
  hostMatch: GameSessionMatch | null;
  guestMatch: GameSessionMatch | null;
};

export type ReadMatchSyncResponse = {
  ok: true;
  snapshot: MatchSyncSnapshot;
};

export type MatchSyncMessage = {
  schemaVersion: 1;
  type: "snapshot";
  snapshot: MatchSyncSnapshot;
};

export function isMatchSyncSnapshot(value: unknown): value is MatchSyncSnapshot;
export function isReadMatchSyncResponse(
  value: unknown,
): value is ReadMatchSyncResponse;
export function isMatchSyncMessage(value: unknown): value is MatchSyncMessage;
