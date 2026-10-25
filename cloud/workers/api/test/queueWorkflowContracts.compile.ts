import { validateEventProgressOutbox } from "../src/eventD1/validation.ts";
import {
  queueFor,
  type QueueMessages,
  type QueueProducer,
} from "../src/queueProducers.ts";
import {
  sendQueueTasks,
  claimAndEnqueueProjectionTasks,
} from "../src/projectionSweep.ts";
import type { EventCommand } from "../../../runtime/eventCommands.js";
import type { EventProgressOutboxRecord } from "../../../runtime/events.js";
import type {
  EventProgressDocument,
  EventProgressDeadLetter,
  RetainedEventProgressParams,
} from "../../../runtime/eventProgressRecords.js";
import type { EventStore } from "../src/eventStoreContracts.ts";
import {
  buildEventProgressPlan,
  buildRetainedEventProgressPlan,
  type EventProgressWorkflowParams,
} from "../src/eventProgressCodec.ts";
import type { EventPrizeWithdrawalWorkflowInput } from "../src/eventPrizeWithdrawal/contracts.ts";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
export type QueueSendResponseIsNative = Assert<
  Equal<
    ReturnType<QueueProducer<string>["send"]>,
    ReturnType<Queue<string>["send"]>
  >
>;
export type QueueBatchResponseIsNative = Assert<
  Equal<
    ReturnType<QueueProducer<string>["sendBatch"]>,
    ReturnType<Queue<string>["sendBatch"]>
  >
>;
export type PendingReadsAreRetained = Assert<
  Equal<
    Awaited<ReturnType<EventStore["readEventProgressOutbox"]>>,
    EventProgressDocument<"pending"> | null
  >
>;
export type FreshWritesAreChecked = Assert<
  Equal<
    Parameters<EventStore["putEventProgressOutbox"]>[1],
    EventProgressOutboxRecord
  >
>;

export function queueFamilies(
  env: Env,
  messages: QueueMessages,
  key: "AUTH_RECOVERY_QUEUE" | "WAGER_SETTLEMENT_QUEUE",
) {
  queueFor(env, "AUTH_RECOVERY_QUEUE").send(messages.AUTH_RECOVERY_QUEUE);
  queueFor(env, "PROFILE_GAME_PROJECTION_QUEUE").send(
    messages.PROFILE_GAME_PROJECTION_QUEUE,
  );
  queueFor(env, "PROFILE_GAME_PROJECTION_QUEUE").send(
    messages.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
  );
  queueFor(env, "EVENT_PROFILE_GAME_PROJECTION_QUEUE").send(
    messages.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
  );
  queueFor(env, "TELEGRAM_PROJECTION_QUEUE").send(
    messages.TELEGRAM_PROJECTION_QUEUE,
  );
  queueFor(env, "TELEGRAM_DELIVERY_QUEUE").send(
    messages.TELEGRAM_DELIVERY_QUEUE,
  );
  queueFor(env, "WAGER_SETTLEMENT_QUEUE").send(messages.WAGER_SETTLEMENT_QUEUE);
  // @ts-expect-error Wrong Queue family.
  queueFor(env, "AUTH_RECOVERY_QUEUE").send(messages.WAGER_SETTLEMENT_QUEUE);
  queueFor(env, "EVENT_PROFILE_GAME_PROJECTION_QUEUE").send(
    // @ts-expect-error General profile messages include tasks the dedicated event Queue cannot accept.
    messages.PROFILE_GAME_PROJECTION_QUEUE,
  );
  queueFor(env, "TELEGRAM_DELIVERY_QUEUE").send(
    // @ts-expect-error Legacy wager input belongs only to the consumer compatibility boundary.
    messages.WAGER_SETTLEMENT_QUEUE,
  );
  // @ts-expect-error Union binding keys cannot safely choose one payload family.
  queueFor(env, key).send(messages.AUTH_RECOVERY_QUEUE);
  // @ts-expect-error Union binding keys cannot safely choose one batch family.
  queueFor(env, key).sendBatch([{ body: messages.AUTH_RECOVERY_QUEUE }]);
  sendQueueTasks(queueFor(env, "EVENT_PROFILE_GAME_PROJECTION_QUEUE"), [
    messages.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
  ]);
  sendQueueTasks(queueFor(env, "EVENT_PROFILE_GAME_PROJECTION_QUEUE"), [
    messages.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
    // @ts-expect-error Generic inference cannot widen the strict batch capability to accept mixed tasks.
    messages.PROFILE_GAME_PROJECTION_QUEUE,
  ]);
  claimAndEnqueueProjectionTasks({
    candidates: ["event"],
    claim: async () => true,
    toTask: () => messages.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
    queue: queueFor(env, "EVENT_PROFILE_GAME_PROJECTION_QUEUE"),
    fallbackErrorMessage: "failed",
  });
}

