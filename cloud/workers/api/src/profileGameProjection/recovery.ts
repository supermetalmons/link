import { createGameplayRepository } from "../gameplayRepository.ts";
import { createRatingRepository } from "../ratingRepository.ts";
import {
  createEventGameplayRepository,
  createEventProgressOutboxWriter,
} from "../eventRepository.ts";
import { isSafeRecordKey } from "../recordKeys.ts";
import {
  parseAutomatchProfileGameProjectionOutbox,
  parseEventProfileGameProjectionOutbox,
  salvageHistoricalMatchDescriptors,
} from "../profileGameProjectionOutbox.ts";
import {
  PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
  type AutomatchProfileGameProjectionTask,
  type EventProfileGameProjectionTask,
  type ProfileGameProjectionTask,
} from "../profileGameProjectionTasks.ts";
import { createProfileGameProjectionLockStore } from "../profileGameProjectionLocksD1.ts";
import { createProfileLinkCatchupStore } from "../profileLinkCatchupD1.ts";
import { runRecoveryItems } from "../recoveryRunner.ts";
import {
  claimAndEnqueueProjectionTasks,
  collectProjectionRepairs,
  sendQueueTasks,
} from "../projectionSweep.ts";
import {
  PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY,
  PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS,
} from "./policy.ts";
import type {
  AutomatchRecoveryState,
  EventProfileProjectionState,
  RatingRecoveryDependencies,
  AutomatchRecoveryDependencies,
  EventRecoveryDependencies,
  ProfileLinkRecoveryDependencies,
  ProfileGameProjectionRecoveryDependencies,
  ProfileGameProjectionSweepResult,
} from "./types.ts";

type AutomatchSweepCandidate = {
  lastQueuedAtMs: number;
  task: AutomatchProfileGameProjectionTask;
};

type AutomatchSweepEntry =
  | { kind: "candidate"; value: AutomatchSweepCandidate }
  | { inviteId: string; kind: "invalid" };

type EventSweepCandidate = {
  lastQueuedAtMs: number;
  task: EventProfileGameProjectionTask;
};

type EventSweepEntry =
  | { kind: "candidate"; value: EventSweepCandidate }
  | { eventId: string; kind: "invalid" };

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function automatchSweepEntries(value: unknown): AutomatchSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([inviteId, raw]) => {
    const outbox = parseAutomatchProfileGameProjectionOutbox(raw);
    return outbox && isSafeRecordKey(inviteId)
      ? {
          kind: "candidate",
          value: {
            lastQueuedAtMs: outbox.lastQueuedAtMs,
            task: {
              kind: "automatch-profile-game-projection",
              inviteId,
              requestId: outbox.requestId,
            },
          },
        }
      : { inviteId, kind: "invalid" };
  });
}

export function eventSweepEntries(value: unknown): EventSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([eventId, raw]) => {
    const outbox = parseEventProfileGameProjectionOutbox(raw);
    return outbox && isSafeRecordKey(eventId)
      ? {
          kind: "candidate",
          value: {
            lastQueuedAtMs: outbox.lastQueuedAtMs,
            task: {
              kind: "event-profile-game-projection",
              eventId,
              requestId: outbox.requestId,
            },
          },
        }
      : { eventId, kind: "invalid" };
  });
}

export async function claimAutomatchSweepCandidate(
  state: AutomatchRecoveryState,
  candidate: AutomatchSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await state.transactAutomatchProfileOutbox(
    candidate.task.inviteId,
    (current) => {
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.lastQueuedAtMs !== candidate.lastQueuedAtMs ||
        outbox.lastQueuedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: { ...toRecord(current), lastQueuedAtMs: nowMs },
        decision: "claimed",
      };
    },
  );
  return result.committed;
}

export async function claimEventSweepCandidate(
  state: Pick<
    EventProfileProjectionState,
    "transactEventProfileGameProjectionOutbox"
  >,
  candidate: EventSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await state.transactEventProfileGameProjectionOutbox(
    candidate.task.eventId,
    (current) => {
      const outbox = parseEventProfileGameProjectionOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.lastQueuedAtMs !== candidate.lastQueuedAtMs ||
        outbox.lastQueuedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: { ...toRecord(current), lastQueuedAtMs: nowMs },
        decision: "claimed",
      };
    },
  );
  return result.committed;
}

type InvalidEventSweepResult =
  | { kind: "changed" }
  | { kind: "removed" }
  | { kind: "repaired"; task: EventProfileGameProjectionTask };

