import type { GameSessionMatch } from "./game-sessions.js";
import { normalizeRecordKey } from "./ids.js";
import { isGameSessionMatch } from "./game-sessions.js";
import { parseInviteMatchIndex } from "./rematches.js";

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

const MATCH_SYNC_SOCKET_PROTOCOL = "mons-match-sync-v1";
const MATCH_SYNC_MAX_MESSAGE_BYTES: number = 1024 * 1024 + 16 * 1024;
const MATCH_SYNC_REFRESH_MS = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const isKey = (value: unknown): value is string =>
  typeof value === "string" && normalizeRecordKey(value) === value;
const isUid = (value: unknown): value is string =>
  isKey(value) && value.length <= 128;

function isMatchSyncSnapshot(value: unknown): value is MatchSyncSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "inviteId",
      "matchId",
      "revision",
      "hostPlayerId",
      "guestPlayerId",
      "hostMatch",
      "guestMatch",
    ]) &&
    isKey(value.inviteId) &&
    isKey(value.matchId) &&
    parseInviteMatchIndex(value.inviteId, value.matchId) !== null &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    isUid(value.hostPlayerId) &&
    (value.guestPlayerId === null ||
      (isUid(value.guestPlayerId) &&
        value.guestPlayerId !== value.hostPlayerId)) &&
    (value.hostMatch === null || isGameSessionMatch(value.hostMatch)) &&
    (value.guestMatch === null ||
      (value.guestPlayerId !== null && isGameSessionMatch(value.guestMatch)))
  );
}

function isReadMatchSyncResponse(
  value: unknown,
): value is ReadMatchSyncResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["ok", "snapshot"]) &&
    value.ok === true &&
    isMatchSyncSnapshot(value.snapshot)
  );
}

function isMatchSyncMessage(value: unknown): value is MatchSyncMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "type", "snapshot"]) &&
    value.schemaVersion === 1 &&
    value.type === "snapshot" &&
    isMatchSyncSnapshot(value.snapshot)
  );
}

export {
  MATCH_SYNC_SOCKET_PROTOCOL,
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  MATCH_SYNC_REFRESH_MS,
  isMatchSyncSnapshot,
  isReadMatchSyncResponse,
  isMatchSyncMessage,
};
