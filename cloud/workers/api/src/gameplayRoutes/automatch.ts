import { GAME_SESSION_OPERATION_ID_PATTERN } from "@mons/shared/game-sessions";
import {
  AUTOMATCH_API_MAX_RESPONSE_BYTES,
  isStartAutomatchRequest,
  parseStartAutomatchApiResponse,
  type CancelAutomatchResponse,
  type StartAutomatchApiResponse,
  type StartAutomatchResponse,
} from "@mons/shared/navigation";
import { AuthApiFailure } from "../authErrors.ts";
import {
  cancelOwnedQueuedAutomatches,
  startAutomatch,
  type AutomatchDependencies,
} from "../automatch.ts";
import { enforceGameSessionMutationRateLimit } from "../gameSessionMutations.ts";
import type { GameplayRepository } from "../gameplayRepository.ts";
import type { AutomatchRepository } from "../gameplayContracts.ts";
import type { RequestIdentity } from "../requestIdentity.ts";
import { readAuthenticatedGameBootstrap } from "../gameBootstrap.ts";
import { measureAutomatchPhase } from "../automatchTelemetry.ts";
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
  repository: AutomatchRepository,
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

export async function enrichAutomatchResponse(
  response: StartAutomatchResponse,
  {
    request,
    identity,
    repository,
    env,
    operationId,
  }: {
    request: Request;
    identity: RequestIdentity;
    repository: GameplayRepository;
    env: Env;
    operationId: string;
  },
  readBootstrap = readAuthenticatedGameBootstrap,
): Promise<StartAutomatchApiResponse> {
  const requested = new URL(request.url).searchParams.getAll("bootstrap");
  if (
    env.AUTOMATCH_DELIVERY_MODE !== "bootstrap" ||
    requested.length !== 1 ||
    requested[0] !== "1" ||
    !response.ok ||
    response.mode !== "matched" ||
    request.signal.aborted
  )
    return response;
  return measureAutomatchPhase("bootstrap", async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bootstrap = await Promise.race([
        readBootstrap(
          {
            inviteId: response.inviteId,
            selection: "current",
            identity,
            signal,
          },
          env,
          { repository },
        ).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(null);
          }, 1_000);
        }),
      ]);
      if (
        signal.aborted ||
        bootstrap?.viewer.automatchOperationId !== operationId
      )
        return response;
      const enriched = parseStartAutomatchApiResponse({
        ...response,
        bootstrap,
      });
      return enriched &&
        new TextEncoder().encode(JSON.stringify(enriched)).byteLength <=
          AUTOMATCH_API_MAX_RESPONSE_BYTES
        ? enriched
        : response;
    } catch {
      return response;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  });
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
        request,
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
      const response = await startAutomatch(
        identity,
        { ...body, operationId: automatchOperationId },
        repository,
        automatchDependencies,
      );
      return enrichAutomatchResponse(response, {
        request,
        identity,
        repository,
        env,
        operationId: automatchOperationId,
      });
    },
  }),
];