export function salvageEventCleanupOwnerProfileIds(value: unknown): string[] {
  return Array.from(
    new Set(
      Object.entries(
        toRecord(toRecord(value)?.cleanupOwnerProfileIds) || {},
      ).flatMap(([profileId, included]) =>
        included === true && isSafeRecordKey(profileId) ? [profileId] : [],
      ),
    ),
  );
}

export async function repairInvalidEventSweepEntry(
  state: Pick<
    EventProfileProjectionState,
    "transactEventProfileGameProjectionOutbox"
  >,
  eventId: string,
  nowMs: number,
  createRequestId: () => string,
): Promise<InvalidEventSweepResult> {
  const safeEventId = isSafeRecordKey(eventId);
  const requestId = safeEventId ? createRequestId() : "";
  const result = await state.transactEventProfileGameProjectionOutbox(
    eventId,
    (current) => {
      if (
        current === null ||
        current === undefined ||
        (parseEventProfileGameProjectionOutbox(current) &&
          isSafeRecordKey(eventId))
      ) {
        return { commit: false, decision: "changed" };
      }
      if (!safeEventId) {
        return { value: null, decision: "removed-invalid" };
      }
      const cleanupOwnerProfileIds =
        salvageEventCleanupOwnerProfileIds(current);
      return {
        value: {
          schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
          status: "pending",
          requestId,
          lastQueuedAtMs: nowMs,
          cleanupOwnerProfileIds: Object.fromEntries(
            cleanupOwnerProfileIds.map((profileId) => [profileId, true]),
          ),
        },
        decision: "repaired-invalid",
      };
    },
  );
  if (!result.committed) {
    return { kind: "changed" };
  }
  return safeEventId
    ? {
        kind: "repaired",
        task: {
          kind: "event-profile-game-projection",
          eventId,
          requestId,
        },
      }
    : { kind: "removed" };
}

type InvalidAutomatchSweepResult =
  | { kind: "changed" }
  | { kind: "removed" }
  | { kind: "repaired"; task: AutomatchProfileGameProjectionTask };

export async function repairInvalidAutomatchSweepEntry(
  state: AutomatchRecoveryState,
  inviteId: string,
  nowMs: number,
  createRequestId: () => string,
): Promise<InvalidAutomatchSweepResult> {
  const safeInviteId = isSafeRecordKey(inviteId);
  const requestId = safeInviteId ? createRequestId() : "";
  const result = await state.transactAutomatchProfileOutbox(
    inviteId,
    (current) => {
      const record = toRecord(current);
      if (
        current === null ||
        current === undefined ||
        (record &&
          parseAutomatchProfileGameProjectionOutbox(current) &&
          isSafeRecordKey(inviteId))
      ) {
        return { commit: false, decision: "changed" };
      }
      if (!safeInviteId) {
        return { value: null, decision: "removed-invalid" };
      }
      const sourceUpdatedAtMs = record?.sourceUpdatedAtMs;
      const historicalMatches = salvageHistoricalMatchDescriptors(current);
      return {
        value: {
          schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
          status: "pending",
          requestId,
          reason:
            typeof record?.reason === "string" && record.reason.trim()
              ? record.reason.trim()
              : "automatch-queue",
          sourceUpdatedAtMs:
            typeof sourceUpdatedAtMs === "number" &&
            Number.isFinite(sourceUpdatedAtMs) &&
            sourceUpdatedAtMs >= 0
              ? Math.floor(sourceUpdatedAtMs)
              : nowMs,
          lastQueuedAtMs: nowMs,
          ...(historicalMatches.length > 0
            ? {
                historicalMatches: Object.fromEntries(
                  historicalMatches.map((descriptor) => [
                    descriptor.matchId,
                    {
                      finalizedAtMs: descriptor.finalizedAtMs,
                      guestPlayerId: descriptor.guestPlayerId,
                      hostPlayerId: descriptor.hostPlayerId,
                      source: descriptor.source,
                      ...(descriptor.retryNotBeforeMs === undefined
                        ? {}
                        : { retryNotBeforeMs: descriptor.retryNotBeforeMs }),
                    },
                  ]),
                ),
              }
            : {}),
        },
        decision: "repaired-invalid",
      };
    },
  );
  if (!result.committed) {
    return { kind: "changed" };
  }
  return safeInviteId
    ? {
        kind: "repaired",
        task: {
          kind: "automatch-profile-game-projection",
          inviteId,
          requestId,
        },
      }
    : { kind: "removed" };
}

export async function sendProfileGameProjectionTasks(
  queue: Queue<ProfileGameProjectionTask>,
  tasks: ProfileGameProjectionTask[],
): Promise<void> {
  return sendQueueTasks(queue, tasks);
}

