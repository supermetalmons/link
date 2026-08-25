import { createGameVariantHelpers } from "@mons/shared/game-variants";
import {
  isEventPrizeId,
  type ToggleEventPrizeSelectionRequest,
  type ToggleEventPrizeSelectionResponse,
} from "@mons/shared/event-prizes";
import {
  MAX_EVENT_PARTICIPANTS,
  isEventParticipantSnapshot,
  type EventParticipantSnapshot,
  type JoinEventRequest,
  type JoinEventResponse,
  type RemoveEventParticipantRequest,
  type RemoveEventParticipantResponse,
} from "@mons/shared/events";
import * as monsRules from "mons-rules";
import {
  createEventLockManagerCore,
  type EventLockManager,
} from "../../../functions/events/lockManagerCore.js";
import { buildScheduledEventDueUpdatesCore } from "../../../functions/events/startTransitionCore.js";
import { getDisplayNameFromAddress } from "../../../functions/telegramDisplay.js";
import { AuthApiFailure } from "./authErrors.ts";
import type { FirebaseIdentity } from "./firebaseAuth.ts";
import type {
  GameplayProfile,
  GameplayRepository,
} from "./gameplayRepository.ts";

const EVENT_LOCK_ATTEMPTS = 40;
const EVENT_LOCK_RETRY_DELAY_MS = 100;
const EVENT_OPERATION_TIMEOUT_MS = 25_000;
const EVENT_RECONCILIATION_TIMEOUT_MS = 2_000;
const gameVariantHelpers = createGameVariantHelpers(monsRules);

type EventRecord = Record<string, unknown>;

export type EventParticipationRepository = Pick<
  GameplayRepository,
  "getGameplayProfile" | "getRtdbPath" | "patchRtdbRoot" | "transactRtdbPath"
>;

export type EventParticipationDependencies = {
  buildDueUpdates?: (input: {
    eventId: string;
    event: EventRecord;
    nowMs: number;
  }) => Promise<{ didChange: boolean; updates: Record<string, unknown> }>;
  lockManager?: EventLockManager;
  now?: () => number;
  random?: () => number;
  signal?: AbortSignal;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "event-participation-service-unavailable",
    );
  }
  return value;
}

function secureRandom(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

function cloneEvent(value: Record<string, unknown>): EventRecord {
  return structuredClone(value);
}

function buildParticipant(
  profile: GameplayProfile,
  loginUid: string,
  joinedAtMs: number,
): EventParticipantSnapshot {
  const parsedEmojiId = Math.floor(Number(profile.emoji));
  const emojiId =
    Number.isSafeInteger(parsedEmojiId) && parsedEmojiId >= 0
      ? parsedEmojiId
      : 0;
  const participant: EventParticipantSnapshot = {
    profileId: profile.profileId,
    loginUid,
    username: normalizeString(profile.username),
    displayName: getDisplayNameFromAddress(
      profile.username,
      profile.eth,
      profile.sol,
      0,
      profile.emoji,
      false,
    ),
    emojiId,
    aura: normalizeString(profile.aura),
    joinedAtMs,
    state: "active",
    eliminatedRoundIndex: null,
    eliminatedByProfileId: null,
  };
  if (!isEventParticipantSnapshot(participant)) {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "event-participation-service-unavailable",
    );
  }
  return participant;
}

function participantCount(event: EventRecord): number {
  const participants = toRecord(event.participants) || {};
  return Object.values(participants).filter(
    (participant) => toRecord(participant) !== null,
  ).length;
}

async function readProfile(
  identity: FirebaseIdentity,
  repository: EventParticipationRepository,
  signal: AbortSignal,
): Promise<GameplayProfile> {
  let profile: GameplayProfile | null;
  try {
    profile = await repository.getGameplayProfile(
      identity.uid,
      identity.idToken,
      signal,
    );
  } catch {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "event-participation-service-unavailable",
    );
  }
  if (!profile?.profileId) {
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "Please sign in to join this event.",
    );
  }
  return profile;
}

