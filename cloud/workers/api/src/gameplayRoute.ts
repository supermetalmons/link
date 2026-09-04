import {
  GAME_SESSION_OPERATION_ID_PATTERN,
  isCreateInviteRequest,
  isEndRematchRequest,
  isEnsureMatchRequest,
  isJoinInviteRequest,
  isProposeRematchRequest,
  isResolveInviteRoleRequest,
} from "@mons/shared/game-sessions";
import { isAutoInviteId } from "@mons/shared/ids";
import {
  inferAutomatchStateHint,
  isReadNavigationGamesRequest,
  isRemoveNavigationGameRequest,
  isStartAutomatchRequest,
  type CancelAutomatchResponse,
  type RemoveNavigationGameResponse,
} from "@mons/shared/navigation";
import {
  isWagerOutcomeResolveRequest,
  isWagerProposalAcceptRequest,
  isWagerProposalRemovalRequest,
  isWagerProposalSendRequest,
  type WagerProposalAcceptRequest,
  type WagerProposalSendRequest,
} from "@mons/shared/wagers";
import {
  isClaimMatchVictoryByTimerRequest,
  isStartMatchTimerRequest,
  type ClaimMatchVictoryByTimerRequest,
  type StartMatchTimerRequest,
} from "@mons/shared/timers";
import {
  isRatingUpdateRequest,
  type RatingUpdateRequest,
} from "@mons/shared/ratings";
import {
  AuthApiFailure,
  authErrorResponse,
  isProfileWritesDisabledFailure,
} from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  verifyFirebaseRequest,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import { MAX_FIREBASE_KEY_BYTES, isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  type GameplayRepository,
  createRatingRepository,
  type RatingRepository,
} from "./gameplayRepository.ts";
import {
  createGameplayCoordinationStores,
  GameSessionMutationLockFailure,
  MatchTimerStartStoreFailure,
  type GameplayCoordinationStores,
} from "./gameplayCoordinationD1.ts";
import { createEventGameplayRepository } from "./eventRepository.ts";
import { isSafeOperationId } from "./operationIds.ts";
import { readBoundedJson } from "./http.ts";
import {
  cancelOwnedQueuedAutomatches,
  startAutomatch,
  type AutomatchDependencies,
} from "./automatch.ts";
import {
  claimMatchVictoryByTimer,
  enforceMatchTimerClaimRateLimit,
  enforceMatchTimerRateLimit,
  startMatchTimer,
  type MatchTimerDependencies,
} from "./matchTimer.ts";
import {
  acceptWagerProposal,
  removeWagerProposal,
  sendWagerProposal,
  type WagerProposalDependencies,
} from "./wagerProposal.ts";
import {
  enforceWagerOutcomeRateLimit,
  resolveWagerOutcome,
  WAGER_SETTLEMENT_INITIAL_RETRY_DELAY_SECONDS,
  type WagerOutcomeDependencies,
} from "./wagerOutcome.ts";
import {
  updateRatings,
  type RatingUpdateDependencies,
} from "./ratingUpdate.ts";
import {
  ensureEventProgressWorkflow,
  type EventProgressPlan,
} from "./eventProgress.ts";
import type { TelegramProjectionTask } from "./telegramProjectionTasks.ts";
import type { ProfileGameProjectionTask } from "./profileGameProjectionTasks.ts";
import {
  createManualInvite,
  endRematchSeries,
  enforceGameSessionMutationRateLimit,
  ensureParticipantMatch,
  joinInvite,
  proposeRematch,
  resolveInviteRole,
  type GameSessionMutationDependencies,
} from "./gameSessionMutations.ts";
import { readProfileGamesPage } from "./profileGamesD1.ts";
import { assertProfileMutationAllowed } from "./profileCanonicalActivation.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
} from "./profileOwnership.ts";

export const GAMEPLAY_PATHS = new Set([
  "/automatch/cancel",
  "/automatch/start",
  "/invites/create",
  "/invites/join",
  "/invites/role/read",
  "/matches/ensure",
  "/matches/timer/claim",
  "/matches/timer/start",
  "/navigation/games/read",
  "/navigation/games/remove",
  "/ratings/update",
  "/rematches/end",
  "/rematches/propose",
  "/wagers/proposals/accept",
  "/wagers/proposals/cancel",
  "/wagers/proposals/decline",
  "/wagers/proposals/send",
  "/wagers/outcomes/resolve",
]);

const GAMEPLAY_READ_PATHS = new Set([
  "/invites/role/read",
  "/navigation/games/read",
]);

