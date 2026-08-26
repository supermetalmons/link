"use strict";

const { normalizeAuthPresentation } = require("./auth");
const { INVITE_ID_RANDOM_LENGTH, isSafeFirebaseKey } = require("./ids");
const {
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
} = require("./match-protocol");

const GAME_SESSION_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_GAME_SESSION_RESPONSE_BYTES = 640 * 1024;
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
  new TextEncoder().encode(value).byteLength <= maxBytes;

const isCreateInviteRequest = (value) =>
  isBaseRequest(value, ["operationId", "inviteId", "emojiId", "aura"]) &&
  MANUAL_INVITE_ID_PATTERN.test(value.inviteId) &&
  isPresentation(value);

const isJoinInviteRequest = (value) =>
  isBaseRequest(value, ["operationId", "inviteId", "emojiId", "aura"]) &&
  isPresentation(value);

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

const isMatchRecord = (value) =>
  isRecord(value) &&
  hasExactKeys(value, [
    "version",
    "color",
    "emojiId",
    "aura",
    "gameVariant",
    "fen",
    "status",
    "flatMovesString",
    "timer",
  ]) &&
  Number.isSafeInteger(value.version) &&
  (value.color === "white" || value.color === "black") &&
  Number.isSafeInteger(value.emojiId) &&
  typeof value.aura === "string" &&
  value.aura.length <= 32 &&
  typeof value.gameVariant === "string" &&
  value.gameVariant !== "" &&
  typeof value.fen === "string" &&
  value.fen !== "" &&
  isMatchFenWithinLimit(value.fen) &&
  isBoundedString(value.status, MAX_GAME_SESSION_STATUS_BYTES) &&
  isMatchHistoryWithinLimits(value.flatMovesString) &&
  isBoundedString(value.timer, MAX_GAME_SESSION_TIMER_BYTES);

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
  MAX_GAME_SESSION_STATUS_BYTES,
  MAX_GAME_SESSION_TIMER_BYTES,
  isCreateInviteRequest,
  isCreateInviteResponse,
  isEndRematchRequest,
  isEndRematchResponse,
  isEnsureMatchRequest,
  isEnsureMatchResponse,
  isGameSessionMatch: isMatchRecord,
  isJoinInviteRequest,
  isJoinInviteResponse,
  isProposeRematchRequest,
  isProposeRematchResponse,
};
