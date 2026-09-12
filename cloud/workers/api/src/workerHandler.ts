import { handleRequest } from "./router.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import { readMatchStateControl } from "./matchStateD1.ts";
import { handleTelegramBridge } from "./telegramBridge.ts";
import {
  AUTH_RECOVERY_QUEUE_NAME,
  handleAuthRecoverySweep,
  handleAuthRecoveryQueue,
  type AuthRecoveryTask,
} from "./authRecovery.ts";
import {
  handleTelegramQueue,
  type TelegramTaskPayload,
} from "./telegramQueue.ts";
import {
  handleWagerSettlementQueue,
  WAGER_SETTLEMENT_QUEUE_NAME,
} from "./wagerSettlementQueue.ts";
import type { WagerSettlementRetryTask } from "./wagerOutcome.ts";
import {
  handleTelegramProjectionQueue,
  handleTelegramProjectionSweep,
} from "./telegramProjection.ts";
import {
  TELEGRAM_PROJECTION_QUEUE_NAME,
  type TelegramProjectionTask,
} from "./telegramProjectionTasks.ts";
import { sweepEventProgress } from "./eventProgress.ts";
import {
  handleProfileGameProjectionQueue,
  handleProfileGameProjectionSweep,
} from "./profileGameProjection.ts";
import {
  PROFILE_GAME_PROJECTION_QUEUE_NAME,
  type ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import { sweepGameSessionMutationReceipts } from "./gameSessionMutations.ts";
import { sweepExpiredAuthState } from "./authStateD1.ts";
import {
  handleTelegramCommand,
  TELEGRAM_COMMAND_PATH,
} from "./telegramCommand.ts";
import {
  assertProfileMutationAllowed,
  profileBackgroundMutationsEnabled,
} from "./profileCanonicalActivation.ts";
import {
  handleHistoricalMatchRoute,
  HISTORICAL_MATCH_PATH,
} from "./historicalMatchRoute.ts";
import { createGameplayRepository } from "./gameplayRepository.ts";
import {
  createGameSessionMutationLockStore,
  createMatchTimerStartStore,
} from "./gameplayCoordinationD1.ts";
import { sweepMatchTimerStarts } from "./matchTimerStartSweep.ts";
import { recoverEventTransitionIntents } from "./eventRepository.ts";
import { readAutomatchRuntimeControl } from "./automatchD1.ts";
import { MATCH_SNAPSHOT_PATH } from "@mons/shared/game-sessions";
import { handleMatchSnapshotRoute } from "./matchSnapshotRoute.ts";

export { extractIdFromJsonUri } from "./helius.ts";
export type { ProviderFetch } from "./provider.ts";
export { handleRequest };

export function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === MATCH_SNAPSHOT_PATH) {
    return handleMatchSnapshotRoute(request, env);
  }
  if (pathname === HISTORICAL_MATCH_PATH) {
    return handleHistoricalMatchRoute(request, env);
  }
  if (pathname === "/internal/telegram/delivery") {
    return handleTelegramBridge(request, env);
  }
  if (pathname === TELEGRAM_COMMAND_PATH) {
    return handleTelegramCommand(request, env);
  }
  return handleRequest(request, env, {}, ctx);
}

type ScheduledTasks = {
  authRecovery: () => Promise<unknown>;
  authState: () => Promise<unknown>;
  eventProgress: () => Promise<unknown>;
  eventTransitions: () => Promise<unknown>;
  gameSessionLocks: () => Promise<unknown>;
  gameSessionReceipts: () => Promise<unknown>;
  gameSessionTransitions: () => Promise<unknown>;
  matchTimerStarts: () => Promise<unknown>;
  profileGameProjection: () => Promise<unknown>;
  telegramProjection: () => Promise<unknown>;
};