export async function sweepRatingProfileGameProjections(
  env: Env,
  dependencies: RatingRecoveryDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const rating = (
    dependencies.createRating ||
    ((workerEnv: Env) =>
      createRatingRepository(
        workerEnv.PROFILE_DB,
        createGameplayRepository(workerEnv),
        createEventProgressOutboxWriter(workerEnv.EVENT_DB),
      ))
  )(env);
  const nowMs = now();
  const records = await rating.listDueRatingProfileGameProjections(
    nowMs,
    PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  );
  const tasks: ProfileGameProjectionTask[] = [];
  let firstFailure: unknown;
  await runRecoveryItems(
    records,
    async (record) => {
      try {
        const claimed = await rating.claimRatingProfileGameProjection(
          record.operationId,
          record.updateTime,
          nowMs,
        );
        if (!claimed) {
          return;
        }
        if (
          record.version !== PROFILE_GAME_PROJECTION_SCHEMA_VERSION ||
          !isSafeRecordKey(record.inviteId) ||
          !isSafeRecordKey(record.matchId) ||
          record.operationId !== `${record.inviteId}__${record.matchId}`
        ) {
          await rating.markRatingProfileGameProjection(
            record.operationId,
            "dead",
            now(),
            "invalid-recovery-marker",
          );
          return;
        }
        tasks.push({
          kind: "rating-profile-game-projection",
          operationId: record.operationId,
        });
      } catch (error) {
        firstFailure ||= error;
        logger.error(
          JSON.stringify({
            event: "profile_game_projection_recovery_record_failed",
            operationId: record.operationId,
          }),
        );
      }
    },
    { concurrency: PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY },
  );
  await sendProfileGameProjectionTasks(
    env.PROFILE_GAME_PROJECTION_QUEUE,
    tasks,
  );
  if (firstFailure) {
    throw firstFailure;
  }
  return tasks.length;
}

export async function sweepAutomatchProfileGameProjections(
  env: Env,
  dependencies: AutomatchRecoveryDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const nowMs = now();
  const dueBeforeMs = nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS;
  const state = (
    dependencies.createStateRepository ||
    ((workerEnv: Env) => createGameplayRepository(workerEnv))
  )(env);
  const [dueValue, malformedValue] = await Promise.all([
    state.listDueAutomatchProfileOutboxes(
      dueBeforeMs,
      PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    ),
    state.listMalformedAutomatchProfileOutboxes(
      PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    ),
  ]);
  const entries = [
    ...automatchSweepEntries(dueValue),
    ...automatchSweepEntries(malformedValue),
  ];
  const invalidInviteIds = entries.flatMap((entry) =>
    entry.kind === "invalid" ? [entry.inviteId] : [],
  );
  const {
    repairedTasks,
    removedCount: invalidRemoved,
    failures: repairFailures,
  } = await collectProjectionRepairs(
    invalidInviteIds,
    (inviteId) =>
      repairInvalidAutomatchSweepEntry(state, inviteId, nowMs, createRequestId),
    "profile-game-projection-invalid-record-failed",
  );
  if (repairedTasks.length > 0 || invalidRemoved > 0) {
    logger.error(
      JSON.stringify({
        event: "profile_game_projection_invalid_outboxes_recovered",
        repaired: repairedTasks.length,
        removed: invalidRemoved,
      }),
    );
  }
  const candidates = entries.flatMap((entry) =>
    entry.kind === "candidate" ? [entry.value] : [],
  );
  const { sentCount, claimFailure } = await claimAndEnqueueProjectionTasks({
    candidates,
    claim: (candidate) => claimAutomatchSweepCandidate(state, candidate, nowMs),
    toTask: ({ task }) => task,
    queue: env.PROFILE_GAME_PROJECTION_QUEUE,
    initialTasks: repairedTasks,
    fallbackErrorMessage: "profile-game-projection-claim-failed",
  });
  if (claimFailure) {
    throw claimFailure;
  }
  if (repairFailures.length > 0) {
    throw repairFailures[0];
  }
  return sentCount;
}

