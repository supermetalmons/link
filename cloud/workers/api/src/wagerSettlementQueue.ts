import { infrastructureRetryDelaySeconds } from "./queueRetry.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  classifyWagerSettlementRetry,
  resumeWagerSettlement,
  type WagerSettlementResolution,
  type WagerSettlementRetryTask,
} from "./wagerOutcome.ts";
import { profileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";
import {
  createWagerReservationRuntime,
  type WagerReservationRuntime,
} from "./wagerReservationRuntime.ts";

export const WAGER_SETTLEMENT_QUEUE_NAME = "mons-link-wager-settlement";
export const WAGER_SETTLEMENT_RETRY_DELAY_SECONDS = 5 * 60;

class WagerSettlementWritesDisabled extends Error {}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isExactNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0
  );
}

export function parseWagerSettlementRetryTask(
  value: unknown,
): WagerSettlementRetryTask | null {
  const task = toRecord(value);
  if (
    task?.kind !== "wager-settlement" ||
    !isSafeRecordKey(task.inviteId) ||
    !isSafeRecordKey(task.matchId) ||
    typeof task.operationId !== "string"
  ) {
    return null;
  }
  if (Object.keys(task).length === 4) {
    return {
      kind: "wager-settlement",
      inviteId: task.inviteId,
      matchId: task.matchId,
      operationId: task.operationId,
    };
  }
  const resolution = toRecord(task.resolution);
  if (
    Object.keys(task).length !== 5 ||
    !resolution ||
    Object.keys(resolution).length !== 4 ||
    !isExactNonEmptyString(resolution.winnerUid) ||
    !isSafeRecordKey(resolution.winnerUid) ||
    !isExactNonEmptyString(resolution.winnerProfileId) ||
    !isExactNonEmptyString(resolution.loserUid) ||
    !isSafeRecordKey(resolution.loserUid) ||
    !isExactNonEmptyString(resolution.loserProfileId)
  ) {
    return null;
  }
  const parsedResolution: WagerSettlementResolution = {
    winnerUid: resolution.winnerUid,
    winnerProfileId: resolution.winnerProfileId,
    loserUid: resolution.loserUid,
    loserProfileId: resolution.loserProfileId,
  };
  return {
    kind: "wager-settlement",
    inviteId: task.inviteId,
    matchId: task.matchId,
    operationId: task.operationId,
    resolution: parsedResolution,
  };
}

async function deferWagerSettlement(
  message: Message<unknown>,
  task: WagerSettlementRetryTask,
  env: Env,
  logger: Pick<Console, "error" | "info">,
  reason: string,
  code?: string,
): Promise<void> {
  try {
    await env.WAGER_SETTLEMENT_QUEUE.send(task, {
      delaySeconds: WAGER_SETTLEMENT_RETRY_DELAY_SECONDS,
    });
    message.ack();
    const entry = JSON.stringify({
      event: "wager_settlement_queue_deferred",
      operationId: task.operationId,
      reason,
      ...(code ? { code } : {}),
    });
    if (code) {
      logger.error(entry);
    } else {
      logger.info(entry);
    }
  } catch (error) {
    message.retry({ delaySeconds: WAGER_SETTLEMENT_RETRY_DELAY_SECONDS });
    logger.error(
      JSON.stringify({
        event: "wager_settlement_queue_defer_failed",
        operationId: task.operationId,
        reason,
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

export async function handleWagerSettlementQueueMessage(
  message: Message<unknown>,
  env: Env,
  {
    createGameplay = (workerEnv) => createGameplayRepository(workerEnv),
    classifySettlement = classifyWagerSettlementRetry,
    logger = console,
    now = Date.now,
    profileMutationsEnabled = profileBackgroundMutationsEnabled,
    createWagerReservations = createWagerReservationRuntime,
    resumeSettlement = resumeWagerSettlement,
  }: {
    createGameplay?: (env: Env) => GameplayRepository;
    classifySettlement?: typeof classifyWagerSettlementRetry;
    logger?: Pick<Console, "error" | "info">;
    now?: () => number;
    profileMutationsEnabled?: typeof profileBackgroundMutationsEnabled;
    createWagerReservations?: (
      env: Env,
      repository: GameplayRepository,
    ) => WagerReservationRuntime;
    resumeSettlement?: typeof resumeWagerSettlement;
  } = {},
): Promise<void> {
  const task = parseWagerSettlementRetryTask(message.body);
  if (!task) {
    message.ack();
    logger.error(
      JSON.stringify({ event: "wager_settlement_queue_invalid_message" }),
    );
    return;
  }
  let mutationsEnabled = false;
  try {
    mutationsEnabled = await profileMutationsEnabled(env);
  } catch {
    mutationsEnabled = false;
  }
  if (!mutationsEnabled) {
    try {
      const status = await classifySettlement(task, createGameplay(env));
      if (status === "completed" || status === "stale") {
        message.ack();
        logger.info(
          JSON.stringify({
            event: "wager_settlement_queue_processed",
            operationId: task.operationId,
            status,
          }),
        );
        return;
      }
    } catch (error) {
      await deferWagerSettlement(
        message,
        task,
        env,
        logger,
        "classification-unavailable",
        error instanceof Error ? error.message : "unknown",
      );
      return;
    }
    await deferWagerSettlement(
      message,
      task,
      env,
      logger,
      "profile-writes-disabled",
    );
    return;
  }
  const assertMutationAllowed = async () => {
    let enabled = false;
    try {
      enabled = await profileMutationsEnabled(env);
    } catch {}
    if (!enabled) throw new WagerSettlementWritesDisabled();
  };
  try {
    const status = await createWagerReservations(env, createGameplay(env)).run(
      "wager-settlement",
      (admittedRepository, admissionGuard) =>
        resumeSettlement(task, admittedRepository, now, async () => {
          await assertMutationAllowed();
          await admissionGuard();
        }),
    );
    message.ack();
    logger.info(
      JSON.stringify({
        event: "wager_settlement_queue_processed",
        operationId: task.operationId,
        status,
      }),
    );
  } catch (error) {
    if (error instanceof WagerSettlementWritesDisabled) {
      await deferWagerSettlement(
        message,
        task,
        env,
        logger,
        "profile-writes-disabled",
      );
      return;
    }
    message.retry({
      delaySeconds: infrastructureRetryDelaySeconds(message.attempts),
    });
    logger.error(
      JSON.stringify({
        event: "wager_settlement_queue_failed",
        operationId: task.operationId,
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

export async function handleWagerSettlementQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await handleWagerSettlementQueueMessage(message, env);
  }
}