const PROFILE_WRITES_QUEUE_RETRY_DELAY_SECONDS = 5 * 60;

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  overrides: Partial<ScheduledTasks> = {},
): Promise<void> {
  const profileWritesEnabled = profileBackgroundMutationsEnabled(env);
  const persistenceWritesEnabled = readAutomatchRuntimeControl(
    env.PROFILE_GAMES_DB,
  ).then((control) => control.state === "active");
  const tasks: ScheduledTasks = {
    authRecovery: () => handleAuthRecoverySweep(controller, env),
    authState: () =>
      sweepExpiredAuthState(env.AUTH_STATE_DB, controller.scheduledTime),
    eventProgress: () => sweepEventProgress(env),
    eventTransitions: () => recoverEventTransitionIntents(env),
    gameSessionLocks: async () => {
      try {
        return await createGameSessionMutationLockStore(
          env.PROFILE_GAMES_DB,
        ).deleteExpired(controller.scheduledTime);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "game_session_mutation_lock_cleanup_failed",
            code: error instanceof Error ? error.message : "unknown",
          }),
        );
        throw error;
      }
    },
    gameSessionReceipts: () =>
      sweepGameSessionMutationReceipts(env, {
        now: () => controller.scheduledTime,
      }),
    gameSessionTransitions: async () => {
      const repository = createGameplayRepository(env);
      const result = await repository.automatchPersistence?.sweep();
      if (result?.failed)
        throw new Error("game-session-transition-recovery-failed");
      return result;
    },
    matchTimerStarts: async () => {
      if (
        (await readMatchStateControl(env.PROFILE_GAMES_DB)).state !== "active"
      )
        return;
      await requireActiveDurableMatchState(env.PROFILE_GAMES_DB);
      return sweepMatchTimerStarts(
        createMatchTimerStartStore(env.PROFILE_GAMES_DB),
        createGameplayRepository(env),
        {
          assertMutationAllowed: async () => {
            await assertProfileMutationAllowed(env);
            await requireActiveDurableMatchState(env.PROFILE_GAMES_DB);
          },
          now: () => controller.scheduledTime,
        },
      );
    },
    profileGameProjection: () =>
      handleProfileGameProjectionSweep(controller, env),
    telegramProjection: () => handleTelegramProjectionSweep(controller, env),
    ...overrides,
  };
  const runProfileTask = async (task: () => Promise<unknown>) => {
    if (await profileWritesEnabled) {
      await task();
    }
  };
  const runPersistenceTask = async (task: () => Promise<unknown>) => {
    if (await persistenceWritesEnabled) await task();
  };
  const results = await Promise.allSettled([
    runProfileTask(tasks.authRecovery),
    runProfileTask(tasks.eventProgress),
    runProfileTask(tasks.eventTransitions),
    runProfileTask(() => runPersistenceTask(tasks.profileGameProjection)),
    runProfileTask(() => runPersistenceTask(tasks.telegramProjection)),
    runProfileTask(() => runPersistenceTask(tasks.gameSessionTransitions)),
    runProfileTask(tasks.matchTimerStarts),
    tasks.gameSessionLocks(),
    runPersistenceTask(tasks.gameSessionReceipts),
    tasks.authState(),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
}

function retryQueueMessages(batch: MessageBatch<unknown>): void {
  for (const message of batch.messages) {
    message.retry({
      delaySeconds: PROFILE_WRITES_QUEUE_RETRY_DELAY_SECONDS,
    });
  }
}

async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  if (
    (batch.queue === PROFILE_GAME_PROJECTION_QUEUE_NAME ||
      batch.queue === TELEGRAM_PROJECTION_QUEUE_NAME) &&
    (await readAutomatchRuntimeControl(env.PROFILE_GAMES_DB)).state === "frozen"
  ) {
    retryQueueMessages(batch);
    return;
  }
  if (
    batch.queue === AUTH_RECOVERY_QUEUE_NAME ||
    batch.queue === PROFILE_GAME_PROJECTION_QUEUE_NAME ||
    batch.queue === TELEGRAM_PROJECTION_QUEUE_NAME
  ) {
    if (!(await profileBackgroundMutationsEnabled(env))) {
      retryQueueMessages(batch);
      return;
    }
  }
  if (batch.queue === AUTH_RECOVERY_QUEUE_NAME) {
    return handleAuthRecoveryQueue(batch, env);
  }
  if (batch.queue === TELEGRAM_PROJECTION_QUEUE_NAME) {
    return handleTelegramProjectionQueue(batch, env);
  }
  if (batch.queue === PROFILE_GAME_PROJECTION_QUEUE_NAME) {
    return handleProfileGameProjectionQueue(batch, env);
  }
  if (batch.queue === WAGER_SETTLEMENT_QUEUE_NAME) {
    return handleWagerSettlementQueue(batch, env);
  }
  return handleTelegramQueue(batch, env);
}

export default {
  fetch: handleFetch,
  queue: handleQueue,
  scheduled(controller, env) {
    return handleScheduled(controller, env);
  },
} satisfies ExportedHandler<
  Env,
  | AuthRecoveryTask
  | ProfileGameProjectionTask
  | TelegramTaskPayload
  | WagerSettlementRetryTask
  | TelegramProjectionTask
>;
