"use strict";

const { normalizeAuthPresentation } = require("./auth");
const { INVITE_ID_RANDOM_LENGTH, isSafeRecordKey } = require("./ids");
const { parseInviteMatchIndex } = require("./rematches");
const {
  CONTROLLER_VERSION,
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
} = require("./match-protocol");

const GAME_SESSION_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_GAME_SESSION_RESPONSE_BYTES = 640 * 1024;
const MATCH_SNAPSHOT_PATH = "/matches/snapshot";
const MATCH_MOVE_PATH = "/matches/move";
const MAX_MATCH_MOVE_REQUEST_BYTES = 1024 * 1024;
const MAX_MATCH_MOVE_PREVIOUS_STATES = 64;
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
  isSafeRecordKey(value.inviteId);

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
  isSafeRecordKey(value.inviteId);

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
  isSafeRecordKey(value.matchId) &&
  isPresentation(value);

const isSurrenderMatchKey = (value) =>
  typeof value === "string" && value === value.trim() && isSafeRecordKey(value);

const isSurrenderMatchRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId", "playerId"]) &&
  isSurrenderMatchKey(value.inviteId) &&
  isSurrenderMatchKey(value.matchId) &&
  isSurrenderMatchKey(value.playerId) &&
  value.playerId.length <= 128 &&
  parseInviteMatchIndex(value.inviteId, value.matchId) !== null;

const isSurrenderMatchResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "inviteId", "matchId", "actorUid"]) &&
  value.ok === true &&
  isSurrenderMatchRequest({
    inviteId: value.inviteId,
    matchId: value.matchId,
    playerId: value.actorUid,
  });

const countMoveHistory = (history) =>
  history === "" ? 0 : history.split("-").length;

const isMoveHistoryPrefix = (prefix, history) =>
  prefix === "" || prefix === history || history.startsWith(`${prefix}-`);

const isSubmitMoveRequest = (value) => {
  if (!isRecord(value)) return false;
  const keys = [
    "inviteId",
    "matchId",
    "playerId",
    "previousFlatMovesString",
    "flatMovesString",
    "fen",
  ];
  if (Object.hasOwn(value, "gameVariant")) keys.push("gameVariant");
  if (Object.hasOwn(value, "previousStates")) keys.push("previousStates");
  if (
    !hasExactKeys(value, keys) ||
    !isSurrenderMatchRequest({
      inviteId: value.inviteId,
      matchId: value.matchId,
      playerId: value.playerId,
    }) ||
    !isMatchFenWithinLimit(value.fen) ||
    value.fen === "" ||
    !isMatchHistoryWithinLimits(value.previousFlatMovesString) ||
    !isMatchHistoryWithinLimits(value.flatMovesString) ||
    (Object.hasOwn(value, "gameVariant") &&
      (!isBoundedString(
        value.gameVariant,
        MAX_GAME_SESSION_GAME_VARIANT_BYTES,
      ) ||
        value.gameVariant === ""))
  ) {
    return false;
  }
  const prefix = value.previousFlatMovesString
    ? `${value.previousFlatMovesString}-`
    : "";
  if (
    !value.flatMovesString.startsWith(prefix) ||
    value.flatMovesString.length <= prefix.length
  )
    return false;
  if (!Object.hasOwn(value, "previousStates")) return true;
  const states = value.previousStates;
  const baseCount = countMoveHistory(value.previousFlatMovesString);
  const targetMoves = value.flatMovesString.split("-");
  return (
    Array.isArray(states) &&
    states.length > 0 &&
    states.length <= MAX_MATCH_MOVE_PREVIOUS_STATES &&
    states.length === targetMoves.length - baseCount &&
    targetMoves.every((move) => move !== "") &&
    Array.from(states).every(
      (state, index) =>
        isRecord(state) &&
        hasExactKeys(state, ["moveCount", "fen"]) &&
        Number.isSafeInteger(state.moveCount) &&
        state.moveCount === baseCount + index &&
        isMatchFenWithinLimit(state.fen) &&
        state.fen !== "",
    ) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      MAX_MATCH_MOVE_REQUEST_BYTES
  );
};

const isSubmitMoveResponse = (value) => {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !isSurrenderMatchRequest({
      inviteId: value.inviteId,
      matchId: value.matchId,
      playerId: value.actorUid,
    })
  )
    return false;
  const keys = ["ok", "inviteId", "matchId", "actorUid", "outcome"];
  if (value.outcome === "superseded") {
    return (
      hasExactKeys(value, [...keys, "fen", "flatMovesString"]) &&
      isMatchFenWithinLimit(value.fen) &&
      value.fen !== "" &&
      isMatchHistoryWithinLimits(value.flatMovesString) &&
      value.flatMovesString !== ""
    );
  }
  return (
    hasExactKeys(value, keys) &&
    (value.outcome === "applied" || value.outcome === "already-applied")
  );
};

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

