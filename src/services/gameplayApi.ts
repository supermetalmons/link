import {
  isCancelAutomatchResponse,
  isRemoveNavigationGameResponse,
  isStartAutomatchResponse,
  type CancelAutomatchResponse,
  type RemoveNavigationGameRequest,
  type RemoveNavigationGameResponse,
  type StartAutomatchRequest,
  type StartAutomatchResponse,
} from "@mons/shared/navigation";
import {
  isWagerOutcomeResolveResponse,
  isWagerProposalAcceptResponse,
  isWagerProposalRemovalResponse,
  isWagerProposalSendResponse,
  type WagerProposalAcceptRequest,
  type WagerProposalAcceptResponse,
  type WagerProposalRemovalRequest,
  type WagerProposalRemovalResponse,
  type WagerProposalSendRequest,
  type WagerProposalSendResponse,
  type WagerOutcomeResolveRequest,
  type WagerOutcomeResolveResponse,
} from "@mons/shared/wagers";
import {
  isClaimMatchVictoryByTimerResponse,
  isStartMatchTimerResponse,
  type ClaimMatchVictoryByTimerRequest,
  type ClaimMatchVictoryByTimerResponse,
  type StartMatchTimerRequest,
  type StartMatchTimerResponse,
} from "@mons/shared/timers";
import {
  isRatingUpdateResponse,
  type RatingUpdateRequest,
  type RatingUpdateResponse,
} from "@mons/shared/ratings";
import type { AuthTokenProvider } from "./authApi";

const GAMEPLAY_API_ROOT = "https://api.mons.link";
const GAMEPLAY_API_TIMEOUT_MS = 30_000;
const RATING_API_TIMEOUT_MS = 60_000;
const RATING_BUSY_RETRY_DELAY_MS = 31_000;
const GAMEPLAY_API_MAX_RESPONSE_BYTES = 64 * 1024;

type RatingRetryOptions = {
  now?: () => number;
  shouldRetry?: () => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class GameplayApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "GameplayApiError";
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > GAMEPLAY_API_MAX_RESPONSE_BYTES
  ) {
    cancelBody(response);
    throw new GameplayApiError(
      "unavailable",
      "Gameplay service is unavailable.",
    );
  }
  if (!response.body) {
    throw new GameplayApiError(
      "unavailable",
      "Gameplay service is unavailable.",
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > GAMEPLAY_API_MAX_RESPONSE_BYTES) {
        throw new Error("oversized-response");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join("")) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new GameplayApiError(
      "unavailable",
      "Gameplay service is unavailable.",
    );
  }
}

function responseError(value: unknown, status: number): GameplayApiError {
  const body = isRecord(value) ? value : {};
  const code =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : status === 401
        ? "unauthenticated"
        : "unavailable";
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : "Gameplay service is unavailable.";
  return new GameplayApiError(code, message, body.details);
}

async function gameplayMutation<T>(
  path: string,
  body: unknown,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
  timeoutMs = GAMEPLAY_API_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(
        new GameplayApiError("unavailable", "Gameplay request timed out."),
      );
    }, timeoutMs);
  });
  const run = async (): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await tokenProvider(attempt === 1);
        if (controller.signal.aborted) {
          throw new GameplayApiError(
            "unavailable",
            "Gameplay request timed out.",
          );
        }
        const response = await fetch(`${GAMEPLAY_API_ROOT}${path}`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401 && attempt === 0) {
          cancelBody(response);
          continue;
        }
        const payload = await readBoundedJson(response);
        if (!response.ok) {
          throw responseError(payload, response.status);
        }
        if (!validate(payload)) {
          throw new GameplayApiError(
            "unavailable",
            "Gameplay service is unavailable.",
          );
        }
        return payload;
      } catch (error) {
        if (error instanceof GameplayApiError) {
          throw error;
        }
        throw new GameplayApiError(
          "unavailable",
          "Gameplay service is unavailable.",
        );
      }
    }
    throw new GameplayApiError("unauthenticated", "authentication-required");
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export function cancelAutomatchViaApi(
  tokenProvider: AuthTokenProvider,
): Promise<CancelAutomatchResponse> {
  return gameplayMutation(
    "/automatch/cancel",
    {},
    tokenProvider,
    isCancelAutomatchResponse,
  );
}

export function startAutomatchViaApi(
  request: StartAutomatchRequest,
  tokenProvider: AuthTokenProvider,
): Promise<StartAutomatchResponse> {
  return gameplayMutation(
    "/automatch/start",
    request,
    tokenProvider,
    isStartAutomatchResponse,
  );
}

