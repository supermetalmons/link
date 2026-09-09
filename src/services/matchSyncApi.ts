import { normalizeFirebaseKey } from "@mons/shared/ids";
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
import type { AuthTokenProvider } from "./authApi";

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
    normalizeFirebaseKey(inviteId) !== inviteId ||
    normalizeFirebaseKey(matchId) !== matchId ||
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

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    Number(response.headers.get("Content-Length")) >
      MATCH_SYNC_MAX_MESSAGE_BYTES ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new MatchSyncApiError("invalid-response");
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MATCH_SYNC_MAX_MESSAGE_BYTES) {
        throw new MatchSyncApiError("invalid-response");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new MatchSyncApiError("invalid-response");
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export async function readMatchSyncViaApi(
  inviteId: string,
  matchId: string,
  tokenProvider?: AuthTokenProvider,
  options: { signal?: AbortSignal } = {},
): Promise<ReadMatchSyncResponse> {
  const path = matchSyncPath(inviteId, matchId);
  if (options.signal?.aborted) throw new MatchSyncApiError("aborted");
  const controller = new AbortController();
  const deadline = Date.now() + MATCH_SYNC_REQUEST_TIMEOUT_MS;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (code: string) => {
    rejectCancellation(new MatchSyncApiError(code));
    controller.abort();
  };
  const onAbort = () => cancel("aborted");
  const timer = setTimeout(
    () => cancel("timeout"),
    MATCH_SYNC_REQUEST_TIMEOUT_MS,
  );
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const assertCurrent = () => {
    if (controller.signal.aborted) throw new MatchSyncApiError("aborted");
    if (Date.now() >= deadline) {
      controller.abort();
      throw new MatchSyncApiError("timeout");
    }
    tokenProvider?.assertCurrentUser?.();
  };
  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      assertCurrent();
      const token = tokenProvider ? await tokenProvider(attempt === 1) : null;
      assertCurrent();
      const response = await fetch(`${MATCH_SYNC_API_ROOT}${path}/snapshot`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      try {
        assertCurrent();
      } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }
      if (response.status === 401 && tokenProvider && attempt === 0) {
        void response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new MatchSyncApiError(
          `http-${response.status}`,
          response.status,
          retryAfterMs(response),
        );
      }
      const payload = await readResponse(response, controller.signal);
      assertCurrent();
      if (
        !isReadMatchSyncResponse(payload) ||
        payload.snapshot.inviteId !== inviteId ||
        payload.snapshot.matchId !== matchId
      ) {
        throw new MatchSyncApiError("invalid-response");
      }
      return payload;
    }
    throw new MatchSyncApiError("unauthenticated", 401);
  };
  try {
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
