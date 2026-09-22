import {
  isEventPrizeWithdrawalRequest,
  isEventPrizeWithdrawalStatusRequest,
} from "@mons/shared/event-prizes";
import {
  AuthApiFailure,
  authErrorResponse,
  isProfileWritesDisabledFailure,
} from "../authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "../authHttp.ts";
import {
  verifySessionRequest,
  type WorkerExecutionContext,
} from "../sessionAuth.ts";
import type { RequestIdentity } from "../requestIdentity.ts";
import { createEventGameplayRepository } from "../eventRepository.ts";
import { readBoundedJson } from "../http.ts";
import { assertProfileMutationAllowed } from "../profileCanonicalActivation.ts";
import {
  toEventPrizeApiFailure,
  type EventPrizeWithdrawalWorkflowInput,
} from "./contracts.ts";
import {
  createEventPrizeRuntimeDependencies,
  type RuntimeOptions,
} from "./runtime.ts";
import {
  getEventPrizeWithdrawalStatus,
  startEventPrizeWithdrawal,
} from "./admission.ts";

export const EVENT_PRIZE_WITHDRAWAL_PATH = "/events/prizes/withdrawals";
export const EVENT_PRIZE_WITHDRAWAL_STATUS_PATH =
  "/events/prizes/withdrawals/status";

type RouteDependencies = RuntimeOptions & {
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<RequestIdentity>;
  workflow?: Workflow<EventPrizeWithdrawalWorkflowInput>;
};

export async function handleEventPrizeWithdrawalRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") return authPreflightResponse(corsHeaders);
    if (request.method !== "POST") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    const pathname = new URL(request.url).pathname;
    const identity = await (
      dependencies.verifyIdentity || verifySessionRequest
    )(request, env, ctx);
    if (pathname === EVENT_PRIZE_WITHDRAWAL_PATH) {
      await assertProfileMutationAllowed(env);
    }
    let body: unknown;
    try {
      body = await readBoundedJson(request);
    } catch {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const repository =
      dependencies.repository || createEventGameplayRepository(env);
    const runtime = await createEventPrizeRuntimeDependencies(env, {
      now: dependencies.now,
      profileDb: dependencies.profileDb,
      repository,
      withdrawalStore: dependencies.withdrawalStore,
    });
    const workflow =
      dependencies.workflow || env.EVENT_PRIZE_WITHDRAWAL_WORKFLOW;

    if (pathname === EVENT_PRIZE_WITHDRAWAL_PATH) {
      if (!isEventPrizeWithdrawalRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const result = await startEventPrizeWithdrawal(
        identity,
        body,
        runtime,
        repository,
        workflow,
      );
      return authJsonResponse(
        result,
        result.status === "completed" ? 200 : 202,
        corsHeaders,
      );
    }

    if (pathname === EVENT_PRIZE_WITHDRAWAL_STATUS_PATH) {
      if (!isEventPrizeWithdrawalStatusRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const result = await getEventPrizeWithdrawalStatus(
        identity,
        body,
        runtime,
        repository,
        workflow,
      );
      return authJsonResponse(
        result,
        result.status === "completed" ? 200 : 202,
        corsHeaders,
      );
    }
    throw new AuthApiFailure(404, "not-found", "not-found");
  } catch (error) {
    const failure = toEventPrizeApiFailure(error);
    if (failure.status >= 500 && !isProfileWritesDisabledFailure(failure)) {
      console.error(
        JSON.stringify({
          event: "event_prize_withdrawal_route_failure",
          kind: failure.code,
          reason: failure.message,
        }),
      );
    }
    return authErrorResponse(failure, corsHeaders);
  }
}
