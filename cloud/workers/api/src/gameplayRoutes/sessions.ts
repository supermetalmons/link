import {
  isCreateInviteRequest,
  isEndRematchRequest,
  isEnsureMatchRequest,
  isJoinInviteRequest,
  isProposeRematchRequest,
  isResolveInviteRoleRequest,
} from "@mons/shared/game-sessions";
import { isAutoInviteId } from "@mons/shared/ids";
import {
  createManualInvite,
  endRematchSeries,
  ensureParticipantMatch,
  joinInvite,
  proposeRematch,
  type GameSessionMutationDependencies,
} from "../gameSessionMutations.ts";
import { enforceGameSessionMutationRateLimit } from "../gameSessionMutationRunner.ts";
import { resolveInviteRole } from "../inviteAccess.ts";
import { defineGameplayRoute, validateBody } from "./definition.ts";
import { requireActiveDurableMatchState } from "../matchStateAuthority.ts";
import {
  createGameplayMutationLocks,
  createGameplayProjectionDispatch,
  gameplayMutationGuard,
  type GameplayRequestContext,
} from "./runtime.ts";

function createSessionRuntime(context: GameplayRequestContext) {
  const { dependencies } = context;
  const dispatch = createGameplayProjectionDispatch(context);
  const gameSessionDependencies: GameSessionMutationDependencies = {
    ...dependencies.gameSession,
    assertMutationAllowed: gameplayMutationGuard(context),
    enqueueProfileGameProjection:
      dependencies.gameSession?.enqueueProfileGameProjection ||
      dispatch.defaultEnqueueProfileGameProjection,
    mutationLocks: createGameplayMutationLocks(context),
  };
  return {
    ...context,
    gameSessionDependencies,
    defaultEnqueueTelegramProjection: dispatch.defaultEnqueueTelegramProjection,
  };
}

async function createEnsureMatchRuntime(context: GameplayRequestContext) {
  await requireActiveDurableMatchState(context.env.PROFILE_GAMES_DB);
  return createSessionRuntime(context);
}

export const sessionRoutes = [
  defineGameplayRoute({
    path: "/invites/create",
    readOnly: false,
    runtime: createSessionRuntime,
    parse: (body) => validateBody(body, isCreateInviteRequest),
    handle: async (body, runtime) => {
      await enforceGameSessionMutationRateLimit(
        runtime.env.AUTH_RATE_LIMITER,
        runtime.identity.uid,
      );
      return createManualInvite(
        runtime.identity,
        body,
        runtime.repository,
        runtime.gameSessionDependencies,
      );
    },
  }),
  defineGameplayRoute({
    path: "/invites/join",
    readOnly: false,
    runtime: createSessionRuntime,
    parse: (body) => validateBody(body, isJoinInviteRequest),
    handle: async (body, runtime) => {
      await enforceGameSessionMutationRateLimit(
        runtime.env.AUTH_RATE_LIMITER,
        runtime.identity.uid,
      );
      const response = await joinInvite(
        runtime.identity,
        body,
        runtime.repository,
        runtime.gameSessionDependencies,
      );
      if (response.joined && isAutoInviteId(body.inviteId)) {
        await runtime.defaultEnqueueTelegramProjection({
          kind: "automatch-telegram-projection",
          inviteId: body.inviteId,
          requestId: body.operationId,
        });
      }
      return response;
    },
  }),
  defineGameplayRoute({
    path: "/invites/role/read",
    readOnly: true,
    runtime: (context) => context,
    parse: (body) => validateBody(body, isResolveInviteRoleRequest),
    handle: (body, runtime) =>
      resolveInviteRole(runtime.identity, body, runtime.repository),
  }),
  defineGameplayRoute({
    path: "/matches/ensure",
    readOnly: false,
    runtime: createEnsureMatchRuntime,
    parse: (body) => validateBody(body, isEnsureMatchRequest),
    handle: async (body, runtime) => {
      await enforceGameSessionMutationRateLimit(
        runtime.env.AUTH_RATE_LIMITER,
        runtime.identity.uid,
      );
      return ensureParticipantMatch(
        runtime.identity,
        body,
        runtime.repository,
        runtime.gameSessionDependencies,
      );
    },
  }),
  defineGameplayRoute({
    path: "/rematches/propose",
    readOnly: false,
    runtime: createSessionRuntime,
    parse: (body) => validateBody(body, isProposeRematchRequest),
    handle: async (body, runtime) => {
      await enforceGameSessionMutationRateLimit(
        runtime.env.AUTH_RATE_LIMITER,
        runtime.identity.uid,
      );
      return proposeRematch(
        runtime.identity,
        body,
        runtime.repository,
        runtime.gameSessionDependencies,
      );
    },
  }),
  defineGameplayRoute({
    path: "/rematches/end",
    readOnly: false,
    runtime: createSessionRuntime,
    parse: (body) => validateBody(body, isEndRematchRequest),
    handle: async (body, runtime) => {
      await enforceGameSessionMutationRateLimit(
        runtime.env.AUTH_RATE_LIMITER,
        runtime.identity.uid,
      );
      return endRematchSeries(
        runtime.identity,
        body,
        runtime.repository,
        runtime.gameSessionDependencies,
      );
    },
  }),
];
