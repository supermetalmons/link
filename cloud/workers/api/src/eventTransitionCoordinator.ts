import * as eventD1 from "./eventD1.ts";
import {
  canonicalEventRepositoryJson as canonicalJson,
  sha256Hex,
} from "./canonicalJson.ts";
import { isEventMutation } from "../../../runtime/eventCommands.js";
import type { EventCommand } from "../../../runtime/eventCommands.js";
import type { EventCommitOptions, EventStore } from "./eventStoreContracts.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import {
  createEventTransitionDraft,
  encodeEventIntentUpdates,
  encodeEventIntentEffects,
  eventIntentCanonicalChanges,
  eventIntentMatchesPlan,
  eventIntentNotificationTargets,
  sameTransitionIntent,
} from "./eventTransitionCodec.ts";
import type { EventIntentEffects } from "./eventD1/types.ts";
import { STATE_EFFECTS_FIELD } from "./stateCompatibility.ts";
import { withEventWriteAdmission } from "./eventWriteAdmission.ts";
import {
  EventD1Conflict,
  EventWritesDisabled,
  createEventTransitionIntent,
  listPendingEventTransitionIntents,
  commitEventMutations,
  readEventRuntimeControl,
  readEventSnapshot,
  readEventTransitionIntent,
  recordEventTransitionAttempt,
  transactEventLease,
  type EventTransitionIntent,
  type EventWriteAdmission,
} from "./eventD1.ts";
import {
  applyInviteEventEffects,
  prepareInviteEventIntent,
} from "./inviteEventEffects.ts";
import {
  acquireInviteSourceAdmission,
  inviteSourceAdmissionGuardStatements,
  inviteSourceControlGuardStatements,
  readInviteSourceControl,
  releaseInviteSourceAdmission,
} from "./inviteSourceD1.ts";
import { notifyInviteSourceChanged } from "./inviteWagersNotifications.ts";
import {
  notifyMatchSyncChanged,
  notifyMatchSyncInvites,
} from "./matchSyncNotifications.ts";
import type { PrepareMatchPresentations } from "./matchPresentationRegistry.ts";

const EVENT_TRANSITION_APPLICATION_LOCK_TTL_MS = 5 * 60 * 1_000;
const EVENT_TRANSITION_APPLICATION_LOCK_OWNER = "event-transition-applier";

type EventTransitionCoordinatorDependencies = {
  env: Env;
  matchState: MatchStatePort;
  prepareMatchPresentations: PrepareMatchPresentations;
  schedule?: (work: Promise<void>) => void;
};

