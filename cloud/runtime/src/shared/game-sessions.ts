import { normalizeAuthPresentation } from "./auth.js";
import { INVITE_ID_RANDOM_LENGTH, isSafeRecordKey } from "./ids.js";
import { parseInviteMatchIndex } from "./rematches.js";
import {
  CONTROLLER_VERSION,
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
} from "./match-protocol.js";

export type GameSessionPresentation = {
  emojiId: number;
  aura: string;
};

export type GameSessionOperation = {
  operationId: string;
  inviteId: string;
};

export type GameSessionMatch = {
  version: number;
  color: "white" | "black";
  emojiId: number;
  aura: string;
  gameVariant: string;
  fen: string;
  status: string;
  flatMovesString: string;
  timer: string;
};

export type HistoricalMatchRecord = GameSessionMatch;

export type ReadMatchSnapshotRequest = {
  playerId: string;
  matchId: string;
};

export type ReadMatchSnapshotResponse = ReadMatchSnapshotRequest & {
  ok: true;
  match: GameSessionMatch | null;
};

export type HistoricalMatchPair = {
  matchId: string;
  hostPlayerId: string;
  guestPlayerId: string | null;
  hostMatch: HistoricalMatchRecord | null;
  guestMatch: HistoricalMatchRecord | null;
};

export type ReadHistoricalMatchRequest = {
  inviteId: string;
  matchId: string;
};

export type ReadHistoricalMatchResponse = {
  ok: true;
  pair: HistoricalMatchPair | null;
};

export type CreateInviteRequest = GameSessionOperation &
  GameSessionPresentation;

export type CreateInviteResponse = {
  ok: true;
  inviteId: string;
  hostId: string;
  matchId: string;
};

export type JoinInviteRequest = GameSessionOperation & GameSessionPresentation;

export type JoinInviteResponse = {
  ok: true;
  inviteId: string;
  guestId: string | null;
  joined: boolean;
  matchId: string | null;
};

export type InviteRole = "host" | "guest" | "watch";

export type ResolveInviteRoleRequest = { inviteId: string };

export type ResolveInviteRoleResponse = {
  ok: true;
  inviteId: string;
  hostId: string;
  guestId: string | null;
  actorUid: string | null;
  role: InviteRole;
};

export type ProposeRematchRequest = GameSessionOperation &
  GameSessionPresentation;

export type ProposeRematchResponse = {
  ok: true;
  inviteId: string;
  actorUid: string;
  matchId: string;
  rematches: string;
  match: GameSessionMatch;
};

export type EndRematchRequest = GameSessionOperation;

export type EndRematchResponse = {
  ok: true;
  inviteId: string;
  actorUid: string;
  rematches: string;
};

export type EnsureMatchRequest = GameSessionOperation &
  GameSessionPresentation & { matchId: string };

export type EnsureMatchResponse = {
  ok: true;
  inviteId: string;
  actorUid: string;
  matchId: string;
  created: boolean;
  match: GameSessionMatch;
};

export type SurrenderMatchRequest = {
  inviteId: string;
  matchId: string;
  playerId: string;
};

export type SurrenderMatchResponse = {
  ok: true;
  inviteId: string;
  matchId: string;
  actorUid: string;
};

export type SubmitMoveRequest = SurrenderMatchRequest & {
  previousFlatMovesString: string;
  flatMovesString: string;
  fen: string;
  gameVariant?: string;
  previousStates?: MovePreviousState[];
};

export type MovePreviousState = {
  moveCount: number;
  fen: string;
};

export type SubmitMoveResponse = SurrenderMatchResponse &
  (
    | { outcome: "applied" | "already-applied" }
    | { outcome: "superseded"; fen: string; flatMovesString: string }
  );

const GAME_SESSION_OPERATION_ID_PATTERN: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_GAME_SESSION_RESPONSE_BYTES: number = 640 * 1024;
const MATCH_SNAPSHOT_PATH = "/matches/snapshot";
const MATCH_MOVE_PATH = "/matches/move";
const MAX_MATCH_MOVE_REQUEST_BYTES: 1048576 = (1024 * 1024) as 1048576;
const MAX_MATCH_MOVE_PREVIOUS_STATES = 64;
const MAX_GAME_SESSION_GAME_VARIANT_BYTES = 256;
const MAX_GAME_SESSION_STATUS_BYTES: number = 1024;
const MAX_GAME_SESSION_TIMER_BYTES: number = 1024;
const MANUAL_INVITE_ID_PATTERN: RegExp = new RegExp(
  `^[A-Za-z0-9]{${INVITE_ID_RANDOM_LENGTH}}$`,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
};

const isOperationId = (value: unknown): value is string =>
  typeof value === "string" && GAME_SESSION_OPERATION_ID_PATTERN.test(value);

const isPresentation = (value: Record<string, unknown>) => {
  if (typeof value.aura !== "string") {
    return false;
  }
  const normalized = normalizeAuthPresentation(value.emojiId, value.aura);
  return normalized.emoji === value.emojiId && normalized.aura === value.aura;
};

const isBaseRequest = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> & {
  operationId: string;
  inviteId: string;
} =>
  isRecord(value) &&
  hasExactKeys(value, keys) &&
  isOperationId(value.operationId) &&
  typeof value.inviteId === "string" &&
  isSafeRecordKey(value.inviteId);

const isBoundedString = (value: unknown, maxBytes: number): value is string =>
  typeof value === "string" &&
  value.length <= maxBytes &&
  new TextEncoder().encode(value).byteLength <= maxBytes;

