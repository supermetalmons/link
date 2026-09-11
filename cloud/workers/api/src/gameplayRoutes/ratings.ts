import { isRatingUpdateRequest } from "@mons/shared/ratings";
import { isSafeRecordKey } from "../recordKeys.ts";
import { isSafeOperationId } from "../operationIds.ts";
import { createRatingRepository } from "../gameplayRepository.ts";
import { updateRatings } from "../ratingUpdate.ts";
import {
  defineGameplayRoute,
  invalidRequest,
  validateBody,
} from "./definition.ts";
import { createGameplayRuntime } from "./runtime.ts";

export const ratingRoutes = [
  defineGameplayRoute({
    path: "/ratings/update",
    readOnly: false,
    runtime: createGameplayRuntime,
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
          createRatingRepository(env, repository),
        ratingDependencies,
      ),
  }),
];
