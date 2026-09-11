import {
  PRESENTATION_MAX_MESSAGE_BYTES,
  isMatchPresentationConflictResponse,
  isReadMatchPresentationResponse,
  isUpdateMatchPresentationRequest,
  isUpdateMatchPresentationResponse,
  type MatchPresentation,
  type ReadMatchPresentationResponse,
  type UpdateMatchPresentationRequest,
  type UpdateMatchPresentationResponse,
} from "@mons/shared/match-presentation";
import { normalizeRecordKey } from "@mons/shared/ids";
import { parseInviteMatchIndex } from "@mons/shared/rematches";
import type { AuthTokenProvider } from "./authApi";

const PRESENTATION_API_ROOT = "https://api.mons.link";
export const PRESENTATION_REQUEST_TIMEOUT_MS = 5_000;

export class MatchPresentationApiError extends Error {
  readonly code: string;
  readonly presentation?: MatchPresentation;

  constructor(code: string, presentation?: MatchPresentation) {
    super(code);
    this.name = "MatchPresentationApiError";
    this.code = code;
    this.presentation = presentation;
  }
}

function presentationPath(inviteId: string, matchId: string): string {
  if (
    normalizeRecordKey(inviteId) !== inviteId ||
    normalizeRecordKey(matchId) !== matchId ||
    parseInviteMatchIndex(inviteId, matchId) === null
  ) {
    throw new MatchPresentationApiError("invalid-match-presentation");
  }
  return `/invites/${encodeURIComponent(inviteId)}/matches/${encodeURIComponent(matchId)}/presentation`;
}

async function readResponse(response: Response): Promise<unknown> {
  if (
    Number(response.headers.get("Content-Length")) >
      PRESENTATION_MAX_MESSAGE_BYTES ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new MatchPresentationApiError("invalid-response");
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
      if (byteLength > PRESENTATION_MAX_MESSAGE_BYTES) {
        throw new MatchPresentationApiError("invalid-response");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new MatchPresentationApiError("invalid-response");
  } finally {
    reader.releaseLock();
  }
}

async function requestPresentation(
  inviteId: string,
  matchId: string,
  body: UpdateMatchPresentationRequest | undefined,
  tokenProvider: AuthTokenProvider | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  const path = presentationPath(inviteId, matchId);
  if (signal?.aborted) throw new MatchPresentationApiError("aborted");
  const controller = new AbortController();
  const deadline = Date.now() + PRESENTATION_REQUEST_TIMEOUT_MS;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (code: string) => {
    controller.abort();
    rejectCancellation(new MatchPresentationApiError(code));
  };
  const onAbort = () => cancel("aborted");
  const timer = setTimeout(
    () => cancel("timeout"),
    PRESENTATION_REQUEST_TIMEOUT_MS,
  );
  signal?.addEventListener("abort", onAbort, { once: true });
  const assertCurrent = () => {
    if (controller.signal.aborted) {
      throw new MatchPresentationApiError("aborted");
    }
    if (Date.now() >= deadline) {
      controller.abort();
      throw new MatchPresentationApiError("timeout");
    }
    tokenProvider?.assertCurrentUser?.();
  };
  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      assertCurrent();
      const token = tokenProvider ? await tokenProvider(attempt === 1) : null;
      assertCurrent();
      const response = await fetch(`${PRESENTATION_API_ROOT}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
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
      if (!response.ok && response.status !== 409) {
        void response.body?.cancel().catch(() => undefined);
        throw new MatchPresentationApiError(`http-${response.status}`);
      }
      const payload = await readResponse(response);
      assertCurrent();
      if (response.status === 409) {
        if (
          body &&
          isMatchPresentationConflictResponse(payload) &&
          payload.presentation.matchId === matchId
        ) {
          throw new MatchPresentationApiError(
            "presentation-conflict",
            payload.presentation,
          );
        }
        throw new MatchPresentationApiError("http-409");
      }
      return payload;
    }
    throw new MatchPresentationApiError("unauthenticated");
  };
  try {
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function readMatchPresentationViaApi(
  inviteId: string,
  matchId: string,
  tokenProvider?: AuthTokenProvider,
  options: { signal?: AbortSignal } = {},
): Promise<ReadMatchPresentationResponse> {
  const payload = await requestPresentation(
    inviteId,
    matchId,
    undefined,
    tokenProvider,
    options.signal,
  );
  if (
    !isReadMatchPresentationResponse(payload) ||
    payload.presentation.matchId !== matchId
  ) {
    throw new MatchPresentationApiError("invalid-response");
  }
  return payload;
}

export async function updateMatchPresentationViaApi(
  inviteId: string,
  matchId: string,
  request: UpdateMatchPresentationRequest,
  tokenProvider: AuthTokenProvider,
  options: { signal?: AbortSignal } = {},
): Promise<UpdateMatchPresentationResponse> {
  if (!isUpdateMatchPresentationRequest(request)) {
    throw new MatchPresentationApiError("invalid-match-presentation");
  }
  const payload = await requestPresentation(
    inviteId,
    matchId,
    request,
    tokenProvider,
    options.signal,
  );
  if (
    !isUpdateMatchPresentationResponse(payload) ||
    payload.presentation.matchId !== matchId
  ) {
    throw new MatchPresentationApiError("invalid-response");
  }
  return payload;
}
