import {
  eventField,
  getEventField,
  mergeEventPlans,
} from "../../../runtime/eventCommands.js";
import type { EventCommitPlan } from "../../../runtime/eventCommands.js";
import type { EventCommitOptions, EventStore } from "./eventStoreContracts.ts";
import { createGameVariantHelpers } from "@mons/shared/game-variants";
import {
  isEventPrizeEvent,
  isEventPrizeId,
  isEventPrizeRevealOpen,
  type ToggleEventPrizeSelectionRequest,
  type ToggleEventPrizeSelectionResponse,
} from "@mons/shared/event-prizes";
import {
  MAX_EVENT_PARTICIPANTS,
  buildEventParticipantSnapshot,
  isEventParticipantSnapshot,
  type EventParticipantSnapshot,
  type JoinEventRequest,
  type JoinEventResponse,
  type LeaveEventRequest,
  type LeaveEventResponse,
  type RemoveEventParticipantRequest,
  type RemoveEventParticipantResponse,
} from "@mons/shared/events";
import * as monsRules from "mons-rules";
import type { EventReads, EventSnapshot } from "../../../runtime/eventReads.js";
import {
  createEventLockManagerCore,
  withEventLease,
  type EventLockManager,
} from "../../../runtime/events/lockManagerCore.js";
import { buildScheduledEventDueUpdatesCore } from "../../../runtime/events/startTransitionCore.js";
import {
  buildEventOwnershipQuery,
  directParticipantParticipation,
  getCanonicalProfileId,
  getLoginProfileId,
  getOwnershipProfile,
  requesterOwnsProfileReference,
  resolveParticipantParticipation,
  type EventOwnershipSnapshot,
} from "../../../runtime/events/ownership.js";
import { AuthApiFailure } from "./authErrors.ts";
import { EventNotUpcoming } from "./eventD1.ts";
import type {
  GameplayProfile,
  GameplayRepository,
} from "./gameplayRepository.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import { requireProfileOwnershipSnapshot } from "./profileOwnership.ts";

const EVENT_LOCK_ATTEMPTS = 40;
const EVENT_LOCK_RETRY_DELAY_MS = 100;
const EVENT_OPERATION_TIMEOUT_MS = 25_000;
const EVENT_RECONCILIATION_TIMEOUT_MS = 2_000;
const gameVariantHelpers = createGameVariantHelpers(monsRules);

type EventRecord = Record<string, unknown>;
type EventDueTransition = {
  didChange: boolean;
  updates: EventCommitPlan;
};

export type EventParticipationRepository = EventStore &
  Pick<GameplayRepository, "readProfileOwnershipSnapshot"> &
  Pick<
    EventReads,
    "readEvent" | "readEventPrizeSelections" | "readEventSnapshot"
  >;

export type EventParticipationDependencies = {
  buildDueUpdates?: (input: {
    eventId: string;
    event: EventRecord;
    nowMs: number;
    ownershipSnapshot?: EventOwnershipSnapshot | null;
    prizeSelections?: EventSnapshot["prizeSelections"];
  }) => Promise<EventDueTransition>;
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
  const participant = buildEventParticipantSnapshot(
    profile,
    loginUid,
    joinedAtMs,
  );
  if (!participant) {
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

async function loadOwnershipSnapshot(
  event: EventRecord,
  repository: EventParticipationRepository,
  extras: { loginUids?: string[]; profileIds?: string[] } = {},
): Promise<EventOwnershipSnapshot> {
  return requireProfileOwnershipSnapshot(
    repository,
    buildEventOwnershipQuery(event, extras),
  );
}

function applyOwnershipPolicy<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "profile-ownership-unavailable"
    ) {
      throw new AuthApiFailure(
        503,
        "unavailable",
        "profile-ownership-unavailable",
      );
    }
    throw error;
  }
}

function directParticipantSnapshot(
  value: unknown,
  profileId: string,
  loginUid: string,
): EventParticipantSnapshot {
  const participant = toRecord(value);
  const normalized = participant
    ? { ...participant, profileId, loginUid }
    : null;
  if (!isEventParticipantSnapshot(normalized)) {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "event-participation-service-unavailable",
    );
  }
  return normalized;
}

