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

export const GAME_SESSION_OPERATION_ID_PATTERN: RegExp;
export const MANUAL_INVITE_ID_PATTERN: RegExp;
export const MAX_GAME_SESSION_RESPONSE_BYTES: number;
export const MAX_GAME_SESSION_GAME_VARIANT_BYTES: 256;
export const MAX_GAME_SESSION_STATUS_BYTES: number;
export const MAX_GAME_SESSION_TIMER_BYTES: number;

export function isCreateInviteRequest(
  value: unknown,
): value is CreateInviteRequest;
export function isCreateInviteResponse(
  value: unknown,
): value is CreateInviteResponse;
export function isJoinInviteRequest(value: unknown): value is JoinInviteRequest;
export function isJoinInviteResponse(
  value: unknown,
): value is JoinInviteResponse;
export function isResolveInviteRoleRequest(
  value: unknown,
): value is ResolveInviteRoleRequest;
export function isResolveInviteRoleResponse(
  value: unknown,
): value is ResolveInviteRoleResponse;
export function isProposeRematchRequest(
  value: unknown,
): value is ProposeRematchRequest;
export function isProposeRematchResponse(
  value: unknown,
): value is ProposeRematchResponse;
export function isEndRematchRequest(value: unknown): value is EndRematchRequest;
export function isEndRematchResponse(
  value: unknown,
): value is EndRematchResponse;
export function isEnsureMatchRequest(
  value: unknown,
): value is EnsureMatchRequest;
export function isEnsureMatchResponse(
  value: unknown,
): value is EnsureMatchResponse;
export function isGameSessionMatch(value: unknown): value is GameSessionMatch;
export function isHistoricalMatchPair(
  value: unknown,
): value is HistoricalMatchPair;
export function normalizeHistoricalMatchRecord(
  value: unknown,
): HistoricalMatchRecord | null;
export function isReadHistoricalMatchRequest(
  value: unknown,
): value is ReadHistoricalMatchRequest;
export function isReadHistoricalMatchResponse(
  value: unknown,
): value is ReadHistoricalMatchResponse;
