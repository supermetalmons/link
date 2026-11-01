import {
  buildAutomatchProfileGameProjectionTask,
  buildAutomatchProjectionTask,
} from "./plans.ts";
import type {
  AutomatchDependencies,
  AutomatchPlanDependencies,
} from "./types.ts";
import type { AutomatchProfileGameProjectionTask } from "../profileGameProjectionTasks.ts";
import type { AutomatchTelegramProjectionTask } from "../telegramProjectionTasks.ts";

export function createAutomatchProjectionTask(
  inviteId: string,
  dependencies: AutomatchPlanDependencies,
  requestId = (
    dependencies.createProjectionRequestId || (() => crypto.randomUUID())
  )(),
): AutomatchTelegramProjectionTask {
  return buildAutomatchProjectionTask(inviteId, requestId);
}

export function createAutomatchProfileGameProjectionTask(
  inviteId: string,
  dependencies: AutomatchPlanDependencies,
): AutomatchProfileGameProjectionTask {
  return buildAutomatchProfileGameProjectionTask(
    inviteId,
    (dependencies.createProjectionRequestId || (() => crypto.randomUUID()))(),
  );
}

async function enqueueAutomatchProjection(
  task: AutomatchTelegramProjectionTask,
  dependencies: AutomatchDependencies,
): Promise<void> {
  if (!dependencies.enqueueTelegramProjection) {
    return;
  }
  try {
    await dependencies.enqueueTelegramProjection(task);
  } catch {
    (
      dependencies.logProjectionFailure ||
      ((failedTask) =>
        console.error(
          JSON.stringify({
            event: "automatch_telegram_projection_enqueue_failed",
            inviteId: failedTask.inviteId,
          }),
        ))
    )(task);
  }
}

async function enqueueAutomatchProfileGameProjection(
  task: AutomatchProfileGameProjectionTask,
  dependencies: AutomatchDependencies,
): Promise<void> {
  if (!dependencies.enqueueProfileGameProjection) {
    return;
  }
  try {
    await dependencies.enqueueProfileGameProjection(task);
  } catch {
    (
      dependencies.logProfileGameProjectionFailure ||
      ((failedTask) =>
        console.error(
          JSON.stringify({
            event: "automatch_profile_game_projection_enqueue_failed",
            inviteId: failedTask.inviteId,
          }),
        ))
    )(task);
  }
}

export async function enqueueAutomatchProjections(
  telegramTask: AutomatchTelegramProjectionTask | null,
  profileTask: AutomatchProfileGameProjectionTask,
  dependencies: AutomatchDependencies,
): Promise<void> {
  if (telegramTask) {
    await enqueueAutomatchProjection(telegramTask, dependencies);
  }
  await enqueueAutomatchProfileGameProjection(profileTask, dependencies);
}
