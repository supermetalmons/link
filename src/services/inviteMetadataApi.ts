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
import type { AuthTokenProvider } from "./authApi";

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
      INVITE_METADATA_MAX_MESSAGE_BYTES ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new InviteMetadataApiError("invalid-response");
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
      if (byteLength > INVITE_METADATA_MAX_MESSAGE_BYTES) {
        throw new InviteMetadataApiError("invalid-response");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new InviteMetadataApiError("invalid-response");
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export async function readInviteMetadataViaApi(
  inviteId: string,
  tokenProvider?: AuthTokenProvider,
  options: { signal?: AbortSignal } = {},
): Promise<ReadInviteMetadataResponse> {
  const path = metadataPath(inviteId);
  if (options.signal?.aborted) throw new InviteMetadataApiError("aborted");
  const controller = new AbortController();
  const deadline = Date.now() + INVITE_METADATA_REQUEST_TIMEOUT_MS;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (code: string) => {
    rejectCancellation(new InviteMetadataApiError(code));
    controller.abort();
  };
  const onAbort = () => cancel("aborted");
  const timer = setTimeout(
    () => cancel("timeout"),
    INVITE_METADATA_REQUEST_TIMEOUT_MS,
  );
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const assertCurrent = () => {
    if (controller.signal.aborted) throw new InviteMetadataApiError("aborted");
    if (Date.now() >= deadline) {
      controller.abort();
      throw new InviteMetadataApiError("timeout");
    }
    tokenProvider?.assertCurrentUser?.();
  };
  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      assertCurrent();
      const token = tokenProvider ? await tokenProvider(attempt === 1) : null;
      assertCurrent();
      const response = await fetch(`${INVITE_METADATA_API_ROOT}${path}`, {
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
        throw new InviteMetadataApiError(
          `http-${response.status}`,
          response.status,
          retryAfterMs(response),
        );
      }
      const payload = await readResponse(response, controller.signal);
      assertCurrent();
      if (
        !isReadInviteMetadataResponse(payload) ||
        payload.snapshot.inviteId !== inviteId
      ) {
        throw new InviteMetadataApiError("invalid-response");
      }
      return payload;
    }
    throw new InviteMetadataApiError("unauthenticated", 401);
  };
  try {
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
