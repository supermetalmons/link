import {
  GAME_SESSION_OPERATION_ID_PATTERN,
  MAX_GAME_SESSION_RESPONSE_BYTES,
  isCreateInviteResponse,
  isEndRematchResponse,
  isEnsureMatchResponse,
  isReadHistoricalMatchResponse,
  isJoinInviteResponse,
  isProposeRematchResponse,
  isResolveInviteRoleResponse,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type EndRematchRequest,
  type EndRematchResponse,
  type EnsureMatchRequest,
  type EnsureMatchResponse,
  type ReadHistoricalMatchRequest,
  type ReadHistoricalMatchResponse,
  type JoinInviteRequest,
  type JoinInviteResponse,
  type ProposeRematchRequest,
  type ProposeRematchResponse,
  type ResolveInviteRoleRequest,
  type ResolveInviteRoleResponse,
} from "@mons/shared/game-sessions";
import {
  isCancelAutomatchResponse,
  isReadNavigationGamesResponse,
  isRemoveNavigationGameResponse,
  isStartAutomatchResponse,
  type CancelAutomatchResponse,
  type ReadNavigationGamesRequest,
  type ReadNavigationGamesResponse,
  type RemoveNavigationGameRequest,
  type RemoveNavigationGameResponse,
  type StartAutomatchRequest,
  type StartAutomatchResponse,
} from "@mons/shared/navigation";
import {
  WAGER_FROZEN_READ_PATH,
  WAGER_STORAGE_VERSION,
  WAGER_STORAGE_VERSION_HEADER,
  isWagerFrozenReadRequest,
  isWagerFrozenReadResponse,
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
  type WagerFrozenReadRequest,
  type WagerFrozenReadResponse,
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
import {
  isProfileEventPrizesResponse,
  isToggleEventPrizeSelectionResponse,
  type ProfileEventPrizesResponse,
  type ToggleEventPrizeSelectionRequest,
  type ToggleEventPrizeSelectionResponse,
} from "@mons/shared/event-prizes";
import {
  EVENT_BOOKMARK_HEADER,
  EVENT_ETAG_HEADER,
  MAX_EVENT_READ_RESPONSE_BYTES,
  isCreateEventResponse,
  isDisqualifyEventMatchWinnersResponse,
  isEventSnapshotResponse,
  isJoinEventResponse,
  isPostponeEventStartResponse,
  isRemoveEventParticipantResponse,
  isSyncEventStateResponse,
  type CreateEventRequest,
  type CreateEventResponse,
  type DisqualifyEventMatchWinnersRequest,
  type DisqualifyEventMatchWinnersResponse,
  type EventSnapshotResponse,
  type JoinEventRequest,
  type JoinEventResponse,
  type PostponeEventStartRequest,
  type PostponeEventStartResponse,
  type RemoveEventParticipantRequest,
  type RemoveEventParticipantResponse,
  type SyncEventStateRequest,
  type SyncEventStateResponse,
} from "@mons/shared/events";
import { AuthApiError, type AuthTokenProvider } from "./authApi";

const GAMEPLAY_API_ROOT = "https://api.mons.link";
const GAMEPLAY_API_TIMEOUT_MS = 30_000;
const RATING_API_TIMEOUT_MS = 60_000;
const RATING_BUSY_RETRY_DELAY_MS = 31_000;
const GAMEPLAY_API_MAX_RESPONSE_BYTES = MAX_GAME_SESSION_RESPONSE_BYTES;
const WAGER_WRITE_PATHS = new Set([
  "/wagers/proposals/send",
  "/wagers/proposals/accept",
  "/wagers/proposals/cancel",
  "/wagers/proposals/decline",
  "/wagers/outcomes/resolve",
]);

type RatingRetryOptions = {
  now?: () => number;
  shouldRetry?: () => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type ConditionalRead<T> =
  | {
      kind: "modified";
      value: T;
      etag: string;
      bookmark: string;
    }
  | {
      kind: "not-modified";
      etag: string;
      bookmark: string;
    };

export type ConditionalReadOptions = {
  etag?: string | null;
  bookmark?: string | null;
  signal?: AbortSignal;
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

async function readBoundedJson(
  response: Response,
  maxBytes = GAMEPLAY_API_MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
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
      if (bytesRead > maxBytes) {
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

function conditionalHeader(response: Response, name: string): string | null {
  const value = response.headers.get(name)?.trim() || "";
  return value && value.length <= 4_096 ? value : null;
}

async function conditionalGameplayRead<T>(
  url: URL,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
  options: ConditionalReadOptions,
): Promise<ConditionalRead<T>> {
  if (options.signal?.aborted) {
    throw new GameplayApiError("aborted", "request-aborted");
  }
  const controller = new AbortController();
  let cancellationKind: "caller" | "timeout" | null = null;
  let rejectCancellation: ((error: GameplayApiError) => void) | null = null;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (kind: "caller" | "timeout") => {
    if (cancellationKind) return;
    cancellationKind = kind;
    controller.abort();
    rejectCancellation?.(
      kind === "caller"
        ? new GameplayApiError("aborted", "request-aborted")
        : new GameplayApiError("unavailable", "Gameplay request timed out."),
    );
  };
  const timeoutId = setTimeout(
    () => cancel("timeout"),
    GAMEPLAY_API_TIMEOUT_MS,
  );
  const handleCallerAbort = () => cancel("caller");
  options.signal?.addEventListener("abort", handleCallerAbort, { once: true });
  const run = async (): Promise<ConditionalRead<T>> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const token = await tokenProvider(attempt === 1);
        if (controller.signal.aborted) {
          throw cancellationKind === "caller"
            ? new GameplayApiError("aborted", "request-aborted")
            : new GameplayApiError(
                "unavailable",
                "Gameplay request timed out.",
              );
        }
        tokenProvider.assertCurrentUser?.();
        const headers = new Headers({
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        });
        const etag = options.etag?.trim();
        const bookmark = options.bookmark?.trim();
        if (etag) headers.set("If-None-Match", etag);
        if (bookmark) headers.set(EVENT_BOOKMARK_HEADER, bookmark);
        const response = await fetch(url, {
          method: "GET",
          headers,
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401 && attempt === 0) {
          cancelBody(response);
          continue;
        }
        if (response.status === 304) {
          const responseEtag = conditionalHeader(response, EVENT_ETAG_HEADER);
          const responseBookmark = conditionalHeader(
            response,
            EVENT_BOOKMARK_HEADER,
          );
          if (!etag || !responseEtag || !responseBookmark) {
            throw new GameplayApiError(
              "unavailable",
              "Gameplay service is unavailable.",
            );
          }
          tokenProvider.assertCurrentUser?.();
          return {
            kind: "not-modified",
            etag: responseEtag,
            bookmark: responseBookmark,
          };
        }
        const payload = await readBoundedJson(
          response,
          MAX_EVENT_READ_RESPONSE_BYTES,
        );
        if (!response.ok) throw responseError(payload, response.status);
        const responseEtag = conditionalHeader(response, EVENT_ETAG_HEADER);
        const responseBookmark = conditionalHeader(
          response,
          EVENT_BOOKMARK_HEADER,
        );
        if (!responseEtag || !responseBookmark) {
          throw new GameplayApiError(
            "unavailable",
            "Gameplay service is unavailable.",
          );
        }
        if (!validate(payload)) {
          throw new GameplayApiError(
            "unavailable",
            "Gameplay service is unavailable.",
          );
        }
        tokenProvider.assertCurrentUser?.();
        return {
          kind: "modified",
          value: payload,
          etag: responseEtag,
          bookmark: responseBookmark,
        };
      } catch (error) {
        if (cancellationKind === "caller") {
          throw new GameplayApiError("aborted", "request-aborted");
        }
        if (cancellationKind === "timeout") {
          throw new GameplayApiError(
            "unavailable",
            "Gameplay request timed out.",
          );
        }
        if (error instanceof GameplayApiError) throw error;
        if (error instanceof AuthApiError) {
          throw new GameplayApiError(error.code, error.message, error.details);
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
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", handleCallerAbort);
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
  options: { signal?: AbortSignal; maxResponseBytes?: number } = {},
): Promise<T> {
  if (options.signal?.aborted) {
    throw new GameplayApiError("aborted", "request-aborted");
  }
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation: (error: GameplayApiError) => void = () => {};
  const handleCallerAbort = () => {
    controller.abort();
    rejectCancellation(new GameplayApiError("aborted", "request-aborted"));
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(
        new GameplayApiError("unavailable", "Gameplay request timed out."),
      );
    }, timeoutMs);
  });
  options.signal?.addEventListener("abort", handleCallerAbort, { once: true });
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
        tokenProvider.assertCurrentUser?.();
        const response = await fetch(`${GAMEPLAY_API_ROOT}${path}`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(WAGER_WRITE_PATHS.has(path)
              ? { [WAGER_STORAGE_VERSION_HEADER]: WAGER_STORAGE_VERSION }
              : {}),
          },
          body: JSON.stringify(body),
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401 && attempt === 0) {
          cancelBody(response);
          continue;
        }
        const payload = await readBoundedJson(
          response,
          options.maxResponseBytes,
        );
        if (!response.ok) {
          throw responseError(payload, response.status);
        }
        if (!validate(payload)) {
          throw new GameplayApiError(
            "unavailable",
            "Gameplay service is unavailable.",
          );
        }
        tokenProvider.assertCurrentUser?.();
        return payload;
      } catch (error) {
        if (error instanceof GameplayApiError) {
          throw error;
        }
        if (error instanceof AuthApiError) {
          throw new GameplayApiError(error.code, error.message, error.details);
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
    options.signal?.removeEventListener("abort", handleCallerAbort);
  }
}

export function readWagerFrozenViaApi(
  request: WagerFrozenReadRequest,
  tokenProvider: AuthTokenProvider,
  options: { signal?: AbortSignal } = {},
): Promise<WagerFrozenReadResponse> {
  if (!isWagerFrozenReadRequest(request)) {
    return Promise.reject(
      new GameplayApiError("invalid-argument", "invalid-player-uid"),
    );
  }
  return gameplayMutation(
    WAGER_FROZEN_READ_PATH,
    request,
    tokenProvider,
    (value): value is WagerFrozenReadResponse =>
      isWagerFrozenReadResponse(value) && value.playerUid === request.playerUid,
    GAMEPLAY_API_TIMEOUT_MS,
    { ...options, maxResponseBytes: 4 * 1024 },
  );
}

export async function readHistoricalMatchPairViaApi(
  request: ReadHistoricalMatchRequest,
): Promise<ReadHistoricalMatchResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    GAMEPLAY_API_TIMEOUT_MS,
  );
  try {
    const url = new URL(`${GAMEPLAY_API_ROOT}/matches/history`);
    url.searchParams.set("inviteId", request.inviteId);
    url.searchParams.set("matchId", request.matchId);
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await readBoundedJson(response);
    if (!response.ok) throw responseError(payload, response.status);
    if (!isReadHistoricalMatchResponse(payload)) {
      throw new GameplayApiError(
        "unavailable",
        "Gameplay service is unavailable.",
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof GameplayApiError) throw error;
    throw new GameplayApiError(
      "unavailable",
      "Gameplay service is unavailable.",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export function readEventSnapshotViaApi(
  eventId: string,
  tokenProvider: AuthTokenProvider,
  options: ConditionalReadOptions = {},
): Promise<ConditionalRead<EventSnapshotResponse>> {
  const normalizedEventId = eventId.trim();
  const url = new URL(`${GAMEPLAY_API_ROOT}/events/snapshot`);
  url.searchParams.set("eventId", normalizedEventId);
  return conditionalGameplayRead(
    url,
    tokenProvider,
    (value): value is EventSnapshotResponse =>
      isEventSnapshotResponse(value) && value.eventId === normalizedEventId,
    options,
  );
}

export function readProfileEventPrizesViaApi(
  profileId: string,
  tokenProvider: AuthTokenProvider,
  options: ConditionalReadOptions = {},
): Promise<ConditionalRead<ProfileEventPrizesResponse>> {
  const normalizedProfileId = profileId.trim();
  return conditionalGameplayRead(
    new URL(`${GAMEPLAY_API_ROOT}/events/prizes`),
    tokenProvider,
    (value): value is ProfileEventPrizesResponse =>
      isProfileEventPrizesResponse(value) &&
      value.profileId === normalizedProfileId,
    options,
  );
}

async function retryGameSessionMutation<T>(
  path: string,
  body: unknown,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
  retryUnavailable: boolean,
): Promise<T> {
  const deadlineAt = Date.now() + GAMEPLAY_API_TIMEOUT_MS;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new GameplayApiError("unavailable", "Gameplay request timed out.");
    }
    try {
      return await gameplayMutation(
        path,
        body,
        tokenProvider,
        validate,
        remainingMs,
      );
    } catch (error) {
      const busy =
        error instanceof GameplayApiError &&
        error.code === "aborted" &&
        (error.message === "invite-busy" ||
          error.message === "invite-lease-lost");
      const unavailable =
        retryUnavailable &&
        error instanceof GameplayApiError &&
        error.code === "unavailable";
      if ((!busy && !unavailable) || attempt === 2) {
        throw error;
      }
      const delayMs = 100 * (attempt + 1);
      if (Date.now() + delayMs >= deadlineAt) {
        throw new GameplayApiError(
          "unavailable",
          "Gameplay request timed out.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new GameplayApiError("unavailable", "Gameplay service is unavailable.");
}

export function cancelAutomatchViaApi(
  tokenProvider: AuthTokenProvider,
): Promise<CancelAutomatchResponse> {
  return retryGameSessionMutation(
    "/automatch/cancel",
    {},
    tokenProvider,
    isCancelAutomatchResponse,
    false,
  );
}

export function startAutomatchViaApi(
  request: StartAutomatchRequest,
  tokenProvider: AuthTokenProvider,
  operationId: string,
): Promise<StartAutomatchResponse> {
  if (!GAME_SESSION_OPERATION_ID_PATTERN.test(operationId)) {
    return Promise.reject(
      new GameplayApiError("invalid-argument", "invalid-request"),
    );
  }
  return retryGameSessionMutation(
    `/automatch/start?operationId=${encodeURIComponent(operationId)}`,
    request,
    tokenProvider,
    isStartAutomatchResponse,
    false,
  );
}

export function createInviteViaApi(
  request: CreateInviteRequest,
  tokenProvider: AuthTokenProvider,
): Promise<CreateInviteResponse> {
  return retryGameSessionMutation(
    "/invites/create",
    request,
    tokenProvider,
    isCreateInviteResponse,
    true,
  );
}

export function joinInviteViaApi(
  request: JoinInviteRequest,
  tokenProvider: AuthTokenProvider,
): Promise<JoinInviteResponse> {
  return retryGameSessionMutation(
    "/invites/join",
    request,
    tokenProvider,
    isJoinInviteResponse,
    true,
  );
}

export function readInviteRoleViaApi(
  request: ResolveInviteRoleRequest,
  tokenProvider: AuthTokenProvider,
): Promise<ResolveInviteRoleResponse> {
  return retryGameSessionMutation(
    "/invites/role/read",
    request,
    tokenProvider,
    isResolveInviteRoleResponse,
    true,
  );
}

export function proposeRematchViaApi(
  request: ProposeRematchRequest,
  tokenProvider: AuthTokenProvider,
): Promise<ProposeRematchResponse> {
  return retryGameSessionMutation(
    "/rematches/propose",
    request,
    tokenProvider,
    isProposeRematchResponse,
    true,
  );
}

export function endRematchViaApi(
  request: EndRematchRequest,
  tokenProvider: AuthTokenProvider,
): Promise<EndRematchResponse> {
  return retryGameSessionMutation(
    "/rematches/end",
    request,
    tokenProvider,
    isEndRematchResponse,
    true,
  );
}

export function ensureMatchViaApi(
  request: EnsureMatchRequest,
  tokenProvider: AuthTokenProvider,
): Promise<EnsureMatchResponse> {
  return retryGameSessionMutation(
    "/matches/ensure",
    request,
    tokenProvider,
    isEnsureMatchResponse,
    true,
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

export function readNavigationGamesViaApi(
  request: ReadNavigationGamesRequest,
  tokenProvider: AuthTokenProvider,
): Promise<ReadNavigationGamesResponse> {
  return gameplayMutation(
    "/navigation/games/read",
    request,
    tokenProvider,
    isReadNavigationGamesResponse,
  );
}

export function joinEventViaApi(
  request: JoinEventRequest,
  tokenProvider: AuthTokenProvider,
): Promise<JoinEventResponse> {
  return gameplayMutation(
    "/events/participants/join",
    request,
    tokenProvider,
    isJoinEventResponse,
  );
}

export function createEventViaApi(
  request: CreateEventRequest,
  tokenProvider: AuthTokenProvider,
): Promise<CreateEventResponse> {
  return gameplayMutation(
    "/events/create",
    request,
    tokenProvider,
    isCreateEventResponse,
  );
}

export function postponeEventStartViaApi(
  request: PostponeEventStartRequest,
  tokenProvider: AuthTokenProvider,
): Promise<PostponeEventStartResponse> {
  return gameplayMutation(
    "/events/start/postpone",
    request,
    tokenProvider,
    isPostponeEventStartResponse,
  );
}

export function disqualifyEventMatchWinnersViaApi(
  request: DisqualifyEventMatchWinnersRequest,
  tokenProvider: AuthTokenProvider,
): Promise<DisqualifyEventMatchWinnersResponse> {
  return gameplayMutation(
    "/events/matches/winners/disqualify",
    request,
    tokenProvider,
    isDisqualifyEventMatchWinnersResponse,
  );
}

export function syncEventStateViaApi(
  request: SyncEventStateRequest,
  tokenProvider: AuthTokenProvider,
): Promise<SyncEventStateResponse> {
  return gameplayMutation(
    "/events/state/sync",
    request,
    tokenProvider,
    isSyncEventStateResponse,
  );
}

export function removeEventParticipantViaApi(
  request: RemoveEventParticipantRequest,
  tokenProvider: AuthTokenProvider,
): Promise<RemoveEventParticipantResponse> {
  return gameplayMutation(
    "/events/participants/remove",
    request,
    tokenProvider,
    isRemoveEventParticipantResponse,
  );
}

export function toggleEventPrizeSelectionViaApi(
  request: ToggleEventPrizeSelectionRequest,
  tokenProvider: AuthTokenProvider,
): Promise<ToggleEventPrizeSelectionResponse> {
  return gameplayMutation(
    "/events/prize-selections/toggle",
    request,
    tokenProvider,
    isToggleEventPrizeSelectionResponse,
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
