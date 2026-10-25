import type { QueueProducer } from "../queueProducers.ts";
import { queueFor } from "../queueProducers.ts";
import {
  readAutomatchProfileRecoveryEntries,
  type AutomatchProfileRecoveryCandidate,
} from "../automatchProjectionRecords.ts";
import { createGameplayRepository } from "../gameplayRepository.ts";
import { createRatingRepository } from "../ratingRepository.ts";
import { createEventProgressOutboxWriter } from "../eventRepository.ts";
import {
  createEventProjectionRecoveryStore,
  type EventProjectionRecoverySnapshot,
  type EventProjectionRecoveryWriter,
} from "../eventProjectionRecoveryD1.ts";
import { isSafeRecordKey } from "../recordKeys.ts";
import { parseEventProfileGameProjectionOutbox } from "../profileGameProjectionOutbox.ts";
import {
  PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
  type EventProfileGameProjectionTask,
  type ProfileGameProjectionTask,
} from "../profileGameProjectionTasks.ts";
import { createProfileGameProjectionLockStore } from "../profileGameProjectionLocksD1.ts";
import { createProfileLinkCatchupStore } from "../profileLinkCatchupD1.ts";
import {
  projectionRecoveryPages,
  PROJECTION_RECOVERY_MAX_PAGES,
} from "../projectionRecoveryPages.ts";
import {
  logRecoveryEvent,
  reportRecoveryFailure,
} from "../recoveryReporting.ts";
import {
  claimAndEnqueueProjectionTasks,
  collectProjectionRepairs,
  recoverAndEnqueueProjectionPages,
  sendQueueTasks,
} from "../projectionSweep.ts";
import {
  PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY,
  PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS,
} from "./policy.ts";
import type {
  AutomatchRecoveryState,
  RatingRecoveryDependencies,
  AutomatchRecoveryDependencies,
  EventRecoveryDependencies,
  ProfileLinkRecoveryDependencies,
  ProfileGameProjectionRecoveryDependencies,
  ProfileGameProjectionSweepResult,
} from "./types.ts";
export { salvageEventCleanupOwnerProfileIds } from "../eventProjectionRecoveryRecords.ts";

type EventSweepCandidate = {
  snapshot: EventProjectionRecoverySnapshot<"profile-game">;
  lastQueuedAtMs: number;
  task: EventProfileGameProjectionTask;
};

type EventSweepEntry =
  | { kind: "candidate"; value: EventSweepCandidate }
  | { eventId: string; kind: "invalid" };