async function readEvent(
  eventId: string,
  repository: EventParticipationRepository,
  signal: AbortSignal,
): Promise<EventRecord> {
  const value = toRecord(
    await repository.getRtdbPath(`events/${eventId}`, undefined, signal),
  );
  if (!value) {
    throw new AuthApiFailure(404, "not-found", "Event not found.");
  }
  return cloneEvent(value);
}

function createDefaultLockManager(
  repository: EventParticipationRepository,
  signal: AbortSignal,
): EventLockManager {
  return createEventLockManagerCore({
    createLockId: () => crypto.randomUUID(),
    transactPath: (path, updater) =>
      repository.transactRtdbPath(path, updater, signal),
    releaseTransactPath: (path, updater) =>
      repository.transactRtdbPath(path, updater),
    sleep: (milliseconds) => scheduler.wait(milliseconds, { signal }),
    logger: {
      error: (_message, error) => {
        console.error(
          JSON.stringify({
            event: "event_participation_lock_failure",
            kind: error instanceof Error ? error.name : typeof error,
          }),
        );
      },
    },
  });
}

async function requireOwnedLock(
  lockManager: EventLockManager,
  lockHandle: Parameters<EventLockManager["isEventLockStillOwned"]>[0],
  message: string,
): Promise<void> {
  if (!(await lockManager.isEventLockStillOwned(lockHandle))) {
    throw new AuthApiFailure(503, "unavailable", message);
  }
}

type ReconciliationCheck = {
  path: string;
  matches: (value: unknown) => boolean;
};

async function patchWithReconciliation(
  updates: Record<string, unknown>,
  repository: EventParticipationRepository,
  operationSignal: AbortSignal,
  checks: readonly ReconciliationCheck[],
): Promise<void> {
  try {
    await repository.patchRtdbRoot(updates, operationSignal);
  } catch (error) {
    const signal = AbortSignal.timeout(EVENT_RECONCILIATION_TIMEOUT_MS);
    const values = await Promise.all(
      checks.map(({ path }) =>
        repository.getRtdbPath(path, undefined, signal).catch(() => undefined),
      ),
    );
    if (
      checks.length === 0 ||
      !checks.every((check, index) => check.matches(values[index]))
    ) {
      throw error;
    }
  }
}

function isSameParticipant(
  value: unknown,
  expected: EventParticipantSnapshot,
): value is EventParticipantSnapshot {
  if (!isEventParticipantSnapshot(value)) {
    return false;
  }
  return (Object.keys(expected) as Array<keyof EventParticipantSnapshot>).every(
    (key) => value[key] === expected[key],
  );
}

async function persistDueTransition(
  eventId: string,
  dueTransition: { didChange: boolean; updates: Record<string, unknown> },
  repository: EventParticipationRepository,
  lockManager: EventLockManager,
  lockHandle: Parameters<EventLockManager["isEventLockStillOwned"]>[0],
  signal: AbortSignal,
  busyMessage: string,
): Promise<void> {
  if (!dueTransition.didChange) {
    return;
  }
  const statusPath = `events/${eventId}/status`;
  const updatedAtPath = `events/${eventId}/updatedAtMs`;
  const expectedStatus = dueTransition.updates[statusPath];
  const expectedUpdatedAtMs = requireTimestamp(
    dueTransition.updates[updatedAtPath],
  );
  if (expectedStatus !== "active" && expectedStatus !== "dismissed") {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "event-participation-service-unavailable",
    );
  }
  await requireOwnedLock(lockManager, lockHandle, busyMessage);
  await patchWithReconciliation(dueTransition.updates, repository, signal, [
    { path: statusPath, matches: (value) => value === expectedStatus },
    {
      path: updatedAtPath,
      matches: (value) => value === expectedUpdatedAtMs,
    },
  ]);
}

