import type { EventReads } from "../../../runtime/eventReads.js";
import { resolveEventTelegramAnnouncements } from "@mons/shared/events";
import { buildTelegramEditDesired } from "../../../runtime/telegram/desiredStateCore.js";
import {
  EVENT_TELEGRAM_PROJECTION_GUARD_FIELD,
  EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
  EVENT_TELEGRAM_PROJECTION_ROOT,
  addEventTelegramProjectionGuard,
  buildEventTelegramDispatches,
  buildEventTelegramProjection,
  buildEventTelegramProjectionUpdates,
  isV2TelegramEvent,
  loadEndedMatchResults,
  splitEventTelegramProjectionUpdates,
} from "../../../runtime/telegram/eventProjectionCore.js";
import { createEventLockManagerCore } from "../../../runtime/events/lockManagerCore.js";
import type { StateRepository } from "./stateRepositoryTypes.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { RatingProjectionRepository } from "./gameplayRepository.ts";
import {
  EVENT_TELEGRAM_PROJECTION_OUTBOX_ROOT,
  EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION,
  getEventTelegramProjectionGenerationPath,
  getEventTelegramProjectionOutboxPath,
} from "./eventTelegramProjectionProducer.ts";
import type {
  EventTelegramProjectionTask,
  TelegramProjectionTask,
} from "./telegramProjectionTasks.ts";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryEngine.js";
import type { InitialTelegramDelivery } from "./telegramDeliveryTasks.ts";
import { adoptSundayMonsReminderMessage } from "./eventReminderProjection.ts";
import type { TelegramAnnouncementRepository } from "./telegramD1.ts";

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
  state: StateRepository,
  task: EventTelegramProjectionTask,
): Promise<boolean> {
  const result = await state.transactPath(
    getEventTelegramProjectionOutboxPath(task.eventId),
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

function createProjectionLockManager(state: StateRepository) {
  return createEventLockManagerCore({
    lockRoot: EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
    createLockId: () => crypto.randomUUID(),
    transactPath: state.transactPath,
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
  state: StateRepository,
  path: string,
  value: unknown,
  generation: number,
): Promise<boolean> {
  const result = await state.transactPath(path, (current) => {
    if (persistedProjectionGeneration(current) > generation) {
      return { commit: false, decision: "newer-projection" };
    }
    return { value, decision: "projection-committed" };
  });
  return result.committed === true;
}

async function commitFencedDesiredUpdate(
  telegram: TelegramRepository,
  path: string,
  value: unknown,
  generation: number,
  expectedApplied?: Record<string, unknown>,
): Promise<boolean | "deferred"> {
  const prefix = "telegramMessages/";
  const suffix = "/desired";
  const messageKey =
    path.startsWith(prefix) && path.endsWith(suffix)
      ? path.slice(prefix.length, -suffix.length)
      : "";
  if (!messageKey) throw new TypeError("invalid Telegram desired path");
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
  state: StateRepository & Pick<EventReads, "readEvent">,
  rating: RatingProjectionRepository,
  enqueueDelivery: (input: InitialTelegramDelivery) => Promise<unknown>,
  now: () => number,
  telegram?: TelegramRepository,
  reminder?: {
    repository: Pick<TelegramAnnouncementRepository, "get">;
    chatId: string;
  },
): Promise<string> {
  const outbox = parseEventProjectionOutbox(
    await state.getPath(getEventTelegramProjectionOutboxPath(task.eventId)),
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
    const [eventData, rawState, rawGeneration] = await Promise.all([
      state.readEvent(task.eventId),
      state.getPath(`${EVENT_TELEGRAM_PROJECTION_ROOT}/${task.eventId}`),
      state.getPath(getEventTelegramProjectionGenerationPath(task.eventId)),
    ]);
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
      if (!telegram) {
        return state.getPath(`telegramMessages/${reminderMessageKey}`);
      }
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
        telegram
          ? telegram.getMessage(upcomingMessageKey)
          : state.getPath(`telegramMessages/${upcomingMessageKey}`),
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
    const updates = addEventTelegramProjectionGuard({
      updates: buildEventTelegramProjectionUpdates({
        eventId: task.eventId,
        projection,
      }),
      guard: {
        ...lockManager.getEventLockGuard(lockHandle),
        generation,
      },
    });
    const { desiredUpdates, stateUpdates } =
      splitEventTelegramProjectionUpdates({
        eventId: task.eventId,
        updates,
      });
    const refreshLock = async () => {
      if (!(await lockManager.refreshEventLock(lockHandle))) {
        throw new Error("event-telegram-lock-lost");
      }
    };
    const editableMessages = new Map([
      [
        `telegramMessages/${upcomingMessageKey}/desired`,
        { textField: "upcomingText", message: upcomingMessage },
      ],
      [
        `telegramMessages/${reminderMessageKey}/desired`,
        { textField: "reminderText", message: reminderMessage },
      ],
    ]);
    const deferredTextFields = new Set<string>();
    if (Object.keys(desiredUpdates).length > 0) {
      await refreshLock();
      const committedDesiredUpdates: Record<string, unknown> = {};
      for (const [path, value] of Object.entries(desiredUpdates)) {
        const editable = editableMessages.get(path);
        const committed = telegram
          ? await commitFencedDesiredUpdate(
              telegram,
              path,
              value,
              generation,
              editable
                ? asObject(asObject(editable.message).applied)
                : undefined,
            )
          : await commitFencedProjectionUpdate(state, path, value, generation);
        if (committed === "deferred") {
          deferredTextFields.add(editable!.textField);
        } else if (committed) {
          committedDesiredUpdates[path] = value;
        }
      }
      const dispatches = buildEventTelegramDispatches({
        eventId: task.eventId,
        desiredUpdates: committedDesiredUpdates,
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
    const [statePath, projectedState] = Object.entries(stateUpdates)[0];
    const stateCommitted = await commitFencedProjectionUpdate(
      state,
      statePath,
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
  state: StateRepository,
  candidate: EventProjectionSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await state.transactPath(
    getEventTelegramProjectionOutboxPath(candidate.task.eventId),
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
  state: StateRepository,
  eventId: string,
  nowMs: number,
): Promise<void> {
  await state.transactPath(
    `${EVENT_TELEGRAM_PROJECTION_OUTBOX_ROOT}/${eventId}`,
    (current) => {
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
    },
  );
}

export async function sweepEventTelegramProjections(
  queue: Queue<TelegramProjectionTask>,
  state: StateRepository,
  nowMs: number,
): Promise<number> {
  const value = await state.getPath(EVENT_TELEGRAM_PROJECTION_OUTBOX_ROOT, {
    orderBy: "updatedAtMs",
    startAt: 0,
    endAt: nowMs,
    limitToFirst: EVENT_PROJECTION_SWEEP_LIMIT,
  });
  const entries = eventProjectionSweepEntries(value);
  const candidates = entries.flatMap((entry) =>
    entry.kind === "candidate" ? [entry.value] : [],
  );
  const invalidEventIds = entries.flatMap((entry) =>
    entry.kind === "invalid" ? [entry.eventId] : [],
  );
  const failures: Error[] = [];
  for (const eventId of invalidEventIds) {
    try {
      await markInvalidEventProjectionSweepEntry(state, eventId, nowMs);
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new Error("invalid-record-failed"),
      );
    }
  }
  const tasks: EventTelegramProjectionTask[] = [];
  for (const candidate of candidates) {
    try {
      if (await claimEventProjectionSweepCandidate(state, candidate, nowMs)) {
        tasks.push(candidate.task);
      }
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new Error("event-claim-failed"),
      );
    }
  }
  for (let index = 0; index < tasks.length; index += 100) {
    await queue.sendBatch(
      tasks.slice(index, index + 100).map((task) => ({ body: task })),
    );
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "event-projection-sweep-failed");
  }
  return tasks.length;
}

export { EVENT_PROJECTION_SWEEP_LIMIT, settleEventOutbox };