type EventTransitionCoordinator = {
  commitEventPlan: EventStore["commitEventPlan"];
  recoverPendingIntents(limit?: number): Promise<number>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function transitionId(
  eventId: string,
  revision: number,
  stateEffects: EventIntentEffects,
): Promise<string> {
  const digest = await sha256Hex(
    `${eventId}\n${revision}\n${canonicalJson(stateEffects)}`,
  );
  return `et_${digest}`;
}

async function withInviteEffectsAdmission<T>(
  db: D1Database,
  work: (
    control: Awaited<ReturnType<typeof readInviteSourceControl>>,
  ) => Promise<T>,
): Promise<T> {
  const admission = await acquireInviteSourceAdmission(db, "event-transition");
  try {
    const control = await readInviteSourceControl(db);
    if (control.backend !== "d1" || control.state !== "active") {
      throw new Error("event-invite-source-unavailable");
    }
    await db.batch([
      ...inviteSourceAdmissionGuardStatements(db, admission),
      ...inviteSourceControlGuardStatements(db, control),
    ]);
    return await work(control);
  } finally {
    await releaseInviteSourceAdmission(db, admission);
  }
}

function transitionApplicationLockKey(transitionId: string): string {
  return `transition:${transitionId}`;
}

async function acquireTransitionApplicationLock(
  db: D1Database,
  intent: EventTransitionIntent,
  admission: EventWriteAdmission,
): Promise<eventD1.EventLeaseRecord> {
  const nowMs = Date.now();
  const lock = {
    lockId: crypto.randomUUID(),
    ownerUid: EVENT_TRANSITION_APPLICATION_LOCK_OWNER,
    acquiredAtMs: nowMs,
    refreshedAtMs: nowMs,
    expiresAtMs: nowMs + EVENT_TRANSITION_APPLICATION_LOCK_TTL_MS,
  };
  const result = await transactEventLease(
    db,
    transitionApplicationLockKey(intent.transitionId),
    (current) => {
      const existing = isRecord(current) ? current : null;
      if (
        existing &&
        typeof existing.expiresAtMs === "number" &&
        existing.expiresAtMs > nowMs
      ) {
        return { commit: false, decision: "busy" };
      }
      return { value: lock, decision: "acquired" };
    },
    { admission },
  );
  if (!result.committed || result.decision !== "acquired") {
    throw new EventD1Conflict("event-transition-application-busy");
  }
  return lock;
}

async function releaseTransitionApplicationLock(
  db: D1Database,
  intent: EventTransitionIntent,
  admission: EventWriteAdmission,
  lock: eventD1.EventLeaseRecord,
): Promise<void> {
  try {
    await transactEventLease(
      db,
      transitionApplicationLockKey(intent.transitionId),
      (current) => {
        const existing = isRecord(current) ? current : null;
        return existing !== null &&
          existing.lockId === lock.lockId &&
          existing.ownerUid === lock.ownerUid
          ? { value: null, decision: "released" }
          : { commit: false, decision: "lost" };
      },
      { admission },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "event_transition_application_lock_release_failed",
        transitionId: intent.transitionId,
        kind: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

async function applyIntent(
  db: D1Database,
  discoveryDb: D1Database,
  intent: EventTransitionIntent,
  admission: EventWriteAdmission,
  raw: MatchStatePort,
  prepareMatchPresentations: PrepareMatchPresentations,
  signal?: AbortSignal,
): Promise<EventTransitionIntent | undefined> {
  let lock: eventD1.EventLeaseRecord | null = null;
  try {
    lock = await acquireTransitionApplicationLock(db, intent, admission);
    const currentIntent = await readEventTransitionIntent(
      db,
      intent.transitionId,
    );
    if (!currentIntent) return;
    if (!sameTransitionIntent(currentIntent, intent)) {
      throw new Error("event-transition-identity-conflict");
    }
    if (currentIntent.schemaVersion !== 2) {
      throw new Error("event-transition-legacy-source-disabled");
    }
    const canonicalChanges = eventIntentCanonicalChanges(currentIntent);
    const effectsStartedAt = Date.now();
    await withInviteEffectsAdmission(discoveryDb, async () => {
      await applyInviteEventEffects(
        discoveryDb,
        raw,
        currentIntent,
        signal,
        prepareMatchPresentations,
      );
    });
    logTransitionTiming(currentIntent, "effects", effectsStartedAt);
    const commitStartedAt = Date.now();
    await commitEventMutations(db, canonicalChanges, {
      admission,
      expectedEventRevisions: {
        [currentIntent.eventId]: currentIntent.expectedRevision,
      },
      transition: {
        eventId: currentIntent.eventId,
        transitionId: currentIntent.transitionId,
      },
    });
    logTransitionTiming(currentIntent, "commit", commitStartedAt);
    return currentIntent;
  } catch (error) {
    await recordEventTransitionAttempt(db, {
      error: error instanceof Error ? error.message : "event-transition-failed",
      nowMs: Date.now(),
      transitionId: intent.transitionId,
    });
    throw error;
  } finally {
    if (lock) {
      await releaseTransitionApplicationLock(db, intent, admission, lock);
    }
  }
}

async function commitD1EventPlan(
  db: D1Database,
  discoveryDb: D1Database,
  plan: readonly EventCommand[],
  admission: EventWriteAdmission,
  raw: MatchStatePort,
  prepareMatchPresentations: PrepareMatchPresentations,
  signal?: AbortSignal,
  options?: EventCommitOptions,
): Promise<EventTransitionIntent | undefined> {
  const canonical = plan.filter(isEventMutation);
  const effects = plan.filter((command) => !isEventMutation(command));
  if (options?.upcomingEventId !== undefined && effects.length > 0) {
    throw new eventD1.EventD1Failure(
      "event-upcoming-guard-effects-unsupported",
    );
  }
  if (
    canonical.length === 0 &&
    effects.some((command) => command.kind === "match-creation")
  )
    throw new Error("event-match-creation-requires-transition");
  if (!effects.length) {
    await commitEventMutations(db, canonical, { admission, ...options });
    return;
  }
  const eventIds = [
    ...new Set(
      canonical.flatMap((change) =>
        "eventId" in change
          ? [change.eventId]
          : change.kind === "progress-outbox" &&
              typeof (change.value as { eventId?: unknown } | null)?.eventId ===
                "string"
            ? [(change.value as { eventId: string }).eventId]
            : [],
      ),
    ),
  ];
  if (eventIds.length !== 1)
    throw new Error("event-transition-must-target-one-event");
  return withInviteEffectsAdmission(discoveryDb, async () => {
    const eventId = eventIds[0];
    const revision = (await readEventSnapshot(db, eventId)).revision;
    if (revision < 1)
      throw new Error("event-match-creation-requires-transition");
    const canonicalUpdates = encodeEventIntentUpdates(canonical);
    const stateEffects = encodeEventIntentEffects(effects);
    const id = await transitionId(eventId, revision, stateEffects);
    const nowMs = Date.now();
    const intent = createEventTransitionDraft({
      schemaVersion: 1,
      transitionId: id,
      eventId,
      expectedRevision: revision,
      canonicalUpdates,
      [STATE_EFFECTS_FIELD]: stateEffects,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    const existing = await readEventTransitionIntent(db, id);
    if (
      existing &&
      !eventIntentMatchesPlan(
        existing,
        canonicalUpdates,
        stateEffects,
        eventId,
        revision,
      )
    )
      throw new Error("event-transition-identity-conflict");
    const activeIntent =
      existing || (await prepareInviteEventIntent(discoveryDb, intent, signal));
    if (!existing)
      await createEventTransitionIntent(db, activeIntent, { admission });
    return applyIntent(
      db,
      discoveryDb,
      activeIntent,
      admission,
      raw,
      prepareMatchPresentations,
      signal,
    );
  });
}

async function notifyEventInviteEffects(
  env: Env,
  intent: EventTransitionIntent,
): Promise<void> {
  if (intent.schemaVersion !== 2) return;
  const { effects, metadataInviteIds, matchInviteIds } =
    eventIntentNotificationTargets(intent);
  await Promise.all([
    notifyInviteSourceChanged(env, {
      metadataInviteIds: [...metadataInviteIds],
      wagerInviteIds: [...metadataInviteIds],
    }),
    notifyMatchSyncInvites(env, matchInviteIds),
    notifyMatchSyncChanged(
      env,
      effects.flatMap((command) =>
        command.kind === "match-creation" ||
        command.kind === "match-terminal-timer"
          ? [{ playerId: command.playerId, matchId: command.matchId }]
          : [],
      ),
      { coveredInviteIds: [...metadataInviteIds, ...matchInviteIds] },
    ),
  ]);
}

function logTransitionTiming(
  intent: EventTransitionIntent,
  phase: "effects" | "commit" | "notifications",
  startedAt: number,
): void {
  try {
    console.log(
      JSON.stringify({
        event: "event_transition_timing",
        eventId: intent.eventId,
        transitionId: intent.transitionId,
        phase,
        durationMs: Date.now() - startedAt,
      }),
    );
  } catch {}
}

async function dispatchCommittedNotifications(
  env: Env,
  intent: EventTransitionIntent | undefined,
  schedule?: EventTransitionCoordinatorDependencies["schedule"],
): Promise<void> {
  if (!intent) return;
  const startedAt = Date.now();
  const logFailure = (error: unknown) => {
    console.error(
      JSON.stringify({
        event: "event_transition_notification_failed",
        eventId: intent.eventId,
        transitionId: intent.transitionId,
        kind: error instanceof Error ? error.name : typeof error,
      }),
    );
  };
  const work = notifyEventInviteEffects(env, intent)
    .catch(logFailure)
    .finally(() => logTransitionTiming(intent, "notifications", startedAt));
  if (schedule) {
    try {
      schedule(work);
      return;
    } catch (error) {
      logFailure(error);
    }
  }
  await work;
}

async function recoverPendingIntents(
  env: Env,
  limit: number,
  raw: MatchStatePort,
  prepareMatchPresentations: PrepareMatchPresentations,
): Promise<number> {
  const control = await readEventRuntimeControl(env.EVENT_DB);
  if (control.storageMode !== "d1") return 0;
  const intents = await listPendingEventTransitionIntents(env.EVENT_DB, limit);
  const failures: unknown[] = [];
  let processed = 0;
  for (const intent of intents) {
    try {
      const committed = await withEventWriteAdmission(
        env.EVENT_DB,
        { kind: "mutation", context: "transition-recovery" },
        async (admission) => {
          return applyIntent(
            env.EVENT_DB,
            env.PROFILE_GAMES_DB,
            intent,
            admission,
            raw,
            prepareMatchPresentations,
          );
        },
      );
      await dispatchCommittedNotifications(env, committed);
      processed += 1;
    } catch (error) {
      if (error instanceof EventWritesDisabled) break;
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error("event-transition-recovery-failed", {
      cause: failures[0],
    });
  }
  return processed;
}

export function createEventTransitionCoordinator({
  env,
  matchState,
  prepareMatchPresentations,
  schedule,
}: EventTransitionCoordinatorDependencies): EventTransitionCoordinator {
  return {
    async commitEventPlan(plan, signal, options) {
      const committed = await withEventWriteAdmission(
        env.EVENT_DB,
        { kind: "mutation", context: "event-root-patch" },
        (admission) =>
          commitD1EventPlan(
            env.EVENT_DB,
            env.PROFILE_GAMES_DB,
            plan,
            admission,
            matchState,
            prepareMatchPresentations,
            signal,
            options,
          ),
      );
      await dispatchCommittedNotifications(env, committed, schedule);
    },
    recoverPendingIntents: (limit = 100) =>
      recoverPendingIntents(env, limit, matchState, prepareMatchPresentations),
  };
}