async function persistJoin(
  eventId: string,
  participant: EventParticipantSnapshot,
  updates: Record<string, unknown>,
  expectedTransitionStatus: "active" | "dismissed" | undefined,
  repository: EventParticipationRepository,
  signal: AbortSignal,
): Promise<EventParticipantSnapshot> {
  const updatedAtPath = `events/${eventId}/updatedAtMs`;
  const expectedUpdatedAtMs = requireTimestamp(updates[updatedAtPath]);
  const checks: ReconciliationCheck[] = [
    {
      path: `events/${eventId}/participants/${participant.profileId}`,
      matches: (value) => isSameParticipant(value, participant),
    },
    {
      path: updatedAtPath,
      matches: (value) => value === expectedUpdatedAtMs,
    },
  ];
  if (expectedTransitionStatus !== undefined) {
    checks.push({
      path: `events/${eventId}/status`,
      matches: (value) => value === expectedTransitionStatus,
    });
  }
  await patchWithReconciliation(updates, repository, signal, checks);
  return participant;
}

async function persistRemoval(
  eventId: string,
  participantProfileId: string,
  updates: Record<string, unknown>,
  repository: EventParticipationRepository,
  signal: AbortSignal,
): Promise<void> {
  const updatedAtPath = `events/${eventId}/updatedAtMs`;
  const expectedUpdatedAtMs = requireTimestamp(updates[updatedAtPath]);
  await patchWithReconciliation(updates, repository, signal, [
    {
      path: `events/${eventId}/participants/${participantProfileId}`,
      matches: (value) => value === null,
    },
    {
      path: `eventPrizeSelections/${eventId}/${participantProfileId}`,
      matches: (value) => value === null,
    },
    {
      path: updatedAtPath,
      matches: (value) => value === expectedUpdatedAtMs,
    },
  ]);
}

function createDueUpdatesBuilder(dependencies: EventParticipationDependencies) {
  const random = dependencies.random || secureRandom;
  return (
    input: Parameters<
      NonNullable<EventParticipationDependencies["buildDueUpdates"]>
    >[0],
  ) =>
    buildScheduledEventDueUpdatesCore({
      ...input,
      random,
      buildRandomGameSeed: (source) =>
        gameVariantHelpers.buildRandomGameSeed(source),
    });
}

async function acquireLock(
  eventId: string,
  identity: FirebaseIdentity,
  lockManager: EventLockManager,
  message: string,
) {
  const lockHandle = await lockManager.acquireEventLockWithRetry(
    eventId,
    identity.uid,
    {
      attempts: EVENT_LOCK_ATTEMPTS,
      delayMs: EVENT_LOCK_RETRY_DELAY_MS,
    },
  );
  if (!lockHandle) {
    throw new AuthApiFailure(503, "unavailable", message);
  }
  return lockHandle;
}

export async function joinEvent(
  identity: FirebaseIdentity,
  request: JoinEventRequest,
  repository: EventParticipationRepository,
  dependencies: EventParticipationDependencies = {},
): Promise<JoinEventResponse> {
  const signal =
    dependencies.signal || AbortSignal.timeout(EVENT_OPERATION_TIMEOUT_MS);
  const profile = await readProfile(identity, repository, signal);
  const eventId = request.eventId.trim();
  const now = dependencies.now || Date.now;
  const buildDueUpdates =
    dependencies.buildDueUpdates || createDueUpdatesBuilder(dependencies);
  const lockManager =
    dependencies.lockManager || createDefaultLockManager(repository, signal);
  const lockHandle = await acquireLock(
    eventId,
    identity,
    lockManager,
    "Event is busy. Please try joining again.",
  );
  const stopHeartbeat = lockManager.startEventLockHeartbeat(lockHandle);
  try {
    const event = await readEvent(eventId, repository, signal);
    const nowMs = now();
    if (event.status !== "scheduled") {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "This event has already started.",
      );
    }
    if (typeof event.startAtMs === "number" && nowMs >= event.startAtMs) {
      const dueTransition = await buildDueUpdates({ eventId, event, nowMs });
      await persistDueTransition(
        eventId,
        dueTransition,
        repository,
        lockManager,
        lockHandle,
        signal,
        "Event is busy. Please try joining again.",
      );
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "This event is no longer accepting participants.",
      );
    }

    const participants = toRecord(event.participants) || {};
    const existingParticipant = toRecord(participants[profile.profileId]);
    if (
      !existingParticipant &&
      participantCount(event) >= MAX_EVENT_PARTICIPANTS
    ) {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        `This event is full (${MAX_EVENT_PARTICIPANTS} players max).`,
      );
    }
    const existingJoinedAtMs = existingParticipant?.joinedAtMs;
    const participant = buildParticipant(
      profile,
      identity.uid,
      typeof existingJoinedAtMs === "number" ? existingJoinedAtMs : nowMs,
    );
    participants[profile.profileId] = participant;
    event.participants = participants;
    event.updatedAtMs = nowMs;
    const updates: Record<string, unknown> = {
      [`events/${eventId}/participants/${profile.profileId}`]: participant,
      [`events/${eventId}/updatedAtMs`]: nowMs,
    };
    const settleNowMs = now();
    const dueTransition = await buildDueUpdates({
      eventId,
      event,
      nowMs: settleNowMs,
    });
    let expectedTransitionStatus: "active" | "dismissed" | undefined;
    if (dueTransition.didChange) {
      Object.assign(updates, dueTransition.updates);
      const transitionStatus =
        dueTransition.updates[`events/${eventId}/status`];
      if (transitionStatus !== "active" && transitionStatus !== "dismissed") {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "event-participation-service-unavailable",
        );
      }
      expectedTransitionStatus = transitionStatus;
    }
    await requireOwnedLock(
      lockManager,
      lockHandle,
      "Event is busy. Please try joining again.",
    );
    const storedParticipant = await persistJoin(
      eventId,
      participant,
      updates,
      expectedTransitionStatus,
      repository,
      signal,
    );
    return { ok: true, eventId, participant: storedParticipant };
  } finally {
    stopHeartbeat();
    await lockManager.releaseEventLock(lockHandle);
  }
}

