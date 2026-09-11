import { STATE_EFFECTS_FIELD } from "./stateCompatibility.ts";
import { createAutomatchPersistence } from "./automatchPersistence.ts";
import {
  type StateRepository,
  type StateQuery,
  type StateTransactionResult,
} from "./stateRepositoryTypes.ts";
import { createMatchStateSource } from "./matchStateSource.ts";
import {
  EventD1Conflict,
  EventWritesDisabled,
  acquireEventWriteAdmission,
  createEventTransitionIntent,
  listPendingEventTransitionIntents,
  listDueEventProgressOutboxes,
  listDueEventProfileGameProjectionOutboxes,
  listDueEventTelegramProjectionOutboxes,
  listEventAggregates,
  patchEventOwnedPaths,
  readEventOwnedPath,
  readEventRuntimeControl,
  readEventSnapshot,
  readEventTransitionIntent,
  recordEventTransitionAttempt,
  releaseEventWriteAdmission,
  transactEventOwnedPath,
  transactEventCoordinationPath,
  transactStoredProfileEventPrizePath,
  type EventTransitionIntent,
  type EventWriteAdmission,
} from "./eventD1.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { parseAutomatchPath } from "./automatchD1.ts";
import {
  eventMatchCreationInviteIds,
  isPlayerMatchPath,
} from "./eventLoginMatchDiscovery.ts";
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

const EVENT_OWNED_ROOTS = new Set([
  "events",
  "eventPrizeSelections",
  "profileEventPrizes",
  "eventProgressOutbox",
  "eventProgressOutboxDead",
  "eventLocks",
  "eventSyncThrottles",
  "eventTelegramProjectionLocks",
  "eventTelegramProjectionGenerations",
  "eventTelegramProjections",
]);
const EVENT_TRANSITION_APPLICATION_LOCK_TTL_MS = 5 * 60 * 1_000;
const EVENT_TRANSITION_APPLICATION_LOCK_OWNER = "event-transition-applier";
export const EVENT_TRANSITION_RECEIPT_ROOT = "eventTransitionReceipts";
type EventStateBackend = Pick<
  StateRepository,
  | "getPath"
  | "patchRoot"
  | "transactPath"
  | "readMatchPair"
  | "createMatchRecords"
  | "applyMatchEventEffects"
>;
type EventTransitionBackend = Pick<EventStateBackend, "getPath" | "patchRoot">;
type EventLockGuard = {
  eventId: string;
  lockId: string;
  lockRoot: string;
  ownerUid: string;
};
export type EventStateRepository = StateRepository & {
  transactStoredProfileEventPrizeWithEventLease(
    path: string,
    updater: (current: unknown) => unknown,
    guard: EventLockGuard,
    signal?: AbortSignal,
  ): Promise<StateTransactionResult>;
};
export type AuthRecoveryPrizeStore = Pick<
  EventStateRepository,
  "getPath" | "transactPath" | "transactStoredProfileEventPrizeWithEventLease"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function transactionDecision(
  next: unknown,
):
  { commit: false; decision?: string } | { value: unknown; decision?: string } {
  if (next === undefined) return { commit: false };
  if (isRecord(next) && next.commit === false) {
    return {
      commit: false,
      decision: typeof next.decision === "string" ? next.decision : undefined,
    };
  }
  if (isRecord(next) && Object.hasOwn(next, "value")) {
    return {
      value: next.value,
      decision: typeof next.decision === "string" ? next.decision : undefined,
    };
  }
  return { value: next };
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

function normalizedPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function d1EventPath(path: string): string {
  const clean = normalizedPath(path);
  const parts = clean.split("/");
  if (parts[0] === "eventTelegramProjectionLocks" && parts[1]) {
    return `eventLocks/telegram:${parts[1]}`;
  }
  if (
    parts[0] === "profileGameProjectionLocks" &&
    parts[1] === "event" &&
    parts[2]
  ) {
    return `eventLocks/profile-game:${parts[2]}`;
  }
  return clean;
}

export function isEventOwnedPath(path: string): boolean {
  const parts = normalizedPath(path).split("/");
  if (EVENT_OWNED_ROOTS.has(parts[0])) return true;
  return (
    (parts[0] === "profileGameProjectionOutbox" ||
      parts[0] === "profileGameProjectionLocks" ||
      parts[0] === "telegramProjectionOutbox") &&
    parts[1] === "event"
  );
}

function splitUpdates(updates: Record<string, unknown>): {
  canonicalUpdates: Record<string, unknown>;
  [STATE_EFFECTS_FIELD]: Record<string, unknown>;
} {
  const canonicalUpdates: Record<string, unknown> = {};
  const stateEffects: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(updates)) {
    (isEventOwnedPath(path) ? canonicalUpdates : stateEffects)[path] = value;
  }
  return { canonicalUpdates, [STATE_EFFECTS_FIELD]: stateEffects };
}