async function readEvent(
  eventId: string,
  repository: EventParticipationRepository,
  signal: AbortSignal,
): Promise<EventRecord> {
  return requireEvent(await repository.readEvent(eventId, signal));
}

function requireEvent(value: EventRecord | null): EventRecord {
  const event = toRecord(value);
  if (!event) {
    throw new AuthApiFailure(404, "not-found", "Event not found.");
  }
  return cloneEvent(event);
}

async function readParticipationSnapshot(
  eventId: string,
  repository: EventParticipationRepository,
  signal: AbortSignal,
): Promise<{
  event: EventRecord;
  prizeSelections: Record<string, string> | undefined;
}> {
  if (!isEventPrizeEvent(eventId)) {
    return {
      event: await readEvent(eventId, repository, signal),
      prizeSelections: undefined,
    };
  }
  const snapshot = await repository.readEventSnapshot(eventId, signal);
  return {
    event: requireEvent(snapshot.event),
    prizeSelections: structuredClone(snapshot.prizeSelections),
  };
}

function getPrizeSelectionProfileIds(value: unknown): string[] {
  return Object.keys(toRecord(value) || {});
}

function createDefaultLockManager(
  repository: EventParticipationRepository,
  signal: AbortSignal,
): EventLockManager {
  return createEventLockManagerCore({
    createLockId: () => crypto.randomUUID(),
    transactEventLease: (key, updater) =>
      repository.transactEventLease(key, updater, signal),
    releaseTransactEventLease: (key, updater) =>
      repository.transactEventLease(key, updater),
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

type ReconciliationCheck = (snapshot: EventSnapshot) => boolean;

async function patchWithReconciliation(
  eventId: string,
  updates: EventCommitPlan,
  repository: EventParticipationRepository,
  operationSignal: AbortSignal,
  checks: readonly ReconciliationCheck[],
  options?: EventCommitOptions,
): Promise<void> {
  try {
    await repository.commitEventPlan(
      mergeEventPlans(updates),
      operationSignal,
      options,
    );
  } catch (error) {
    if (error instanceof EventNotUpcoming) throw error;
    const signal = AbortSignal.timeout(EVENT_RECONCILIATION_TIMEOUT_MS);
    const snapshot = await repository
      .readEventSnapshot(eventId, signal)
      .catch(() => null);
    if (
      !snapshot ||
      checks.length === 0 ||
      !checks.every((check) => check(snapshot))
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

function participantFromCanonicalParent(
  value: unknown,
  loginUid: string,
): EventParticipantSnapshot {
  const matches = Object.entries(toRecord(value) || {}).filter(
    ([, participant]) =>
      normalizeString(toRecord(participant)?.loginUid) === loginUid,
  );
  if (matches.length !== 1) {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "event-participation-service-unavailable",
    );
  }
  return directParticipantSnapshot(matches[0][1], matches[0][0], loginUid);
}

async function persistDueTransition(
  eventId: string,
  dueTransition: EventDueTransition,
  repository: EventParticipationRepository,
  assertOwned: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (!dueTransition.didChange) {
    return;
  }
  const expectedStatus = getEventField(
    dueTransition.updates,
    eventId,
    "status",
  );
  const expectedUpdatedAtMs = requireTimestamp(
    getEventField(dueTransition.updates, eventId, "updatedAtMs"),
  );
  if (expectedStatus !== "active" && expectedStatus !== "dismissed") {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "event-participation-service-unavailable",
    );
  }
  await assertOwned();
  await patchWithReconciliation(
    eventId,
    dueTransition.updates,
    repository,
    signal,
    [
      ({ event }) => (event?.status ?? null) === expectedStatus,
      ({ event }) => (event?.updatedAtMs ?? null) === expectedUpdatedAtMs,
    ],
  );
}

async function persistJoin(
  eventId: string,
  participant: EventParticipantSnapshot,
  updates: EventCommitPlan,
  expectedTransitionStatus: "active" | "dismissed" | undefined,
  repository: EventParticipationRepository,
  signal: AbortSignal,
): Promise<EventParticipantSnapshot> {
  const expectedUpdatedAtMs = requireTimestamp(
    getEventField(updates, eventId, "updatedAtMs"),
  );
  const checks: ReconciliationCheck[] = [
    ({ event }) =>
      isSameParticipant(
        toRecord(event?.participants)?.[participant.profileId] ?? null,
        participant,
      ),
    ({ event }) => (event?.updatedAtMs ?? null) === expectedUpdatedAtMs,
  ];
  if (expectedTransitionStatus !== undefined) {
    checks.push(
      ({ event }) => (event?.status ?? null) === expectedTransitionStatus,
    );
  }
  await patchWithReconciliation(eventId, updates, repository, signal, checks);
  return participant;
}

async function persistRemoval(
  eventId: string,
  participantProfileId: string,
  updates: EventCommitPlan,
  repository: EventParticipationRepository,
  signal: AbortSignal,
  options?: EventCommitOptions,
): Promise<void> {
  const expectedUpdatedAtMs = requireTimestamp(
    getEventField(updates, eventId, "updatedAtMs"),
  );
  await patchWithReconciliation(
    eventId,
    updates,
    repository,
    signal,
    [
      ({ event }) =>
        (toRecord(event?.participants)?.[participantProfileId] ?? null) ===
        null,
      ({ prizeSelections }) =>
        (prizeSelections[participantProfileId] ?? null) === null,
      ({ event }) => (event?.updatedAtMs ?? null) === expectedUpdatedAtMs,
    ],
    options,
  );
}

function createDueUpdatesBuilder(dependencies: EventParticipationDependencies) {
  const random = dependencies.random || secureRandom;
  return async (
    input: Parameters<
      NonNullable<EventParticipationDependencies["buildDueUpdates"]>
    >[0],
  ) => {
    try {
      return await buildScheduledEventDueUpdatesCore({
        ...input,
        random,
        buildRandomGameSeed: (source) =>
          gameVariantHelpers.buildRandomGameSeed(source),
        ownershipSnapshot: input.ownershipSnapshot || null,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "profile-ownership-unavailable"
      ) {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "profile-ownership-unavailable",
        );
      }
      throw error;
    }
  };
}

async function withParticipationLock<T>(
  eventId: string,
  identity: RequestIdentity,
  lockManager: EventLockManager,
  message: string,
  operation: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
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
  return withEventLease(lockManager, lockHandle, async () => {
    return await operation(async () => {
      if (!(await lockManager.isEventLockStillOwned(lockHandle))) {
        throw new AuthApiFailure(503, "unavailable", message);
      }
    });
  });
}

export async function joinEvent(
  identity: RequestIdentity,
  request: JoinEventRequest,
  repository: EventParticipationRepository,
  dependencies: EventParticipationDependencies = {},
): Promise<JoinEventResponse> {
  const signal =
    dependencies.signal || AbortSignal.timeout(EVENT_OPERATION_TIMEOUT_MS);
  const eventId = request.eventId.trim();
  const now = dependencies.now || Date.now;
  const buildDueUpdates =
    dependencies.buildDueUpdates || createDueUpdatesBuilder(dependencies);
  const lockManager =
    dependencies.lockManager || createDefaultLockManager(repository, signal);
  await readEvent(eventId, repository, signal);
  return withParticipationLock(
    eventId,
    identity,
    lockManager,
    "Event is busy. Please try joining again.",
    async (assertOwned) => {
      const { event, prizeSelections: eventPrizeSelections } =
        await readParticipationSnapshot(eventId, repository, signal);
      const participants = toRecord(event.participants) || {};
      const nowMs = now();
      if (
        event.status === "scheduled" &&
        typeof event.startAtMs === "number" &&
        nowMs >= event.startAtMs &&
        participantCount(event) < 2
      ) {
        const prizeSelections = eventPrizeSelections;
        const dueTransition = await buildDueUpdates({
          eventId,
          event,
          nowMs,
          ownershipSnapshot: null,
          prizeSelections,
        });
        await persistDueTransition(
          eventId,
          dueTransition,
          repository,
          assertOwned,
          signal,
        );
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "This event is no longer accepting participants.",
        );
      }
      const directParticipation = applyOwnershipPolicy(() =>
        directParticipantParticipation(event, identity.uid),
      );
      let ownershipSnapshot: EventOwnershipSnapshot | null = null;
      let prizeSelections: EventSnapshot["prizeSelections"] | undefined;
      let profile: GameplayProfile | null = null;
      let existingParticipantProfileId = directParticipation.profileId || "";
      if (
        !directParticipation.isParticipant ||
        (typeof event.startAtMs === "number" && nowMs >= event.startAtMs)
      ) {
        prizeSelections = eventPrizeSelections;
        ownershipSnapshot = await loadOwnershipSnapshot(event, repository, {
          loginUids: [identity.uid],
          profileIds: getPrizeSelectionProfileIds(prizeSelections),
        });
      }
      if (!directParticipation.isParticipant) {
        const ownerProfileId = applyOwnershipPolicy(() =>
          getLoginProfileId(ownershipSnapshot!, identity.uid),
        );
        profile = ownerProfileId
          ? (getOwnershipProfile(
              ownershipSnapshot!,
              ownerProfileId,
            ) as GameplayProfile | null)
          : null;
        if (!profile) {
          throw new AuthApiFailure(
            409,
            "failed-precondition",
            "Please sign in to join this event.",
          );
        }
        const ownedParticipation = applyOwnershipPolicy(() =>
          resolveParticipantParticipation(
            event,
            identity.uid,
            ownershipSnapshot,
          ),
        );
        existingParticipantProfileId =
          ownedParticipation.profileId || profile.profileId;
      }
      if (event.status !== "scheduled") {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "This event has already started.",
        );
      }
      if (typeof event.startAtMs === "number" && nowMs >= event.startAtMs) {
        const dueTransition = await buildDueUpdates({
          eventId,
          event,
          nowMs,
          ownershipSnapshot,
          prizeSelections,
        });
        await persistDueTransition(
          eventId,
          dueTransition,
          repository,
          assertOwned,
          signal,
        );
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "This event is no longer accepting participants.",
        );
      }

      const existingParticipant = toRecord(
        participants[existingParticipantProfileId],
      );
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
      const participant = directParticipation.isParticipant
        ? directParticipantSnapshot(
            existingParticipant,
            existingParticipantProfileId,
            identity.uid,
          )
        : buildParticipant(
            { ...profile!, profileId: existingParticipantProfileId },
            identity.uid,
            typeof existingJoinedAtMs === "number" ? existingJoinedAtMs : nowMs,
          );
      participants[existingParticipantProfileId] = participant;
      event.participants = participants;
      event.updatedAtMs = nowMs;
      const updates: EventCommitPlan = [
        {
          kind: "event-participant",
          eventId: eventId,
          profileId: existingParticipantProfileId,
          value: participant,
        },
        eventField(eventId, "updatedAtMs", nowMs),
      ];
      const settleNowMs = now();
      const isDueAtSettle =
        typeof event.startAtMs === "number" && settleNowMs >= event.startAtMs;
      if (isDueAtSettle) {
        prizeSelections = eventPrizeSelections;
      }
      if (!ownershipSnapshot && isDueAtSettle) {
        ownershipSnapshot = await loadOwnershipSnapshot(event, repository, {
          loginUids: [identity.uid],
          profileIds: getPrizeSelectionProfileIds(prizeSelections),
        });
      }
      const dueTransition = await buildDueUpdates({
        eventId,
        event,
        nowMs: settleNowMs,
        ownershipSnapshot,
        prizeSelections: isDueAtSettle ? prizeSelections : undefined,
      });
      let expectedTransitionStatus: "active" | "dismissed" | undefined;
      if (dueTransition.didChange) {
        updates.push(...dueTransition.updates);
        const transitionStatus = getEventField(
          dueTransition.updates,
          eventId,
          "status",
        );
        if (transitionStatus !== "active" && transitionStatus !== "dismissed") {
          throw new AuthApiFailure(
            503,
            "unavailable",
            "event-participation-service-unavailable",
          );
        }
        expectedTransitionStatus = transitionStatus;
      }
      let storedParticipant = participant;
      const canonicalParticipants = getEventField(
        updates,
        eventId,
        "participants",
      );
      if (canonicalParticipants !== undefined) {
        const index = updates.findIndex(
          (command) =>
            command.kind === "event-participant" &&
            command.eventId === eventId &&
            command.profileId === existingParticipantProfileId,
        );
        if (index >= 0) updates.splice(index, 1);
        storedParticipant = participantFromCanonicalParent(
          canonicalParticipants,
          participant.loginUid,
        );
      }
      await assertOwned();
      storedParticipant = await persistJoin(
        eventId,
        storedParticipant,
        updates,
        expectedTransitionStatus,
        repository,
        signal,
      );
      return { ok: true, eventId, participant: storedParticipant };
    },
  );
}

export async function removeEventParticipant(
  identity: RequestIdentity,
  request: RemoveEventParticipantRequest,
  repository: EventParticipationRepository,
  dependencies: EventParticipationDependencies = {},
): Promise<RemoveEventParticipantResponse> {
  return removeEventParticipation(
    identity,
    request.eventId,
    request.participantProfileId,
    repository,
    dependencies,
  );
}

export async function leaveEvent(
  identity: RequestIdentity,
  request: LeaveEventRequest,
  repository: EventParticipationRepository,
  dependencies: EventParticipationDependencies = {},
): Promise<LeaveEventResponse> {
  return removeEventParticipation(
    identity,
    request.eventId,
    null,
    repository,
    dependencies,
  );
}

async function removeEventParticipation(
  identity: RequestIdentity,
  eventIdInput: string,
  participantProfileIdInput: string | null,
  repository: EventParticipationRepository,
  dependencies: EventParticipationDependencies,
): Promise<RemoveEventParticipantResponse> {
  const signal =
    dependencies.signal || AbortSignal.timeout(EVENT_OPERATION_TIMEOUT_MS);
  const eventId = eventIdInput.trim();
  const isLeaving = participantProfileIdInput === null;
  let participantProfileId = participantProfileIdInput?.trim() || "";
  const busyMessage = isLeaving
    ? "Event is busy. Please try leaving again."
    : "Event is busy. Please try removing again.";
  const closedMessage = isLeaving
    ? "This event can no longer be left."
    : "This event can no longer remove participants.";
  const now = dependencies.now || Date.now;
  const buildDueUpdates =
    dependencies.buildDueUpdates || createDueUpdatesBuilder(dependencies);
  const lockManager =
    dependencies.lockManager || createDefaultLockManager(repository, signal);
  await readEvent(eventId, repository, signal);
  return withParticipationLock(
    eventId,
    identity,
    lockManager,
    busyMessage,
    async (assertOwned) => {
      const { event, prizeSelections } = await readParticipationSnapshot(
        eventId,
        repository,
        signal,
      );
      const creatorLoginUid = normalizeString(event.createdByLoginUid);
      const creatorProfileId = normalizeString(event.createdByProfileId);
      const participants = toRecord(event.participants) || {};
      const directCreator = identity.uid === creatorLoginUid;
      let ownershipSnapshot: EventOwnershipSnapshot | null = null;
      if (!directCreator) {
        ownershipSnapshot = await loadOwnershipSnapshot(event, repository, {
          loginUids: [identity.uid],
          profileIds: getPrizeSelectionProfileIds(prizeSelections),
        });
        if (
          !isLeaving &&
          !applyOwnershipPolicy(() =>
            requesterOwnsProfileReference({
              requesterUid: identity.uid,
              snapshot: ownershipSnapshot,
              storedLoginUid: creatorLoginUid,
              storedProfileId: creatorProfileId,
            }),
          )
        ) {
          throw new AuthApiFailure(
            403,
            "permission-denied",
            "Only the event creator can remove participants.",
          );
        }
      }
      if (isLeaving) {
        participantProfileId =
          applyOwnershipPolicy(() =>
            resolveParticipantParticipation(
              event,
              identity.uid,
              ownershipSnapshot,
            ),
          ).profileId || "";
      }
      const targetParticipant = toRecord(participants[participantProfileId]);
      const targetLoginUid = normalizeString(targetParticipant?.loginUid);
      const targetProfileId =
        normalizeString(targetParticipant?.profileId) || participantProfileId;
      if (isLeaving && targetParticipant && ownershipSnapshot) {
        const snapshot = ownershipSnapshot;
        const ownedParticipantIds = applyOwnershipPolicy(() => {
          const ownerProfileId = getLoginProfileId(snapshot, identity.uid);
          if (!ownerProfileId) return [];
          return Object.entries(participants).flatMap(([key, value]) => {
            const candidate = toRecord(value);
            if (!candidate) return [];
            const candidateProfileId =
              normalizeString(candidate.profileId) || key;
            return getCanonicalProfileId(snapshot, candidateProfileId) ===
              ownerProfileId
              ? [key]
              : [];
          });
        });
        if (
          ownedParticipantIds.length !== 1 ||
          ownedParticipantIds[0] !== participantProfileId
        ) {
          throw new AuthApiFailure(
            503,
            "unavailable",
            "profile-ownership-unavailable",
          );
        }
      }
      if (event.status !== "scheduled") {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          isLeaving
            ? closedMessage
            : "Only scheduled events can remove participants.",
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
      const startAtMs = event.startAtMs;
      const persistDueTransitionIfNeeded = async (
        dueNowMs: number,
      ): Promise<boolean> => {
        if (dueNowMs < startAtMs) return false;
        if (!ownershipSnapshot && participantCount(event) >= 2) {
          ownershipSnapshot = await loadOwnershipSnapshot(event, repository, {
            loginUids: [identity.uid],
            profileIds: getPrizeSelectionProfileIds(prizeSelections),
          });
        }
        const dueTransition = await buildDueUpdates({
          eventId,
          event,
          nowMs: dueNowMs,
          ownershipSnapshot,
          prizeSelections,
        });
        await persistDueTransition(
          eventId,
          dueTransition,
          repository,
          assertOwned,
          signal,
        );
        return true;
      };
      if (await persistDueTransitionIfNeeded(nowMs)) {
        throw new AuthApiFailure(409, "failed-precondition", closedMessage);
      }
      if (isLeaving && directCreator) {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "Event creator cannot leave.",
        );
      }
      if (!targetParticipant) {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          isLeaving
            ? "You are not participating in this event."
            : "Selected participant was not found.",
        );
      }
      let targetIsCreator =
        participantProfileId === creatorProfileId ||
        targetProfileId === creatorProfileId ||
        targetLoginUid === creatorLoginUid;
      if (!targetIsCreator && directCreator) {
        const hasSeparateCreatorParticipant = Object.entries(participants).some(
          ([candidateProfileId, value]) => {
            if (candidateProfileId === participantProfileId) return false;
            const candidate = toRecord(value);
            return (
              candidateProfileId === creatorProfileId ||
              normalizeString(candidate?.profileId) === creatorProfileId ||
              normalizeString(candidate?.loginUid) === creatorLoginUid
            );
          },
        );
        targetIsCreator = !hasSeparateCreatorParticipant;
      }
      if (!targetIsCreator && ownershipSnapshot) {
        targetIsCreator = applyOwnershipPolicy(
          () =>
            getCanonicalProfileId(ownershipSnapshot!, targetProfileId) ===
            getCanonicalProfileId(ownershipSnapshot!, creatorProfileId),
        );
      }
      if (targetIsCreator) {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          isLeaving
            ? "Event creator cannot leave."
            : "Event creator cannot be removed.",
        );
      }
      await assertOwned();
      const commitNowMs = now();
      if (await persistDueTransitionIfNeeded(commitNowMs)) {
        throw new AuthApiFailure(409, "failed-precondition", closedMessage);
      }
      try {
        await persistRemoval(
          eventId,
          participantProfileId,
          [
            {
              kind: "event-participant",
              eventId: eventId,
              profileId: participantProfileId,
              value: null,
            },
            {
              kind: "prize-selection",
              eventId: eventId,
              profileId: participantProfileId,
              value: null,
            },
            eventField(eventId, "updatedAtMs", commitNowMs),
          ],
          repository,
          signal,
          isLeaving ? { upcomingEventId: eventId } : undefined,
        );
      } catch (error) {
        if (!isLeaving || !(error instanceof EventNotUpcoming)) throw error;
        const latest = await readParticipationSnapshot(
          eventId,
          repository,
          signal,
        );
        if (latest.event.status === "scheduled") {
          const latestStartAtMs = requireTimestamp(latest.event.startAtMs);
          const dueNowMs =
            latestStartAtMs === startAtMs
              ? Math.max(now(), latestStartAtMs)
              : now();
          if (dueNowMs >= latestStartAtMs) {
            const latestOwnership =
              participantCount(latest.event) >= 2
                ? await loadOwnershipSnapshot(latest.event, repository, {
                    loginUids: [identity.uid],
                    profileIds: getPrizeSelectionProfileIds(
                      latest.prizeSelections,
                    ),
                  })
                : null;
            const dueTransition = await buildDueUpdates({
              eventId,
              event: latest.event,
              nowMs: dueNowMs,
              ownershipSnapshot: latestOwnership,
              prizeSelections: latest.prizeSelections,
            });
            await persistDueTransition(
              eventId,
              dueTransition,
              repository,
              assertOwned,
              signal,
            );
          }
        }
        throw new AuthApiFailure(409, "failed-precondition", closedMessage);
      }
      return { ok: true, eventId, removedProfileId: participantProfileId };
    },
  );
}

