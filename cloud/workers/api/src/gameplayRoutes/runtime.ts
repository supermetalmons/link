import type { AutomatchDependencies } from "../automatch.ts";
import type { GameSessionMutationDependencies } from "../gameSessionMutations.ts";
import {
  createGameplayCoordinationStores,
  type GameplayCoordinationStores,
} from "../gameplayCoordinationD1.ts";
import type {
  GameplayRepository,
  RatingRepository,
} from "../gameplayRepository.ts";
import type {
  StartMatchTimerDependencies,
  ClaimMatchVictoryByTimerDependencies,
} from "../matchTimer.ts";
import type { SurrenderMatchDependencies } from "../matchSurrender.ts";
import type { SubmitMoveDependencies } from "../matchMove.ts";
import type { WagerProposalDependencies } from "../wagerProposal.ts";
import type { WagerOutcomeDependencies } from "../wagerOutcome.ts";
import type { RatingUpdateDependencies } from "../ratingUpdate.ts";
import type { WagerReservationRuntime } from "../wagerReservationRuntime.ts";
import type { readProfileGamesPage } from "../profileGamesD1.ts";
import type { RequestIdentity } from "../requestIdentity.ts";
import type { WorkerExecutionContext } from "../sessionAuth.ts";
import { assertProfileMutationAllowed } from "../profileCanonicalActivation.ts";
import { canonicalMatchOperations } from "../matchStateClient.ts";
import {
  ensureEventProgressWorkflow,
  type EventProgressPlan,
} from "../eventProgress.ts";
import type { TelegramProjectionTask } from "../telegramProjectionTasks.ts";
import type { ProfileGameProjectionTask } from "../profileGameProjectionTasks.ts";

export type GameplayRouteDependencies = {
  wagerReservations?: WagerReservationRuntime;
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
  timer?: Partial<
    StartMatchTimerDependencies & ClaimMatchVictoryByTimerDependencies
  >;
  surrender?: Partial<SurrenderMatchDependencies>;
  move?: Partial<SubmitMoveDependencies>;
  wager?: Partial<WagerProposalDependencies>;
  wagerOutcome?: WagerOutcomeDependencies;
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<RequestIdentity>;
};

export type GameplayRequestContext = {
  request: Request;
  env: Env;
  ctx: WorkerExecutionContext;
  dependencies: GameplayRouteDependencies;
  pathname: string;
  identity: RequestIdentity;
  repository: GameplayRepository;
  reservations: WagerReservationRuntime | null;
  automatchOperationId: string | null;
};

export type GameplayRuntime = Awaited<ReturnType<typeof createGameplayRuntime>>;

export async function createGameplayRuntime(context: GameplayRequestContext) {
  const { env, ctx, dependencies, pathname, repository } = context;
  const baseCoordination =
    dependencies.coordination ||
    createGameplayCoordinationStores(env.PROFILE_GAMES_DB);
  const coordination = repository.automatchPersistence
    ? {
        ...baseCoordination,
        mutationLocks: repository.automatchPersistence.decorateLocks(
          baseCoordination.mutationLocks,
        ),
      }
    : baseCoordination;
  const assertMutationAllowed =
    dependencies.assertMutationAllowed ||
    (() => assertProfileMutationAllowed(env));
  const defaultEnqueueEventProgress = async (plan: EventProgressPlan) => {
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
  const defaultEnqueueTelegramProjection = async (
    task: TelegramProjectionTask,
  ) => {
    if (
      repository.automatchPersistence &&
      !(await repository.automatchPersistence.writesEnabled())
    )
      return;
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
    if (
      repository.automatchPersistence &&
      !(await repository.automatchPersistence.writesEnabled())
    )
      return;
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
      dependencies.rating?.enqueueEventProgress || defaultEnqueueEventProgress,
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
  const canonical = pathname.startsWith("/matches/")
    ? await canonicalMatchOperations(env)
    : null;
  return {
    ...context,
    coordination,
    assertMutationAllowed,
    defaultEnqueueEventProgress,
    defaultEnqueueTelegramProjection,
    defaultEnqueueProfileGameProjection,
    automatchDependencies,
    ratingDependencies,
    gameSessionDependencies,
    wagerDependencies,
    canonical,
  };
}