export type GameplayRouteDependencies = {
  assertMutationAllowed?: () => Promise<void>;
  automatch?: Partial<AutomatchDependencies>;
  coordination?: GameplayCoordinationStores;
  gameSession?: Partial<GameSessionMutationDependencies>;
  logCoordinationFailure?: (record: {
    operation: string;
    store: "mutation-lock" | "timer-start";
  }) => void;
  logFailure?: (kind: string) => void;
  profileGamesDb?: D1Database;
  readNavigationPage?: typeof readProfileGamesPage;
  repository?: GameplayRepository;
  rating?: Partial<RatingUpdateDependencies>;
  ratingRepository?: RatingRepository;
  timer?: Partial<MatchTimerDependencies>;
  wager?: Partial<WagerProposalDependencies>;
  wagerOutcome?: WagerOutcomeDependencies;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<RequestIdentity>;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readAutomatchOperationId(request: Request): string {
  const values = new URL(request.url).searchParams.getAll("operationId");
  if (
    values.length !== 1 ||
    !GAME_SESSION_OPERATION_ID_PATTERN.test(values[0])
  ) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  return values[0];
}

async function resolveProfileId(
  identity: RequestIdentity,
  repository: GameplayRepository,
): Promise<string> {
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: [identity.uid],
    profileIds: [],
  });
  return getLoginProfileId(ownership, identity.uid) || "";
}

export async function cancelAutomatch(
  identity: RequestIdentity,
  repository: GameplayRepository,
  dependencies: AutomatchDependencies,
): Promise<CancelAutomatchResponse> {
  return {
    ok: await cancelOwnedQueuedAutomatches(
      identity.uid,
      repository,
      dependencies,
    ),
  };
}

function skippedNavigationResponse(
  inviteId: string,
  reason: string,
): RemoveNavigationGameResponse {
  return { ok: true, skipped: true, reason, inviteId };
}

export async function removeNavigationGame(
  identity: RequestIdentity,
  inviteId: string,
  repository: GameplayRepository,
): Promise<RemoveNavigationGameResponse> {
  const profileId = await resolveProfileId(identity, repository);
  if (!profileId) {
    return skippedNavigationResponse(inviteId, "profile-unresolved");
  }
  const [inviteValue, automatchValue] = await Promise.all([
    repository.getRtdbPath(`invites/${inviteId}`),
    repository.getRtdbPath(`automatch/${inviteId}`),
  ]);
  const invite = toRecord(inviteValue);
  if (!invite) {
    return skippedNavigationResponse(inviteId, "invite-missing");
  }
  const guestId = normalizeString(invite.guestId);
  if (guestId) {
    return skippedNavigationResponse(inviteId, "invite-active");
  }
  if (
    inferAutomatchStateHint({
      inviteId,
      queueValue: automatchValue,
      hasGuest: false,
      storedStateHint: invite.automatchStateHint,
    }) === "pending"
  ) {
    return skippedNavigationResponse(inviteId, "pending-automatch");
  }
  const game = await repository.getNavigationGame(profileId, inviteId);
  if (!game) {
    return {
      ...skippedNavigationResponse(inviteId, "not-found"),
      deleted: false,
    };
  }
  if (game.status !== "waiting") {
    return {
      ...skippedNavigationResponse(
        inviteId,
        game.status ? `status-${game.status}` : "status-missing",
      ),
      deleted: false,
    };
  }
  const result = await repository.deleteNavigationGame(profileId, inviteId);
  return result === "deleted"
    ? {
        ok: true,
        skipped: false,
        deleted: true,
        reason: null,
        inviteId,
      }
    : {
        ...skippedNavigationResponse(inviteId, "not-found"),
        deleted: false,
      };
}