const isMatchSnapshotKey = (value) => {
  if (!isSurrenderMatchKey(value)) return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
};

const isReadMatchSnapshotRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["playerId", "matchId"]) &&
  isMatchSnapshotKey(value.playerId) &&
  value.playerId.length <= 128 &&
  isMatchSnapshotKey(value.matchId);

const normalizeMatchSnapshot = (value) => {
  if (
    !isRecord(value) ||
    typeof value.fen !== "string" ||
    value.fen === "" ||
    (Object.hasOwn(value, "version") && !Number.isSafeInteger(value.version)) ||
    (Object.hasOwn(value, "emojiId") &&
      !(
        (typeof value.emojiId === "number" ||
          (typeof value.emojiId === "string" && value.emojiId.trim() !== "")) &&
        Number.isSafeInteger(Number(value.emojiId))
      )) ||
    (Object.hasOwn(value, "aura") &&
      (typeof value.aura !== "string" || value.aura.length > 32)) ||
    (Object.hasOwn(value, "gameVariant") &&
      !isBoundedString(
        value.gameVariant,
        MAX_GAME_SESSION_GAME_VARIANT_BYTES,
      )) ||
    (Object.hasOwn(value, "status") &&
      !isBoundedString(value.status, MAX_GAME_SESSION_STATUS_BYTES)) ||
    (Object.hasOwn(value, "flatMovesString") &&
      !isMatchHistoryWithinLimits(value.flatMovesString)) ||
    (Object.hasOwn(value, "timer") &&
      !isBoundedString(value.timer, MAX_GAME_SESSION_TIMER_BYTES))
  ) {
    return null;
  }
  const match = normalizeHistoricalMatchRecord(value);
  return isMatchRecord(match) ? match : null;
};

const isReadMatchSnapshotResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "playerId", "matchId", "match"]) &&
  value.ok === true &&
  isReadMatchSnapshotRequest({
    playerId: value.playerId,
    matchId: value.matchId,
  }) &&
  (value.match === null || isMatchRecord(value.match));

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
  isSafeRecordKey(value.matchId) &&
  typeof value.hostPlayerId === "string" &&
  isSafeRecordKey(value.hostPlayerId) &&
  (value.guestPlayerId === null ||
    (typeof value.guestPlayerId === "string" &&
      isSafeRecordKey(value.guestPlayerId) &&
      value.guestPlayerId !== value.hostPlayerId)) &&
  (value.hostMatch === null || isCanonicalMatchRecord(value.hostMatch)) &&
  (value.guestMatch === null || isCanonicalMatchRecord(value.guestMatch)) &&
  (value.hostMatch !== null || value.guestMatch !== null) &&
  (value.guestPlayerId !== null || value.guestMatch === null);

const isReadHistoricalMatchRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId"]) &&
  typeof value.inviteId === "string" &&
  isSafeRecordKey(value.inviteId) &&
  typeof value.matchId === "string" &&
  isSafeRecordKey(value.matchId) &&
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
  isSafeRecordKey(value.inviteId) &&
  typeof value.hostId === "string" &&
  isSafeRecordKey(value.hostId) &&
  (value.guestId === null ||
    (typeof value.guestId === "string" && isSafeRecordKey(value.guestId))) &&
  value.guestId !== value.hostId &&
  (value.actorUid === null ||
    (typeof value.actorUid === "string" && isSafeRecordKey(value.actorUid))) &&
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
  MATCH_SNAPSHOT_PATH,
  MATCH_MOVE_PATH,
  MAX_MATCH_MOVE_REQUEST_BYTES,
  MAX_MATCH_MOVE_PREVIOUS_STATES,
  MAX_GAME_SESSION_GAME_VARIANT_BYTES,
  MAX_GAME_SESSION_STATUS_BYTES,
  MAX_GAME_SESSION_TIMER_BYTES,
  isCreateInviteRequest,
  isCreateInviteResponse,
  isEndRematchRequest,
  isEndRematchResponse,
  isEnsureMatchRequest,
  isEnsureMatchResponse,
  isSurrenderMatchRequest,
  isSurrenderMatchResponse,
  isSubmitMoveRequest,
  isSubmitMoveResponse,
  countMoveHistory,
  isMoveHistoryPrefix,
  isGameSessionMatch: isMatchRecord,
  isHistoricalMatchPair,
  isJoinInviteRequest,
  isJoinInviteResponse,
  isResolveInviteRoleRequest,
  isResolveInviteRoleResponse,
  normalizeHistoricalMatchRecord,
  normalizeMatchSnapshot,
  isReadMatchSnapshotRequest,
  isReadMatchSnapshotResponse,
  isReadHistoricalMatchRequest,
  isReadHistoricalMatchResponse,
  isProposeRematchRequest,
  isProposeRematchResponse,
};
