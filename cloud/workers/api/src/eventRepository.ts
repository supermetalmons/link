import * as eventD1 from "./eventD1.ts";
import { isEventMutation } from "../../../runtime/eventCommands.js";
import type { EventCommand } from "../../../runtime/eventCommands.js";
import type { EventLeaseKey } from "../../../runtime/eventLeases.js";
import type { EventStore } from "./eventStoreContracts.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import {
  encodeEventUpdates,
  decodeEventUpdates,
  decodeCanonicalEventUpdates,
} from "./eventCompatibilityCodec.ts";
import { STATE_EFFECTS_FIELD } from "./stateCompatibility.ts";
import { createEventReadRepository } from "./eventReadRepository.ts";
import { createEventOutboxReadRepository } from "./eventOutboxReadRepository.ts";
import { createMatchStateSource } from "./matchStateSource.ts";
import {
  EventD1Conflict,
  EventWritesDisabled,
  acquireEventWriteAdmission,
  createEventTransitionIntent,
  listPendingEventTransitionIntents,
  commitEventMutations,
  readEventRuntimeControl,
  readEventSnapshot,
  readEventTransitionIntent,
  recordEventTransitionAttempt,
  releaseEventWriteAdmission,
  transactEventLease,
  type EventTransitionIntent,
  type EventWriteAdmission,
} from "./eventD1.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
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
import {
  prepareCreatedMatchPresentations,
  type PrepareMatchPresentations,
} from "./matchPresentationRegistry.ts";