async function readGameplayBody(
  request: Request,
  pathname: string,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | null;
  try {
    body = toRecord(await readBoundedJson(request));
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  if (!body) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  if (pathname === "/automatch/cancel") {
    if (Object.keys(body).length !== 0) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/automatch/start") {
    if (!isStartAutomatchRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/navigation/games/read") {
    if (!isReadNavigationGamesRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/invites/create") {
    if (!isCreateInviteRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/invites/join") {
    if (!isJoinInviteRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/invites/role/read") {
    if (!isResolveInviteRoleRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/matches/ensure") {
    if (!isEnsureMatchRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/rematches/propose") {
    if (!isProposeRematchRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/rematches/end") {
    if (!isEndRematchRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/matches/timer/start") {
    if (!isStartMatchTimerRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const playerId = body.playerId.trim();
    const opponentId = body.opponentId.trim();
    const matchId = body.matchId.trim();
    const inviteId = body.inviteId.trim();
    return {
      playerId,
      opponentId,
      matchId,
      inviteId,
    } satisfies StartMatchTimerRequest;
  }
  if (pathname === "/matches/timer/claim") {
    if (!isClaimMatchVictoryByTimerRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const playerId = body.playerId.trim();
    const opponentId = body.opponentId.trim();
    const matchId = body.matchId.trim();
    const inviteId = body.inviteId.trim();
    return {
      playerId,
      opponentId,
      matchId,
      inviteId,
    } satisfies ClaimMatchVictoryByTimerRequest;
  }
  if (pathname.startsWith("/wagers/proposals/")) {
    if (pathname === "/wagers/proposals/send") {
      if (!isWagerProposalSendRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const inviteId = body.inviteId.trim();
      const matchId = body.matchId.trim();
      if (!isSafeFirebaseKey(inviteId) || !isSafeFirebaseKey(matchId)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      return {
        inviteId,
        matchId,
        material: body.material,
        count: body.count,
      } satisfies WagerProposalSendRequest;
    }
    if (!isWagerProposalAcceptRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const inviteId = body.inviteId.trim();
    const matchId = body.matchId.trim();
    if (!isSafeFirebaseKey(inviteId) || !isSafeFirebaseKey(matchId)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return { inviteId, matchId } satisfies WagerProposalAcceptRequest;
  }
  if (pathname === "/wagers/outcomes/resolve") {
    if (!isWagerOutcomeResolveRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const inviteId = body.inviteId.trim();
    const matchId = body.matchId.trim();
    if (!isSafeFirebaseKey(inviteId) || !isSafeFirebaseKey(matchId)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return { inviteId, matchId };
  }
  if (pathname === "/ratings/update") {
    if (!isRatingUpdateRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const playerId = body.playerId.trim();
    const opponentId = body.opponentId.trim();
    const inviteId = body.inviteId.trim();
    const matchId = body.matchId.trim();
    if (
      !isSafeFirebaseKey(playerId) ||
      !isSafeFirebaseKey(opponentId) ||
      !isSafeFirebaseKey(inviteId) ||
      !isSafeFirebaseKey(matchId) ||
      !isSafeOperationId(`${inviteId}__${matchId}`)
    ) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return {
      playerId,
      opponentId,
      inviteId,
      matchId,
    } satisfies RatingUpdateRequest;
  }
  if (!isRemoveNavigationGameRequest(body)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  const inviteId = body.inviteId.trim();
  if (!isSafeFirebaseKey(inviteId)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-invite-id");
  }
  return { inviteId };
}

export async function handleGameplayRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: GameplayRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") {
      return authPreflightResponse(corsHeaders);
    }
    if (request.method !== "POST") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    const pathname = new URL(request.url).pathname;
    if (!GAMEPLAY_PATHS.has(pathname)) {
      throw new AuthApiFailure(404, "not-found", "not-found");
    }
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    const automatchOperationId =
      pathname === "/automatch/start"
        ? readAutomatchOperationId(request)
        : null;
    if (!GAMEPLAY_READ_PATHS.has(pathname)) {
      await assertProfileMutationAllowed(env);
    }
    if (pathname === "/wagers/outcomes/resolve") {
      await enforceWagerOutcomeRateLimit(env.AUTH_RATE_LIMITER, identity.uid);
    }
    const body = await readGameplayBody(request, pathname);
    const repository =
      dependencies.repository || createEventGameplayRepository(env);
    const coordination =
      dependencies.coordination ||
      createGameplayCoordinationStores(env.PROFILE_GAMES_DB);
    const assertMutationAllowed =
      dependencies.assertMutationAllowed ||
      (() => assertProfileMutationAllowed(env));
    const defaultEnqueueEventProgress = async (plan: EventProgressPlan) => {
      ctx.waitUntil(
        ensureEventProgressWorkflow(env.EVENT_PROGRESS_WORKFLOW, plan).catch(
          () => {
            console.error(
              JSON.stringify({
                event: "event_progress_enqueue_failed",
                eventId: plan.params.eventId,
                sourceKey: plan.params.sourceKey,
              }),
            );
          },
        ),
      );
    };
    const defaultEnqueueTelegramProjection = async (
      task: TelegramProjectionTask,
    ) => {
      ctx.waitUntil(
        env.TELEGRAM_PROJECTION_QUEUE.send(task).catch(() => {
          console.error(
            JSON.stringify({
              event: "telegram_projection_enqueue_failed",
              kind: task.kind,
            }),
          );
        }),
      );
    };
    const defaultEnqueueProfileGameProjection = async (
      task: ProfileGameProjectionTask,
    ) => {
      ctx.waitUntil(
        env.PROFILE_GAME_PROJECTION_QUEUE.send(task).catch(() => {
          console.error(
            JSON.stringify({
              event: "profile_game_projection_enqueue_failed",
              kind: task.kind,
            }),
          );
        }),
      );
    };
    const automatchDependencies: AutomatchDependencies = {
      ...dependencies.automatch,
      assertMutationAllowed,
      enqueueProfileGameProjection:
        dependencies.automatch?.enqueueProfileGameProjection ||
        defaultEnqueueProfileGameProjection,
      enqueueTelegramProjection:
        dependencies.automatch?.enqueueTelegramProjection ||
        defaultEnqueueTelegramProjection,
      mutationLocks: coordination.mutationLocks,
    };
    const ratingDependencies: RatingUpdateDependencies = {
      ...dependencies.rating,
      assertMutationAllowed,
      enqueueEventProgress:
        dependencies.rating?.enqueueEventProgress ||
        defaultEnqueueEventProgress,
      enqueueProfileGameProjection:
        dependencies.rating?.enqueueProfileGameProjection ||
        defaultEnqueueProfileGameProjection,
      enqueueTelegramProjection:
        dependencies.rating?.enqueueTelegramProjection ||
        defaultEnqueueTelegramProjection,
      timerStarts: coordination.timerStarts,
    };
    const gameSessionDependencies: GameSessionMutationDependencies = {
      ...dependencies.gameSession,
      assertMutationAllowed,
      enqueueProfileGameProjection:
        dependencies.gameSession?.enqueueProfileGameProjection ||
        defaultEnqueueProfileGameProjection,
      mutationLocks: coordination.mutationLocks,
    };
    const wagerDependencies: WagerProposalDependencies = {
      ...dependencies.wager,
      assertMutationAllowed,
      mutationLocks: coordination.mutationLocks,
    };
    let response;
    if (pathname === "/automatch/cancel") {
      response = await cancelAutomatch(
        identity,
        repository,
        automatchDependencies,
      );
    } else if (pathname === "/automatch/start") {
      if (!isStartAutomatchRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      if (!automatchOperationId) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      await enforceGameSessionMutationRateLimit(
        env.AUTH_RATE_LIMITER,
        identity.uid,
      );
      response = await startAutomatch(
        identity,
        { ...body, operationId: automatchOperationId },
        repository,
        automatchDependencies,
      );
    } else if (pathname === "/invites/create") {
      if (!isCreateInviteRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      await enforceGameSessionMutationRateLimit(
        env.AUTH_RATE_LIMITER,
        identity.uid,
      );
      response = await createManualInvite(
        identity,
        body,
        repository,
        gameSessionDependencies,
      );
    } else if (pathname === "/invites/join") {
      if (!isJoinInviteRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      await enforceGameSessionMutationRateLimit(
        env.AUTH_RATE_LIMITER,
        identity.uid,
      );
      const joinResponse = await joinInvite(
        identity,
        body,
        repository,
        gameSessionDependencies,
      );
      response = joinResponse;
      if (joinResponse.joined && isAutoInviteId(body.inviteId)) {
        await defaultEnqueueTelegramProjection({
          kind: "automatch-telegram-projection",
          inviteId: body.inviteId,
          requestId: body.operationId,
        });
      }
    } else if (pathname === "/invites/role/read") {
      if (!isResolveInviteRoleRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await resolveInviteRole(identity, body, repository);
    } else if (pathname === "/matches/ensure") {
      if (!isEnsureMatchRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      await enforceGameSessionMutationRateLimit(
        env.AUTH_RATE_LIMITER,
        identity.uid,
      );
      response = await ensureParticipantMatch(
        identity,
        body,
        repository,
        gameSessionDependencies,
      );
    } else if (pathname === "/rematches/propose") {
      if (!isProposeRematchRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      await enforceGameSessionMutationRateLimit(
        env.AUTH_RATE_LIMITER,
        identity.uid,
      );
      response = await proposeRematch(
        identity,
        body,
        repository,
        gameSessionDependencies,
      );
    } else if (pathname === "/rematches/end") {
      if (!isEndRematchRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      await enforceGameSessionMutationRateLimit(
        env.AUTH_RATE_LIMITER,
        identity.uid,
      );
      response = await endRematchSeries(
        identity,
        body,
        repository,
        gameSessionDependencies,
      );
    } else if (pathname === "/matches/timer/start") {
      if (!isStartMatchTimerRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      await enforceMatchTimerRateLimit(env.AUTH_RATE_LIMITER, identity.uid);
      response = await startMatchTimer(identity, body, repository, {
        ...dependencies.timer,
        assertMutationAllowed,
        enqueueEventProgress:
          dependencies.timer?.enqueueEventProgress ||
          defaultEnqueueEventProgress,
        signal: dependencies.timer?.signal || request.signal,
        timerStarts: coordination.timerStarts,
      });
    } else if (pathname === "/matches/timer/claim") {
      if (!isClaimMatchVictoryByTimerRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      await enforceMatchTimerClaimRateLimit(
        env.AUTH_RATE_LIMITER,
        identity.uid,
      );
      response = await claimMatchVictoryByTimer(identity, body, repository, {
        ...dependencies.timer,
        assertMutationAllowed,
        enqueueEventProgress:
          dependencies.timer?.enqueueEventProgress ||
          defaultEnqueueEventProgress,
        signal: dependencies.timer?.signal || request.signal,
        timerStarts: coordination.timerStarts,
      });
    } else if (pathname === "/navigation/games/read") {
      if (!isReadNavigationGamesRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const profileId = await resolveProfileId(identity, repository);
      response = profileId
        ? await (dependencies.readNavigationPage || readProfileGamesPage)(
            dependencies.profileGamesDb || env.PROFILE_GAMES_DB,
            profileId,
            body.limit,
            body.cursor,
          )
        : { ok: true, items: [], nextCursor: null, hasMore: false };
    } else if (pathname === "/navigation/games/remove") {
      response = await removeNavigationGame(
        identity,
        normalizeString(body.inviteId),
        repository,
      );
    } else if (pathname === "/ratings/update") {
      if (!isRatingUpdateRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await updateRatings(
        identity,
        body,
        dependencies.ratingRepository ||
          createRatingRepository(env, repository),
        ratingDependencies,
      );
    } else if (pathname === "/wagers/proposals/send") {
      if (!isWagerProposalSendRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await sendWagerProposal(
        identity,
        body,
        repository,
        wagerDependencies,
      );
    } else if (pathname === "/wagers/proposals/accept") {
      if (!isWagerProposalAcceptRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await acceptWagerProposal(
        identity,
        body,
        repository,
        wagerDependencies,
      );
    } else if (pathname === "/wagers/outcomes/resolve") {
      if (!isWagerOutcomeResolveRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await resolveWagerOutcome(identity, body, repository, {
        ...dependencies.wagerOutcome,
        assertMutationAllowed,
        scheduleRetry:
          dependencies.wagerOutcome?.scheduleRetry ||
          (async (task) => {
            await env.TELEGRAM_DELIVERY_QUEUE.send(task, {
              delaySeconds: WAGER_SETTLEMENT_INITIAL_RETRY_DELAY_SECONDS,
            });
          }),
        signal: dependencies.wagerOutcome?.signal || request.signal,
      });
    } else {
      if (!isWagerProposalRemovalRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await removeWagerProposal(
        identity,
        body,
        pathname.endsWith("/cancel") ? "cancel" : "decline",
        repository,
        wagerDependencies,
      );
    }
    return authJsonResponse(response, 200, corsHeaders);
  } catch (error) {
    if (
      error instanceof GameSessionMutationLockFailure ||
      error instanceof MatchTimerStartStoreFailure
    ) {
      (
        dependencies.logCoordinationFailure ||
        ((record) =>
          console.error(
            JSON.stringify({
              event: "gameplay_coordination_failure",
              ...record,
            }),
          ))
      )({
        operation: error.operation,
        store:
          error instanceof GameSessionMutationLockFailure
            ? "mutation-lock"
            : "timer-start",
      });
    }
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(
            503,
            "unavailable",
            "gameplay-service-unavailable",
          );
    if (failure.status >= 500 && !isProfileWritesDisabledFailure(failure)) {
      (
        dependencies.logFailure ||
        ((kind) =>
          console.error(
            JSON.stringify({ event: "gameplay_route_failure", kind }),
          ))
      )(failure.message);
    }
    return authErrorResponse(failure, corsHeaders);
  }
}

export {
  MAX_FIREBASE_KEY_BYTES,
  isSafeFirebaseKey,
  readGameplayBody,
  resolveProfileId,
};