export async function sweepEventProfileGameProjections(
  env: Env,
  dependencies: EventRecoveryDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const nowMs = now();
  const dueBeforeMs = nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS;
  const state = (
    dependencies.createStateRepository ||
    ((workerEnv: Env) => createEventGameplayRepository(workerEnv))
  )(env);
  const records = await state.listDueEventProfileGameProjectionOutboxes(
    dueBeforeMs,
    PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  );
  const entries = eventSweepEntries(
    Object.fromEntries(records.map(({ eventId, record }) => [eventId, record])),
  );
  const invalidEventIds = Array.from(
    new Set(
      entries.flatMap((entry) =>
        entry.kind === "invalid" ? [entry.eventId] : [],
      ),
    ),
  );
  const {
    repairedTasks,
    removedCount: invalidRemoved,
    failures,
  } = await collectProjectionRepairs(
    invalidEventIds,
    (eventId) =>
      repairInvalidEventSweepEntry(state, eventId, nowMs, createRequestId),
    "event-profile-game-invalid-record-failed",
  );
  if (repairedTasks.length > 0 || invalidRemoved > 0) {
    logger.error(
      JSON.stringify({
        event: "event_profile_game_projection_invalid_outboxes_recovered",
        repaired: repairedTasks.length,
        removed: invalidRemoved,
      }),
    );
  }
  const candidateByEventId = new Map<string, EventSweepCandidate>();
  for (const entry of entries) {
    if (entry.kind === "candidate") {
      candidateByEventId.set(entry.value.task.eventId, entry.value);
    }
  }
  const { sentCount, claimFailure } = await claimAndEnqueueProjectionTasks({
    candidates: Array.from(candidateByEventId.values()),
    claim: (candidate) => claimEventSweepCandidate(state, candidate, nowMs),
    toTask: ({ task }) => task,
    queue: env.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
    initialTasks: repairedTasks,
    fallbackErrorMessage: "profile-game-projection-claim-failed",
  });
  if (claimFailure) {
    failures.push(claimFailure);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "event-profile-game-projection-sweep-failed",
    );
  }
  return sentCount;
}

export async function sweepProfileLinkProfileGameProjections(
  env: Env,
  dependencies: ProfileLinkRecoveryDependencies = {},
): Promise<number> {
  const nowMs = (dependencies.now || Date.now)();
  const jobs = (
    dependencies.createProfileLinkJobs ||
    ((workerEnv: Env) => createProfileLinkCatchupStore(workerEnv.PROFILE_DB))
  )(env);
  const candidates = await jobs.listDue(
    nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS,
    PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  );
  const { sentCount, claimFailure } = await claimAndEnqueueProjectionTasks({
    candidates,
    claim: (job) =>
      jobs.claimDispatch(
        job.loginUid,
        job.requestId,
        job.lastQueuedAtMs,
        nowMs,
      ),
    toTask: ({ loginUid, requestId }): ProfileGameProjectionTask => ({
      kind: "profile-link-profile-game-projection",
      loginUid,
      requestId,
    }),
    queue: env.PROFILE_GAME_PROJECTION_QUEUE,
    fallbackErrorMessage: "profile-game-projection-claim-failed",
  });
  if (claimFailure) throw claimFailure;
  return sentCount;
}

export async function sweepProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionRecoveryDependencies = {},
): Promise<ProfileGameProjectionSweepResult> {
  const locks = (
    dependencies.createLocks ||
    ((workerEnv: Env) =>
      createProfileGameProjectionLockStore(workerEnv.PROFILE_GAMES_DB))
  )(env);
  const [automatch, event, profile, rating, cleanup] = await Promise.allSettled(
    [
      sweepAutomatchProfileGameProjections(env, dependencies),
      sweepEventProfileGameProjections(env, dependencies),
      sweepProfileLinkProfileGameProjections(env, dependencies),
      sweepRatingProfileGameProjections(env, dependencies),
      locks.deleteExpired((dependencies.now || Date.now)()),
    ],
  );
  if (cleanup.status === "rejected") {
    (dependencies.logger || console).error(
      JSON.stringify({
        event: "profile_game_projection_lock_cleanup_failed",
        lockScope: "cleanup",
        code:
          cleanup.reason instanceof Error ? cleanup.reason.message : "unknown",
      }),
    );
  }
  const failures = [automatch, event, profile, rating, cleanup].flatMap(
    (result) => (result.status === "rejected" ? [result.reason] : []),
  );
  if (
    failures.length > 0 ||
    automatch.status === "rejected" ||
    event.status === "rejected" ||
    profile.status === "rejected" ||
    rating.status === "rejected"
  ) {
    throw new AggregateError(failures, "profile-game-projection-sweep-failed");
  }
  return {
    automatch: automatch.value,
    event: event.value,
    profile: profile.value,
    rating: rating.value,
  };
}

export async function handleProfileGameProjectionSweep(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  const enqueued = await sweepProfileGameProjections(env);
  console.info(
    JSON.stringify({
      event: "profile_game_projection_sweep_completed",
      enqueued:
        enqueued.automatch +
        enqueued.event +
        enqueued.profile +
        enqueued.rating,
      automatchEnqueued: enqueued.automatch,
      eventEnqueued: enqueued.event,
      profileEnqueued: enqueued.profile,
      ratingEnqueued: enqueued.rating,
    }),
  );
}
