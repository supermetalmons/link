import {
  GAME_SESSION_OPERATION_ID_PATTERN,
  MAX_GAME_SESSION_RESPONSE_BYTES,
  MATCH_SNAPSHOT_PATH,
  MATCH_MOVE_PATH,
  isCreateInviteResponse,
  isEndRematchResponse,
  isEnsureMatchResponse,
  isReadHistoricalMatchResponse,
  isReadMatchSnapshotRequest,
  isReadMatchSnapshotResponse,
  isJoinInviteResponse,
  isProposeRematchResponse,
  isResolveInviteRoleResponse,
  isSurrenderMatchRequest,
  isSurrenderMatchResponse,
  isSubmitMoveRequest,
  isSubmitMoveResponse,
  isMoveHistoryPrefix,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type EndRematchRequest,
  type EndRematchResponse,
  type EnsureMatchRequest,
  type EnsureMatchResponse,
  type ReadHistoricalMatchRequest,
  type ReadHistoricalMatchResponse,
  type ReadMatchSnapshotRequest,
  type ReadMatchSnapshotResponse,
  type JoinInviteRequest,
  type JoinInviteResponse,
  type ProposeRematchRequest,
  type ProposeRematchResponse,
  type ResolveInviteRoleRequest,
  type ResolveInviteRoleResponse,
  type SurrenderMatchRequest,
  type SurrenderMatchResponse,
  type SubmitMoveRequest,
  type SubmitMoveResponse,
} from "@mons/shared/game-sessions";
import {
  AUTOMATCH_API_MAX_RESPONSE_BYTES,
  isCancelAutomatchResponse,
  isReadNavigationGamesResponse,
  isRemoveNavigationGameResponse,
  parseStartAutomatchApiResponse,
  type CancelAutomatchResponse,
  type ReadNavigationGamesRequest,
  type ReadNavigationGamesResponse,
  type RemoveNavigationGameRequest,
  type RemoveNavigationGameResponse,
  type StartAutomatchRequest,
  type StartAutomatchApiResponse,
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
  isCreateEventResponse,
  isDisqualifyEventMatchWinnersResponse,
  isEventSnapshotSeed,
  isJoinEventResponse,
  isPostponeEventStartResponse,
  isRemoveEventParticipantResponse,
  isSyncEventStateResponse,
  type CreateEventRequest,
  type CreateEventResponse,
  type DisqualifyEventMatchWinnersRequest,
  type DisqualifyEventMatchWinnersResponse,
  type EventSnapshotSeed,
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
import {
  GAMEPLAY_API_ROOT,
  GAMEPLAY_API_TIMEOUT_MS,
  GameplayApiError,
  cancelBody,
  conditionalGameplayRead,
  isRecord,
  readBoundedJson,
  responseError,
  type ConditionalRead,
  type ConditionalReadOptions,
} from "./gameplayTransport";

export { GameplayApiError } from "./gameplayTransport";
export type {
  ConditionalRead,
  ConditionalReadOptions,
} from "./gameplayTransport";
export { readEventSnapshotViaApi } from "./eventReadApi";

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
          options.maxResponseBytes ?? GAMEPLAY_API_MAX_RESPONSE_BYTES,
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

export async function readMatchSnapshotViaApi(
  request: ReadMatchSnapshotRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ReadMatchSnapshotResponse> {
  const timeoutMs = options.timeoutMs ?? GAMEPLAY_API_TIMEOUT_MS;
  if (
    !isReadMatchSnapshotRequest(request) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new GameplayApiError("invalid-argument", "invalid-request");
  }
  if (options.signal?.aborted) {
    throw new GameplayApiError("aborted", "request-aborted");
  }
  const controller = new AbortController();
  let cancellationError: GameplayApiError | null = null;
  let rejectCancellation: (error: GameplayApiError) => void = () => {};
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (caller: boolean) => {
    if (cancellationError) return;
    cancellationError = caller
      ? new GameplayApiError("aborted", "request-aborted")
      : new GameplayApiError("unavailable", "Gameplay request timed out.");
    controller.abort();
    rejectCancellation(cancellationError);
  };
  const handleCallerAbort = () => cancel(true);
  options.signal?.addEventListener("abort", handleCallerAbort, { once: true });
  const timeoutId = setTimeout(
    () => cancel(false),
    Math.min(timeoutMs, GAMEPLAY_API_TIMEOUT_MS),
  );
  const run = async (): Promise<ReadMatchSnapshotResponse> => {
    try {
      const url = new URL(`${GAMEPLAY_API_ROOT}${MATCH_SNAPSHOT_PATH}`);
      url.searchParams.set("playerId", request.playerId);
      url.searchParams.set("matchId", request.matchId);
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        cancelBody(response);
        throw cancellationError;
      }
      const payload = await readBoundedJson(
        response,
        GAMEPLAY_API_MAX_RESPONSE_BYTES,
        controller.signal,
      );
      if (cancellationError) throw cancellationError;
      if (!response.ok) throw responseError(payload, response.status);
      if (
        !isReadMatchSnapshotResponse(payload) ||
        payload.playerId !== request.playerId ||
        payload.matchId !== request.matchId
      ) {
        throw new GameplayApiError(
          "unavailable",
          "Gameplay service is unavailable.",
        );
      }
      return payload;
    } catch (error) {
      if (cancellationError) throw cancellationError;
      if (error instanceof GameplayApiError) throw error;
      throw new GameplayApiError(
        "unavailable",
        "Gameplay service is unavailable.",
      );
    }
  };
  try {
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", handleCallerAbort);
  }
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
    const payload = await readBoundedJson(
      response,
      GAMEPLAY_API_MAX_RESPONSE_BYTES,
    );
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
  maxResponseBytes?: number,
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
        { maxResponseBytes },
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

export async function startAutomatchViaApi(
  request: StartAutomatchRequest,
  tokenProvider: AuthTokenProvider,
  operationId: string,
): Promise<StartAutomatchApiResponse> {
  if (!GAME_SESSION_OPERATION_ID_PATTERN.test(operationId)) {
    return Promise.reject(
      new GameplayApiError("invalid-argument", "invalid-request"),
    );
  }
  const response = await retryGameSessionMutation(
    `/automatch/start?operationId=${encodeURIComponent(operationId)}&bootstrap=1`,
    request,
    tokenProvider,
    (value): value is StartAutomatchApiResponse =>
      parseStartAutomatchApiResponse(value) !== null,
    false,
    AUTOMATCH_API_MAX_RESPONSE_BYTES,
  );
  const parsed = parseStartAutomatchApiResponse(response)!;
  if (
    parsed.ok &&
    parsed.mode === "matched" &&
    parsed.bootstrap &&
    parsed.bootstrap.viewer.automatchOperationId !== operationId
  ) {
    const { bootstrap: _bootstrap, ...legacy } = parsed;
    return legacy;
  }
  return parsed;
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
  return gameplayMutation(
    "/rematches/end",
    request,
    tokenProvider,
    isEndRematchResponse,
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

export function submitMoveViaApi(
  request: SubmitMoveRequest,
  tokenProvider: AuthTokenProvider,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SubmitMoveResponse> {
  const timeoutMs = options.timeoutMs ?? GAMEPLAY_API_TIMEOUT_MS;
  if (
    !isSubmitMoveRequest(request) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return Promise.reject(
      new GameplayApiError("invalid-argument", "invalid-move-request"),
    );
  }
  const body: SubmitMoveRequest = {
    ...request,
    ...(request.previousStates
      ? {
          previousStates: request.previousStates.map((state) => ({ ...state })),
        }
      : {}),
  };
  return gameplayMutation(
    MATCH_MOVE_PATH,
    body,
    tokenProvider,
    (value): value is SubmitMoveResponse =>
      isSubmitMoveResponse(value) &&
      value.inviteId === body.inviteId &&
      value.matchId === body.matchId &&
      value.actorUid === body.playerId &&
      (value.outcome !== "superseded" ||
        (body.previousStates !== undefined &&
          value.flatMovesString !== body.flatMovesString &&
          isMoveHistoryPrefix(body.flatMovesString, value.flatMovesString))),
    timeoutMs,
    options,
  );
}

export function surrenderMatchViaApi(
  request: SurrenderMatchRequest,
  tokenProvider: AuthTokenProvider,
): Promise<SurrenderMatchResponse> {
  if (!isSurrenderMatchRequest(request)) {
    return Promise.reject(
      new GameplayApiError("invalid-argument", "invalid-surrender-request"),
    );
  }
  const { inviteId, matchId, playerId } = request;
  return gameplayMutation(
    "/matches/surrender",
    { inviteId, matchId, playerId },
    tokenProvider,
    (value): value is SurrenderMatchResponse =>
      isSurrenderMatchResponse(value) &&
      value.inviteId === inviteId &&
      value.matchId === matchId &&
      value.actorUid === playerId,
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

export type EventMutationResponse<T> = T & {
  eventSnapshot?: EventSnapshotSeed;
};

async function eventMutation<T extends { eventId: string }>(
  path: string,
  request: unknown,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
): Promise<EventMutationResponse<T>> {
  const payload = await gameplayMutation(
    `${path}?eventSnapshot=v1`,
    request,
    tokenProvider,
    isRecord,
  );
  const { eventSnapshot, ...response } = payload;
  if (!validate(response)) {
    throw new GameplayApiError(
      "unavailable",
      "Gameplay service is unavailable.",
    );
  }
  return isEventSnapshotSeed(eventSnapshot) &&
    eventSnapshot.snapshot.eventId === response.eventId
    ? Object.assign(response, { eventSnapshot })
    : response;
}

export function createEventViaApi(
  request: CreateEventRequest,
  tokenProvider: AuthTokenProvider,
): Promise<EventMutationResponse<CreateEventResponse>> {
  return eventMutation(
    "/events/create",
    request,
    tokenProvider,
    isCreateEventResponse,
  );
}

export function postponeEventStartViaApi(
  request: PostponeEventStartRequest,
  tokenProvider: AuthTokenProvider,
): Promise<EventMutationResponse<PostponeEventStartResponse>> {
  return eventMutation(
    "/events/start/postpone",
    request,
    tokenProvider,
    isPostponeEventStartResponse,
  );
}

export function disqualifyEventMatchWinnersViaApi(
  request: DisqualifyEventMatchWinnersRequest,
  tokenProvider: AuthTokenProvider,
): Promise<EventMutationResponse<DisqualifyEventMatchWinnersResponse>> {
  return eventMutation(
    "/events/matches/winners/disqualify",
    request,
    tokenProvider,
    isDisqualifyEventMatchWinnersResponse,
  );
}

export function syncEventStateViaApi(
  request: SyncEventStateRequest,
  tokenProvider: AuthTokenProvider,
): Promise<EventMutationResponse<SyncEventStateResponse>> {
  return eventMutation(
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

export {
  GAMEPLAY_API_TIMEOUT_MS,
  RATING_API_TIMEOUT_MS,
  RATING_BUSY_RETRY_DELAY_MS,
};