export function eventSweepEntries(
  snapshots: readonly EventProjectionRecoverySnapshot<"profile-game">[],
): EventSweepEntry[] {
  const records = Object.fromEntries(
    snapshots.map((snapshot) => [snapshot.eventId, snapshot]),
  );
  return Object.entries(records).map(([eventId, snapshot]) => {
    const outbox = parseEventProfileGameProjectionOutbox(snapshot.record);
    return outbox && isSafeRecordKey(eventId)
      ? {
          kind: "candidate",
          value: {
            snapshot,
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
  candidate: AutomatchProfileRecoveryCandidate,
  nowMs: number,
): Promise<boolean> {
  return state.claimAutomatchProfileOutbox(
    candidate.task.inviteId,
    candidate.task.requestId,
    candidate.lastQueuedAtMs,
    nowMs,
    undefined,
    candidate.snapshot,
  );
}

export async function claimEventSweepCandidate(
  writer: Pick<EventProjectionRecoveryWriter<"profile-game">, "claim">,
  candidate: EventSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  return writer.claim(
    candidate.snapshot,
    candidate.task.requestId,
    candidate.lastQueuedAtMs,
    nowMs,
  );
}

type InvalidEventSweepResult =
  | { kind: "changed" }
  | { kind: "removed" }
  | { kind: "repaired"; task: EventProfileGameProjectionTask };

export async function repairInvalidEventSweepEntry(
  writer: Pick<EventProjectionRecoveryWriter<"profile-game">, "repairInvalid">,
  eventId: string,
  nowMs: number,
  createRequestId: () => string,
): Promise<InvalidEventSweepResult> {
  const safeEventId = isSafeRecordKey(eventId);
  const requestId = safeEventId ? createRequestId() : "";
  const result = await writer.repairInvalid(eventId, {
    eventId,
    safeEventId,
    requestId,
    nowMs,
  });
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

export function repairInvalidAutomatchSweepEntry(
  state: AutomatchRecoveryState,
  inviteId: string,
  nowMs: number,
  createRequestId: () => string,
) {
  return state.projectionRecovery.repairInvalidAutomatchProfileOutbox(
    inviteId,
    nowMs,
    createRequestId,
  );
}

export async function sendProfileGameProjectionTasks(
  queue: Pick<QueueProducer<ProfileGameProjectionTask>, "sendBatch">,
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
  const pages = projectionRecoveryPages((excludedIdentities) =>
    rating.scanDueRatingProfileGameProjectionsPage(
      nowMs,
      PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
      excludedIdentities,
    ),
  );
  const { sentCount, failures } = await recoverAndEnqueueProjectionPages({
    pages,
    queue: queueFor(env, "PROFILE_GAME_PROJECTION_QUEUE"),
    concurrency: PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY,
    async quarantine(entry) {
      const quarantined = await rating.quarantineRatingRecoveryEntry(
        entry,
        nowMs,
      );
      if (quarantined) {
        logRecoveryEvent(logger, "error", {
          event: "profile_game_projection_recovery_record_quarantined",
          scope: "profile-game",
          source: "rating",
          ...quarantined,
        });
      }
    },
    async processCandidate(record, setPhase) {
      const claimed = await rating.claimRatingProfileGameProjection(
        record.operationId,
        record.revision,
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
        setPhase("quarantine");
        await rating.markRatingProfileGameProjection(
          record.operationId,
          "dead",
          now(),
          "invalid-recovery-marker",
        );
        return;
      }
      return {
        kind: "rating-profile-game-projection",
        operationId: record.operationId,
      } satisfies ProfileGameProjectionTask;
    },
    onFailure: (entry, error, itemIndex, phase) =>
      reportRecoveryFailure(
        logger,
        {
          event: "profile_game_projection_recovery_record_failed",
          scope: "profile-game",
          source: "rating",
          phase,
          itemIndex,
          operationId:
            entry.kind === "candidate" ? entry.value.operationId : undefined,
        },
        error,
      ),
  });
  if (failures.length > 0) {
    throw failures[0];
  }
  return sentCount;
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
  const duePages = projectionRecoveryPages(
    (excludedIdentities) =>
      state.projectionRecovery.listDueAutomatchProfileOutboxesPage(
        dueBeforeMs,
        PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
        excludedIdentities,
      ),
    (page) => readAutomatchProfileRecoveryEntries(page.entries, page.snapshots),
  );
  const malformedPages = projectionRecoveryPages((excludedIdentities) =>
    state.projectionRecovery.listMalformedAutomatchProfileOutboxesPage(
      PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
      excludedIdentities,
    ),
  );
  let sentCount = 0;
  const claimFailures: Error[] = [];
  const repairFailures: Error[] = [];
  for (
    let pageIndex = 0;
    pageIndex < PROJECTION_RECOVERY_MAX_PAGES;
    pageIndex++
  ) {
    const [due, malformed] = await Promise.all([
      duePages.next(),
      malformedPages.next(),
    ]);
    if (due.done && malformed.done) break;
    const itemOffset = pageIndex * PROFILE_GAME_PROJECTION_SWEEP_LIMIT * 2;
    const entries = [
      ...(due.done ? [] : due.value.entries),
      ...readAutomatchProfileRecoveryEntries(
        malformed.done ? null : malformed.value.entries,
      ),
    ];
    const invalidInviteIds = entries.flatMap((entry) =>
      entry.kind === "invalid" ? [entry.inviteId] : [],
    );
    const {
      repairedTasks,
      removedCount: invalidRemoved,
      failures: pageRepairFailures,
    } = await collectProjectionRepairs(
      invalidInviteIds,
      (inviteId) =>
        repairInvalidAutomatchSweepEntry(
          state,
          inviteId,
          nowMs,
          createRequestId,
        ),
      "profile-game-projection-invalid-record-failed",
      (inviteId, error, itemIndex) =>
        reportRecoveryFailure(
          logger,
          {
            event: "profile_game_projection_recovery_record_failed",
            scope: "profile-game",
            source: "automatch",
            phase: "repair",
            itemIndex: itemOffset + itemIndex,
            inviteId,
          },
          error,
        ),
    );
    if (repairedTasks.length > 0 || invalidRemoved > 0) {
      logRecoveryEvent(logger, "error", {
        event: "profile_game_projection_invalid_outboxes_recovered",
        repaired: repairedTasks.length,
        removed: invalidRemoved,
      });
    }
    const candidates = entries.flatMap((entry) =>
      entry.kind === "candidate" ? [entry.value] : [],
    );
    const result = await claimAndEnqueueProjectionTasks({
      candidates,
      claim: (candidate) =>
        claimAutomatchSweepCandidate(state, candidate, nowMs),
      toTask: ({ task }) => task,
      queue: queueFor(env, "PROFILE_GAME_PROJECTION_QUEUE"),
      initialTasks: repairedTasks,
      fallbackErrorMessage: "profile-game-projection-claim-failed",
      onClaimFailure: ({ task }, error, itemIndex) =>
        reportRecoveryFailure(
          logger,
          {
            event: "profile_game_projection_recovery_record_failed",
            scope: "profile-game",
            source: "automatch",
            phase: "claim",
            itemIndex: itemOffset + itemIndex,
            inviteId: task.inviteId,
          },
          error,
        ),
    });
    sentCount += result.sentCount;
    claimFailures.push(...result.claimFailures);
    repairFailures.push(...pageRepairFailures);
  }
  if (claimFailures.length > 0) {
    throw claimFailures[0];
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
  const recovery = (
    dependencies.createEventRecovery ||
    ((workerEnv: Env) =>
      createEventProjectionRecoveryStore(workerEnv.EVENT_DB, "profile-game"))
  )(env);
  const pages = projectionRecoveryPages((excludedIdentities) =>
    recovery.listDuePage(
      dueBeforeMs,
      PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
      excludedIdentities,
    ),
  );
  let sentCount = 0;
  const repairFailures: Error[] = [];
  let firstClaimFailure: Error | null = null;
  for await (const { entries: records, itemOffset } of pages) {
    if (records.length === 0) continue;
    const result = await recovery.withAdmission(async (writer) => {
      const entries = eventSweepEntries(records);
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
        failures: pageFailures,
      } = await collectProjectionRepairs(
        invalidEventIds,
        (eventId) =>
          repairInvalidEventSweepEntry(writer, eventId, nowMs, createRequestId),
        "event-profile-game-invalid-record-failed",
        (eventId, error, itemIndex) =>
          reportRecoveryFailure(
            logger,
            {
              event: "profile_game_projection_recovery_record_failed",
              scope: "profile-game",
              source: "event",
              phase: "repair",
              itemIndex: itemOffset + itemIndex,
              eventId,
            },
            error,
          ),
      );
      if (repairedTasks.length > 0 || invalidRemoved > 0) {
        logRecoveryEvent(logger, "error", {
          event: "event_profile_game_projection_invalid_outboxes_recovered",
          repaired: repairedTasks.length,
          removed: invalidRemoved,
        });
      }
      const candidateByEventId = new Map<string, EventSweepCandidate>();
      for (const entry of entries) {
        if (entry.kind === "candidate") {
          candidateByEventId.set(entry.value.task.eventId, entry.value);
        }
      }
      const { sentCount, claimFailure } = await claimAndEnqueueProjectionTasks({
        candidates: Array.from(candidateByEventId.values()),
        claim: (candidate) =>
          claimEventSweepCandidate(writer, candidate, nowMs),
        toTask: ({ task }) => task,
        queue: queueFor(env, "EVENT_PROFILE_GAME_PROJECTION_QUEUE"),
        initialTasks: repairedTasks,
        fallbackErrorMessage: "profile-game-projection-claim-failed",
        onClaimFailure: ({ task }, error, itemIndex) =>
          reportRecoveryFailure(
            logger,
            {
              event: "profile_game_projection_recovery_record_failed",
              scope: "profile-game",
              source: "event",
              phase: "claim",
              itemIndex: itemOffset + itemIndex,
              eventId: task.eventId,
            },
            error,
          ),
      });
      return { sentCount, repairFailures: pageFailures, claimFailure };
    });
    sentCount += result.sentCount;
    repairFailures.push(...result.repairFailures);
    firstClaimFailure ||= result.claimFailure;
  }
  const failures = [
    ...repairFailures,
    ...(firstClaimFailure ? [firstClaimFailure] : []),
  ];
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
  const logger = dependencies.logger || console;
  const jobs = (
    dependencies.createProfileLinkJobs ||
    ((workerEnv: Env) => createProfileLinkCatchupStore(workerEnv.PROFILE_DB))
  )(env);
  const pages = projectionRecoveryPages((excludedIdentities) =>
    jobs.scanDuePage(
      nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS,
      PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
      excludedIdentities,
    ),
  );
  const { sentCount, failures } = await recoverAndEnqueueProjectionPages({
    pages,
    queue: queueFor(env, "PROFILE_GAME_PROJECTION_QUEUE"),
    async quarantine(entry) {
      const quarantined = await jobs.quarantineInvalidEntry(entry, nowMs);
      if (quarantined) {
        logRecoveryEvent(logger, "error", {
          event: "profile_game_projection_recovery_record_quarantined",
          scope: "profile-game",
          source: "profile-link",
          ...quarantined,
        });
      }
    },
    async processCandidate(job) {
      if (
        await jobs.claimDispatch(
          job.loginUid,
          job.requestId,
          job.lastQueuedAtMs,
          nowMs,
        )
      ) {
        return {
          kind: "profile-link-profile-game-projection",
          loginUid: job.loginUid,
          requestId: job.requestId,
        } satisfies ProfileGameProjectionTask;
      }
    },
    onFailure: (entry, error, itemIndex, phase) =>
      reportRecoveryFailure(
        logger,
        {
          event: "profile_game_projection_recovery_record_failed",
          scope: "profile-game",
          source: "profile-link",
          phase,
          itemIndex,
          loginUid:
            entry.kind === "candidate" ? entry.value.loginUid : undefined,
        },
        error,
      ),
  });
  if (failures.length > 0) {
    const error = failures[0];
    throw error instanceof Error
      ? error
      : new Error("profile-game-projection-claim-failed");
  }
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
    reportRecoveryFailure(
      dependencies.logger || console,
      {
        event: "profile_game_projection_lock_cleanup_failed",
        scope: "profile-game",
        phase: "cleanup",
        lockScope: "cleanup",
      },
      cleanup.reason,
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
  logRecoveryEvent(console, "info", {
    event: "profile_game_projection_sweep_completed",
    enqueued:
      enqueued.automatch + enqueued.event + enqueued.profile + enqueued.rating,
    automatchEnqueued: enqueued.automatch,
    eventEnqueued: enqueued.event,
    profileEnqueued: enqueued.profile,
    ratingEnqueued: enqueued.rating,
  });
}

export { readAutomatchProfileRecoveryEntries as automatchSweepEntries } from "../automatchProjectionRecords.ts";