export async function removeEventParticipant(
  identity: FirebaseIdentity,
  request: RemoveEventParticipantRequest,
  repository: EventParticipationRepository,
  dependencies: EventParticipationDependencies = {},
): Promise<RemoveEventParticipantResponse> {
  const signal =
    dependencies.signal || AbortSignal.timeout(EVENT_OPERATION_TIMEOUT_MS);
  const profile = await readProfile(identity, repository, signal);
  const eventId = request.eventId.trim();
  const participantProfileId = request.participantProfileId.trim();
  const now = dependencies.now || Date.now;
  const buildDueUpdates =
    dependencies.buildDueUpdates || createDueUpdatesBuilder(dependencies);
  const lockManager =
    dependencies.lockManager || createDefaultLockManager(repository, signal);
  const lockHandle = await acquireLock(
    eventId,
    identity,
    lockManager,
    "Event is busy. Please try removing again.",
  );
  const stopHeartbeat = lockManager.startEventLockHeartbeat(lockHandle);
  try {
    const event = await readEvent(eventId, repository, signal);
    const creatorLoginUid = normalizeString(event.createdByLoginUid);
    const creatorProfileId = normalizeString(event.createdByProfileId);
    if (
      identity.uid !== creatorLoginUid &&
      profile.profileId !== creatorProfileId
    ) {
      throw new AuthApiFailure(
        403,
        "permission-denied",
        "Only the event creator can remove participants.",
      );
    }
    if (event.status !== "scheduled") {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "Only scheduled events can remove participants.",
      );
    }
    const nowMs = now();
    if (
      typeof event.startAtMs !== "number" ||
      !Number.isFinite(event.startAtMs)
    ) {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "This event cannot be updated right now.",
      );
    }
    if (nowMs >= event.startAtMs) {
      const dueTransition = await buildDueUpdates({ eventId, event, nowMs });
      await persistDueTransition(
        eventId,
        dueTransition,
        repository,
        lockManager,
        lockHandle,
        signal,
        "Event is busy. Please try removing again.",
      );
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "This event can no longer remove participants.",
      );
    }
    const participants = toRecord(event.participants) || {};
    const targetParticipant = toRecord(participants[participantProfileId]);
    if (!targetParticipant) {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "Selected participant was not found.",
      );
    }
    if (
      participantProfileId === creatorProfileId ||
      normalizeString(targetParticipant.loginUid) === creatorLoginUid
    ) {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "Event creator cannot be removed.",
      );
    }
    await requireOwnedLock(
      lockManager,
      lockHandle,
      "Event is busy. Please try removing again.",
    );
    const commitNowMs = now();
    if (commitNowMs >= event.startAtMs) {
      const dueTransition = await buildDueUpdates({
        eventId,
        event,
        nowMs: commitNowMs,
      });
      await persistDueTransition(
        eventId,
        dueTransition,
        repository,
        lockManager,
        lockHandle,
        signal,
        "Event is busy. Please try removing again.",
      );
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "This event can no longer remove participants.",
      );
    }
    await persistRemoval(
      eventId,
      participantProfileId,
      {
        [`events/${eventId}/participants/${participantProfileId}`]: null,
        [`eventPrizeSelections/${eventId}/${participantProfileId}`]: null,
        [`events/${eventId}/updatedAtMs`]: commitNowMs,
      },
      repository,
      signal,
    );
    return { ok: true, eventId, removedProfileId: participantProfileId };
  } finally {
    stopHeartbeat();
    await lockManager.releaseEventLock(lockHandle);
  }
}