export function nativeBatchVariance(
  queue: Queue<QueueMessages["EVENT_PROFILE_GAME_PROJECTION_QUEUE"]>,
  tasks: QueueMessages["PROFILE_GAME_PROJECTION_QUEUE"][],
) {
  // @ts-expect-error Native method bivariance must not weaken the real generic helper's strict batch port.
  sendQueueTasks(queue, tasks);
}

export function progressCommands(
  fresh: EventProgressOutboxRecord,
  pending: EventProgressDocument<"pending">,
  dead: EventProgressDocument<"dead">,
  letter: EventProgressDeadLetter,
) {
  const accepted: EventCommand[] = [
    { kind: "progress-outbox", outboxId: "id", value: fresh },
    { kind: "progress-outbox", outboxId: "id", value: pending },
    { kind: "progress-dead", outboxId: "id", value: dead },
    { kind: "progress-dead", outboxId: "id", value: letter },
    { kind: "progress-outbox", outboxId: "id", value: null },
    { kind: "progress-dead", outboxId: "id", value: null },
  ];
  // @ts-expect-error Retained pending evidence exposes no domain fields.
  void pending.eventId;
  // @ts-expect-error Retained dead evidence exposes no dictionary access.
  void dead["reason"];
  // @ts-expect-error Dead records cannot be published as pending work.
  accepted.push({ kind: "progress-outbox", outboxId: "id", value: dead });
  // @ts-expect-error Pending records cannot be published as dead letters.
  accepted.push({ kind: "progress-dead", outboxId: "id", value: pending });
  accepted.push({
    kind: "progress-outbox",
    outboxId: "id",
    // @ts-expect-error Fresh incomplete dictionaries are not pending records.
    value: { eventId: "event" },
  });
  accepted.push({
    kind: "progress-dead",
    outboxId: "id",
    value: {
      deadAtMs: 1,
      // @ts-expect-error Fresh dead letters cannot accept arbitrary original records.
      originalRecord: { arbitrary: true },
      reason: "invalid-event-progress-outbox",
    },
  });
  return accepted;
}

export function workflowFamilies(
  env: Env,
  progress: EventProgressWorkflowParams,
  withdrawal: Extract<
    EventPrizeWithdrawalWorkflowInput,
    { kind: "withdrawal" }
  >,
  retained: RetainedEventProgressParams,
) {
  env.EVENT_PROGRESS_WORKFLOW.create({ params: progress });
  env.EVENT_PRIZE_WITHDRAWAL_WORKFLOW.create({ params: withdrawal });
  env.EVENT_PRIZE_WITHDRAWAL_WORKFLOW.create({
    params: { schemaVersion: 1, kind: "preflight" },
  });
  // @ts-expect-error Workflow families remain concrete.
  env.EVENT_PROGRESS_WORKFLOW.create({ params: withdrawal });
  // @ts-expect-error Workflow families remain concrete.
  env.EVENT_PRIZE_WITHDRAWAL_WORKFLOW.create({ params: progress });
  // @ts-expect-error Retained progress parameters require the explicit private compatibility transport.
  env.EVENT_PROGRESS_WORKFLOW.create({ params: retained });
  // @ts-expect-error Fresh progress builders reject arbitrary parameter fields.
  buildEventProgressPlan({ eventId: 3, sourceKey: "source", reason: "reason" });
  buildRetainedEventProgressPlan({
    eventId: 3,
    sourceKey: null,
    reason: false,
  });
}

export function publicProgressPorts(store: EventStore) {
  // @ts-expect-error Generic retained progress transactions remain private adapter capabilities.
  void store.transactEventProgressOutbox;
  // @ts-expect-error Generic retained dead-letter transactions remain private adapter capabilities.
  void store.transactEventProgressDeadOutbox;
}

type StoredProgress = ReturnType<typeof validateEventProgressOutbox>;
export type PartialStorageValidationIsNotFresh = Assert<
  Equal<StoredProgress extends EventProgressOutboxRecord ? true : false, false>
>;
export type RetainedReasonRemainsUnknown = Assert<
  Equal<StoredProgress["reason"], unknown>
>;
export type RetainedFirstQueuedAtRemainsUnknown = Assert<
  Equal<StoredProgress["firstQueuedAtMs"], unknown>
>;
export function retainedWorkflowEvidence(params: RetainedEventProgressParams) {
  // @ts-expect-error Retained Workflow parameters expose no domain fields.
  void params.eventId;
  // @ts-expect-error Retained Workflow parameters expose no dictionary index.
  void params["sourceKey"];
}
export function strictClaimBatch(env: Env, messages: QueueMessages) {
  claimAndEnqueueProjectionTasks({
    candidates: ["event"],
    claim: async () => true,
    // @ts-expect-error Claim batching cannot widen a dedicated event producer to accept mixed task families.
    toTask: () => messages.PROFILE_GAME_PROJECTION_QUEUE,
    queue: queueFor(env, "EVENT_PROFILE_GAME_PROJECTION_QUEUE"),
    fallbackErrorMessage: "failed",
  });
}
