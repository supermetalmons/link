import { GAME_SESSION_OPERATION_ID_PATTERN } from "@mons/shared/game-sessions";
import {
  isStartAutomatchRequest,
  type CancelAutomatchResponse,
} from "@mons/shared/navigation";
import { AuthApiFailure } from "../authErrors.ts";
import {
  cancelOwnedQueuedAutomatches,
  startAutomatch,
  type AutomatchDependencies,
} from "../automatch.ts";
import { enforceGameSessionMutationRateLimit } from "../gameSessionMutations.ts";
import type { GameplayRepository } from "../gameplayRepository.ts";
import type { RequestIdentity } from "../requestIdentity.ts";
import {
  defineGameplayRoute,
  invalidRequest,
  validateBody,
} from "./definition.ts";
import { createGameplayRuntime } from "./runtime.ts";

export function readAutomatchOperationId(request: Request): string {
  const values = new URL(request.url).searchParams.getAll("operationId");
  if (
    values.length !== 1 ||
    !GAME_SESSION_OPERATION_ID_PATTERN.test(values[0])
  ) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  return values[0];
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

export const automatchRoutes = [
  defineGameplayRoute({
    path: "/automatch/cancel",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse(body) {
      if (Object.keys(body).length !== 0) throw invalidRequest();
      return body;
    },
    handle: (_body, { identity, repository, automatchDependencies }) =>
      cancelAutomatch(identity, repository, automatchDependencies),
  }),
  defineGameplayRoute({
    path: "/automatch/start",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse: (body) => validateBody(body, isStartAutomatchRequest),
    async handle(
      body,
      {
        identity,
        repository,
        env,
        automatchDependencies,
        automatchOperationId,
      },
    ) {
      if (!automatchOperationId) throw invalidRequest();
      await enforceGameSessionMutationRateLimit(
        env.AUTH_RATE_LIMITER,
        identity.uid,
      );
      return startAutomatch(
        identity,
        { ...body, operationId: automatchOperationId },
        repository,
        automatchDependencies,
      );
    },
  }),
];
