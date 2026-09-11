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
import type { AuthTokenProvider } from "./authApi";

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
      INVITE_WAGERS_MAX_MESSAGE_BYTES ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new InviteWagersApiError("invalid-response");
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
      if (byteLength > INVITE_WAGERS_MAX_MESSAGE_BYTES) {
        throw new InviteWagersApiError("invalid-response");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new InviteWagersApiError("invalid-response");
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export async function readInviteWagersViaApi(
  inviteId: string,
  tokenProvider?: AuthTokenProvider,
  options: { signal?: AbortSignal } = {},
): Promise<ReadInviteWagersResponse> {
  const path = wagersPath(inviteId);
  if (options.signal?.aborted) throw new InviteWagersApiError("aborted");
  const controller = new AbortController();
  const deadline = Date.now() + INVITE_WAGERS_REQUEST_TIMEOUT_MS;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (code: string) => {
    rejectCancellation(new InviteWagersApiError(code));
    controller.abort();
  };
  const onAbort = () => cancel("aborted");
  const timer = setTimeout(
    () => cancel("timeout"),
    INVITE_WAGERS_REQUEST_TIMEOUT_MS,
  );
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const assertCurrent = () => {
    if (controller.signal.aborted) throw new InviteWagersApiError("aborted");
    if (Date.now() >= deadline) {
      controller.abort();
      throw new InviteWagersApiError("timeout");
    }
    tokenProvider?.assertCurrentUser?.();
  };
  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      assertCurrent();
      const token = tokenProvider ? await tokenProvider(attempt === 1) : null;
      assertCurrent();
      const response = await fetch(`${INVITE_WAGERS_API_ROOT}${path}`, {
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
        throw new InviteWagersApiError(
          `http-${response.status}`,
          response.status,
          retryAfterMs(response),
        );
      }
      const payload = await readResponse(response, controller.signal);
      assertCurrent();
      if (
        !isReadInviteWagersResponse(payload) ||
        payload.snapshot.inviteId !== inviteId
      ) {
        throw new InviteWagersApiError("invalid-response");
      }
      return payload;
    }
    throw new InviteWagersApiError("unauthenticated", 401);
  };
  try {
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
