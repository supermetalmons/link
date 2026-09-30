import {} from "../../../../runtime/telegram/automatchSource.js";
import {
  buildTelegramEditDesired,
  buildTelegramSendDesired,
} from "../../../../runtime/telegram/desiredStateCore.js";
import {
  asObject,
  buildAutomatchProjectionGuard,
  buildAutomatchTelegramProjection,
  evaluateAutomatchProjectionUpdate,
  mergeRatingResultFragment,
  shouldProjectRatingTelegramUpdate,
  type AutomatchTelegramProjection,
} from "../../../../runtime/telegram/projectionCore.js";
import type { TelegramRepository } from "../../../../runtime/telegram/deliveryEngine.js";
import type { GameSessionPort } from "../gameSessionContracts.ts";
import type { RatingProjectionRepository } from "../ratingContracts.ts";
import {
  TELEGRAM_PROJECTION_SCHEMA_VERSION,
  type AutomatchTelegramProjectionTask,
  type RatingTelegramProjectionTask,
} from "../telegramProjectionTasks.ts";
import { parseAutomatchTelegramProjectionOutbox as parseOutbox } from "../telegramProjectionOutbox.ts";
import type { InitialTelegramDelivery } from "../telegramDeliveryTasks.ts";
import { PROJECTION_INPUT_RETRIES } from "./policy.ts";

type AutomatchProjectionResult = {
  delivery?: { messageKey: string; revision: string };
  status: "projected" | "stale" | "invalid";
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inputFingerprint(input: {
  inviteData: unknown;
  source: unknown;
}): string {
  return JSON.stringify({
    source: input.source,
    guestId: toRecord(input.inviteData)?.guestId || null,
  });
}

function projectionDesired(projection: AutomatchTelegramProjection) {
  return projection.operation === "send"
    ? buildTelegramSendDesired(projection)
    : buildTelegramEditDesired(projection);
}

async function readAutomatchInputs(
  inviteId: string,
  state: GameSessionPort,
): Promise<{ inviteData: unknown; source: unknown }> {
  const [source, inviteData] = await Promise.all([
    state.readAutomatchTelegramSource(inviteId),
    state.readInviteMetadata(inviteId),
  ]);
  return { source, inviteData };
}

export async function projectAutomatchSource(
  inviteId: string,
  state: GameSessionPort,
  telegram: TelegramRepository,
): Promise<AutomatchProjectionResult> {
  let input = await readAutomatchInputs(inviteId, state);
  for (let attempt = 0; attempt < PROJECTION_INPUT_RETRIES; attempt += 1) {
    const projection = buildAutomatchTelegramProjection({
      inviteId,
      source: toRecord(input.source),
      inviteData: toRecord(input.inviteData),
    });
    if (!projection) {
      return { status: "invalid" };
    }
    const desired = projectionDesired(projection);
    const transaction = await telegram.transactMessage(
      projection.messageKey,
      (current) => {
        const decision = evaluateAutomatchProjectionUpdate(current, projection);
        if (!decision.allowed) {
          return { commit: false, decision: decision.reason };
        }
        return {
          value: {
            ...asObject(current),
            desired,
            automatchProjection: buildAutomatchProjectionGuard(projection),
          },
          decision: decision.reason,
        };
      },
    );
    const latest = await readAutomatchInputs(inviteId, state);
    if (inputFingerprint(input) === inputFingerprint(latest)) {
      return transaction.committed
        ? {
            status: "projected",
            delivery: {
              messageKey: projection.messageKey,
              revision: desired.revision,
            },
          }
        : { status: "stale" };
    }
    input = latest;
  }
  throw new Error("telegram-projection-source-kept-changing");
}

async function settleAutomatchOutbox(
  state: GameSessionPort,
  task: AutomatchTelegramProjectionTask,
  disposition: "clear" | "dead",
  now: () => number,
  reason = "",
): Promise<boolean> {
  if (disposition === "clear") {
    return state.acknowledgeAutomatchTelegramOutbox(
      task.inviteId,
      task.requestId,
    );
  }
  const result = await state.transactAutomatchTelegramOutbox(
    task.inviteId,
    (current) => {
      const record = toRecord(current);
      if (record?.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return {
        value: {
          ...record,
          status: "dead",
          reason,
          updatedAtMs: null,
          deadAtMs: now(),
        },
        decision: "dead",
      };
    },
  );
  return result.committed;
}

export async function processAutomatchTask(
  task: AutomatchTelegramProjectionTask,
  state: GameSessionPort,
  enqueueDelivery: (input: InitialTelegramDelivery) => Promise<unknown>,
  now: () => number,
  telegram: TelegramRepository,
): Promise<string> {
  const outbox = parseOutbox(
    await state.readAutomatchTelegramOutbox(task.inviteId),
  );
  if (!outbox || outbox.requestId !== task.requestId) {
    return "stale";
  }
  const projection = await projectAutomatchSource(
    task.inviteId,
    state,
    telegram,
  );
  if (projection.status === "invalid") {
    await settleAutomatchOutbox(state, task, "dead", now, "invalid-source");
    return "dead";
  }
  if (projection.delivery) {
    await enqueueDelivery({
      ...projection.delivery,
      generation: `automatch:${task.requestId}:${projection.delivery.revision}`,
      producer: "automatch-projection",
    });
  }
  await settleAutomatchOutbox(state, task, "clear", now);
  return projection.status;
}

export async function processRatingTask(
  task: RatingTelegramProjectionTask,
  state: GameSessionPort,
  rating: RatingProjectionRepository,
  enqueueDelivery: (input: InitialTelegramDelivery) => Promise<unknown>,
  now: () => number,
  telegram: TelegramRepository,
): Promise<string> {
  const update = await rating.readRatingUpdate(task.operationId);
  if (!update || update.telegramProjectionState !== "pending") {
    return "stale";
  }
  if (
    update.telegramProjectionVersion !== TELEGRAM_PROJECTION_SCHEMA_VERSION ||
    !shouldProjectRatingTelegramUpdate(update)
  ) {
    await rating.markRatingTelegramProjection(
      task.operationId,
      "dead",
      now(),
      "invalid-record",
    );
    return "dead";
  }
  let mergeReason = "skipped";
  await state.transactAutomatchTelegramSource(update.inviteId, (source) => {
    const merged = mergeRatingResultFragment(source, update);
    mergeReason = merged.reason;
    return merged.changed
      ? { value: merged.source, decision: merged.reason }
      : { commit: false, decision: merged.reason };
  });
  if (mergeReason === "skipped") {
    await rating.markRatingTelegramProjection(
      task.operationId,
      "dead",
      now(),
      "invalid-source",
    );
    return "dead";
  }
  const projection = await projectAutomatchSource(
    update.inviteId,
    state,
    telegram,
  );
  if (projection.status === "invalid") {
    await rating.markRatingTelegramProjection(
      task.operationId,
      "dead",
      now(),
      "invalid-projection",
    );
    return "dead";
  }
  if (projection.delivery) {
    await enqueueDelivery({
      ...projection.delivery,
      generation: `rating:${task.operationId}:${projection.delivery.revision}`,
      producer: "rating-projection",
    });
  }
  await rating.markRatingTelegramProjection(task.operationId, "done", now());
  return mergeReason === "duplicate" ? "duplicate" : projection.status;
}
