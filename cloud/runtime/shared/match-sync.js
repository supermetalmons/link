// Generated from src/shared/match-sync.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MATCH_SYNC_REFRESH_MS =
  exports.MATCH_SYNC_MAX_MESSAGE_BYTES =
  exports.MATCH_SYNC_SOCKET_PROTOCOL =
    void 0;
exports.isMatchSyncSnapshot = isMatchSyncSnapshot;
exports.isReadMatchSyncResponse = isReadMatchSyncResponse;
exports.isMatchSyncMessage = isMatchSyncMessage;
const ids_js_1 = require("./ids.js");
const game_sessions_js_1 = require("./game-sessions.js");
const rematches_js_1 = require("./rematches.js");
const MATCH_SYNC_SOCKET_PROTOCOL = "mons-match-sync-v1";
exports.MATCH_SYNC_SOCKET_PROTOCOL = MATCH_SYNC_SOCKET_PROTOCOL;
const MATCH_SYNC_MAX_MESSAGE_BYTES = 1024 * 1024 + 16 * 1024;
exports.MATCH_SYNC_MAX_MESSAGE_BYTES = MATCH_SYNC_MAX_MESSAGE_BYTES;
const MATCH_SYNC_REFRESH_MS = 1000;
exports.MATCH_SYNC_REFRESH_MS = MATCH_SYNC_REFRESH_MS;
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const isKey = (value) =>
  typeof value === "string" &&
  (0, ids_js_1.normalizeRecordKey)(value) === value;
const isUid = (value) => isKey(value) && value.length <= 128;
function isMatchSyncSnapshot(value) {
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
    (0, rematches_js_1.parseInviteMatchIndex)(value.inviteId, value.matchId) !==
      null &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    isUid(value.hostPlayerId) &&
    (value.guestPlayerId === null ||
      (isUid(value.guestPlayerId) &&
        value.guestPlayerId !== value.hostPlayerId)) &&
    (value.hostMatch === null ||
      (0, game_sessions_js_1.isGameSessionMatch)(value.hostMatch)) &&
    (value.guestMatch === null ||
      (value.guestPlayerId !== null &&
        (0, game_sessions_js_1.isGameSessionMatch)(value.guestMatch)))
  );
}
function isReadMatchSyncResponse(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["ok", "snapshot"]) &&
    value.ok === true &&
    isMatchSyncSnapshot(value.snapshot)
  );
}
function isMatchSyncMessage(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "type", "snapshot"]) &&
    value.schemaVersion === 1 &&
    value.type === "snapshot" &&
    isMatchSyncSnapshot(value.snapshot)
  );
}
