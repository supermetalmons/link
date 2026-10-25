import type { QueueProducer } from "./queueProducers.ts";
import { retainEventTelegramEndedResults } from "../../../runtime/telegram/eventProjectionRecords.js";
import {
  deferEventTelegramProjectionTexts,
  eventTelegramProjectionGeneration,
  eventTelegramProjectionNeedsResults,
  type EventTelegramProjectionStateDocument,
  type EventTelegramTextField,
} from "../../../runtime/telegram/eventProjectionRecords.js";
import {
  messageAppliedDocument,
  type TelegramAppliedDocument,
} from "../../../runtime/telegram/records.js";
import { projectEventMessage } from "../../../runtime/telegram/messageProjectionRecords.js";
import { resolveEventTelegramAnnouncements } from "@mons/shared/events";

import {
  addEventTelegramProjectionGuard,
  buildEventTelegramDispatches,
  buildEventTelegramProjection,
  buildEventTelegramProjectionChanges,
  type EventTelegramDesiredChange,
  isV2TelegramEvent,
  loadEndedMatchResults,
} from "../../../runtime/telegram/eventProjectionCore.js";
import {
  createEventLockManagerCore,
  withEventLease,
} from "../../../runtime/events/lockManagerCore.js";
import type { EventStore } from "./eventStoreContracts.ts";
import type {
  EventProjectionRecoverySnapshot,
  EventProjectionRecoveryStore,
  EventProjectionRecoveryWriter,
} from "./eventProjectionRecoveryD1.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { RatingProjectionRepository } from "./ratingContracts.ts";
import { parseEventProjectionOutbox } from "./telegramProjectionOutbox.ts";
import type {
  EventTelegramProjectionTask,
  TelegramProjectionTask,
} from "./telegramProjectionTasks.ts";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryEngine.js";
import type { InitialTelegramDelivery } from "./telegramDeliveryTasks.ts";
import { adoptSundayMonsReminderMessage } from "./eventReminderProjection.ts";
import type { TelegramAnnouncementRepository } from "./telegramD1.ts";
import {
  claimAndEnqueueProjectionTasks,
  collectProjectionRepairs,
} from "./projectionSweep.ts";
import { reportRecoveryFailure } from "./recoveryReporting.ts";

const EVENT_TELEGRAM_PROJECTION_OWNER_UID = "event-telegram-projector";
const EVENT_PROJECTION_SWEEP_LIMIT = 100;

export type EventProjectionSweepCandidate = {
  snapshot: EventProjectionRecoverySnapshot<"telegram">;
  task: EventTelegramProjectionTask;
  updatedAtMs: number;
};

type EventProjectionSweepEntry =
  | { kind: "candidate"; value: EventProjectionSweepCandidate }
  | { eventId: string; kind: "invalid" };

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return toRecord(value) || {};
}

async function settleEventOutbox(
  state: EventStore,
  task: EventTelegramProjectionTask,
): Promise<boolean> {
  return state.acknowledgeEventTelegramProjectionOutbox(
    task.eventId,
    task.requestId,
  );
}

function createProjectionLockManager(state: EventStore) {
  return createEventLockManagerCore({
    lockKind: "telegram-projection",
    createLockId: () => crypto.randomUUID(),
    transactEventLease: state.transactEventLease,
    logger: {
      error: (_message, error) => {
        console.error(
          JSON.stringify({
            event: "event_telegram_projection_lock_failure",
            code: error instanceof Error ? error.message : "unknown",
          }),
        );
      },
    },
  });
}

