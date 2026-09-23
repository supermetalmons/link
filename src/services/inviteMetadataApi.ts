import { normalizeRecordKey } from "@mons/shared/ids";
import {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  INVITE_METADATA_SOCKET_PROTOCOL,
  isReadInviteMetadataResponse,
  type ReadInviteMetadataResponse,
} from "@mons/shared/invite-metadata";
import {
  REACTION_AUTH_PROTOCOL_PREFIX,
  isReactionSocketToken,
} from "@mons/shared/reactions";
import { readSnapshotJson, type AuthTokenProvider } from "./apiTransport";

const INVITE_METADATA_API_ROOT = "https://api.mons.link";
export const INVITE_METADATA_REQUEST_TIMEOUT_MS = 10_000;

export class InviteMetadataApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: string, status?: number, retryAfterMs?: number) {
    super(code);
    this.name = "InviteMetadataApiError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function metadataPath(inviteId: string): string {
  if (!inviteId || normalizeRecordKey(inviteId) !== inviteId) {
    throw new InviteMetadataApiError("invalid-invite");
  }
  return `/invites/${encodeURIComponent(inviteId)}/metadata`;
}

export function getInviteMetadataSocketUrl(inviteId: string): string {
  return `${INVITE_METADATA_API_ROOT.replace("https:", "wss:")}${metadataPath(inviteId)}/socket`;
}

export function createInviteMetadataSocketProtocols(token: string): string[] {
  if (!isReactionSocketToken(token)) {
    throw new InviteMetadataApiError("invalid-metadata-socket-token");
  }
  return [
    INVITE_METADATA_SOCKET_PROTOCOL,
    `${REACTION_AUTH_PROTOCOL_PREFIX}${token}`,
  ];
}

export async function readInviteMetadataViaApi(
  inviteId: string,
  tokenProvider?: AuthTokenProvider,
  options: { signal?: AbortSignal } = {},
): Promise<ReadInviteMetadataResponse> {
  const path = metadataPath(inviteId);
  return readSnapshotJson({
    url: `${INVITE_METADATA_API_ROOT}${path}`,
    tokenProvider,
    signal: options.signal,
    timeoutMs: INVITE_METADATA_REQUEST_TIMEOUT_MS,
    maxResponseBytes: INVITE_METADATA_MAX_MESSAGE_BYTES,
    validate: (payload): payload is ReadInviteMetadataResponse =>
      isReadInviteMetadataResponse(payload) &&
      payload.snapshot.inviteId === inviteId,
    createError: (code, status, retryAfterMs) =>
      new InviteMetadataApiError(code, status, retryAfterMs),
  });
}