export async function toggleEventPrizeSelection(
  identity: RequestIdentity,
  request: ToggleEventPrizeSelectionRequest,
  repository: EventParticipationRepository,
  dependencies: EventParticipationDependencies = {},
): Promise<ToggleEventPrizeSelectionResponse> {
  const signal =
    dependencies.signal || AbortSignal.timeout(EVENT_OPERATION_TIMEOUT_MS);
  const eventId = request.eventId;
  if (!isEventPrizeId(eventId, request.prizeId)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  const lockManager =
    dependencies.lockManager || createDefaultLockManager(repository, signal);
  const busyMessage = "Event is busy. Please try selecting again.";
  await readEvent(eventId, repository, signal);
  return withParticipationLock(
    eventId,
    identity,
    lockManager,
    busyMessage,
    async (assertOwned) => {
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
      const startAtMs =
        event.status === "scheduled"
          ? requireTimestamp(event.startAtMs)
          : event.startAtMs;
      if (
        !isEventPrizeRevealOpen(
          event.status,
          startAtMs,
          (dependencies.now ?? Date.now)(),
        )
      ) {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "Prize selection opens less than one hour before the event starts.",
        );
      }
      const directParticipation = applyOwnershipPolicy(() =>
        directParticipantParticipation(event, identity.uid),
      );
      let participantProfileId = directParticipation.profileId || "";
      if (!directParticipation.isParticipant) {
        const ownershipSnapshot = await loadOwnershipSnapshot(
          event,
          repository,
          {
            loginUids: [identity.uid],
          },
        );
        participantProfileId =
          applyOwnershipPolicy(() =>
            resolveParticipantParticipation(
              event,
              identity.uid,
              ownershipSnapshot,
            ),
          ).profileId || "";
      }
      if (!participantProfileId) {
        throw new AuthApiFailure(
          403,
          "permission-denied",
          "Only event participants can select prizes.",
        );
      }
      await assertOwned();
      const result = await repository.transactEventPrizeSelection(
        eventId,
        participantProfileId,
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
    },
  );
}

export {
  EVENT_LOCK_ATTEMPTS,
  EVENT_LOCK_RETRY_DELAY_MS,
  EVENT_OPERATION_TIMEOUT_MS,
  EVENT_RECONCILIATION_TIMEOUT_MS,
  buildParticipant,
  participantCount,
};
