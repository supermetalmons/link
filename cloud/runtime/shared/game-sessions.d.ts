// Generated from src/shared/game-sessions.ts. Run npm run generate:runtime.
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
export type ResolveInviteRoleRequest = {
  inviteId: string;
};
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
  GameSessionPresentation & {
    matchId: string;
  };
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
    | {
        outcome: "applied" | "already-applied";
      }
    | {
        outcome: "superseded";
        fen: string;
        flatMovesString: string;
      }
  );
declare const GAME_SESSION_OPERATION_ID_PATTERN: RegExp;
declare const MAX_GAME_SESSION_RESPONSE_BYTES: number;
declare const MATCH_SNAPSHOT_PATH = "/matches/snapshot";
declare const MATCH_MOVE_PATH = "/matches/move";
declare const MAX_MATCH_MOVE_REQUEST_BYTES: 1048576;
declare const MAX_MATCH_MOVE_PREVIOUS_STATES = 64;
declare const MAX_GAME_SESSION_GAME_VARIANT_BYTES = 256;
declare const MAX_GAME_SESSION_STATUS_BYTES: number;
declare const MAX_GAME_SESSION_TIMER_BYTES: number;
declare const MANUAL_INVITE_ID_PATTERN: RegExp;
declare const isCreateInviteRequest: (
  value: unknown,
) => value is CreateInviteRequest;
declare const isJoinInviteRequest: (
  value: unknown,
) => value is JoinInviteRequest;
declare const isResolveInviteRoleRequest: (
  value: unknown,
) => value is ResolveInviteRoleRequest;
declare const isProposeRematchRequest: (
  value: unknown,
) => value is ProposeRematchRequest;
declare const isEndRematchRequest: (
  value: unknown,
) => value is EndRematchRequest;
declare const isEnsureMatchRequest: (
  value: unknown,
) => value is EnsureMatchRequest;
declare const isSurrenderMatchRequest: (
  value: unknown,
) => value is SurrenderMatchRequest;
declare const isSurrenderMatchResponse: (
  value: unknown,
) => value is SurrenderMatchResponse;
declare const countMoveHistory: (history: string) => number;
declare const isMoveHistoryPrefix: (prefix: string, history: string) => boolean;
declare const isSubmitMoveRequest: (
  value: unknown,
) => value is SubmitMoveRequest;
declare const isSubmitMoveResponse: (
  value: unknown,
) => value is SubmitMoveResponse;
declare const isMatchRecord: (value: unknown) => value is GameSessionMatch;
declare const normalizeHistoricalMatchRecord: (
  value: unknown,
) => HistoricalMatchRecord | null;
declare const isReadMatchSnapshotRequest: (
  value: unknown,
) => value is ReadMatchSnapshotRequest;
declare const normalizeMatchSnapshot: (
  value: unknown,
) => GameSessionMatch | null;
declare const isReadMatchSnapshotResponse: (
  value: unknown,
) => value is ReadMatchSnapshotResponse;
declare const isHistoricalMatchPair: (
  value: unknown,
) => value is HistoricalMatchPair;
declare const isReadHistoricalMatchRequest: (
  value: unknown,
) => value is ReadHistoricalMatchRequest;
declare const isReadHistoricalMatchResponse: (
  value: unknown,
) => value is ReadHistoricalMatchResponse;
declare const isCreateInviteResponse: (
  value: unknown,
) => value is CreateInviteResponse;
declare const isJoinInviteResponse: (
  value: unknown,
) => value is JoinInviteResponse;
declare const isResolveInviteRoleResponse: (
  value: unknown,
) => value is ResolveInviteRoleResponse;
declare const isProposeRematchResponse: (
  value: unknown,
) => value is ProposeRematchResponse;
declare const isEndRematchResponse: (
  value: unknown,
) => value is EndRematchResponse;
declare const isEnsureMatchResponse: (
  value: unknown,
) => value is EnsureMatchResponse;
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
