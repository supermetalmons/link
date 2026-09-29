import { isRatingUpdateRequest } from "@mons/shared/ratings";
import { isSafeRecordKey } from "../recordKeys.ts";
import { isSafeOperationId } from "../operationIds.ts";
import { createRatingRepository } from "../ratingRepository.ts";
import { createEventProgressOutboxWriter } from "../eventRepository.ts";
import {
  updateRatings,
  type RatingUpdateDependencies,
} from "../ratingUpdate.ts";
import { createMatchTimerStartStore } from "../gameplayCoordinationD1.ts";
import { ensureEventProgressWorkflow } from "../eventProgressDispatch.ts";
import type { EventProgressPlan } from "../eventProgressCodec.ts";
import {
  defineGameplayRoute,
  invalidRequest,
  validateBody,
} from "./definition.ts";
import {
  createGameplayProjectionDispatch,
  gameplayMutationGuard,
  type GameplayRequestContext,
} from "./runtime.ts";

function createRatingRuntime(context: GameplayRequestContext) {
  const { env, ctx, dependencies } = context;
  const dispatch = createGameplayProjectionDispatch(context);
  const enqueueEventProgress = async (plan: EventProgressPlan) => {
    ctx.waitUntil(
      ensureEventProgressWorkflow(env, plan).catch(() => {
        console.error(
          JSON.stringify({
            event: "event_progress_enqueue_failed",
            eventId: plan.params.eventId,
            sourceKey: plan.params.sourceKey,
          }),
        );
      }),
    );
  };
  const ratingDependencies: RatingUpdateDependencies = {
    ...dependencies.rating,
    assertMutationAllowed: gameplayMutationGuard(context),
    enqueueEventProgress:
      dependencies.rating?.enqueueEventProgress || enqueueEventProgress,
    enqueueProfileGameProjection:
      dependencies.rating?.enqueueProfileGameProjection ||
      dispatch.defaultEnqueueProfileGameProjection,
    enqueueTelegramProjection:
      dependencies.rating?.enqueueTelegramProjection ||
      dispatch.defaultEnqueueTelegramProjection,
    timerStarts:
      dependencies.coordination?.timerStarts ||
      createMatchTimerStartStore(env.PROFILE_GAMES_DB),
  };
  return { ...context, ratingDependencies };
}

export const ratingRoutes = [
  defineGameplayRoute({
    path: "/ratings/update",
    readOnly: false,
    runtime: createRatingRuntime,
    parse(body) {
      const value = validateBody(body, isRatingUpdateRequest);
      const playerId = value.playerId.trim();
      const opponentId = value.opponentId.trim();
      const inviteId = value.inviteId.trim();
      const matchId = value.matchId.trim();
      if (
        !isSafeRecordKey(playerId) ||
        !isSafeRecordKey(opponentId) ||
        !isSafeRecordKey(inviteId) ||
        !isSafeRecordKey(matchId) ||
        !isSafeOperationId(`${inviteId}__${matchId}`)
      ) {
        throw invalidRequest();
      }
      return { playerId, opponentId, inviteId, matchId };
    },
    handle: (
      body,
      { identity, dependencies, env, repository, ratingDependencies },
    ) =>
      updateRatings(
        identity,
        body,
        dependencies.ratingRepository ||
          createRatingRepository(
            env.PROFILE_DB,
            repository,
            createEventProgressOutboxWriter(env.EVENT_DB),
          ),
        ratingDependencies,
      ),
  }),
];
