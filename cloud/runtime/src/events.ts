import {
  eventRequestId,
  eventRequestMatchKey,
  eventRequestPostponeMinutes,
  eventRequestStartsInMinutes,
  eventCreateOptions,
} from "./events/requests.js";
import type { EventSyncSkipReason } from "./shared/events.js";
import type { WithdrawalDocument } from "./eventPrizes/records.js";
import {
  eventState,
  eventRounds,
  eventThirdPlaceMatch,
  eventRoundAt,
  eventRoundMatches,
  eventMatchAt,
  eventMatchEntries,
  eventMatchState,
  readEventDocument,
  cloneEventDocument,
  createEventDocument,
  createEventParticipantsDocument,
  createEventParticipantDocument,
  createEventRoundsDocument,
  patchEventDocument,
} from "./events/documents.js";
import type { EventData, EventMatch } from "./events/model.js";
import type { EventOwnershipProfile } from "./events/ownership.js";
import {
  withEventLease,
  type EventLockManager,
} from "./events/lockManagerCore.js";
import type { EventCommand, EventCommitPlan } from "./eventCommands.js";
import type { EventPrizeAssignmentRecord } from "./eventReads.js";
import type { EventRuntimeStore } from "./eventCommands.js";
import type { EventMatchPairRequest } from "./events/bracket.js";
import type { EventOwnershipSnapshot } from "./events/ownership.js";

import { eventField, mergeEventPlans } from "./eventCommands.js";
import { isEventPrizeEvent } from "@mons/shared/event-prizes";
import { getCompletedEventPrizeProjectionCleanupRequest } from "./eventPrizeProjectionState.js";
import { INVITE_ID_RANDOM_LENGTH, randomAlphanumeric } from "@mons/shared/ids";
import {
  EVENT_POSTPONE_OPTIONS_MINUTES,
  EVENT_SCHEMA_VERSION,
  MAX_STARTS_IN_MINUTES,
  MIN_STARTS_IN_MINUTES,
  THIRD_PLACE_MATCH_KEY,
  buildEventParticipantSnapshot,
  isMonsLinkAdmin,
  parseEventMatchKey as parseMatchKey,
  resolveEventTelegramAnnouncements,
} from "@mons/shared/events";
import { createEventBracketRuntime } from "./events/bracket.js";
import {
  buildActiveEventSyncPlan,
  buildEndedEventSyncPlan,
} from "./events/syncTransitions.js";
import { getEventParticipantIds } from "./events/participants.js";
import {
  assertScheduledStartWindow,
  hasDateTimeScheduleRequest,
  resolveScheduledDateTimeStartAtMs,
} from "./events/scheduling.js";
import {
  buildEventOwnershipQuery,
  directRequesterParticipation,
  getLoginProfileId,
  getOwnershipProfile,
  profileOwnershipUnavailable,
  requesterOwnsProfileReference,
  resolveRequesterParticipation,
} from "./events/ownership.js";
type EventSyncLog = {
  mode?: string;
  eventId?: string | null;
  requesterUid?: string | null;
  sourceKey?: string;
  triggerReason?: string;
  workflowInstanceId?: string;
  targetMatchKey?: string | null;
  reason?: string | null;
  requesterProfileId?: string | null;
  skipped?: boolean;
  didChange?: boolean;
  durationMs?: number;
};
export type EventRuntimeCode =
  | "aborted"
  | "failed-precondition"
  | "invalid-argument"
  | "not-found"
  | "permission-denied"
  | "unauthenticated"
  | "unavailable";
export type EventRuntimeRequest = {
  auth: {
    uid: string;
  } | null;
  data: unknown;
};
export type EventProgressOutboxRecord = {
  schemaVersion: 1;
  eventId: string;
  sourceKey: string;
  reason: string;
  runAtMs: number | null;
  firstQueuedAtMs: number;
  lastQueuedAtMs: number;
};
export type EventRuntimeCreateResult = {
  ok: true;
  eventId: string;
  event: EventData;
};
export type EventRuntimePostponeResult = EventRuntimeCreateResult & {
  postponeByMinutes: number;
  startAtMs: number;
};
export type EventRuntimeSyncResult =
  | {
      ok: true;
      eventId: string;
      didChange: boolean;
      event: EventData | null;
      skipped?: never;
      reason?: never;
    }
  | {
      ok: true;
      eventId: string;
      skipped: true;
      reason: EventSyncSkipReason;
      event?: EventData | null;
      didChange?: never;
    };
