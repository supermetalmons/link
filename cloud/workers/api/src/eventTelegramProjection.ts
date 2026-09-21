import { resolveEventTelegramAnnouncements } from "@mons/shared/events";
import { buildTelegramEditDesired } from "../../../runtime/telegram/desiredStateCore.js";
import {
  EVENT_TELEGRAM_PROJECTION_GUARD_FIELD,
  addEventTelegramProjectionGuard,
  buildEventTelegramDispatches,
  buildEventTelegramProjection,
  buildEventTelegramProjectionChanges,
  type EventTelegramDesiredChange,
  isV2TelegramEvent,
  loadEndedMatchResults,
} from "../../../runtime/telegram/eventProjectionCore.js";
import { createEventLockManagerCore } from "../../../runtime/events/lockManagerCore.js";
import type { EventStore } from "./eventStoreContracts.ts";
import type { EventOutboxReads } from "./eventOutboxReadRepository.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { RatingProjectionRepository } from "./gameplayRepository.ts";
import { EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION } from "./eventTelegramProjectionProducer.ts";
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

const EVENT_TELEGRAM_PROJECTION_OWNER_UID = "event-telegram-projector";
const EVENT_PROJECTION_SWEEP_LIMIT = 100;

type EventOutbox = {
  firstQueuedAtMs: number;
  requestId: string;
  schemaVersion: number;
  status: string;
  updatedAtMs: number;
};

