// Generated from src/shared/match-sync.ts. Run npm run generate:runtime.
import type { GameSessionMatch } from "./game-sessions.js";
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
declare const MATCH_SYNC_SOCKET_PROTOCOL = "mons-match-sync-v1";
declare const MATCH_SYNC_MAX_MESSAGE_BYTES: number;
declare const MATCH_SYNC_REFRESH_MS = 1000;
declare function isMatchSyncSnapshot(
  value: unknown,
): value is MatchSyncSnapshot;
declare function isReadMatchSyncResponse(
  value: unknown,
): value is ReadMatchSyncResponse;
declare function isMatchSyncMessage(value: unknown): value is MatchSyncMessage;
export {
  MATCH_SYNC_SOCKET_PROTOCOL,
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  MATCH_SYNC_REFRESH_MS,
  isMatchSyncSnapshot,
  isReadMatchSyncResponse,
  isMatchSyncMessage,
};
