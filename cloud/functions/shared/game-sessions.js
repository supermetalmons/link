"use strict";

const { normalizeAuthPresentation } = require("./auth");
const { INVITE_ID_RANDOM_LENGTH, isSafeFirebaseKey } = require("./ids");
const { parseInviteMatchIndex } = require("./rematches");
const {
  CONTROLLER_VERSION,
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
} = require("./match-protocol");

const GAME_SESSION_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_GAME_SESSION_RESPONSE_BYTES = 640 * 1024;
const MAX_GAME_SESSION_GAME_VARIANT_BYTES = 256;
const MAX_GAME_SESSION_STATUS_BYTES = 1024;
const MAX_GAME_SESSION_TIMER_BYTES = 1024;
const MANUAL_INVITE_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9]{${INVITE_ID_RANDOM_LENGTH}}$`,
);

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value, expected) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
};

const isOperationId = (value) =>
  typeof value === "string" && GAME_SESSION_OPERATION_ID_PATTERN.test(value);

const isPresentation = (value) => {
  if (typeof value.aura !== "string") {
    return false;
  }
  const normalized = normalizeAuthPresentation(value.emojiId, value.aura);
  return normalized.emoji === value.emojiId && normalized.aura === value.aura;
};

const isBaseRequest = (value, keys) =>
  isRecord(value) &&
  hasExactKeys(value, keys) &&
  isOperationId(value.operationId) &&
  typeof value.inviteId === "string" &&
  isSafeFirebaseKey(value.inviteId);

const isBoundedString = (value, maxBytes) =>
  typeof value === "string" &&
  value.length <= maxBytes &&
  new TextEncoder().encode(value).byteLength <= maxBytes;

const isCreateInviteRequest = (value) =>
  isBaseRequest(value, ["operationId", "inviteId", "emojiId", "aura"]) &&
  MANUAL_INVITE_ID_PATTERN.test(value.inviteId) &&
  isPresentation(value);

const isJoinInviteRequest = (value) =>
  isBaseRequest(value, ["operationId", "inviteId", "emojiId", "aura"]) &&
  isPresentation(value);

const isResolveInviteRoleRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId"]) &&
  typeof value.inviteId === "string" &&
  isSafeFirebaseKey(value.inviteId);

const isProposeRematchRequest = isJoinInviteRequest;

const isEndRematchRequest = (value) =>
  isBaseRequest(value, ["operationId", "inviteId"]);

const isEnsureMatchRequest = (value) =>
  isBaseRequest(value, [
    "operationId",
    "inviteId",
    "matchId",
    "emojiId",
    "aura",
  ]) &&
  typeof value.matchId === "string" &&
  isSafeFirebaseKey(value.matchId) &&
  isPresentation(value);

const MATCH_RECORD_KEYS = [
  "version",
  "color",
  "emojiId",
  "aura",
  "gameVariant",
  "fen",
  "status",
  "flatMovesString",
  "timer",
];

const isCanonicalMatchRecord = (value) =>
  isRecord(value) &&
  hasExactKeys(value, MATCH_RECORD_KEYS) &&
  Number.isSafeInteger(value.version) &&
  (value.color === "white" || value.color === "black") &&
  Number.isSafeInteger(value.emojiId) &&
  typeof value.aura === "string" &&
  value.aura.length <= 32 &&
  typeof value.gameVariant === "string" &&
  value.gameVariant !== "" &&
  isBoundedString(value.gameVariant, MAX_GAME_SESSION_GAME_VARIANT_BYTES) &&
  typeof value.fen === "string" &&
  isMatchFenWithinLimit(value.fen) &&
  isBoundedString(value.status, MAX_GAME_SESSION_STATUS_BYTES) &&
  isMatchHistoryWithinLimits(value.flatMovesString) &&
  isBoundedString(value.timer, MAX_GAME_SESSION_TIMER_BYTES);

const isMatchRecord = (value) =>
  isCanonicalMatchRecord(value) && value.fen !== "";

const normalizeHistoricalMatchRecord = (value) => {
  if (!isRecord(value)) {
    return null;
  }
  const rawEmojiId =
    typeof value.emojiId === "number" || typeof value.emojiId === "string"
      ? Number(value.emojiId)
      : 0;
  const emojiId = Number.isSafeInteger(rawEmojiId) ? rawEmojiId : 0;
  const fen = typeof value.fen === "string" ? value.fen : "";
  const flatMovesString =
    typeof value.flatMovesString === "string" ? value.flatMovesString : "";
  if (
    (value.color !== "white" && value.color !== "black") ||
    !isMatchFenWithinLimit(fen) ||
    !isMatchHistoryWithinLimits(flatMovesString)
  ) {
    return null;
  }
  const rawGameVariant =
    typeof value.gameVariant === "string" && value.gameVariant.trim()
      ? value.gameVariant.trim()
      : "Classic";
  return {
    version: Number.isSafeInteger(value.version)
      ? Number(value.version)
      : CONTROLLER_VERSION,
    color: value.color,
    emojiId,
    aura:
      typeof value.aura === "string" && value.aura.length <= 32
        ? value.aura
        : "",
    gameVariant: isBoundedString(
      rawGameVariant,
      MAX_GAME_SESSION_GAME_VARIANT_BYTES,
    )
      ? rawGameVariant
      : "Classic",
    fen,
    status: isBoundedString(value.status, MAX_GAME_SESSION_STATUS_BYTES)
      ? value.status
      : "",
    flatMovesString,
    timer: isBoundedString(value.timer, MAX_GAME_SESSION_TIMER_BYTES)
      ? value.timer
      : "",
  };
};

const isHistoricalMatchPair = (value) =>
  isRecord(value) &&
  hasExactKeys(value, [
    "matchId",
    "hostPlayerId",
    "guestPlayerId",
    "hostMatch",
    "guestMatch",
  ]) &&
  typeof value.matchId === "string" &&
  isSafeFirebaseKey(value.matchId) &&
  typeof value.hostPlayerId === "string" &&
  isSafeFirebaseKey(value.hostPlayerId) &&
  (value.guestPlayerId === null ||
    (typeof value.guestPlayerId === "string" &&
      isSafeFirebaseKey(value.guestPlayerId) &&
      value.guestPlayerId !== value.hostPlayerId)) &&
  (value.hostMatch === null || isCanonicalMatchRecord(value.hostMatch)) &&
  (value.guestMatch === null || isCanonicalMatchRecord(value.guestMatch)) &&
  (value.hostMatch !== null || value.guestMatch !== null) &&
  (value.guestPlayerId !== null || value.guestMatch === null);

const isReadHistoricalMatchRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId"]) &&
  typeof value.inviteId === "string" &&
  isSafeFirebaseKey(value.inviteId) &&
  typeof value.matchId === "string" &&
  isSafeFirebaseKey(value.matchId) &&
  parseInviteMatchIndex(value.inviteId, value.matchId) !== null;

const isReadHistoricalMatchResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "pair"]) &&
  value.ok === true &&
  (value.pair === null || isHistoricalMatchPair(value.pair));

const isCreateInviteResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "inviteId", "hostId", "matchId"]) &&
  value.ok === true &&
  typeof value.inviteId === "string" &&
  value.inviteId !== "" &&
  typeof value.hostId === "string" &&
  value.hostId !== "" &&
  value.matchId === value.inviteId;

const isJoinInviteResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "inviteId", "guestId", "joined", "matchId"]) &&
  value.ok === true &&
  typeof value.inviteId === "string" &&
  value.inviteId !== "" &&
  (value.guestId === null || typeof value.guestId === "string") &&
  typeof value.joined === "boolean" &&
  (value.matchId === null || typeof value.matchId === "string") &&
  (value.joined
    ? value.guestId !== null && value.matchId === value.inviteId
    : value.matchId === null);

const isResolveInviteRoleResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, [
    "ok",
    "inviteId",
    "hostId",
    "guestId",
    "actorUid",
    "role",
  ]) &&
  value.ok === true &&
  typeof value.inviteId === "string" &&
  isSafeFirebaseKey(value.inviteId) &&
  typeof value.hostId === "string" &&
  isSafeFirebaseKey(value.hostId) &&
  (value.guestId === null ||
    (typeof value.guestId === "string" && isSafeFirebaseKey(value.guestId))) &&
  value.guestId !== value.hostId &&
  (value.actorUid === null ||
    (typeof value.actorUid === "string" &&
      isSafeFirebaseKey(value.actorUid))) &&
  (value.role === "host" || value.role === "guest" || value.role === "watch") &&
  ((value.role === "host" && value.actorUid === value.hostId) ||
    (value.role === "guest" &&
      value.guestId !== null &&
      value.actorUid === value.guestId) ||
    (value.role === "watch" && value.actorUid === null));

const isProposeRematchResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, [
    "ok",
    "inviteId",
    "actorUid",
    "matchId",
    "rematches",
    "match",
  ]) &&
  value.ok === true &&
  typeof value.inviteId === "string" &&
  value.inviteId !== "" &&
  typeof value.actorUid === "string" &&
  value.actorUid !== "" &&
  typeof value.matchId === "string" &&
  value.matchId !== "" &&
  typeof value.rematches === "string" &&
  isMatchRecord(value.match);

const isEndRematchResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "inviteId", "actorUid", "rematches"]) &&
  value.ok === true &&
  typeof value.inviteId === "string" &&
  value.inviteId !== "" &&
  typeof value.actorUid === "string" &&
  value.actorUid !== "" &&
  typeof value.rematches === "string" &&
  value.rematches.endsWith("x");

const isEnsureMatchResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, [
    "ok",
    "inviteId",
    "actorUid",
    "matchId",
    "created",
    "match",
  ]) &&
  value.ok === true &&
  typeof value.inviteId === "string" &&
  value.inviteId !== "" &&
  typeof value.actorUid === "string" &&
  value.actorUid !== "" &&
  typeof value.matchId === "string" &&
  value.matchId !== "" &&
  typeof value.created === "boolean" &&
  isMatchRecord(value.match);

module.exports = {
  GAME_SESSION_OPERATION_ID_PATTERN,
  MANUAL_INVITE_ID_PATTERN,
  MAX_GAME_SESSION_RESPONSE_BYTES,
  MAX_GAME_SESSION_GAME_VARIANT_BYTES,
  MAX_GAME_SESSION_STATUS_BYTES,
  MAX_GAME_SESSION_TIMER_BYTES,
  isCreateInviteRequest,
  isCreateInviteResponse,
  isEndRematchRequest,
  isEndRematchResponse,
  isEnsureMatchRequest,
  isEnsureMatchResponse,
  isGameSessionMatch: isMatchRecord,
  isHistoricalMatchPair,
  isJoinInviteRequest,
  isJoinInviteResponse,
  isResolveInviteRoleRequest,
  isResolveInviteRoleResponse,
  normalizeHistoricalMatchRecord,
  isReadHistoricalMatchRequest,
  isReadHistoricalMatchResponse,
  isProposeRematchRequest,
  isProposeRematchResponse,
};