function eventIdsFromUpdates(updates: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const path of Object.keys(updates)) {
    const [root, eventId] = normalizedPath(path).split("/");
    if (
      (root === "events" ||
        root === "eventPrizeSelections" ||
        root === "profileEventPrizes") &&
      eventId
    ) {
      if (root === "profileEventPrizes") {
        const parts = normalizedPath(path).split("/");
        if (parts[2]) ids.add(parts[2]);
      } else {
        ids.add(eventId);
      }
    } else if (root === "eventProgressOutbox" && isRecord(updates[path])) {
      const progressEventId = updates[path].eventId;
      if (typeof progressEventId === "string" && progressEventId) {
        ids.add(progressEventId);
      }
    }
  }
  return [...ids];
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

function isTransitionReceiptPath(path: string): boolean {
  return normalizedPath(path).split("/")[0] === EVENT_TRANSITION_RECEIPT_ROOT;
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

function transitionApplicationLockPath(transitionId: string): string {
  return `eventLocks/transition:${transitionId}`;
}

async function acquireTransitionApplicationLock(
  db: D1Database,
  intent: EventTransitionIntent,
  admission: EventWriteAdmission,
): Promise<Record<string, unknown>> {
  const nowMs = Date.now();
  const lock = {
    lockId: crypto.randomUUID(),
    ownerUid: EVENT_TRANSITION_APPLICATION_LOCK_OWNER,
    acquiredAtMs: nowMs,
    refreshedAtMs: nowMs,
    expiresAtMs: nowMs + EVENT_TRANSITION_APPLICATION_LOCK_TTL_MS,
  };
  const result = await transactEventCoordinationPath(
    db,
    transitionApplicationLockPath(intent.transitionId),
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
  lock: Record<string, unknown>,
): Promise<void> {
  try {
    await transactEventCoordinationPath(
      db,
      transitionApplicationLockPath(intent.transitionId),
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
  raw: StateRepository,
  onCommitted: (intent: EventTransitionIntent) => Promise<void>,
  prepareMatchPresentations: PrepareMatchPresentations,
  signal?: AbortSignal,
): Promise<void> {
  let lock: Record<string, unknown> | null = null;
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
    await withInviteEffectsAdmission(discoveryDb, async () => {
      await applyInviteEventEffects(
        discoveryDb,
        raw,
        currentIntent,
        signal,
        prepareMatchPresentations,
      );
    });
    await onCommitted(currentIntent);
    await patchEventOwnedPaths(db, currentIntent.canonicalUpdates, {
      admission,
      expectedEventRevisions: {
        [currentIntent.eventId]: currentIntent.expectedRevision,
      },
      transition: {
        eventId: currentIntent.eventId,
        transitionId: currentIntent.transitionId,
      },
    });
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

async function patchD1EventState(
  db: D1Database,
  discoveryDb: D1Database,
  base: EventTransitionBackend,
  updates: Record<string, unknown>,
  admission: EventWriteAdmission,
  raw: StateRepository,
  onCommitted: (intent: EventTransitionIntent) => Promise<void>,
  prepareMatchPresentations: PrepareMatchPresentations,
  signal?: AbortSignal,
): Promise<void> {
  const { canonicalUpdates, [STATE_EFFECTS_FIELD]: stateEffects } =
    splitUpdates(updates);
  if (Object.keys(canonicalUpdates).length === 0) {
    if (eventMatchCreationInviteIds(stateEffects).length) {
      throw new Error("event-match-creation-requires-transition");
    }
    await base.patchRoot(stateEffects, signal);
    return;
  }
  if (Object.keys(stateEffects).length === 0) {
    await patchEventOwnedPaths(db, canonicalUpdates, { admission });
    return;
  }
  if (Object.keys(stateEffects).some(isTransitionReceiptPath)) {
    throw new Error("event-transition-receipt-path-reserved");
  }
  await withInviteEffectsAdmission(discoveryDb, async () => {
    const eventIds = eventIdsFromUpdates(canonicalUpdates);
    if (eventIds.length !== 1) {
      throw new Error("event-transition-must-target-one-event");
    }
    const eventId = eventIds[0];
    const revision = (await readEventSnapshot(db, eventId)).revision;
    if (revision < 1) {
      if (
        eventMatchCreationInviteIds(stateEffects).length ||
        Object.keys(stateEffects).some((path) =>
          normalizedPath(path).startsWith("invites/"),
        )
      ) {
        throw new Error("event-match-creation-requires-transition");
      }
      await patchEventOwnedPaths(db, canonicalUpdates, { admission });
      await base.patchRoot(stateEffects, signal);
      return;
    }
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
    ) {
      throw new Error("event-transition-identity-conflict");
    }
    const activeIntent =
      existing || (await prepareInviteEventIntent(discoveryDb, intent, signal));
    if (!existing) {
      await createEventTransitionIntent(db, activeIntent, { admission });
    }
    await applyIntent(
      db,
      discoveryDb,
      activeIntent,
      admission,
      raw,
      onCommitted,
      prepareMatchPresentations,
      signal,
    );
  });
}

function createEventRawClient(env: Env): StateRepository {
  return createMatchStateSource(env);
}

async function notifyEventInviteEffects(
  env: Env,
  intent: EventTransitionIntent,
): Promise<void> {
  if (intent.schemaVersion !== 2) return;
  await Promise.all([
    notifyInviteSourceChanged(
      env,
      Object.fromEntries(
        intent.inviteMutations.map(({ current, value }) => [
          `invites/${current.inviteId}`,
          value,
        ]),
      ),
      true,
    ),
    notifyMatchSyncInvites(
      env,
      intent.inviteMutations.map(({ current }) => current.inviteId),
    ),
    notifyMatchSyncChanged(env, intent[STATE_EFFECTS_FIELD]),
  ]);
}

export async function recoverEventTransitionIntents(
  env: Env,
  limit = 100,
  raw: StateRepository = createEventRawClient(env),
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
      await withEventWriteAdmission(
        env.EVENT_DB,
        "transition-recovery",
        async (admission) => {
          await applyIntent(
            env.EVENT_DB,
            env.PROFILE_GAMES_DB,
            intent,
            admission,
            raw,
            (committed) => notifyEventInviteEffects(env, committed),
            prepareMatchPresentations,
          );
        },
      );
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
): GameplayRepository {
  const eventClient = createEventStateRepository(env, {
    getPath: base.getStatePath,
    patchRoot: base.patchStateRoot,
    transactPath: base.transactStatePath,
    readMatchPair: base.readMatchPair,
  });
  return {
    ...base,
    getStatePath: eventClient.getPath,
    patchStateRoot: eventClient.patchRoot,
    transactStatePath: eventClient.transactPath,
  };
}

function transactD1EventPath(
  db: D1Database,
  path: string,
  updater: (current: unknown) => unknown,
  signal?: AbortSignal,
  guard?: EventLockGuard,
  allowStoredProfilePrizeAssignment = false,
): Promise<StateTransactionResult> {
  return withEventWriteAdmission(
    db,
    "event-path-transaction",
    async (admission) => {
      const storagePath = d1EventPath(path);
      if (
        storagePath.startsWith("eventLocks/") ||
        storagePath.startsWith("eventSyncThrottles/")
      ) {
        if (guard || allowStoredProfilePrizeAssignment) {
          throw new Error("event-lock-guard-path-unsupported");
        }
        return transactEventCoordinationPath(
          db,
          storagePath,
          (current) => transactionDecision(updater(current)),
          { admission },
        );
      }
      const eventLease = guard
        ? {
            eventId: guard.eventId,
            lockId: guard.lockId,
            ownerUid: guard.ownerUid,
          }
        : null;
      const applyUpdate = (current: unknown) =>
        transactionDecision(updater(current));
      if (allowStoredProfilePrizeAssignment) {
        if (!eventLease) {
          throw new Error("event-lock-guard-path-unsupported");
        }
        return transactStoredProfileEventPrizePath(
          db,
          storagePath,
          applyUpdate,
          {
            admission,
            eventLease,
            signal,
          },
        );
      }
      return transactEventOwnedPath(db, storagePath, applyUpdate, {
        admission,
        ...(eventLease ? { eventLease } : {}),
        signal,
      });
    },
  );
}

async function readProfileEventPrizePage(
  db: D1Database,
  path: string,
  query: StateQuery,
): Promise<Record<string, unknown>> {
  const prizes = (await readEventOwnedPath(db, path)) as Record<
    string,
    unknown
  >;
  const startAt = typeof query.startAt === "string" ? query.startAt : "";
  const entries = Object.entries(prizes || {})
    .filter(([eventId]) => !startAt || eventId >= startAt)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, query.limitToFirst || 100);
  return Object.fromEntries(entries);
}

function transactStoredProfileEventPrizeWithEventLease(
  db: D1Database,
  path: string,
  updater: (current: unknown) => unknown,
  guard: EventLockGuard,
  signal?: AbortSignal,
): Promise<StateTransactionResult> {
  const [root, profileId, eventId, ...nested] = normalizedPath(path).split("/");
  if (
    guard.lockRoot !== "eventLocks" ||
    root !== "profileEventPrizes" ||
    !profileId ||
    eventId !== guard.eventId ||
    nested.length > 0
  ) {
    throw new Error("event-lock-guard-path-unsupported");
  }
  return transactD1EventPath(db, path, updater, signal, guard, true);
}

export function createD1AuthRecoveryPrizeStore(
  db: D1Database,
): AuthRecoveryPrizeStore {
  return {
    async getPath(path, query) {
      const cleanPath = normalizedPath(path);
      if (!/^profileEventPrizes\/[^/]+(?:\/[^/]+)?$/.test(cleanPath)) {
        throw new Error("auth-recovery-prize-path-unsupported");
      }
      if (query?.orderBy === "$key" && cleanPath.split("/").length === 2) {
        return readProfileEventPrizePage(db, cleanPath, query);
      }
      if (query && Object.keys(query).length > 0) {
        throw new Error("event-d1-query-unsupported");
      }
      return readEventOwnedPath(db, cleanPath);
    },
    async transactPath(path, updater, signal) {
      if (!/^eventLocks\/[^/]+$/.test(normalizedPath(path))) {
        throw new Error("auth-recovery-prize-path-unsupported");
      }
      return transactD1EventPath(db, path, updater, signal);
    },
    transactStoredProfileEventPrizeWithEventLease(
      path,
      updater,
      guard,
      signal,
    ) {
      return transactStoredProfileEventPrizeWithEventLease(
        db,
        path,
        updater,
        guard,
        signal,
      );
    },
  };
}

export function createEventStateRepository(
  env: Env,
  base: EventStateBackend = createAutomatchPersistence(
    env.PROFILE_GAMES_DB,
    createEventRawClient(env),
    {
      prepareMatchPresentations: (creations) =>
        prepareCreatedMatchPresentations(env, creations),
    },
  ).client,
  raw: StateRepository = createEventRawClient(env),
  prepareMatchPresentations: PrepareMatchPresentations = (creations) =>
    prepareCreatedMatchPresentations(env, creations),
): EventStateRepository {
  return {
    ...base,
    async getPath(path, query, signal) {
      if (isTransitionReceiptPath(path)) {
        throw new Error("event-transition-receipt-path-reserved");
      }
      if (!isEventOwnedPath(path)) {
        return base.getPath(path, query, signal);
      }
      const cleanPath = normalizedPath(path);
      if (cleanPath === "events") {
        const status = query?.equalTo;
        if (
          query?.orderBy !== "status" ||
          (status !== "scheduled" &&
            status !== "active" &&
            status !== "ended" &&
            status !== "dismissed")
        ) {
          throw new Error("event-d1-query-unsupported");
        }
        return listEventAggregates(env.EVENT_DB, {
          status,
          limit: query.limitToFirst || 1_000,
        });
      }
      if (cleanPath === "eventProgressOutbox") {
        const records = await listDueEventProgressOutboxes(
          env.EVENT_DB,
          typeof query?.endAt === "number"
            ? query.endAt
            : Number.MAX_SAFE_INTEGER,
          query?.limitToFirst || 100,
        );
        return Object.fromEntries(
          records.map(({ outboxId, record }) => [outboxId, record]),
        );
      }
      if (cleanPath === "profileGameProjectionOutbox/event") {
        if (query?.startAt === "") return {};
        const records = await listDueEventProfileGameProjectionOutboxes(
          env.EVENT_DB,
          typeof query?.endAt === "number"
            ? query.endAt
            : Number.MAX_SAFE_INTEGER,
          query?.limitToFirst || 100,
        );
        return Object.fromEntries(
          records.map(({ eventId, record }) => [eventId, record]),
        );
      }
      if (cleanPath === "telegramProjectionOutbox/event") {
        const records = await listDueEventTelegramProjectionOutboxes(
          env.EVENT_DB,
          typeof query?.endAt === "number"
            ? query.endAt
            : Number.MAX_SAFE_INTEGER,
          query?.limitToFirst || 100,
        );
        return Object.fromEntries(
          records.map(({ eventId, record }) => [eventId, record]),
        );
      }
      if (
        cleanPath.startsWith("profileEventPrizes/") &&
        query?.orderBy === "$key"
      ) {
        return readProfileEventPrizePage(env.EVENT_DB, cleanPath, query);
      }
      if (query && Object.keys(query).length > 0) {
        throw new Error("event-d1-query-unsupported");
      }
      return readEventOwnedPath(env.EVENT_DB, d1EventPath(cleanPath));
    },
    async patchRoot(updates, signal) {
      const paths = Object.keys(updates);
      if (paths.some(isTransitionReceiptPath)) {
        throw new Error("event-transition-receipt-path-reserved");
      }
      if (!paths.some(isEventOwnedPath)) {
        if (
          eventMatchCreationInviteIds(updates).length &&
          !paths.some((path) => parseAutomatchPath(path) !== null)
        ) {
          throw new Error("event-match-creation-requires-transition");
        }
        await base.patchRoot(updates, signal);
        return;
      }
      await withEventWriteAdmission(
        env.EVENT_DB,
        "event-root-patch",
        async (admission) => {
          await patchD1EventState(
            env.EVENT_DB,
            env.PROFILE_GAMES_DB,
            base,
            updates,
            admission,
            raw,
            (committed) => notifyEventInviteEffects(env, committed),
            prepareMatchPresentations,
            signal,
          );
        },
      );
    },
    async transactPath(path, updater, signal) {
      if (isTransitionReceiptPath(path)) {
        throw new Error("event-transition-receipt-path-reserved");
      }
      if (!isEventOwnedPath(path)) {
        if (isPlayerMatchPath(path)) {
          throw new Error("event-match-creation-requires-transition");
        }
        return base.transactPath(path, updater, signal);
      }
      return transactD1EventPath(env.EVENT_DB, path, updater, signal);
    },
    transactStoredProfileEventPrizeWithEventLease(
      path,
      updater,
      guard,
      signal,
    ) {
      return transactStoredProfileEventPrizeWithEventLease(
        env.EVENT_DB,
        path,
        updater,
        guard,
        signal,
      );
    },
  };
}
