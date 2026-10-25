import type { AuthRecoveryTask } from "./authRecovery/jobs.ts";
import type {
  EventProfileGameProjectionTask,
  ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import type { TelegramProjectionTask } from "./telegramProjectionTasks.ts";
import type { TelegramTaskPayload } from "../../../runtime/telegram/taskIdentity.js";
import type { WagerSettlementRetryTask } from "./wagerOutcome.ts";

export type QueueMessages = {
  AUTH_RECOVERY_QUEUE: AuthRecoveryTask;
  PROFILE_GAME_PROJECTION_QUEUE: ProfileGameProjectionTask;
  EVENT_PROFILE_GAME_PROJECTION_QUEUE: EventProfileGameProjectionTask;
  TELEGRAM_PROJECTION_QUEUE: TelegramProjectionTask;
  TELEGRAM_DELIVERY_QUEUE: TelegramTaskPayload;
  WAGER_SETTLEMENT_QUEUE: WagerSettlementRetryTask;
};

export type QueueProducer<Body> = {
  send: (
    ...args: Parameters<Queue<Body>["send"]>
  ) => ReturnType<Queue<Body>["send"]>;
  sendBatch: (
    ...args: Parameters<Queue<Body>["sendBatch"]>
  ) => ReturnType<Queue<Body>["sendBatch"]>;
};

type QueueProducers = {
  [Key in keyof QueueMessages]: QueueProducer<QueueMessages[Key]>;
};

export function queueFor<Key extends keyof QueueMessages>(
  env: Pick<Env, Key>,
  key: Key,
): QueueProducers[Key] {
  return env[key];
}