const isCreateInviteRequest = (value: unknown): value is CreateInviteRequest =>
  isBaseRequest(value, ["operationId", "inviteId", "emojiId", "aura"]) &&
  MANUAL_INVITE_ID_PATTERN.test(value.inviteId) &&
  isPresentation(value);

const isJoinInviteRequest = (value: unknown): value is JoinInviteRequest =>
  isBaseRequest(value, ["operationId", "inviteId", "emojiId", "aura"]) &&
  isPresentation(value);

const isResolveInviteRoleRequest = (
  value: unknown,
): value is ResolveInviteRoleRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId"]) &&
  typeof value.inviteId === "string" &&
  isSafeRecordKey(value.inviteId);

const isProposeRematchRequest: (
  value: unknown,
) => value is ProposeRematchRequest = isJoinInviteRequest;

const isEndRematchRequest = (value: unknown): value is EndRematchRequest =>
  isBaseRequest(value, ["operationId", "inviteId"]);

const isEnsureMatchRequest = (value: unknown): value is EnsureMatchRequest =>
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

const isSurrenderMatchKey = (value: unknown): value is string =>
  typeof value === "string" && value === value.trim() && isSafeRecordKey(value);

const isSurrenderMatchRequest = (
  value: unknown,
): value is SurrenderMatchRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId", "playerId"]) &&
  isSurrenderMatchKey(value.inviteId) &&
  isSurrenderMatchKey(value.matchId) &&
  isSurrenderMatchKey(value.playerId) &&
  value.playerId.length <= 128 &&
  parseInviteMatchIndex(value.inviteId, value.matchId) !== null;

const isSurrenderMatchResponse = (
  value: unknown,
): value is SurrenderMatchResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "inviteId", "matchId", "actorUid"]) &&
  value.ok === true &&
  isSurrenderMatchRequest({
    inviteId: value.inviteId,
    matchId: value.matchId,
    playerId: value.actorUid,
  });

const countMoveHistory = (history: string): number =>
  history === "" ? 0 : history.split("-").length;

const isMoveHistoryPrefix = (prefix: string, history: string): boolean =>
  prefix === "" || prefix === history || history.startsWith(`${prefix}-`);

const isSubmitMoveRequest = (value: unknown): value is SubmitMoveRequest => {
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

const isSubmitMoveResponse = (value: unknown): value is SubmitMoveResponse => {
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

const isCanonicalMatchRecord = (value: unknown): value is GameSessionMatch =>
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

const isMatchRecord = (value: unknown): value is GameSessionMatch =>
  isCanonicalMatchRecord(value) && value.fen !== "";

const normalizeHistoricalMatchRecord = (
  value: unknown,
): HistoricalMatchRecord | null => {
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

const isMatchSnapshotKey = (value: unknown): value is string => {
  if (!isSurrenderMatchKey(value)) return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
};

const isReadMatchSnapshotRequest = (
  value: unknown,
): value is ReadMatchSnapshotRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["playerId", "matchId"]) &&
  isMatchSnapshotKey(value.playerId) &&
  value.playerId.length <= 128 &&
  isMatchSnapshotKey(value.matchId);

const normalizeMatchSnapshot = (value: unknown): GameSessionMatch | null => {
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

const isReadMatchSnapshotResponse = (
  value: unknown,
): value is ReadMatchSnapshotResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "playerId", "matchId", "match"]) &&
  value.ok === true &&
  isReadMatchSnapshotRequest({
    playerId: value.playerId,
    matchId: value.matchId,
  }) &&
  (value.match === null || isMatchRecord(value.match));

const isHistoricalMatchPair = (value: unknown): value is HistoricalMatchPair =>
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

const isReadHistoricalMatchRequest = (
  value: unknown,
): value is ReadHistoricalMatchRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId"]) &&
  typeof value.inviteId === "string" &&
  isSafeRecordKey(value.inviteId) &&
  typeof value.matchId === "string" &&
  isSafeRecordKey(value.matchId) &&
  parseInviteMatchIndex(value.inviteId, value.matchId) !== null;

const isReadHistoricalMatchResponse = (
  value: unknown,
): value is ReadHistoricalMatchResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "pair"]) &&
  value.ok === true &&
  (value.pair === null || isHistoricalMatchPair(value.pair));

const isCreateInviteResponse = (
  value: unknown,
): value is CreateInviteResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "inviteId", "hostId", "matchId"]) &&
  value.ok === true &&
  typeof value.inviteId === "string" &&
  value.inviteId !== "" &&
  typeof value.hostId === "string" &&
  value.hostId !== "" &&
  value.matchId === value.inviteId;

const isJoinInviteResponse = (value: unknown): value is JoinInviteResponse =>
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

const isResolveInviteRoleResponse = (
  value: unknown,
): value is ResolveInviteRoleResponse =>
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

const isProposeRematchResponse = (
  value: unknown,
): value is ProposeRematchResponse =>
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

const isEndRematchResponse = (value: unknown): value is EndRematchResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "inviteId", "actorUid", "rematches"]) &&
  value.ok === true &&
  typeof value.inviteId === "string" &&
  value.inviteId !== "" &&
  typeof value.actorUid === "string" &&
  value.actorUid !== "" &&
  typeof value.rematches === "string" &&
  value.rematches.endsWith("x");

const isEnsureMatchResponse = (value: unknown): value is EnsureMatchResponse =>
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

export {
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
  isMatchRecord as isGameSessionMatch,
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
