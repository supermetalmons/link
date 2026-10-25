import { projectAutomatchMessage } from "../../../../runtime/telegram/messageProjectionRecords.js";
import type { InviteDocument } from "@mons/shared/invite-records";
import {} from "../../../../runtime/telegram/automatchSource.js";
import {
  buildTelegramEditDesired,
  buildTelegramSendDesired,
} from "../../../../runtime/telegram/desiredStateCore.js";
import {
  shouldProjectRatingTelegramUpdate,
  type AutomatchTelegramProjection,
} from "../../../../runtime/telegram/projectionCore.js";
import type { TelegramRepository } from "../../../../runtime/telegram/deliveryEngine.js";
import type { AutomatchTelegramSourceSnapshot } from "../automatchProjectionRecords.ts";
import type { GameSessionPort } from "../gameSessionContracts.ts";
import type { RatingProjectionRepository } from "../ratingContracts.ts";
import {
  TELEGRAM_PROJECTION_SCHEMA_VERSION,
  type AutomatchTelegramProjectionTask,
  type RatingTelegramProjectionTask,
} from "../telegramProjectionTasks.ts";
import type { InitialTelegramDelivery } from "../telegramDeliveryTasks.ts";
import { PROJECTION_INPUT_RETRIES } from "./policy.ts";

type AutomatchProjectionResult = {
  delivery?: { messageKey: string; revision: string };
  status: "projected" | "stale" | "invalid";
};

function inputFingerprint(input: {
  inviteData: InviteDocument | null;
  source: AutomatchTelegramSourceSnapshot;
}): string {
  return input.source.fingerprint(input.inviteData);
}

function projectionDesired(projection: AutomatchTelegramProjection) {
  return projection.operation === "send"
    ? buildTelegramSendDesired(projection)
    : buildTelegramEditDesired(projection);
}

async function readAutomatchInputs(
  inviteId: string,
  state: GameSessionPort,
): Promise<{
  inviteData: InviteDocument | null;
  source: AutomatchTelegramSourceSnapshot;
}> {
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
    const projection = input.source.project(input.inviteData);
    if (!projection) {
      return { status: "invalid" };
    }
    const desired = projectionDesired(projection);
    const transaction = await telegram.transactMessage(
      projection.messageKey,
      (current) => projectAutomatchMessage(current, projection, desired),
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
  return state.markAutomatchTelegramOutboxDead(
    task.inviteId,
    task.requestId,
    reason,
    now,
  );
}

export async function processAutomatchTask(
  task: AutomatchTelegramProjectionTask,
  state: GameSessionPort,
  enqueueDelivery: (input: InitialTelegramDelivery) => Promise<unknown>,
  now: () => number,
  telegram: TelegramRepository,
): Promise<"stale" | "dead" | "projected"> {
  const outbox = (await state.readAutomatchTelegramOutbox(task.inviteId)).value;
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
): Promise<"stale" | "dead" | "projected" | "duplicate"> {
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
  const mergeReason = await state.mergeAutomatchTelegramRatingResult(
    update.inviteId,
    update,
  );
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
