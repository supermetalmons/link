// Generated from src/shared/reactions.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSendInviteReactionResponse =
  exports.isInviteReactionForInvite =
  exports.isInviteReaction =
  exports.isReactionSocketToken =
  exports.REACTION_AUTH_PROTOCOL_PREFIX =
  exports.REACTION_SOCKET_PROTOCOL =
  exports.REACTION_HEARTBEAT_RESPONSE =
  exports.REACTION_HEARTBEAT_REQUEST =
  exports.REACTION_MAX_MESSAGE_BYTES =
  exports.REACTION_PROTOCOL_VERSION =
  exports.STICKER_ID_WHITELIST =
  exports.FIXED_STICKER_IDS =
    void 0;
exports.isInviteRoomMessage = isInviteRoomMessage;
const ids_js_1 = require("./ids.js");
const nfts_js_1 = require("./nfts.js");
const rematches_js_1 = require("./rematches.js");
const match_presentation_js_1 = require("./match-presentation.js");
const REACTION_PROTOCOL_VERSION = 2;
exports.REACTION_PROTOCOL_VERSION = REACTION_PROTOCOL_VERSION;
const REACTION_MAX_MESSAGE_BYTES = 4096;
exports.REACTION_MAX_MESSAGE_BYTES = REACTION_MAX_MESSAGE_BYTES;
const REACTION_HEARTBEAT_REQUEST = "ping";
exports.REACTION_HEARTBEAT_REQUEST = REACTION_HEARTBEAT_REQUEST;
const REACTION_HEARTBEAT_RESPONSE = "pong";
exports.REACTION_HEARTBEAT_RESPONSE = REACTION_HEARTBEAT_RESPONSE;
const REACTION_SOCKET_PROTOCOL = "mons-reactions-v2";
exports.REACTION_SOCKET_PROTOCOL = REACTION_SOCKET_PROTOCOL;
const REACTION_AUTH_PROTOCOL_PREFIX = "bearer.";
exports.REACTION_AUTH_PROTOCOL_PREFIX = REACTION_AUTH_PROTOCOL_PREFIX;
const FIXED_STICKER_IDS = Object.freeze([
  900316, 900101, 900393, 90063, 900109, 900228, 900245, 900189, 900267, 900374,
  900347, 900382, 900429, 900225, 900999,
]);
exports.FIXED_STICKER_IDS = FIXED_STICKER_IDS;
const STICKER_ID_WHITELIST = Object.freeze([
  ...nfts_js_1.VALID_REACTION_IDS,
  ...FIXED_STICKER_IDS,
]);
exports.STICKER_ID_WHITELIST = STICKER_ID_WHITELIST;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOICE_VARIATIONS = Object.freeze({
  yo: 4,
  gg: 2,
  wahoo: 1,
  drop: 1,
  slurp: 1,
});
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, keys) => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
};
const isExactKey = (value) =>
  typeof value === "string" &&
  (0, ids_js_1.normalizeRecordKey)(value) === value;
const isReactionSocketToken = (value) =>
  typeof value === "string" &&
  value.length <= REACTION_MAX_MESSAGE_BYTES &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
exports.isReactionSocketToken = isReactionSocketToken;
function hasReactionFields(value) {
  if (
    !isRecord(value) ||
    typeof value.uuid !== "string" ||
    !UUID_PATTERN.test(value.uuid) ||
    typeof value.kind !== "string" ||
    !Number.isSafeInteger(value.variation) ||
    value.variation < 1
  ) {
    return false;
  }
  return value.kind === "sticker"
    ? STICKER_ID_WHITELIST.includes(value.variation)
    : Object.hasOwn(VOICE_VARIATIONS, value.kind) &&
        value.variation <= VOICE_VARIATIONS[value.kind];
}
const isInviteReaction = (value) =>
  hasReactionFields(value) &&
  hasExactKeys(value, ["uuid", "kind", "variation", "matchId"]) &&
  isExactKey(value.matchId);
exports.isInviteReaction = isInviteReaction;
const isInviteReactionForInvite = (inviteId, value) =>
  isExactKey(inviteId) &&
  isInviteReaction(value) &&
  (0, rematches_js_1.parseInviteMatchIndex)(inviteId, value.matchId) !== null;
exports.isInviteReactionForInvite = isInviteReactionForInvite;
const isSendInviteReactionResponse = (value) =>
  isRecord(value) && value.ok === true && hasExactKeys(value, ["ok"]);
exports.isSendInviteReactionResponse = isSendInviteReactionResponse;
function isInviteRoomMessage(value) {
  if (!isRecord(value) || value.schemaVersion !== REACTION_PROTOCOL_VERSION)
    return false;
  if (value.type === "presentation") {
    return (
      hasExactKeys(value, ["schemaVersion", "type", "presentation"]) &&
      (0, match_presentation_js_1.isMatchPresentation)(value.presentation)
    );
  }
  if (value.type === "snapshot") {
    return (
      hasExactKeys(value, [
        "schemaVersion",
        "type",
        "reactions",
        "presentation",
      ]) &&
      isRecord(value.reactions) &&
      Object.keys(value.reactions).length <= 2 &&
      Object.entries(value.reactions).every(
        ([senderUid, reaction]) =>
          isExactKey(senderUid) && isInviteReaction(reaction),
      ) &&
      (0, match_presentation_js_1.isMatchPresentationSnapshot)(
        value.presentation,
      )
    );
  }
  return (
    value.type === "reaction" &&
    hasExactKeys(value, ["schemaVersion", "type", "senderUid", "reaction"]) &&
    isExactKey(value.senderUid) &&
    isInviteReaction(value.reaction)
  );
}