export type EventRuntimeDisqualifyResult = EventRuntimeSyncResult & {
  didDisqualify: boolean;
  matchKey: string;
};
export type EventRuntime = {
  createEvent(request: EventRuntimeRequest): Promise<EventRuntimeCreateResult>;
  disqualifyEventMatchWinners(
    request: EventRuntimeRequest,
  ): Promise<EventRuntimeDisqualifyResult>;
  postponeEventStart(
    request: EventRuntimeRequest,
  ): Promise<EventRuntimePostponeResult>;
  runEventSyncState(input: {
    eventId: string;
    requesterUid: string;
    enforceParticipantGate: boolean;
    enforceThrottle: boolean;
    syncLog: EventSyncLog;
  }): Promise<EventRuntimeSyncResult>;
  syncEventState(request: EventRuntimeRequest): Promise<EventRuntimeSyncResult>;
};
type Signature_createEventRuntime = (dependencies: {
  readMatchPair: (input: EventMatchPairRequest) => Promise<[unknown, unknown]>;
  readMatchPairs: (
    inputs: EventMatchPairRequest[],
  ) => Promise<Array<[unknown, unknown]>>;
  state: EventRuntimeStore;
  enqueueEventProgressTask(input: {
    eventId: string;
    sourceKey: string;
    reason: string;
    scheduleTimeMs?: number;
  }): Promise<{ outboxId: string; outbox: EventProgressOutboxRecord }>;
  eventLockManager: Pick<
    EventLockManager,
    | "acquireEventLockWithRetry"
    | "isEventLockStillOwned"
    | "releaseEventLock"
    | "startEventLockHeartbeat"
  >;
  readProfileOwnershipSnapshot(query: {
    loginUids: string[];
    profileIds: string[];
  }): Promise<EventOwnershipSnapshot>;
  readEventPrizeWithdrawals?: (
    eventId: string,
  ) => Promise<Record<string, WithdrawalDocument>>;
  now?: () => number;
  random?: () => number;
  sleep(milliseconds: number): Promise<void>;
}) => EventRuntime;

class EventRuntimeError extends Error {
  declare code: EventRuntimeCode;
  constructor(code: EventRuntimeCode, message: string) {
    super(message);
    this.code = code;
  }
}

