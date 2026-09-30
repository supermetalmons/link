// Generated from src/shared/invite-metadata.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INVITE_METADATA_REFRESH_MS =
  exports.INVITE_METADATA_MAX_MESSAGE_BYTES =
  exports.INVITE_METADATA_SOCKET_PROTOCOL =
    void 0;
exports.isInviteMetadataSnapshot = isInviteMetadataSnapshot;
exports.isReadInviteMetadataResponse = isReadInviteMetadataResponse;
exports.isInviteMetadataMessage = isInviteMetadataMessage;
const ids_js_1 = require("./ids.js");
const game_sessions_js_1 = require("./game-sessions.js");
const INVITE_METADATA_SOCKET_PROTOCOL = "mons-invite-metadata-v1";
exports.INVITE_METADATA_SOCKET_PROTOCOL = INVITE_METADATA_SOCKET_PROTOCOL;
const INVITE_METADATA_MAX_MESSAGE_BYTES = 1024 * 1024 + 16 * 1024;
exports.INVITE_METADATA_MAX_MESSAGE_BYTES = INVITE_METADATA_MAX_MESSAGE_BYTES;
const INVITE_METADATA_REFRESH_MS = 5000;
exports.INVITE_METADATA_REFRESH_MS = INVITE_METADATA_REFRESH_MS;
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const isKey = (value) =>
  typeof value === "string" &&
  (0, ids_js_1.normalizeRecordKey)(value) === value;
const isUid = (value) => isKey(value) && value.length <= 128;
function isInviteMetadataSnapshot(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "inviteId",
      "revision",
      "hostId",
      "guestId",
      "hostColor",
      "hostRematches",
      "guestRematches",
      "automatchStateHint",
      "eventId",
      "eventOwned",
    ]) &&
    isKey(value.inviteId) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    isUid(value.hostId) &&
    (value.guestId === null ||
      (isUid(value.guestId) && value.guestId !== value.hostId)) &&
    (value.hostColor === "white" || value.hostColor === "black") &&
    typeof value.hostRematches === "string" &&
    typeof value.guestRematches === "string" &&
    value.hostRematches.length <= INVITE_METADATA_MAX_MESSAGE_BYTES &&
    value.guestRematches.length <= INVITE_METADATA_MAX_MESSAGE_BYTES &&
    [null, "pending", "matched", "canceled"].includes(
      value.automatchStateHint,
    ) &&
    (value.eventId === null || isKey(value.eventId)) &&
    typeof value.eventOwned === "boolean"
  );
}
function isReadInviteMetadataResponse(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ok", "snapshot", "viewer"]) ||
    value.ok !== true ||
    !isInviteMetadataSnapshot(value.snapshot) ||
    !isRecord(value.viewer) ||
    !hasExactKeys(value.viewer, ["role", "actorUid", "automatchOperationId"])
  ) {
    return false;
  }
  const { role, actorUid, automatchOperationId } = value.viewer;
  return (
    ((role === "watch" && actorUid === null) ||
      (role === "host" && actorUid === value.snapshot.hostId) ||
      (role === "guest" &&
        value.snapshot.guestId !== null &&
        actorUid === value.snapshot.guestId)) &&
    (automatchOperationId === null ||
      (typeof automatchOperationId === "string" &&
        game_sessions_js_1.GAME_SESSION_OPERATION_ID_PATTERN.test(
          automatchOperationId,
        )))
  );
}
function isInviteMetadataMessage(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "type", "snapshot"]) &&
    value.schemaVersion === 1 &&
    value.type === "snapshot" &&
    isInviteMetadataSnapshot(value.snapshot)
  );
}
