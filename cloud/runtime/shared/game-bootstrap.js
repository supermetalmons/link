// Generated from src/shared/game-bootstrap.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GAME_BOOTSTRAP_MAX_RESPONSE_BYTES = void 0;
exports.isReadGameBootstrapResponse = isReadGameBootstrapResponse;
const invite_metadata_js_1 = require("./invite-metadata.js");
const match_sync_js_1 = require("./match-sync.js");
const rematches_js_1 = require("./rematches.js");
const GAME_BOOTSTRAP_MAX_RESPONSE_BYTES =
  invite_metadata_js_1.INVITE_METADATA_MAX_MESSAGE_BYTES +
  match_sync_js_1.MATCH_SYNC_MAX_MESSAGE_BYTES +
  4096;
exports.GAME_BOOTSTRAP_MAX_RESPONSE_BYTES = GAME_BOOTSTRAP_MAX_RESPONSE_BYTES;
function isReadGameBootstrapResponse(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value;
  if (
    Object.keys(value).length !== 6 ||
    !Object.keys(value).every((key) =>
      [
        "ok",
        "schemaVersion",
        "metadata",
        "viewer",
        "match",
        "hasPendingProposal",
      ].includes(key),
    ) ||
    record.ok !== true ||
    record.schemaVersion !== 1 ||
    typeof record.hasPendingProposal !== "boolean" ||
    !(0, invite_metadata_js_1.isReadInviteMetadataResponse)({
      ok: true,
      snapshot: record.metadata,
      viewer: record.viewer,
    }) ||
    !(0, match_sync_js_1.isMatchSyncSnapshot)(record.match) ||
    record.match.inviteId !== record.metadata.inviteId ||
    record.match.hostPlayerId !== record.metadata.hostId ||
    record.match.guestPlayerId !== record.metadata.guestId
  ) {
    return false;
  }
  const response = record;
  const selection = (0, rematches_js_1.selectInviteMatch)(
    response.metadata.inviteId,
    response.metadata,
    response.viewer.actorUid,
    { preferApproved: !response.hasPendingProposal },
  );
  return (
    selection.matchId === response.match.matchId &&
    selection.hasPendingProposal === response.hasPendingProposal
  );
}