export type EventProjectionSweepCandidate = {
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

export function parseEventProjectionOutbox(value: unknown): EventOutbox | null {
  const record = toRecord(value);
  const updatedAtMs = record?.updatedAtMs;
  const firstQueuedAtMs = record?.firstQueuedAtMs ?? updatedAtMs;
  return record?.schemaVersion === EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION &&
    record.status === "pending" &&
    typeof record.requestId === "string" &&
    isSafeRecordKey(record.requestId) &&
    typeof updatedAtMs === "number" &&
    Number.isSafeInteger(updatedAtMs) &&
    updatedAtMs >= 0 &&
    typeof firstQueuedAtMs === "number" &&
    Number.isSafeInteger(firstQueuedAtMs) &&
    firstQueuedAtMs >= 0
    ? {
        schemaVersion: EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION,
        status: "pending",
        requestId: record.requestId,
        firstQueuedAtMs,
        updatedAtMs,
      }
    : null;
}

async function settleEventOutbox(
  state: EventStore,
  task: EventTelegramProjectionTask,
): Promise<boolean> {
  const result = await state.transactEventTelegramProjectionOutbox(
    task.eventId,
    (current) => {
      const outbox = parseEventProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return { value: null, decision: "cleared" };
    },
  );
  return result.committed === true;
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

function persistedProjectionGeneration(value: unknown): number {
  const record = toRecord(value);
  const guard = toRecord(record?.[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD]);
  return readProjectionGeneration(guard?.generation);
}

async function commitFencedProjectionUpdate(
  state: EventStore,
  eventId: string,
  value: Record<string, unknown>,
  generation: number,
): Promise<boolean> {
  const result = await state.transactEventTelegramProjectionState(
    eventId,
    (current) => {
      if (persistedProjectionGeneration(current) > generation) {
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
  expectedApplied?: Record<string, unknown>,
): Promise<boolean | "deferred"> {
  const result = await telegram.transactMessage(messageKey, (current) => {
    const record = asObject(current);
    if (persistedProjectionGeneration(record.desired) > generation) {
      return { commit: false, decision: "newer-projection" };
    }
    if (expectedApplied) {
      const desired = asObject(value);
      const delivery = asObject(record.delivery);
      const abandoned = asObject(delivery.abandonedSend);
      if (
        delivery.status === "terminal" &&
        asObject(delivery.lastError).code === "manually-abandoned" &&
        abandoned.destination === desired.destination &&
        abandoned.instanceKey === desired.instanceKey
      ) {
        return { commit: false, decision: "abandoned" };
      }
      const applied = asObject(record.applied);
      if (
        delivery.sendInFlight ||
        [
          "destination",
          "instanceKey",
          "messageId",
          "contentHash",
          "revision",
        ].some((key) => applied[key] !== expectedApplied[key])
      ) {
        const previousDesired = asObject(record.desired);
        if (
          desired.operation === "edit" &&
          desired.ifMissing === "skip" &&
          previousDesired.destination === desired.destination &&
          previousDesired.instanceKey === desired.instanceKey
        ) {
          return {
            value: {
              ...record,
              desired: {
                ...buildTelegramEditDesired({
                  ...previousDesired,
                  ifMissing: "skip",
                  sourceRevision: desired.sourceRevision,
                }),
                [EVENT_TELEGRAM_PROJECTION_GUARD_FIELD]:
                  desired[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD],
              },
            },
            decision: "delivery-changed",
          };
        }
        return { commit: false, decision: "delivery-changed" };
      }
    }
    return {
      value: { ...record, desired: value },
      decision: "projection-committed",
    };
  });
  return result.decision === "delivery-changed"
    ? "deferred"
    : result.committed === true;
}

export async function processEventProjectionTask(
  task: EventTelegramProjectionTask,
  state: EventStore,
  rating: RatingProjectionRepository,
  enqueueDelivery: (input: InitialTelegramDelivery) => Promise<unknown>,
  now: () => number,
  telegram: TelegramRepository,
  reminder?: {
    repository: Pick<TelegramAnnouncementRepository, "get">;
    chatId: string;
  },
): Promise<string> {
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
  const stopHeartbeat = lockManager.startEventLockHeartbeat(lockHandle);
  try {
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
    const projectionState = asObject(rawState);
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
        projectionState.endedAnnouncementArmed === true &&
        (typeof projectionState.endedText !== "string" ||
          projectionState.endedText === "")
          ? loadEndedMatchResults(eventData, {
              readRatingUpdate: (operationId) =>
                rating.readRatingUpdate(operationId),
            })
          : {},
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
        { textField: "upcomingText", message: upcomingMessage },
      ],
      [
        reminderMessageKey,
        { textField: "reminderText", message: reminderMessage },
      ],
    ]);
    const deferredTextFields = new Set<string>();
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
          editable ? asObject(asObject(editable.message).applied) : undefined,
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
        ? {
            ...asObject(projectedState),
            ...Object.fromEntries(
              Array.from(deferredTextFields, (field) => [
                field,
                typeof projectionState[field] === "string"
                  ? projectionState[field]
                  : "",
              ]),
            ),
            lastProjectedSignature: "",
          }
        : projectedState,
      generation,
    );
    if (deferredTextFields.size > 0) {
      throw new Error("event-telegram-delivery-changed");
    }
    await settleEventOutbox(state, task);
    return stateCommitted ? "projected" : "superseded";
  } finally {
    stopHeartbeat();
    await lockManager.releaseEventLock(lockHandle);
  }
}

export function eventProjectionSweepEntries(
  value: unknown,
): EventProjectionSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([eventId, raw]) => {
    const outbox = parseEventProjectionOutbox(raw);
    return outbox && isSafeRecordKey(eventId)
      ? {
          kind: "candidate" as const,
          value: {
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
  state: EventStore,
  candidate: EventProjectionSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await state.transactEventTelegramProjectionOutbox(
    candidate.task.eventId,
    (current) => {
      const outbox = parseEventProjectionOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.updatedAtMs !== candidate.updatedAtMs ||
        outbox.updatedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: {
          ...asObject(current),
          firstQueuedAtMs: outbox.firstQueuedAtMs,
          updatedAtMs: nowMs,
        },
        decision: "claimed",
      };
    },
  );
  return result.committed;
}

async function markInvalidEventProjectionSweepEntry(
  state: EventStore,
  eventId: string,
  nowMs: number,
): Promise<void> {
  await state.transactEventTelegramProjectionOutbox(eventId, (current) => {
    const record = toRecord(current);
    const updatedAtMs = record?.updatedAtMs;
    if (
      !record ||
      (parseEventProjectionOutbox(current) && isSafeRecordKey(eventId)) ||
      typeof updatedAtMs !== "number" ||
      !Number.isFinite(updatedAtMs) ||
      updatedAtMs > nowMs
    ) {
      return { commit: false, decision: "changed" };
    }
    return {
      value: {
        ...record,
        status: "dead",
        reason: "invalid-record",
        updatedAtMs: null,
        deadAtMs: nowMs,
      },
      decision: "dead",
    };
  });
}

export async function sweepEventTelegramProjections(
  queue: Queue<TelegramProjectionTask>,
  state: EventStore &
    Pick<EventOutboxReads, "listDueEventTelegramProjectionOutboxes">,
  nowMs: number,
): Promise<number> {
  const records = await state.listDueEventTelegramProjectionOutboxes(
    nowMs,
    EVENT_PROJECTION_SWEEP_LIMIT,
  );
  const entries = eventProjectionSweepEntries(
    Object.fromEntries(records.map(({ eventId, record }) => [eventId, record])),
  );
  const candidates = entries.flatMap((entry) =>
    entry.kind === "candidate" ? [entry.value] : [],
  );
  const invalidEventIds = entries.flatMap((entry) =>
    entry.kind === "invalid" ? [entry.eventId] : [],
  );
  const { failures: repairFailures } = await collectProjectionRepairs(
    invalidEventIds,
    (eventId) => markInvalidEventProjectionSweepEntry(state, eventId, nowMs),
    "invalid-record-failed",
  );
  const { sentCount, claimFailures } = await claimAndEnqueueProjectionTasks({
    candidates,
    claim: (candidate) =>
      claimEventProjectionSweepCandidate(state, candidate, nowMs),
    toTask: (candidate) => candidate.task,
    queue,
    fallbackErrorMessage: "event-claim-failed",
  });
  const failures = [...repairFailures, ...claimFailures];
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "event-projection-sweep-failed");
  }
  return sentCount;
}

export { EVENT_PROJECTION_SWEEP_LIMIT, settleEventOutbox };
