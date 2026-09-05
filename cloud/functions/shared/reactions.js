"use strict";

const { normalizeFirebaseKey } = require("./ids");
const { VALID_REACTION_IDS } = require("./nfts");
const { parseInviteMatchIndex } = require("./rematches");

const REACTION_PROTOCOL_VERSION = 1;
const REACTION_MAX_MESSAGE_BYTES = 4096;
const REACTION_HEARTBEAT_REQUEST = "ping";
const REACTION_HEARTBEAT_RESPONSE = "pong";
const REACTION_SOCKET_PROTOCOL = "mons-reactions-v1";
const REACTION_AUTH_PROTOCOL_PREFIX = "bearer.";
const FIXED_STICKER_IDS = Object.freeze([
  900316, 900101, 900393, 90063, 900109, 900228, 900245, 900189, 900267, 900374,
  900347, 900382, 900429, 900225, 900999,
]);
const STICKER_ID_WHITELIST = Object.freeze([
  ...VALID_REACTION_IDS,
  ...FIXED_STICKER_IDS,
]);
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
  typeof value === "string" && normalizeFirebaseKey(value) === value;

const isReactionSocketToken = (value) =>
  typeof value === "string" &&
  value.length <= REACTION_MAX_MESSAGE_BYTES &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);

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

const isReaction = (value) =>
  hasReactionFields(value) &&
  hasExactKeys(value, ["uuid", "kind", "variation"]);

const isInviteReaction = (value) =>
  hasReactionFields(value) &&
  hasExactKeys(value, ["uuid", "kind", "variation", "matchId"]) &&
  isExactKey(value.matchId);

const isInviteReactionForInvite = (inviteId, value) =>
  isExactKey(inviteId) &&
  isInviteReaction(value) &&
  parseInviteMatchIndex(inviteId, value.matchId) !== null;

function isInviteReactionMessage(value) {
  if (!isRecord(value) || value.schemaVersion !== REACTION_PROTOCOL_VERSION) {
    return false;
  }
  if (value.type === "snapshot") {
    return (
      hasExactKeys(value, ["schemaVersion", "type", "reactions"]) &&
      isRecord(value.reactions) &&
      Object.keys(value.reactions).length <= 2 &&
      Object.entries(value.reactions).every(
        ([senderUid, reaction]) =>
          isExactKey(senderUid) && isInviteReaction(reaction),
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

const isSendInviteReactionResponse = (value) =>
  isRecord(value) && value.ok === true && hasExactKeys(value, ["ok"]);

module.exports = {
  FIXED_STICKER_IDS,
  STICKER_ID_WHITELIST,
  REACTION_PROTOCOL_VERSION,
  REACTION_MAX_MESSAGE_BYTES,
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_SOCKET_PROTOCOL,
  REACTION_AUTH_PROTOCOL_PREFIX,
  isReaction,
  isReactionSocketToken,
  isInviteReaction,
  isInviteReactionForInvite,
  isInviteReactionMessage,
  isSendInviteReactionResponse,
};
