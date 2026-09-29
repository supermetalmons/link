import { normalizeRecordKey } from "@mons/shared/ids";
import { parseInviteMatchIndex } from "@mons/shared/rematches";
import {
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  MATCH_SYNC_SOCKET_PROTOCOL,
  isReadMatchSyncResponse,
  type ReadMatchSyncResponse,
} from "@mons/shared/match-sync";
import {
  REACTION_AUTH_PROTOCOL_PREFIX,
  isReactionSocketToken,
} from "@mons/shared/reactions";
import { readSnapshotJson, type AuthTokenProvider } from "./apiTransport";

const MATCH_SYNC_API_ROOT = "https://api.mons.link";
export const MATCH_SYNC_REQUEST_TIMEOUT_MS = 10_000;

export class MatchSyncApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: string, status?: number, retryAfterMs?: number) {
    super(code);
    this.name = "MatchSyncApiError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function matchSyncPath(inviteId: string, matchId: string): string {
  if (
    !inviteId ||
    normalizeRecordKey(inviteId) !== inviteId ||
    normalizeRecordKey(matchId) !== matchId ||
    parseInviteMatchIndex(inviteId, matchId) === null
  ) {
    throw new MatchSyncApiError("invalid-invite");
  }
  return `/invites/${encodeURIComponent(inviteId)}/matches/${encodeURIComponent(matchId)}`;
}

export function getMatchSyncSocketUrl(
  inviteId: string,
  matchId: string,
): string {
  return `${MATCH_SYNC_API_ROOT.replace("https:", "wss:")}${matchSyncPath(inviteId, matchId)}/socket`;
}

export function createMatchSyncSocketProtocols(token: string): string[] {
  if (!isReactionSocketToken(token)) {
    throw new MatchSyncApiError("invalid-match-sync-socket-token");
  }
  return [
    MATCH_SYNC_SOCKET_PROTOCOL,
    `${REACTION_AUTH_PROTOCOL_PREFIX}${token}`,
  ];
}

export async function readMatchSyncViaApi(
  inviteId: string,
  matchId: string,
  tokenProvider?: AuthTokenProvider,
  options: { signal?: AbortSignal } = {},
): Promise<ReadMatchSyncResponse> {
  const path = matchSyncPath(inviteId, matchId);
  return readSnapshotJson({
    url: `${MATCH_SYNC_API_ROOT}${path}/snapshot`,
    tokenProvider,
    signal: options.signal,
    timeoutMs: MATCH_SYNC_REQUEST_TIMEOUT_MS,
    maxResponseBytes: MATCH_SYNC_MAX_MESSAGE_BYTES,
    validate: (payload): payload is ReadMatchSyncResponse =>
      isReadMatchSyncResponse(payload) &&
      payload.snapshot.inviteId === inviteId &&
      payload.snapshot.matchId === matchId,
    createError: (code, status, retryAfterMs) =>
      new MatchSyncApiError(code, status, retryAfterMs),
  });
}
