import { handleFetch, handleRequest } from "./router.ts";
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
import { sweepEventProgress } from "./eventProgressRecovery.ts";
import {
  handleEventProfileGameProjectionQueue,
  handleProfileGameProjectionQueue,
  handleProfileGameProjectionSweep,
} from "./profileGameProjection.ts";
import {
  EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME,
  PROFILE_GAME_PROJECTION_QUEUE_NAME,
  type ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import { sweepGameSessionMutationReceipts } from "./gameSessionMutationRunner.ts";
import { sweepExpiredAuthState } from "./authStateD1.ts";
import { profileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";
import { createGameplayRepository } from "./gameplayRepository.ts";
import { createAutomatchPersistence } from "./automatchPersistence.ts";
import { createMatchStateSource } from "./matchStateSource.ts";
import { createGameSessionMutationLockStore } from "./gameplayCoordinationD1.ts";
import { recoverEventTransitionIntents } from "./eventRepository.ts";
import { readAutomatchRuntimeControl } from "./automatchD1.ts";
import { runScheduledTasks } from "./scheduledTasks.ts";
import { withD1OperationTelemetry } from "./d1Telemetry.ts";
import { runApplicationOperation } from "./applicationExecution.ts";
import { ApplicationDataUnavailable } from "./applicationDataControl.ts";
import {
  canonicalQueueBatch,
  type QueueBinding,
  type CanonicalQueueEnvelope,
} from "./queueEnvelope.ts";

export { extractIdFromJsonUri } from "./helius.ts";
export type { ProviderFetch } from "./provider.ts";
export { handleFetch, handleRequest };

type ScheduledTasks = {
  authRecovery: () => Promise<unknown>;
  authState: () => Promise<unknown>;
  eventProgress: () => Promise<unknown>;
  eventTransitions: () => Promise<unknown>;
  gameSessionLocks: () => Promise<unknown>;
  gameSessionReceipts: () => Promise<unknown>;
  gameSessionTransitions: () => Promise<unknown>;
  profileGameProjection: () => Promise<unknown>;
  telegramProjection: () => Promise<unknown>;
};

const PROFILE_WRITES_QUEUE_RETRY_DELAY_SECONDS = 5 * 60;

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  overrides: Partial<ScheduledTasks> = {},
): Promise<void> {
  return withD1OperationTelemetry("scheduled.recovery", env, (measuredEnv) =>
    handleScheduledTasks(controller, measuredEnv, overrides),
  );
}

async function handleScheduledTasks(
  controller: ScheduledController,
  env: Env,
  overrides: Partial<ScheduledTasks>,
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
      sweepGameSessionMutationReceipts(
        createAutomatchPersistence(
          env.PROFILE_GAMES_DB,
          createMatchStateSource(env),
        ),
        { now: () => controller.scheduledTime },
      ),
    gameSessionTransitions: async () => {
      const repository = createGameplayRepository(env);
      const result = await repository.automatchPersistence.sweep();
      if (result.failed)
        throw new Error("game-session-transition-recovery-failed");
      return result;
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
  await runScheduledTasks(
    [
      { name: "authRecovery", run: () => runProfileTask(tasks.authRecovery) },
      { name: "eventProgress", run: () => runProfileTask(tasks.eventProgress) },
      {
        name: "eventTransitions",
        run: () => runProfileTask(tasks.eventTransitions),
      },
      {
        name: "profileGameProjection",
        run: () =>
          runProfileTask(() => runPersistenceTask(tasks.profileGameProjection)),
      },
      {
        name: "telegramProjection",
        run: () =>
          runProfileTask(() => runPersistenceTask(tasks.telegramProjection)),
      },
      {
        name: "gameSessionTransitions",
        run: () =>
          runProfileTask(() =>
            runPersistenceTask(tasks.gameSessionTransitions),
          ),
      },
      { name: "gameSessionLocks", run: tasks.gameSessionLocks },
      {
        name: "gameSessionReceipts",
        run: () => runPersistenceTask(tasks.gameSessionReceipts),
      },
      { name: "authState", run: tasks.authState },
    ],
    { scheduledTime: controller.scheduledTime },
  );
}

function retryQueueMessages(batch: MessageBatch<unknown>): void {
  for (const message of batch.messages) {
    message.retry({
      delaySeconds: PROFILE_WRITES_QUEUE_RETRY_DELAY_SECONDS,
    });
  }
}

type QueueHandler = {
  binding: QueueBinding;
  handle: (batch: MessageBatch<unknown>, env: Env) => Promise<void>;
  profileWrites: boolean;
  persistenceWrites: boolean;
};

const queueHandlers: ReadonlyMap<string, QueueHandler> = new Map([
  [
    AUTH_RECOVERY_QUEUE_NAME,
    {
      binding: "AUTH_RECOVERY_QUEUE",
      handle: handleAuthRecoveryQueue,
      profileWrites: true,
      persistenceWrites: false,
    },
  ],
  [
    PROFILE_GAME_PROJECTION_QUEUE_NAME,
    {
      binding: "PROFILE_GAME_PROJECTION_QUEUE",
      handle: handleProfileGameProjectionQueue,
      profileWrites: true,
      persistenceWrites: true,
    },
  ],
  [
    EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME,
    {
      binding: "EVENT_PROFILE_GAME_PROJECTION_QUEUE",
      handle: handleEventProfileGameProjectionQueue,
      profileWrites: true,
      persistenceWrites: true,
    },
  ],
  [
    TELEGRAM_PROJECTION_QUEUE_NAME,
    {
      binding: "TELEGRAM_PROJECTION_QUEUE",
      handle: handleTelegramProjectionQueue,
      profileWrites: true,
      persistenceWrites: true,
    },
  ],
  [
    "mons-link-telegram-delivery-data1",
    {
      binding: "TELEGRAM_DELIVERY_QUEUE",
      handle: handleTelegramQueue,
      profileWrites: false,
      persistenceWrites: false,
    },
  ],
  [
    WAGER_SETTLEMENT_QUEUE_NAME,
    {
      binding: "WAGER_SETTLEMENT_QUEUE",
      handle: handleWagerSettlementQueue,
      profileWrites: false,
      persistenceWrites: false,
    },
  ],
]);

async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const handler = queueHandlers.get(batch.queue);
  if (!handler) {
    console.error(
      JSON.stringify({ event: "worker_queue_unsupported", queue: batch.queue }),
    );
    throw new Error("unsupported-queue");
  }
  if (
    handler.persistenceWrites &&
    (await readAutomatchRuntimeControl(env.PROFILE_GAMES_DB)).state === "frozen"
  ) {
    retryQueueMessages(batch);
    return;
  }
  if (
    handler.profileWrites &&
    !(await profileBackgroundMutationsEnabled(env))
  ) {
    retryQueueMessages(batch);
    return;
  }
  return handler.handle(canonicalQueueBatch(batch, handler.binding), env);
}

export default {
  fetch: handleFetch,
  async queue(batch, env, ctx?: Pick<ExecutionContext, "waitUntil">) {
    try {
      await runApplicationOperation(
        env,
        "queue",
        1,
        (admittedEnv) => handleQueue(batch, admittedEnv),
        ctx,
      );
    } catch (error) {
      if (!(error instanceof ApplicationDataUnavailable)) throw error;
      retryQueueMessages(batch);
    }
  },
  async scheduled(controller, env, ctx?: Pick<ExecutionContext, "waitUntil">) {
    try {
      await runApplicationOperation(
        env,
        "scheduled",
        1,
        (admittedEnv) => handleScheduled(controller, admittedEnv),
        ctx,
      );
    } catch (error) {
      if (!(error instanceof ApplicationDataUnavailable)) throw error;
    }
  },
} satisfies ExportedHandler<
  Env,
  CanonicalQueueEnvelope<
    | AuthRecoveryTask
    | ProfileGameProjectionTask
    | TelegramTaskPayload
    | WagerSettlementRetryTask
    | TelegramProjectionTask
  >
>;