function readProjectionGeneration(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

async function commitFencedProjectionUpdate(
  state: EventStore,
  eventId: string,
  value: EventTelegramProjectionStateDocument,
  generation: number,
): Promise<boolean> {
  const result = await state.transactEventTelegramProjectionState(
    eventId,
    (current) => {
      if (eventTelegramProjectionGeneration(current) > generation) {
        return { commit: false, decision: "newer-projection" };
      }
      return { value, decision: "projection-committed" };
    },
  );
  return result.committed === true;
}

async function commitFencedDesiredUpdate(
  telegram: TelegramRepository,
  messageKey: string,
  value: EventTelegramDesiredChange["value"],
  generation: number,
  expectedApplied?: TelegramAppliedDocument,
): Promise<boolean | "deferred"> {
  const result = await telegram.transactMessage(messageKey, (current) =>
    projectEventMessage(current, value, generation, expectedApplied),
  );
  return result.decision === "delivery-changed"
    ? "deferred"
    : result.committed === true;
}

export async function processEventProjectionTask(
  task: EventTelegramProjectionTask,
  state: EventStore,
  rating: Pick<RatingProjectionRepository, "readRatingUpdates">,
  enqueueDelivery: (input: InitialTelegramDelivery) => Promise<unknown>,
  now: () => number,
  telegram: TelegramRepository,
  reminder?: {
    repository: Pick<TelegramAnnouncementRepository, "get">;
    chatId: string;
  },
): Promise<
  | "stale"
  | "missing"
  | "not-v2"
  | "skip"
  | "unchanged"
  | "projected"
  | "superseded"
> {
  const outbox = parseEventProjectionOutbox(
    await state.readEventTelegramProjectionOutbox(task.eventId),
  );
  if (!outbox || outbox.requestId !== task.requestId) {
    return "stale";
  }
  const lockManager = createProjectionLockManager(state);
  const lockHandle = await lockManager.acquireEventLock(
    task.eventId,
    EVENT_TELEGRAM_PROJECTION_OWNER_UID,
  );
  if (!lockHandle) {
    throw new Error("event-telegram-lock-busy");
  }
  return withEventLease(lockManager, lockHandle, async () => {
    const [eventData, projectionSnapshot] = await Promise.all([
      state.readEvent(task.eventId),
      state.readEventTelegramProjectionState(task.eventId),
    ]);
    const rawState = projectionSnapshot?.state ?? null;
    const rawGeneration = projectionSnapshot?.generation ?? 0;
    if (!isV2TelegramEvent(eventData)) {
      await settleEventOutbox(state, task);
      return eventData === null ? "missing" : "not-v2";
    }
    const event = asObject(eventData);
    const generation = readProjectionGeneration(rawGeneration);
    const announcements = resolveEventTelegramAnnouncements(event);
    const upcomingMessageKey = `event:${task.eventId}:upcoming`;
    const reminderMessageKey = `event:${task.eventId}:reminder`;
    const readReminderMessage = async () => {
      const current = await telegram.getMessage(reminderMessageKey);
      if (
        current != null ||
        !reminder ||
        event.status !== "scheduled" ||
        event.isSundayMons !== true
      ) {
        return current;
      }
      return adoptSundayMonsReminderMessage({
        eventId: task.eventId,
        receipt: await reminder.repository.get(
          `event:${task.eventId}:reminder:v1`,
        ),
        telegram,
        chatId: reminder.chatId,
      });
    };
    const [upcomingMessage, reminderMessage, endedMatchResults] =
      await Promise.all([
        telegram.getMessage(upcomingMessageKey),
        readReminderMessage(),
        announcements.results &&
        event.status === "ended" &&
        eventTelegramProjectionNeedsResults(rawState)
          ? loadEndedMatchResults(eventData, {
              readRatingUpdates: (operationIds) =>
                rating.readRatingUpdates(operationIds),
            })
          : retainEventTelegramEndedResults({}),
      ]);
    const projection = buildEventTelegramProjection({
      eventId: task.eventId,
      eventData,
      endedMatchResults,
      state: rawState,
      upcomingMessage,
      reminderMessage,
      nowMs: now(),
    });
    if (projection.action !== "project") {
      await settleEventOutbox(state, task);
      return projection.action;
    }
    const changes = buildEventTelegramProjectionChanges({
      eventId: task.eventId,
      projection,
    });
    if (!changes) throw new Error("event-telegram-projection-changes-missing");
    const guarded = addEventTelegramProjectionGuard({
      changes,
      guard: { ...lockManager.getEventLockGuard(lockHandle), generation },
    });
    const refreshLock = async () => {
      if (!(await lockManager.refreshEventLock(lockHandle))) {
        throw new Error("event-telegram-lock-lost");
      }
    };
    const editableMessages = new Map([
      [
        upcomingMessageKey,
        { textField: "upcomingText" as const, message: upcomingMessage },
      ],
      [
        reminderMessageKey,
        { textField: "reminderText" as const, message: reminderMessage },
      ],
    ]);
    const deferredTextFields = new Set<EventTelegramTextField>();
    if (guarded.desired.length > 0) {
      await refreshLock();
      const committedDesiredChanges: EventTelegramDesiredChange[] = [];
      for (const { messageKey, value } of guarded.desired) {
        const editable = editableMessages.get(messageKey);
        const committed = await commitFencedDesiredUpdate(
          telegram,
          messageKey,
          value,
          generation,
          editable ? messageAppliedDocument(editable.message) : undefined,
        );
        if (committed === "deferred") {
          deferredTextFields.add(editable!.textField);
        } else if (committed) {
          committedDesiredChanges.push({ messageKey, value });
        }
      }
      const dispatches = buildEventTelegramDispatches({
        eventId: task.eventId,
        desiredChanges: committedDesiredChanges,
      });
      await Promise.all(
        dispatches.map((dispatch) =>
          enqueueDelivery({
            ...dispatch,
            producer: "event-projection",
          }),
        ),
      );
    }
    await refreshLock();
    const projectedState = guarded.state;
    const stateCommitted = await commitFencedProjectionUpdate(
      state,
      task.eventId,
      deferredTextFields.size > 0
        ? deferEventTelegramProjectionTexts(
            projectedState,
            rawState,
            deferredTextFields,
          )
        : projectedState,
      generation,
    );
    if (deferredTextFields.size > 0) {
      throw new Error("event-telegram-delivery-changed");
    }
    await settleEventOutbox(state, task);
    return stateCommitted ? "projected" : "superseded";
  });
}

export function eventProjectionSweepEntries(
  snapshots: readonly EventProjectionRecoverySnapshot<"telegram">[],
): EventProjectionSweepEntry[] {
  const records = Object.fromEntries(
    snapshots.map((snapshot) => [snapshot.eventId, snapshot]),
  );
  return Object.entries(records).map(([eventId, snapshot]) => {
    const outbox = parseEventProjectionOutbox(snapshot.record);
    return outbox && isSafeRecordKey(eventId)
      ? {
          kind: "candidate" as const,
          value: {
            snapshot,
            task: {
              kind: "event-telegram-projection" as const,
              eventId,
              requestId: outbox.requestId,
            },
            updatedAtMs: outbox.updatedAtMs,
          },
        }
      : { kind: "invalid" as const, eventId };
  });
}

export async function claimEventProjectionSweepCandidate(
  writer: Pick<EventProjectionRecoveryWriter<"telegram">, "claim">,
  candidate: EventProjectionSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  return writer.claim(
    candidate.snapshot,
    candidate.task.requestId,
    candidate.updatedAtMs,
    nowMs,
  );
}

async function markInvalidEventProjectionSweepEntry(
  writer: Pick<EventProjectionRecoveryWriter<"telegram">, "markInvalid">,
  eventId: string,
  nowMs: number,
): Promise<void> {
  await writer.markInvalid(eventId, nowMs);
}

export async function sweepEventTelegramProjections(
  queue: Pick<QueueProducer<TelegramProjectionTask>, "sendBatch">,
  recovery: EventProjectionRecoveryStore<"telegram">,
  nowMs: number,
  logger: Pick<Console, "error"> = console,
): Promise<number> {
  const records = await recovery.listDue(nowMs, EVENT_PROJECTION_SWEEP_LIMIT);
  if (records.length === 0) return 0;
  return recovery.withAdmission(async (writer) => {
    const entries = eventProjectionSweepEntries(records);
    const candidates = entries.flatMap((entry) =>
      entry.kind === "candidate" ? [entry.value] : [],
    );
    const invalidEventIds = entries.flatMap((entry) =>
      entry.kind === "invalid" ? [entry.eventId] : [],
    );
    const { failures: repairFailures } = await collectProjectionRepairs(
      invalidEventIds,
      (eventId) => markInvalidEventProjectionSweepEntry(writer, eventId, nowMs),
      "invalid-record-failed",
      (eventId, error, itemIndex) =>
        reportRecoveryFailure(
          logger,
          {
            event: "telegram_projection_recovery_record_failed",
            scope: "telegram",
            source: "event",
            phase: "repair",
            itemIndex,
            eventId,
          },
          error,
        ),
    );
    const { sentCount, claimFailures } = await claimAndEnqueueProjectionTasks({
      candidates,
      claim: (candidate) =>
        claimEventProjectionSweepCandidate(writer, candidate, nowMs),
      toTask: (candidate) => candidate.task,
      queue,
      fallbackErrorMessage: "event-claim-failed",
      onClaimFailure: ({ task }, error, itemIndex) =>
        reportRecoveryFailure(
          logger,
          {
            event: "telegram_projection_recovery_record_failed",
            scope: "telegram",
            source: "event",
            phase: "claim",
            itemIndex,
            eventId: task.eventId,
          },
          error,
        ),
    });
    const failures = [...repairFailures, ...claimFailures];
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "event-projection-sweep-failed");
    }
    return sentCount;
  });
}

export {
  EVENT_PROJECTION_SWEEP_LIMIT,
  parseEventProjectionOutbox,
  settleEventOutbox,
};