const createEventRuntime: Signature_createEventRuntime = (dependencies) => {
  const state = dependencies.state;
  const readProfileOwnershipSnapshot =
    dependencies.readProfileOwnershipSnapshot;
  const enqueueEventProgressTask = dependencies.enqueueEventProgressTask;
  const readEventPrizeWithdrawals = dependencies.readEventPrizeWithdrawals;
  const lockManager = dependencies.eventLockManager;
  const { acquireEventLockWithRetry, isEventLockStillOwned } = lockManager;
  const bracket = createEventBracketRuntime({
    state,
    readEventPrizeWithdrawals,
    readMatchPair: dependencies.readMatchPair,
    readMatchPairs: dependencies.readMatchPairs,
  });
  const {
    buildScheduledEventDueUpdates,
    isMatchWinnerDisqualified,
    reconcileProfileEventPrizeAssignments,
    removeCompletedEventPrizeProjections,
  } = bracket;
  const syncPlanningDependencies = {
    addEventPrizeAssignmentUpdates: bracket.addEventPrizeAssignmentUpdates,
    applyMatchResolution: bracket.applyMatchResolution,
    getSortedRoundIndexes: bracket.getSortedRoundIndexes,
    hasThirdPlaceMatchField: bracket.hasThirdPlaceMatchField,
    isMatchResolved: bracket.isMatchResolved,
    rebuildParticipantStatesFromRounds:
      bracket.rebuildParticipantStatesFromRounds,
    recomputeRoundStatuses: bracket.recomputeRoundStatuses,
    reconcileBracketMatchReadiness: bracket.reconcileBracketMatchReadiness,
    reconcileThirdPlaceMatchReadiness:
      bracket.reconcileThirdPlaceMatchReadiness,
    resolveEventPrizeAssignments: bracket.resolveEventPrizeAssignments,
    resolveRoundMatchState: bracket.resolveRoundMatchState,
    resolveRoundMatchesWithConcurrency:
      bracket.resolveRoundMatchesWithConcurrency,
  };
  const HttpsError = EventRuntimeError;
  const EVENT_SYNC_THROTTLE_WINDOW_MS = 500;

  const normalizeString = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : "";
  const normalizeUsername = (value: unknown) =>
    normalizeString(value).toLowerCase();
  const getNowMs = dependencies.now || Date.now;
  const sleep = dependencies.sleep;

  const getPrizeSelectionProfileIds = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value)
      : [];

  const generateEventId = () =>
    randomAlphanumeric(INVITE_ID_RANDOM_LENGTH, dependencies.random);

  const loadOwnershipSnapshot = async (
    event: EventData,
    extras: { loginUids?: string[]; profileIds?: string[] } = {},
  ) => {
    if (typeof readProfileOwnershipSnapshot !== "function") {
      throw profileOwnershipUnavailable();
    }
    try {
      return await readProfileOwnershipSnapshot(
        buildEventOwnershipQuery(event, extras),
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (error as { code?: unknown }).code === "unavailable" &&
        (error as { message?: unknown }).message ===
          "profile-ownership-unavailable"
      ) {
        throw error;
      }
      throw profileOwnershipUnavailable();
    }
  };

  const ensurePilotEventCreator = (
    uid: string,
    ownershipSnapshot: EventOwnershipSnapshot,
  ) => {
    const profileId = getLoginProfileId(ownershipSnapshot, uid);
    const profile = profileId
      ? getOwnershipProfile(ownershipSnapshot, profileId)
      : null;
    if (!profileId || !profile) {
      throw new HttpsError(
        "failed-precondition",
        "Event creation requires a signed-in profile.",
      );
    }
    const username = normalizeUsername(profile.username);
    if (!isMonsLinkAdmin(username)) {
      throw new HttpsError(
        "permission-denied",
        "Only approved pilot users can create pilot events.",
      );
    }
    return profile;
  };

  const createBaseEventRecord = ({
    eventId,
    creatorProfile,
    creatorUid,
    startAtMs,
    createdAtMs,
    isSundayMons,
    telegramAnnouncements,
  }: {
    eventId: string;
    creatorProfile: EventOwnershipProfile;
    creatorUid: string;
    startAtMs: number;
    createdAtMs: number;
    isSundayMons: boolean;
    telegramAnnouncements: ReturnType<typeof resolveEventTelegramAnnouncements>;
  }) => {
    const creatorParticipant = buildEventParticipantSnapshot(
      creatorProfile,
      creatorUid,
      createdAtMs,
    );
    if (!creatorParticipant) {
      throw new HttpsError("unavailable", "event-service-unavailable");
    }
    return createEventDocument({
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId,
      status: "scheduled",
      createdAtMs,
      updatedAtMs: createdAtMs,
      startAtMs,
      isSundayMons,
      telegramAnnouncements,
      telegramDeliveryVersion: 2,
      startedAtMs: null,
      endedAtMs: null,
      createdByProfileId: creatorParticipant.profileId,
      createdByLoginUid: creatorUid,
      createdByUsername: creatorParticipant.username,
      winnerProfileId: null,
      winnerDisplayName: null,
      currentRoundIndex: null,
      bracketSize: 0,
      roundCount: 0,
      supportsThirdPlaceMatch: true,
      thirdPlaceMatch: null,
      participants: createEventParticipantsDocument({
        [creatorParticipant.profileId]:
          createEventParticipantDocument(creatorParticipant),
      }),
      rounds: createEventRoundsDocument(),
    });
  };

  const tryAcquireEventSyncThrottle = async (
    eventId: string,
    ownerUid: string,
  ) => {
    const nowMs = getNowMs();
    const token = crypto.randomUUID();
    const result = await state.transactEventSyncThrottle(eventId, (current) => {
      const lastStartedAtMs =
        current && typeof current.startedAtMs === "number"
          ? Math.floor(current.startedAtMs)
          : 0;
      if (
        lastStartedAtMs > 0 &&
        nowMs - lastStartedAtMs < EVENT_SYNC_THROTTLE_WINDOW_MS
      ) {
        return { commit: false };
      }
      return { value: { startedAtMs: nowMs, ownerUid, token } };
    });
    if (!result.committed) {
      return null;
    }
    return {
      startedAtMs: nowMs,
      ownerUid,
      token,
    };
  };

  const logSyncEventStateResult = (payload: EventSyncLog) => {
    try {
      console.log(JSON.stringify({ event: "event_sync_result", ...payload }));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "event_sync_log_failure",
          kind: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
  };

  const createSyncLog = ({
    eventId,
    requesterUid,
    mode,
  }: {
    eventId: string | null;
    requesterUid: string | null;
    mode: string;
  }): EventSyncLog => ({
    mode,
    eventId,
    requesterUid: requesterUid || null,
    requesterProfileId: null,
    skipped: false,
    reason: null,
    didChange: false,
    durationMs: 0,
  });

  const createEvent: EventRuntime["createEvent"] = async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "The function must be called while authenticated.",
      );
    }

    const ownershipSnapshot = await loadOwnershipSnapshot(
      readEventDocument({})!,
      { loginUids: [request.auth.uid] },
    );
    const creatorProfile = ensurePilotEventCreator(
      request.auth.uid,
      ownershipSnapshot,
    );
    const createdAtMs = getNowMs();
    const options = eventCreateOptions(request.data);
    if (!options.validSundayMons) {
      throw new HttpsError(
        "invalid-argument",
        "Sunday Mons must be a boolean.",
      );
    }
    const telegramAnnouncements = options.telegramAnnouncements;
    let startAtMs = 0;

    if (hasDateTimeScheduleRequest(request.data)) {
      startAtMs = resolveScheduledDateTimeStartAtMs(request.data, createdAtMs);
      assertScheduledStartWindow(startAtMs, createdAtMs);
    } else {
      const rawStartsInMinutes = eventRequestStartsInMinutes(request.data);
      if (rawStartsInMinutes < MIN_STARTS_IN_MINUTES) {
        throw new HttpsError(
          "invalid-argument",
          `Event must start at least ${MIN_STARTS_IN_MINUTES} minute from now.`,
        );
      }
      const startsInMinutes = Math.min(
        MAX_STARTS_IN_MINUTES,
        rawStartsInMinutes,
      );
      startAtMs = createdAtMs + startsInMinutes * 60 * 1000;
    }

    const eventId = generateEventId();
    const event = createBaseEventRecord({
      eventId,
      creatorProfile,
      creatorUid: request.auth.uid,
      startAtMs,
      createdAtMs,
      isSundayMons: options.isSundayMons,
      telegramAnnouncements,
    });

    const sourceKey = `start:${eventId}:${startAtMs}`;
    let progress;
    try {
      progress = await enqueueEventProgressTask({
        eventId,
        sourceKey,
        reason: "scheduled-start",
        scheduleTimeMs: startAtMs,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "event_progress_enqueue_failed",
          eventId,
          sourceKey,
          reason: "scheduled-start",
          kind: error instanceof Error ? error.name : typeof error,
        }),
      );
      throw new HttpsError(
        "unavailable",
        "Could not schedule event start. Please try again.",
      );
    }

    await state.commitEventPlan([
      { kind: "event", eventId: eventId, value: event },
      {
        kind: "progress-outbox",
        outboxId: progress.outboxId,
        value: progress.outbox,
      },
    ]);

    return {
      ok: true,
      eventId,
      event,
    };
  };

  const postponeEventStart: EventRuntime["postponeEventStart"] = async (
    request,
  ) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "The function must be called while authenticated.",
      );
    }

    const requesterUid = request.auth.uid;
    const eventId = eventRequestId(request.data);
    if (!eventId) {
      throw new HttpsError("invalid-argument", "eventId is required.");
    }
    const postponeByMinutes = eventRequestPostponeMinutes(request.data);
    if (
      !(EVENT_POSTPONE_OPTIONS_MINUTES as readonly number[]).includes(
        postponeByMinutes,
      )
    ) {
      throw new HttpsError(
        "invalid-argument",
        "postponeByMinutes must be one of: 5, 10, 15.",
      );
    }

    const initialEventValue = await state.readEvent(eventId);
    if (!(initialEventValue !== null && initialEventValue !== undefined)) {
      throw new HttpsError("not-found", "Event not found.");
    }
    const lockHandle = await acquireEventLockWithRetry(eventId, requesterUid, {
      attempts: 40,
      delayMs: 100,
    });
    if (!lockHandle) {
      throw new HttpsError(
        "unavailable",
        "Event is busy. Please try postponing again.",
      );
    }
    return withEventLease(lockManager, lockHandle, async () => {
      const snapshot = isEventPrizeEvent(eventId)
        ? await state.readEventSnapshot(eventId)
        : null;
      const eventValue = snapshot
        ? snapshot.event
        : await state.readEvent(eventId);
      if (!(eventValue !== null && eventValue !== undefined)) {
        throw new HttpsError("not-found", "Event not found.");
      }
      const event = cloneEventDocument(readEventDocument(eventValue)!);
      const currentEvent = eventState(event);
      const creatorLoginUid = normalizeString(currentEvent.createdByLoginUid);
      const creatorProfileId = normalizeString(currentEvent.createdByProfileId);
      const nowMs = getNowMs();
      const prizeSelections =
        isEventPrizeEvent(eventId) &&
        normalizeString(currentEvent.status) === "scheduled" &&
        typeof currentEvent.startAtMs === "number" &&
        nowMs >= currentEvent.startAtMs
          ? { ...snapshot!.prizeSelections }
          : undefined;
      const directCreator = requesterUid === creatorLoginUid;
      const dueParticipantCount = getEventParticipantIds(event).length;
      const ownershipSnapshot =
        directCreator &&
        (nowMs < (currentEvent.startAtMs as number) || dueParticipantCount < 2)
          ? null
          : await loadOwnershipSnapshot(event, {
              loginUids: [requesterUid],
              profileIds: getPrizeSelectionProfileIds(prizeSelections),
            });
      if (
        !requesterOwnsProfileReference({
          requesterUid,
          snapshot: ownershipSnapshot,
          storedLoginUid: creatorLoginUid,
          storedProfileId: creatorProfileId,
        })
      ) {
        throw new HttpsError(
          "permission-denied",
          "Only the event creator can postpone this event.",
        );
      }
      if (normalizeString(currentEvent.status) !== "scheduled") {
        throw new HttpsError(
          "failed-precondition",
          "Only scheduled events can be postponed.",
        );
      }
      if (
        typeof currentEvent.startAtMs !== "number" ||
        !Number.isFinite(currentEvent.startAtMs)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "This event cannot be postponed right now.",
        );
      }
      if (nowMs >= currentEvent.startAtMs) {
        const dueTransition = await buildScheduledEventDueUpdates({
          eventId,
          event,
          nowMs,
          ownershipSnapshot,
          prizeSelections,
        });
        if (dueTransition.didChange) {
          const lockOwned = await isEventLockStillOwned(lockHandle);
          if (!lockOwned) {
            throw new HttpsError(
              "unavailable",
              "Event is busy. Please try postponing again.",
            );
          }
          await state.commitEventPlan(dueTransition.updates);
        }
        throw new HttpsError(
          "failed-precondition",
          "This event can no longer be postponed.",
        );
      }

      const nextStartAtMs =
        Math.floor(currentEvent.startAtMs) + postponeByMinutes * 60 * 1000;
      assertScheduledStartWindow(nextStartAtMs, nowMs);
      const sourceKey = `start:${eventId}:${nextStartAtMs}`;
      let progress;
      try {
        progress = await enqueueEventProgressTask({
          eventId,
          sourceKey,
          reason: "scheduled-start-postpone",
          scheduleTimeMs: nextStartAtMs,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "event_progress_enqueue_failed",
            eventId,
            sourceKey,
            reason: "scheduled-start-postpone",
            kind: error instanceof Error ? error.name : typeof error,
          }),
        );
        throw new HttpsError(
          "unavailable",
          "Could not schedule postponed event start. Please try again.",
        );
      }

      const lockOwned = await isEventLockStillOwned(lockHandle);
      if (!lockOwned) {
        throw new HttpsError(
          "unavailable",
          "Event is busy. Please try postponing again.",
        );
      }

      patchEventDocument(event, {
        startAtMs: nextStartAtMs,
        updatedAtMs: nowMs,
      });
      await state.commitEventPlan([
        eventField(eventId, "startAtMs", nextStartAtMs),
        eventField(eventId, "updatedAtMs", nowMs),
        {
          kind: "progress-outbox",
          outboxId: progress.outboxId,
          value: progress.outbox,
        },
      ]);

      return {
        ok: true,
        eventId,
        event,
        postponeByMinutes,
        startAtMs: nextStartAtMs,
      };
    });
  };

  const disqualifyEventMatchWinners: EventRuntime["disqualifyEventMatchWinners"] =
    async (request) => {
      const startedAtMs = getNowMs();
      const eventId = eventRequestId(request.data);
      const matchKeyInput = eventRequestMatchKey(request.data);
      const syncLog = createSyncLog({
        eventId: eventId || null,
        requesterUid: request && request.auth ? request.auth.uid : null,
        mode: "callable-disqualify",
      });
      syncLog.targetMatchKey = matchKeyInput || null;
      try {
        if (!request.auth) {
          throw new HttpsError(
            "unauthenticated",
            "The function must be called while authenticated.",
          );
        }
        const requesterUid = request.auth.uid;
        if (!eventId) {
          throw new HttpsError("invalid-argument", "eventId is required.");
        }
        const isThirdPlaceTarget = matchKeyInput === THIRD_PLACE_MATCH_KEY;
        const parsedMatchKey = isThirdPlaceTarget
          ? null
          : parseMatchKey(matchKeyInput);
        if (!isThirdPlaceTarget && !parsedMatchKey) {
          throw new HttpsError("invalid-argument", "matchKey is invalid.");
        }

        const lockHandle = await acquireEventLockWithRetry(
          eventId,
          requesterUid,
          {
            attempts: 40,
            delayMs: 100,
          },
        );
        if (!lockHandle) {
          throw new HttpsError(
            "unavailable",
            "Event is busy. Please try disqualifying again.",
          );
        }
        const result = await withEventLease(
          lockManager,
          lockHandle,
          async () => {
            let resolvedMatchKey = matchKeyInput;
            const eventValue = await state.readEvent(eventId);
            if (!(eventValue !== null && eventValue !== undefined)) {
              throw new HttpsError("not-found", "Event not found.");
            }
            const event = cloneEventDocument(readEventDocument(eventValue)!);
            const ownershipSnapshot = await loadOwnershipSnapshot(event, {
              loginUids: [requesterUid],
            });
            ensurePilotEventCreator(requesterUid, ownershipSnapshot);
            if (normalizeString(eventState(event).status) !== "active") {
              throw new HttpsError(
                "failed-precondition",
                "Only active events can be updated.",
              );
            }

            let targetMatch: EventMatch | null = null;
            let targetMatchUpdate: Omit<
              Extract<EventCommand, { kind: "event-disqualification" }>,
              "value"
            > | null = null;
            if (isThirdPlaceTarget) {
              const thirdPlaceMatchCandidate = eventThirdPlaceMatch(event);
              if (
                thirdPlaceMatchCandidate &&
                typeof thirdPlaceMatchCandidate === "object"
              ) {
                targetMatch = thirdPlaceMatchCandidate;
                resolvedMatchKey = THIRD_PLACE_MATCH_KEY;
                targetMatchUpdate = {
                  kind: "event-disqualification",
                  eventId,
                  roundKey: null,
                  matchKey: "third_place",
                };
              }
            } else {
              const round = eventRoundAt(
                eventRounds(event),
                String(parsedMatchKey!.roundIndex),
              );
              if (
                !round ||
                !eventRoundMatches(round) ||
                typeof eventRoundMatches(round) !== "object"
              ) {
                throw new HttpsError(
                  "failed-precondition",
                  "Selected match not found.",
                );
              }

              targetMatch = eventMatchAt(
                eventRoundMatches(round),
                resolvedMatchKey,
              );
              if (!targetMatch || typeof targetMatch !== "object") {
                const fallbackEntry =
                  eventMatchEntries(eventRoundMatches(round)).find(
                    ([candidateMatchKey]) => {
                      const parsedCandidate = parseMatchKey(candidateMatchKey);
                      return (
                        parsedCandidate?.matchIndex ===
                        parsedMatchKey!.matchIndex
                      );
                    },
                  ) || null;
                if (fallbackEntry) {
                  [resolvedMatchKey, targetMatch] = fallbackEntry;
                }
              }
              targetMatchUpdate = {
                kind: "event-disqualification",
                eventId,
                roundKey: String(parsedMatchKey!.roundIndex),
                matchKey: resolvedMatchKey,
              };
            }

            if (!targetMatch || typeof targetMatch !== "object") {
              throw new HttpsError(
                "failed-precondition",
                "Selected match not found.",
              );
            }

            if (
              normalizeString(eventMatchState(targetMatch).status) !==
                "pending" ||
              !normalizeString(eventMatchState(targetMatch).inviteId)
            ) {
              throw new HttpsError(
                "failed-precondition",
                "Only active matches can be disqualified.",
              );
            }
            if (
              !normalizeString(eventMatchState(targetMatch).hostProfileId) ||
              !normalizeString(eventMatchState(targetMatch).guestProfileId)
            ) {
              throw new HttpsError(
                "failed-precondition",
                "Selected match must have two participants.",
              );
            }

            const didDisqualify = !isMatchWinnerDisqualified(targetMatch);
            if (didDisqualify) {
              const lockOwned = await isEventLockStillOwned(lockHandle);
              if (!lockOwned) {
                throw new HttpsError(
                  "unavailable",
                  "Event is busy. Please try disqualifying again.",
                );
              }
              await state.commitEventPlan([
                { ...targetMatchUpdate!, value: true },
                eventField(eventId, "updatedAtMs", getNowMs()),
              ]);
            }
            return { didDisqualify, resolvedMatchKey };
          },
        );

        let syncResult!: EventRuntimeSyncResult;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          syncLog.skipped = false;
          syncLog.reason = null;
          syncResult = await runEventSyncState({
            eventId,
            requesterUid,
            enforceParticipantGate: false,
            enforceThrottle: false,
            syncLog,
          });
          if (!(
            syncResult &&
            syncResult.skipped &&
            syncResult.reason === "locked"
          )) {
            break;
          }
          await sleep(80);
        }

        return {
          ...syncResult,
          didDisqualify: result.didDisqualify,
          matchKey: result.resolvedMatchKey,
        };
      } finally {
        syncLog.durationMs = getNowMs() - startedAtMs;
        logSyncEventStateResult(syncLog);
      }
    };

  const buildSkippedSyncResponse = ({
    eventId,
    reason,
    event,
  }: {
    eventId: string;
    reason: EventSyncSkipReason;
    event?: EventData | null;
  }): EventRuntimeSyncResult => ({
    ok: true,
    eventId,
    skipped: true,
    reason,
    ...(event !== undefined ? { event } : {}),
  });

  const runEventSyncState: EventRuntime["runEventSyncState"] = async ({
    eventId,
    requesterUid,
    enforceParticipantGate,
    enforceThrottle,
    syncLog,
  }) => {
    try {
      const eventValue = await state.readEvent(eventId);
      if (!(eventValue !== null && eventValue !== undefined)) {
        throw new HttpsError("not-found", "Event not found.");
      }
      const lockHandle = await acquireEventLockWithRetry(
        eventId,
        requesterUid,
        {
          attempts: 10,
          delayMs: 100,
        },
      );
      if (!lockHandle) {
        syncLog.skipped = true;
        syncLog.reason = "locked";
        return buildSkippedSyncResponse({
          eventId,
          reason: "locked",
        });
      }
      return await withEventLease(lockManager, lockHandle, async () => {
        const snapshot = isEventPrizeEvent(eventId)
          ? await state.readEventSnapshot(eventId)
          : null;
        const lockedEventValue = snapshot
          ? snapshot.event
          : await state.readEvent(eventId);
        if (!(lockedEventValue !== null && lockedEventValue !== undefined)) {
          throw new HttpsError("not-found", "Event not found.");
        }
        let event = cloneEventDocument(readEventDocument(lockedEventValue)!);
        const currentEvent = eventState(event);
        const nowMs = getNowMs();
        let prizeSelections;
        if (
          isEventPrizeEvent(eventId) &&
          (currentEvent.status === "active" ||
            currentEvent.status === "ended" ||
            (currentEvent.status === "scheduled" &&
              typeof currentEvent.startAtMs === "number" &&
              nowMs >= currentEvent.startAtMs))
        ) {
          prizeSelections = { ...snapshot!.prizeSelections };
        }
        const directParticipation = enforceParticipantGate
          ? directRequesterParticipation(event, requesterUid)
          : null;
        const scheduledEventIsDue =
          currentEvent.status === "scheduled" &&
          typeof currentEvent.startAtMs === "number" &&
          nowMs >= currentEvent.startAtMs;
        const needsOwnershipSnapshot =
          currentEvent.status === "active" ||
          (scheduledEventIsDue && getEventParticipantIds(event).length >= 2) ||
          (currentEvent.status === "ended" && isEventPrizeEvent(eventId)) ||
          (enforceParticipantGate && !directParticipation?.isParticipant);
        const ownershipSnapshot = needsOwnershipSnapshot
          ? await loadOwnershipSnapshot(event, {
              loginUids: enforceParticipantGate ? [requesterUid] : [],
              profileIds: getPrizeSelectionProfileIds(prizeSelections),
            })
          : null;
        if (enforceParticipantGate) {
          const lockedRequesterParticipation = resolveRequesterParticipation(
            event,
            requesterUid,
            ownershipSnapshot,
          );
          syncLog.requesterProfileId = lockedRequesterParticipation.profileId;
          if (!lockedRequesterParticipation.isParticipant) {
            syncLog.skipped = true;
            syncLog.reason = "not-participant";
            return buildSkippedSyncResponse({
              eventId,
              reason: "not-participant",
            });
          }
        }
        if (enforceThrottle) {
          const syncThrottle = await tryAcquireEventSyncThrottle(
            eventId,
            requesterUid,
          );
          if (!syncThrottle) {
            syncLog.skipped = true;
            syncLog.reason = "rate-limited";
            return buildSkippedSyncResponse({
              eventId,
              reason: "rate-limited",
            });
          }
        }
        const updates: EventCommitPlan = [];
        let didChange = false;
        let eventPrizeAssignmentsForProjectionCleanup: Record<
          string,
          EventPrizeAssignmentRecord
        > | null = null;

        if (eventState(event).status === "scheduled") {
          const dueTransition = await buildScheduledEventDueUpdates({
            eventId,
            event,
            nowMs,
            ownershipSnapshot,
            prizeSelections,
          });
          updates.push(...dueTransition.updates);
          didChange = dueTransition.didChange;
        } else if (
          eventState(event).status === "active" ||
          eventState(event).status === "ended"
        ) {
          const transition = await (
            eventState(event).status === "active"
              ? buildActiveEventSyncPlan
              : buildEndedEventSyncPlan
          )(
            { eventId, event, nowMs, ownershipSnapshot, prizeSelections },
            syncPlanningDependencies,
          );
          updates.push(...transition.updates);
          didChange = transition.didChange;
          event = transition.eventForProjection;
          eventPrizeAssignmentsForProjectionCleanup =
            transition.prizeAssignmentsForProjection;
        }

        if (didChange) {
          const lockOwned = await isEventLockStillOwned(lockHandle);
          if (!lockOwned) {
            const latestValue = await state.readEvent(eventId);
            syncLog.skipped = true;
            syncLog.reason = "locked";
            return buildSkippedSyncResponse({
              eventId,
              reason: "locked",
              event: latestValue,
            });
          }
          await state.commitEventPlan(mergeEventPlans(updates));
        }
        if (eventPrizeAssignmentsForProjectionCleanup) {
          if (!(await isEventLockStillOwned(lockHandle))) {
            throw new HttpsError(
              "aborted",
              "Event lock expired while projecting prizes.",
            );
          }
          const projectionResult = await reconcileProfileEventPrizeAssignments({
            event,
            eventId,
            assignments: eventPrizeAssignmentsForProjectionCleanup,
            ownershipSnapshot,
          });
          if (projectionResult.didChange) didChange = true;
        }
        const projectionCleanupRequest =
          getCompletedEventPrizeProjectionCleanupRequest({
            eventId,
            eventStatus: eventState(event).status,
            assignments: eventPrizeAssignmentsForProjectionCleanup,
          });
        if (projectionCleanupRequest) {
          if (!(await isEventLockStillOwned(lockHandle))) {
            throw new HttpsError(
              "aborted",
              "Event lock expired while cleaning prize projections.",
            );
          }
          await removeCompletedEventPrizeProjections({
            ...projectionCleanupRequest,
            event,
            ownershipSnapshot,
          });
        }

        const refreshedValue = await state.readEvent(eventId);
        syncLog.didChange = didChange;
        return {
          ok: true,
          eventId,
          didChange,
          event: refreshedValue,
        };
      });
    } catch (error) {
      if (!syncLog.reason) {
        syncLog.reason =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "error";
      }
      throw error;
    }
  };

  const syncEventState: EventRuntime["syncEventState"] = async (request) => {
    const startedAtMs = getNowMs();
    const eventId = eventRequestId(request.data);
    const syncLog = createSyncLog({
      eventId: eventId || null,
      requesterUid: request && request.auth ? request.auth.uid : null,
      mode: "callable",
    });
    try {
      if (!request.auth) {
        throw new HttpsError(
          "unauthenticated",
          "The function must be called while authenticated.",
        );
      }
      if (!eventId) {
        throw new HttpsError("invalid-argument", "eventId is required.");
      }
      return await runEventSyncState({
        eventId,
        requesterUid: request.auth.uid,
        enforceParticipantGate: true,
        enforceThrottle: true,
        syncLog,
      });
    } finally {
      syncLog.durationMs = getNowMs() - startedAtMs;
      logSyncEventStateResult(syncLog);
    }
  };

  return {
    createEvent,
    disqualifyEventMatchWinners,
    postponeEventStart,
    runEventSyncState,
    syncEventState,
  };
};

export { createEventRuntime, EventRuntimeError };