export function removeNavigationGameViaApi(
  request: RemoveNavigationGameRequest,
  tokenProvider: AuthTokenProvider,
): Promise<RemoveNavigationGameResponse> {
  return gameplayMutation(
    "/navigation/games/remove",
    request,
    tokenProvider,
    isRemoveNavigationGameResponse,
  );
}

export function startMatchTimerViaApi(
  request: StartMatchTimerRequest,
  tokenProvider: AuthTokenProvider,
): Promise<StartMatchTimerResponse> {
  return gameplayMutation(
    "/matches/timer/start",
    request,
    tokenProvider,
    isStartMatchTimerResponse,
  );
}

export function claimMatchVictoryByTimerViaApi(
  request: ClaimMatchVictoryByTimerRequest,
  tokenProvider: AuthTokenProvider,
): Promise<ClaimMatchVictoryByTimerResponse> {
  return gameplayMutation(
    "/matches/timer/claim",
    request,
    tokenProvider,
    isClaimMatchVictoryByTimerResponse,
  );
}

export function cancelWagerProposalViaApi(
  request: WagerProposalRemovalRequest,
  tokenProvider: AuthTokenProvider,
): Promise<WagerProposalRemovalResponse> {
  return gameplayMutation(
    "/wagers/proposals/cancel",
    request,
    tokenProvider,
    isWagerProposalRemovalResponse,
  );
}

export function declineWagerProposalViaApi(
  request: WagerProposalRemovalRequest,
  tokenProvider: AuthTokenProvider,
): Promise<WagerProposalRemovalResponse> {
  return gameplayMutation(
    "/wagers/proposals/decline",
    request,
    tokenProvider,
    isWagerProposalRemovalResponse,
  );
}

export function sendWagerProposalViaApi(
  request: WagerProposalSendRequest,
  tokenProvider: AuthTokenProvider,
): Promise<WagerProposalSendResponse> {
  return gameplayMutation(
    "/wagers/proposals/send",
    request,
    tokenProvider,
    isWagerProposalSendResponse,
  );
}

export function acceptWagerProposalViaApi(
  request: WagerProposalAcceptRequest,
  tokenProvider: AuthTokenProvider,
): Promise<WagerProposalAcceptResponse> {
  return gameplayMutation(
    "/wagers/proposals/accept",
    request,
    tokenProvider,
    isWagerProposalAcceptResponse,
  );
}

export function resolveWagerOutcomeViaApi(
  request: WagerOutcomeResolveRequest,
  tokenProvider: AuthTokenProvider,
): Promise<WagerOutcomeResolveResponse> {
  return gameplayMutation(
    "/wagers/outcomes/resolve",
    request,
    tokenProvider,
    isWagerOutcomeResolveResponse,
  );
}

export async function updateRatingsViaApi(
  request: RatingUpdateRequest,
  tokenProvider: AuthTokenProvider,
  options: RatingRetryOptions = {},
): Promise<RatingUpdateResponse> {
  const now = options.now || Date.now;
  const deadlineAt = now() + RATING_API_TIMEOUT_MS;
  let canRetryUnavailable = true;
  const mutate = () => {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      throw new GameplayApiError("unavailable", "Gameplay request timed out.");
    }
    return gameplayMutation(
      "/ratings/update",
      request,
      tokenProvider,
      isRatingUpdateResponse,
      remainingMs,
    );
  };
  const mutateWithUnavailableRetry = async () => {
    try {
      return await mutate();
    } catch (error) {
      if (
        !canRetryUnavailable ||
        !(error instanceof GameplayApiError) ||
        error.code !== "unavailable" ||
        (options.shouldRetry && !options.shouldRetry()) ||
        deadlineAt - now() <= 0
      ) {
        throw error;
      }
      canRetryUnavailable = false;
      return mutate();
    }
  };
  const response = await mutateWithUnavailableRetry();
  if (response.ok && "skipped" in response) {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      return response;
    }
    await (
      options.sleep ||
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
    )(Math.min(RATING_BUSY_RETRY_DELAY_MS, remainingMs));
    if (
      (options.shouldRetry && !options.shouldRetry()) ||
      deadlineAt - now() <= 0
    ) {
      return response;
    }
    return mutateWithUnavailableRetry();
  }
  return response;
}

export { RATING_API_TIMEOUT_MS, RATING_BUSY_RETRY_DELAY_MS };
