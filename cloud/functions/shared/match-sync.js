"use strict";

const { normalizeFirebaseKey } = require("./ids");
const { isGameSessionMatch } = require("./game-sessions");
const { parseInviteMatchIndex } = require("./rematches");

const MATCH_SYNC_SOCKET_PROTOCOL = "mons-match-sync-v1";
const MATCH_SYNC_MAX_MESSAGE_BYTES = 1024 * 1024 + 16 * 1024;
const MATCH_SYNC_REFRESH_MS = 1000;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const isKey = (value) =>
  typeof value === "string" && normalizeFirebaseKey(value) === value;
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
    parseInviteMatchIndex(value.inviteId, value.matchId) !== null &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    isUid(value.hostPlayerId) &&
    (value.guestPlayerId === null ||
      (isUid(value.guestPlayerId) &&
        value.guestPlayerId !== value.hostPlayerId)) &&
    (value.hostMatch === null || isGameSessionMatch(value.hostMatch)) &&
    (value.guestMatch === null ||
      (value.guestPlayerId !== null && isGameSessionMatch(value.guestMatch)))
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

module.exports = {
  MATCH_SYNC_SOCKET_PROTOCOL,
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  MATCH_SYNC_REFRESH_MS,
  isMatchSyncSnapshot,
  isReadMatchSyncResponse,
  isMatchSyncMessage,
};
