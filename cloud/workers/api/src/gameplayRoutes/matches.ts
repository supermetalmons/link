import {
  MATCH_MOVE_PATH,
  MAX_MATCH_MOVE_REQUEST_BYTES,
  isSurrenderMatchRequest,
  isSubmitMoveRequest,
} from "@mons/shared/game-sessions";
import {
  isClaimMatchVictoryByTimerRequest,
  isStartMatchTimerRequest,
} from "@mons/shared/timers";
import { enforceGameSessionMutationRateLimit } from "../gameSessionMutations.ts";
import { enforceMatchMoveRateLimit, submitMove } from "../matchMove.ts";
import { surrenderMatch } from "../matchSurrender.ts";
import {
  claimMatchVictoryByTimer,
  enforceMatchTimerClaimRateLimit,
  enforceMatchTimerRateLimit,
  startMatchTimer,
} from "../matchTimer.ts";
import {
  defineGameplayRoute,
  invalidRequest,
  validateBody,
} from "./definition.ts";
import { createGameplayRuntime } from "./runtime.ts";

export const matchRoutes = [
  defineGameplayRoute({
    path: MATCH_MOVE_PATH,
    readOnly: false,
    maxBodyBytes: MAX_MATCH_MOVE_REQUEST_BYTES,
    runtime: createGameplayRuntime,
    parse: (body) => validateBody(body, isSubmitMoveRequest),
    handle: async (body, runtime) => {
      const { canonical, dependencies } = runtime;
      if (!canonical) throw invalidRequest();
      await enforceMatchMoveRateLimit(
        runtime.env.MOVE_RATE_LIMITER,
        runtime.identity.uid,
      );
      return submitMove(runtime.identity, body, runtime.repository, {
        submitCanonical:
          dependencies.move?.submitCanonical || canonical.submitCanonical,
        assertMutationAllowed: runtime.assertMutationAllowed,
        signal: dependencies.move?.signal || runtime.request.signal,
      });
    },
  }),
  defineGameplayRoute({
    path: "/matches/surrender",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse: (body) => validateBody(body, isSurrenderMatchRequest),
    handle: async (body, runtime) => {
      const { canonical, dependencies } = runtime;
      if (!canonical) throw invalidRequest();
      await enforceGameSessionMutationRateLimit(
        runtime.env.AUTH_RATE_LIMITER,
        runtime.identity.uid,
      );
      return surrenderMatch(runtime.identity, body, runtime.repository, {
        surrenderCanonical:
          dependencies.surrender?.surrenderCanonical ||
          canonical.surrenderCanonical,
        assertMutationAllowed: runtime.assertMutationAllowed,
        signal: dependencies.surrender?.signal || runtime.request.signal,
      });
    },
  }),
  defineGameplayRoute({
    path: "/matches/timer/start",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse: (body) => {
      const value = validateBody(body, isStartMatchTimerRequest);
      return {
        playerId: value.playerId.trim(),
        opponentId: value.opponentId.trim(),
        matchId: value.matchId.trim(),
        inviteId: value.inviteId.trim(),
      };
    },
    handle: async (body, runtime) => {
      const { canonical, dependencies } = runtime;
      if (!canonical) throw invalidRequest();
      await enforceMatchTimerRateLimit(
        runtime.env.AUTH_RATE_LIMITER,
        runtime.identity.uid,
      );
      return startMatchTimer(runtime.identity, body, runtime.repository, {
        startCanonical:
          dependencies.timer?.startCanonical || canonical.startCanonical,
        assertMutationAllowed: runtime.assertMutationAllowed,
        signal: dependencies.timer?.signal || runtime.request.signal,
      });
    },
  }),
  defineGameplayRoute({
    path: "/matches/timer/claim",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse: (body) => {
      const value = validateBody(body, isClaimMatchVictoryByTimerRequest);
      return {
        playerId: value.playerId.trim(),
        opponentId: value.opponentId.trim(),
        matchId: value.matchId.trim(),
        inviteId: value.inviteId.trim(),
      };
    },
    handle: async (body, runtime) => {
      const { canonical, dependencies } = runtime;
      if (!canonical) throw invalidRequest();
      await enforceMatchTimerClaimRateLimit(
        runtime.env.AUTH_RATE_LIMITER,
        runtime.identity.uid,
      );
      const claim = claimMatchVictoryByTimer(
        runtime.identity,
        body,
        runtime.repository,
        {
          claimCanonical:
            dependencies.timer?.claimCanonical || canonical.claimCanonical,
          assertMutationAllowed: runtime.assertMutationAllowed,
          signal: dependencies.timer?.signal || runtime.request.signal,
        },
      );
      runtime.ctx.waitUntil(claim.catch(() => undefined));
      return claim;
    },
  }),
];