export async function toggleEventPrizeSelection(
  identity: FirebaseIdentity,
  request: ToggleEventPrizeSelectionRequest,
  repository: EventParticipationRepository,
  dependencies: EventParticipationDependencies = {},
): Promise<ToggleEventPrizeSelectionResponse> {
  const signal =
    dependencies.signal || AbortSignal.timeout(EVENT_OPERATION_TIMEOUT_MS);
  const profile = await readProfile(identity, repository, signal);
  const eventId = request.eventId;
  if (!isEventPrizeId(eventId, request.prizeId)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  const lockManager =
    dependencies.lockManager || createDefaultLockManager(repository, signal);
  const busyMessage = "Event is busy. Please try selecting again.";
  const lockHandle = await acquireLock(
    eventId,
    identity,
    lockManager,
    busyMessage,
  );
  const stopHeartbeat = lockManager.startEventLockHeartbeat(lockHandle);
  try {
    const event = await readEvent(eventId, repository, signal);
    if (event.status !== "scheduled" && event.status !== "active") {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "Prize selection is closed for this event.",
      );
    }
    if (
      event.prizeSelectionsLockedAtMs !== undefined &&
      event.prizeSelectionsLockedAtMs !== null
    ) {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "Prize selection is locked for this event.",
      );
    }
    const participants = toRecord(event.participants) || {};
    let participantProfileId = "";
    if (toRecord(participants[profile.profileId])) {
      participantProfileId = profile.profileId;
    } else {
      const matchingProfileIds = Object.entries(participants)
        .filter(([, participant]) => {
          const record = toRecord(participant);
          return record && normalizeString(record.loginUid) === identity.uid;
        })
        .map(([profileId]) => profileId);
      if (matchingProfileIds.length === 1) {
        participantProfileId = matchingProfileIds[0];
      }
    }
    if (!participantProfileId) {
      throw new AuthApiFailure(
        403,
        "permission-denied",
        "Only event participants can select prizes.",
      );
    }
    await requireOwnedLock(lockManager, lockHandle, busyMessage);
    const result = await repository.transactRtdbPath(
      `eventPrizeSelections/${eventId}/${participantProfileId}`,
      (current) => ({
        value: current === request.prizeId ? null : request.prizeId,
      }),
      signal,
    );
    if (!result.committed) {
      throw new AuthApiFailure(503, "unavailable", busyMessage);
    }
    const selectedPrizeId =
      result.value === null
        ? null
        : isEventPrizeId(eventId, result.value)
          ? result.value
          : undefined;
    if (selectedPrizeId === undefined) {
      throw new AuthApiFailure(
        503,
        "unavailable",
        "event-participation-service-unavailable",
      );
    }
    return { ok: true, eventId, selectedPrizeId };
  } finally {
    stopHeartbeat();
    await lockManager.releaseEventLock(lockHandle);
  }
}

export {
  EVENT_LOCK_ATTEMPTS,
  EVENT_LOCK_RETRY_DELAY_MS,
  EVENT_OPERATION_TIMEOUT_MS,
  EVENT_RECONCILIATION_TIMEOUT_MS,
  buildParticipant,
  participantCount,
};
