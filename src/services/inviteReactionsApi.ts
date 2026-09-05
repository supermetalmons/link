import {
  REACTION_AUTH_PROTOCOL_PREFIX,
  REACTION_MAX_MESSAGE_BYTES,
  REACTION_SOCKET_PROTOCOL,
  isInviteReactionForInvite,
  isReactionSocketToken,
  isSendInviteReactionResponse,
  type InviteReaction,
  type SendInviteReactionResponse,
} from "@mons/shared/reactions";
import type { AuthTokenProvider } from "./authApi";

const REACTIONS_API_ROOT = "https://api.mons.link";
export const REACTION_SEND_TIMEOUT_MS = 5_000;

export class InviteReactionApiError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "InviteReactionApiError";
    this.code = code;
  }
}

function reactionPath(inviteId: string): string {
  return `/invites/${encodeURIComponent(inviteId)}/reactions`;
}

export function getInviteReactionSocketUrl(inviteId: string): string {
  return `${REACTIONS_API_ROOT.replace("https:", "wss:")}${reactionPath(inviteId)}/socket`;
}

export function createInviteReactionSocketProtocols(token: string): string[] {
  if (!isReactionSocketToken(token)) {
    throw new InviteReactionApiError("invalid-reaction-socket-token");
  }
  return [REACTION_SOCKET_PROTOCOL, `${REACTION_AUTH_PROTOCOL_PREFIX}${token}`];
}

async function readResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (declaredLength > REACTION_MAX_MESSAGE_BYTES || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new InviteReactionApiError("invalid-response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > REACTION_MAX_MESSAGE_BYTES) {
        throw new InviteReactionApiError("invalid-response");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new InviteReactionApiError("invalid-response");
  } finally {
    reader.releaseLock();
  }
}

export async function sendInviteReactionViaApi(
  inviteId: string,
  reaction: InviteReaction,
  tokenProvider: AuthTokenProvider,
  options: { signal?: AbortSignal } = {},
): Promise<SendInviteReactionResponse> {
  if (!isInviteReactionForInvite(inviteId, reaction)) {
    throw new InviteReactionApiError("invalid-reaction");
  }
  if (options.signal?.aborted) throw new InviteReactionApiError("aborted");
  const deadline = Date.now() + REACTION_SEND_TIMEOUT_MS;
  const controller = new AbortController();
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (code: string) => {
    controller.abort();
    rejectCancellation(new InviteReactionApiError(code));
  };
  const onAbort = () => cancel("aborted");
  const timer = setTimeout(() => cancel("timeout"), REACTION_SEND_TIMEOUT_MS);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const assertCurrent = () => {
    if (controller.signal.aborted) throw new InviteReactionApiError("aborted");
    if (Date.now() >= deadline) {
      controller.abort();
      throw new InviteReactionApiError("timeout");
    }
    tokenProvider.assertCurrentUser?.();
  };
  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      assertCurrent();
      const token = await tokenProvider(attempt === 1);
      assertCurrent();
      const response = await fetch(
        `${REACTIONS_API_ROOT}${reactionPath(inviteId)}`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(reaction),
          cache: "no-store",
          signal: controller.signal,
        },
      );
      try {
        assertCurrent();
      } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }
      if (response.status === 401 && attempt === 0) {
        void response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new InviteReactionApiError(`http-${response.status}`);
      }
      const payload = await readResponse(response);
      assertCurrent();
      if (!isSendInviteReactionResponse(payload)) {
        throw new InviteReactionApiError("invalid-response");
      }
      return payload;
    }
    throw new InviteReactionApiError("unauthenticated");
  };
  try {
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
