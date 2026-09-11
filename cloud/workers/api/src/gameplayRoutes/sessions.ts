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
  enforceGameSessionMutationRateLimit,
  ensureParticipantMatch,
  joinInvite,
  proposeRematch,
  resolveInviteRole,
} from "../gameSessionMutations.ts";
import { defineGameplayRoute, validateBody } from "./definition.ts";
import { createGameplayRuntime } from "./runtime.ts";

export const sessionRoutes = [
  defineGameplayRoute({
    path: "/invites/create",
    readOnly: false,
    runtime: createGameplayRuntime,
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
    runtime: createGameplayRuntime,
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
    runtime: createGameplayRuntime,
    parse: (body) => validateBody(body, isResolveInviteRoleRequest),
    handle: (body, runtime) =>
      resolveInviteRole(runtime.identity, body, runtime.repository),
  }),
  defineGameplayRoute({
    path: "/matches/ensure",
    readOnly: false,
    runtime: createGameplayRuntime,
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
    runtime: createGameplayRuntime,
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
    runtime: createGameplayRuntime,
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