const EVENT_TRANSITION_APPLICATION_LOCK_TTL_MS = 5 * 60 * 1_000;
const EVENT_TRANSITION_APPLICATION_LOCK_OWNER = "event-transition-applier";
export const EVENT_TRANSITION_RECEIPT_ROOT = "eventTransitionReceipts";
export type EventGameplayRepository = GameplayRepository & EventStore;
export type EventStateRepository = MatchStatePort & EventStore;
type EventRepositoryOptions = {
  schedule?: (work: Promise<void>) => void;
};
export type AuthRecoveryPrizeStore = Pick<
  EventStore,
  | "readProfileEventPrizeAssignment"
  | "listProfileEventPrizeAssignments"
  | "transactEventLease"
  | "transactStoredProfileEventPrizeWithEventLease"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function withEventWriteAdmission<T>(
  db: D1Database,
  context:
    "event-path-transaction" | "event-root-patch" | "transition-recovery",
  work: (admission: EventWriteAdmission) => Promise<T>,
): Promise<T> {
  const admission = await acquireEventWriteAdmission(db);
  try {
    return await work(admission);
  } finally {
    let failureKind = "missing";
    let released = false;
    try {
      released = await releaseEventWriteAdmission(db, admission);
    } catch (error) {
      failureKind = error instanceof Error ? error.name : typeof error;
    }
    if (!released) {
      console.error(
        JSON.stringify({
          event: "event_write_admission_release_failed",
          admissionId: admission.admissionId,
          freezeGeneration: admission.freezeGeneration,
          attempts: 1,
          context,
          kind: failureKind,
        }),
      );
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function transitionId(
  eventId: string,
  revision: number,
  stateEffects: Record<string, unknown>,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${eventId}\n${revision}\n${canonicalJson(stateEffects)}`,
    ),
  );
  return `et_${bytesToHex(digest)}`;
}

function sameTransitionIntent(
  left: EventTransitionIntent,
  right: EventTransitionIntent,
): boolean {
  return (
    left.transitionId === right.transitionId &&
    left.schemaVersion === right.schemaVersion &&
    left.eventId === right.eventId &&
    left.expectedRevision === right.expectedRevision &&
    canonicalJson(left.canonicalUpdates) ===
      canonicalJson(right.canonicalUpdates) &&
    canonicalJson(left[STATE_EFFECTS_FIELD]) ===
      canonicalJson(right[STATE_EFFECTS_FIELD]) &&
    (left.schemaVersion !== 2 ||
      (right.schemaVersion === 2 &&
        left.payloadDigest === right.payloadDigest &&
        left.sourceEpoch === right.sourceEpoch &&
        canonicalJson(left.inviteMutations) ===
          canonicalJson(right.inviteMutations)))
  );
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
    const canonicalChanges = decodeCanonicalEventUpdates(
      currentIntent.canonicalUpdates,
    );
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
): Promise<EventTransitionIntent | undefined> {
  const canonical = plan.filter(isEventMutation);
  const effects = plan.filter((command) => !isEventMutation(command));
  if (
    canonical.length === 0 &&
    effects.some((command) => command.kind === "match-creation")
  )
    throw new Error("event-match-creation-requires-transition");
  if (!effects.length) {
    await commitEventMutations(db, canonical, { admission });
    return;
  }
  const eventIds = [
    ...new Set(
      canonical.flatMap((change) =>
        "eventId" in change
          ? [change.eventId]
          : change.kind === "progress-outbox" &&
              typeof change.value?.eventId === "string"
            ? [change.value.eventId]
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
    const canonicalUpdates = encodeEventUpdates(canonical);
    const stateEffects = encodeEventUpdates(effects);
    const id = await transitionId(eventId, revision, stateEffects);
    const nowMs = Date.now();
    const intent: Extract<EventTransitionIntent, { schemaVersion: 1 }> = {
      schemaVersion: 1,
      transitionId: id,
      eventId,
      expectedRevision: revision,
      canonicalUpdates,
      [STATE_EFFECTS_FIELD]: stateEffects,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const existing = await readEventTransitionIntent(db, id);
    if (
      existing &&
      (canonicalJson(existing.canonicalUpdates) !==
        canonicalJson(canonicalUpdates) ||
        (existing.schemaVersion === 1 &&
          canonicalJson(existing[STATE_EFFECTS_FIELD]) !==
            canonicalJson(stateEffects)) ||
        existing.eventId !== eventId ||
        existing.expectedRevision !== revision)
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

function createEventRawClient(env: Env): MatchStatePort {
  return createMatchStateSource(env);
}

async function notifyEventInviteEffects(
  env: Env,
  intent: EventTransitionIntent,
): Promise<void> {
  if (intent.schemaVersion !== 2) return;
  const effects = decodeEventUpdates(intent[STATE_EFFECTS_FIELD]);
  await Promise.all([
    notifyInviteSourceChanged(env, {
      metadataInviteIds: intent.inviteMutations.map(
        ({ current }) => current.inviteId,
      ),
      wagerInviteIds: intent.inviteMutations.map(
        ({ current }) => current.inviteId,
      ),
    }),
    notifyMatchSyncInvites(env, [
      ...intent.inviteMutations.map(({ current }) => current.inviteId),
      ...effects.flatMap((command) =>
        command.kind === "match-timer-claim" &&
        isRecord(command.value) &&
        typeof command.value.inviteId === "string"
          ? [command.value.inviteId]
          : [],
      ),
    ]),
    notifyMatchSyncChanged(
      env,
      effects.flatMap((command) =>
        command.kind === "match-creation" ||
        command.kind === "match-terminal-timer"
          ? [{ playerId: command.playerId, matchId: command.matchId }]
          : [],
      ),
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
  schedule?: EventRepositoryOptions["schedule"],
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

export async function recoverEventTransitionIntents(
  env: Env,
  limit = 100,
  raw: MatchStatePort = createEventRawClient(env),
  prepareMatchPresentations: PrepareMatchPresentations = (creations) =>
    prepareCreatedMatchPresentations(env, creations),
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
        "transition-recovery",
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

export function createEventGameplayRepository(
  env: Env,
  base: GameplayRepository = createGameplayRepository(env),
  options: EventRepositoryOptions = {},
): EventGameplayRepository {
  return {
    ...base,
    ...createEventStateRepository(env, base, base, undefined, options),
  };
}
function leaseStorageKey(key: EventLeaseKey): string {
  switch (key.kind) {
    case "event":
      return key.id;
    case "telegram-projection":
      return `telegram:${key.id}`;
    case "profile-game-projection":
      return `profile-game:${key.id}`;
    case "transition":
      return `transition:${key.id}`;
  }
}
function createEventStore(
  db: D1Database,
  commit: (
    changes: readonly EventCommand[],
    signal?: AbortSignal,
  ) => Promise<void>,
): EventStore {
  const admit = <T>(work: (admission: EventWriteAdmission) => Promise<T>) =>
    withEventWriteAdmission(db, "event-path-transaction", work);
  const read = <T>(work: () => Promise<T>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return work();
  };
  return {
    ...createEventReadRepository(db),
    ...createEventOutboxReadRepository(db),
    commitEventPlan: commit,
    putEventProgressOutbox: (outboxId, record, signal) =>
      commit([{ kind: "progress-outbox", outboxId, value: record }], signal),
    transactEventLease: (key, updater, signal) => {
      signal?.throwIfAborted();
      return admit((admission) =>
        eventD1.transactEventLease(db, leaseStorageKey(key), updater, {
          admission,
        }),
      );
    },
    transactEventSyncThrottle: (eventId, updater, signal) => {
      signal?.throwIfAborted();
      return admit((admission) =>
        eventD1.transactEventSyncThrottle(db, eventId, updater, { admission }),
      );
    },
    transactEventPrizeSelection: (eventId, profileId, updater, signal) =>
      admit((admission) =>
        eventD1.transactEventPrizeSelection(db, eventId, profileId, updater, {
          admission,
          signal,
        }),
      ),
    transactProfileEventPrize: (profileId, eventId, updater, signal) =>
      admit((admission) =>
        eventD1.transactProfileEventPrize(db, profileId, eventId, updater, {
          admission,
          signal,
        }),
      ),
    transactStoredProfileEventPrizeWithEventLease: (
      profileId,
      eventId,
      updater,
      guard,
      signal,
    ) => {
      if (guard.lockRoot !== "eventLocks" || guard.eventId !== eventId)
        throw new Error("event-lock-guard-path-unsupported");
      return admit((admission) =>
        eventD1.transactStoredProfileEventPrize(
          db,
          profileId,
          eventId,
          updater,
          {
            admission,
            signal,
            eventLease: guard,
          },
        ),
      );
    },
    readEventProgressOutbox: (id, signal) =>
      read(() => eventD1.readEventProgressOutbox(db, id), signal),
    readEventProfileGameProjectionOutbox: (id, signal) =>
      read(() => eventD1.readEventProfileGameProjectionOutbox(db, id), signal),
    readEventTelegramProjectionOutbox: (id, signal) =>
      read(() => eventD1.readEventTelegramProjectionOutbox(db, id), signal),
    readEventTelegramProjectionState: (id, signal) =>
      read(() => eventD1.readEventTelegramProjectionState(db, id), signal),
    transactEventProgressOutbox: (id, updater, signal) =>
      admit((admission) =>
        eventD1.transactEventProgressOutbox(db, id, updater, {
          admission,
          signal,
        }),
      ),
    transactEventProgressDeadOutbox: (id, updater, signal) =>
      admit((admission) =>
        eventD1.transactEventProgressDeadOutbox(db, id, updater, {
          admission,
          signal,
        }),
      ),
    transactEventProfileGameProjectionOutbox: (id, updater, signal) =>
      admit((admission) =>
        eventD1.transactEventProfileGameProjectionOutbox(db, id, updater, {
          admission,
          signal,
        }),
      ),
    transactEventTelegramProjectionOutbox: (id, updater, signal) =>
      admit((admission) =>
        eventD1.transactEventTelegramProjectionOutbox(db, id, updater, {
          admission,
          signal,
        }),
      ),
    transactEventTelegramProjectionState: (id, updater, signal) =>
      admit((admission) =>
        eventD1.transactEventTelegramProjectionState(db, id, updater, {
          admission,
          signal,
        }),
      ),
  };
}
export function createD1AuthRecoveryPrizeStore(
  db: D1Database,
): AuthRecoveryPrizeStore {
  const store = createEventStore(db, async () => {
    throw new Error("auth-recovery-prize-path-unsupported");
  });
  return {
    readProfileEventPrizeAssignment: store.readProfileEventPrizeAssignment,
    listProfileEventPrizeAssignments: store.listProfileEventPrizeAssignments,
    transactEventLease: (key, updater, signal) => {
      if (key.kind !== "event")
        return Promise.reject(
          new Error("auth-recovery-prize-path-unsupported"),
        );
      return store.transactEventLease(key, updater, signal);
    },
    transactStoredProfileEventPrizeWithEventLease:
      store.transactStoredProfileEventPrizeWithEventLease,
  };
}
export function createEventStateRepository(
  env: Env,
  base: MatchStatePort = createEventRawClient(env),
  raw: MatchStatePort = base,
  prepareMatchPresentations: PrepareMatchPresentations = (creations) =>
    prepareCreatedMatchPresentations(env, creations),
  options: EventRepositoryOptions = {},
): EventStateRepository {
  return {
    ...base,
    ...createEventStore(env.EVENT_DB, async (plan, signal) => {
      const committed = await withEventWriteAdmission(
        env.EVENT_DB,
        "event-root-patch",
        (admission) =>
          commitD1EventPlan(
            env.EVENT_DB,
            env.PROFILE_GAMES_DB,
            plan,
            admission,
            raw,
            prepareMatchPresentations,
            signal,
          ),
      );
      await dispatchCommittedNotifications(env, committed, options.schedule);
    }),
  };
}
