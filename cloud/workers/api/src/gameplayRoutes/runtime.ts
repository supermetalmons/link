import type { AutomatchDependencies } from "../automatch.ts";
import type { GameSessionMutationDependencies } from "../gameSessionMutations.ts";
import {
  createGameSessionMutationLockStore,
  type GameplayCoordinationStores,
} from "../gameplayCoordinationD1.ts";
import type { GameplayRepository } from "../gameplayRepository.ts";
import type { RatingRepository } from "../ratingContracts.ts";
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
  admittedMatchEpoch?: number;
};

export function gameplayMutationGuard({
  env,
  dependencies,
}: GameplayRequestContext): () => Promise<void> {
  return (
    dependencies.assertMutationAllowed ||
    (() => assertProfileMutationAllowed(env))
  );
}

export function createGameplayMutationLocks({
  env,
  dependencies,
  repository,
}: GameplayRequestContext) {
  return repository.automatchPersistence.decorateLocks(
    dependencies.coordination?.mutationLocks ||
      createGameSessionMutationLockStore(env.PROFILE_GAMES_DB),
  );
}

export function createGameplayProjectionDispatch({
  env,
  ctx,
  repository,
}: GameplayRequestContext) {
  const defaultEnqueueTelegramProjection = async (
    task: TelegramProjectionTask,
  ) => {
    if (!(await repository.automatchPersistence.writesEnabled())) return;
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
    if (!(await repository.automatchPersistence.writesEnabled())) return;
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
  return {
    defaultEnqueueTelegramProjection,
    defaultEnqueueProfileGameProjection,
  };
}
