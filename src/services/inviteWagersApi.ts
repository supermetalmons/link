import { normalizeRecordKey } from "@mons/shared/ids";
import {
  INVITE_WAGERS_MAX_MESSAGE_BYTES,
  INVITE_WAGERS_SOCKET_PROTOCOL,
  isReadInviteWagersResponse,
  type ReadInviteWagersResponse,
} from "@mons/shared/invite-wagers";
import {
  REACTION_AUTH_PROTOCOL_PREFIX,
  isReactionSocketToken,
} from "@mons/shared/reactions";
import { readSnapshotJson, type AuthTokenProvider } from "./apiTransport";

const INVITE_WAGERS_API_ROOT = "https://api.mons.link";
export const INVITE_WAGERS_REQUEST_TIMEOUT_MS = 10_000;

export class InviteWagersApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: string, status?: number, retryAfterMs?: number) {
    super(code);
    this.name = "InviteWagersApiError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function wagersPath(inviteId: string): string {
  if (!inviteId || normalizeRecordKey(inviteId) !== inviteId) {
    throw new InviteWagersApiError("invalid-invite");
  }
  return `/invites/${encodeURIComponent(inviteId)}/wagers`;
}

export function getInviteWagersSocketUrl(inviteId: string): string {
  return `${INVITE_WAGERS_API_ROOT.replace("https:", "wss:")}${wagersPath(inviteId)}/socket`;
}

export function createInviteWagersSocketProtocols(token: string): string[] {
  if (!isReactionSocketToken(token)) {
    throw new InviteWagersApiError("invalid-wagers-socket-token");
  }
  return [
    INVITE_WAGERS_SOCKET_PROTOCOL,
    `${REACTION_AUTH_PROTOCOL_PREFIX}${token}`,
  ];
}

export async function readInviteWagersViaApi(
  inviteId: string,
  tokenProvider?: AuthTokenProvider,
  options: { signal?: AbortSignal } = {},
): Promise<ReadInviteWagersResponse> {
  const path = wagersPath(inviteId);
  return readSnapshotJson({
    url: `${INVITE_WAGERS_API_ROOT}${path}`,
    tokenProvider,
    signal: options.signal,
    timeoutMs: INVITE_WAGERS_REQUEST_TIMEOUT_MS,
    maxResponseBytes: INVITE_WAGERS_MAX_MESSAGE_BYTES,
    validate: (payload): payload is ReadInviteWagersResponse =>
      isReadInviteWagersResponse(payload) &&
      payload.snapshot.inviteId === inviteId,
    createError: (code, status, retryAfterMs) =>
      new InviteWagersApiError(code, status, retryAfterMs),
  });
}
