// Generated from src/events.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventRuntimeError = exports.createEventRuntime = void 0;
const requests_js_1 = require("./events/requests.js");
const documents_js_1 = require("./events/documents.js");
const lockManagerCore_js_1 = require("./events/lockManagerCore.js");
const eventCommands_js_1 = require("./eventCommands.js");
const event_prizes_1 = require("@mons/shared/event-prizes");
const eventPrizeProjectionState_js_1 = require("./eventPrizeProjectionState.js");
const ids_1 = require("@mons/shared/ids");
const events_1 = require("@mons/shared/events");
const bracket_js_1 = require("./events/bracket.js");
const syncTransitions_js_1 = require("./events/syncTransitions.js");
const participants_js_1 = require("./events/participants.js");
const scheduling_js_1 = require("./events/scheduling.js");
const ownership_js_1 = require("./events/ownership.js");
class EventRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
exports.EventRuntimeError = EventRuntimeError;
const createEventRuntime = (dependencies) => {
  const state = dependencies.state;
  const readProfileOwnershipSnapshot =
    dependencies.readProfileOwnershipSnapshot;
  const enqueueEventProgressTask = dependencies.enqueueEventProgressTask;
  const readEventPrizeWithdrawals = dependencies.readEventPrizeWithdrawals;
  const lockManager = dependencies.eventLockManager;
  const { acquireEventLockWithRetry, isEventLockStillOwned } = lockManager;
  const bracket = (0, bracket_js_1.createEventBracketRuntime)({
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
  const normalizeString = (value) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : "";
  const normalizeUsername = (value) => normalizeString(value).toLowerCase();
  const getNowMs = dependencies.now || Date.now;
  const sleep = dependencies.sleep;
  const getPrizeSelectionProfileIds = (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value)
      : [];
  const generateEventId = () =>
    (0, ids_1.randomAlphanumeric)(
      ids_1.INVITE_ID_RANDOM_LENGTH,
      dependencies.random,
    );
  const loadOwnershipSnapshot = async (event, extras = {}) => {
    if (typeof readProfileOwnershipSnapshot !== "function") {
      throw (0, ownership_js_1.profileOwnershipUnavailable)();
    }
    try {
      return await readProfileOwnershipSnapshot(
        (0, ownership_js_1.buildEventOwnershipQuery)(event, extras),
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        error.code === "unavailable" &&
        error.message === "profile-ownership-unavailable"
      ) {
        throw error;
      }
      throw (0, ownership_js_1.profileOwnershipUnavailable)();
    }
  };
  const ensurePilotEventCreator = (uid, ownershipSnapshot) => {
    const profileId = (0, ownership_js_1.getLoginProfileId)(
      ownershipSnapshot,
      uid,
    );
    const profile = profileId
      ? (0, ownership_js_1.getOwnershipProfile)(ownershipSnapshot, profileId)
      : null;
    if (!profileId || !profile) {
      throw new HttpsError(
        "failed-precondition",
        "Event creation requires a signed-in profile.",
      );
    }
    const username = normalizeUsername(profile.username);
    if (!(0, events_1.isMonsLinkAdmin)(username)) {
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
  }) => {
    const creatorParticipant = (0, events_1.buildEventParticipantSnapshot)(
      creatorProfile,
      creatorUid,
      createdAtMs,
    );
    if (!creatorParticipant) {
      throw new HttpsError("unavailable", "event-service-unavailable");
    }
    return (0, documents_js_1.createEventDocument)({
      schemaVersion: events_1.EVENT_SCHEMA_VERSION,
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
      participants: (0, documents_js_1.createEventParticipantsDocument)({
        [creatorParticipant.profileId]: (0,
        documents_js_1.createEventParticipantDocument)(creatorParticipant),
      }),
      rounds: (0, documents_js_1.createEventRoundsDocument)(),
    });
  };
  const tryAcquireEventSyncThrottle = async (eventId, ownerUid) => {
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
  const logSyncEventStateResult = (payload) => {
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
  const createSyncLog = ({ eventId, requesterUid, mode }) => ({
    mode,
    eventId,
    requesterUid: requesterUid || null,
    requesterProfileId: null,
    skipped: false,
    reason: null,
    didChange: false,
    durationMs: 0,
  });
  const createEvent = async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "The function must be called while authenticated.",
      );
    }
    const ownershipSnapshot = await loadOwnershipSnapshot(
      (0, documents_js_1.readEventDocument)({}),
      { loginUids: [request.auth.uid] },
    );
    const creatorProfile = ensurePilotEventCreator(
      request.auth.uid,
      ownershipSnapshot,
    );
    const createdAtMs = getNowMs();
    const options = (0, requests_js_1.eventCreateOptions)(request.data);
    if (!options.validSundayMons) {
      throw new HttpsError(
        "invalid-argument",
        "Sunday Mons must be a boolean.",
      );
    }
    const telegramAnnouncements = options.telegramAnnouncements;
    let startAtMs = 0;
    if ((0, scheduling_js_1.hasDateTimeScheduleRequest)(request.data)) {
      startAtMs = (0, scheduling_js_1.resolveScheduledDateTimeStartAtMs)(
        request.data,
        createdAtMs,
      );
      (0, scheduling_js_1.assertScheduledStartWindow)(startAtMs, createdAtMs);
    } else {
      const rawStartsInMinutes = (0, requests_js_1.eventRequestStartsInMinutes)(
        request.data,
      );
      if (rawStartsInMinutes < events_1.MIN_STARTS_IN_MINUTES) {
        throw new HttpsError(
          "invalid-argument",
          `Event must start at least ${events_1.MIN_STARTS_IN_MINUTES} minute from now.`,
        );
      }
      const startsInMinutes = Math.min(
        events_1.MAX_STARTS_IN_MINUTES,
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
  const postponeEventStart = async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "The function must be called while authenticated.",
      );
    }
    const requesterUid = request.auth.uid;
    const eventId = (0, requests_js_1.eventRequestId)(request.data);
    if (!eventId) {
      throw new HttpsError("invalid-argument", "eventId is required.");
    }
    const postponeByMinutes = (0, requests_js_1.eventRequestPostponeMinutes)(
      request.data,
    );
    if (!events_1.EVENT_POSTPONE_OPTIONS_MINUTES.includes(postponeByMinutes)) {
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
    return (0, lockManagerCore_js_1.withEventLease)(
      lockManager,
      lockHandle,
      async () => {
        const snapshot = (0, event_prizes_1.isEventPrizeEvent)(eventId)
          ? await state.readEventSnapshot(eventId)
          : null;
        const eventValue = snapshot
          ? snapshot.event
          : await state.readEvent(eventId);
        if (!(eventValue !== null && eventValue !== undefined)) {
          throw new HttpsError("not-found", "Event not found.");
        }
        const event = (0, documents_js_1.cloneEventDocument)(
          (0, documents_js_1.readEventDocument)(eventValue),
        );
        const currentEvent = (0, documents_js_1.eventState)(event);
        const creatorLoginUid = normalizeString(currentEvent.createdByLoginUid);
        const creatorProfileId = normalizeString(
          currentEvent.createdByProfileId,
        );
        const nowMs = getNowMs();
        const prizeSelections =
          (0, event_prizes_1.isEventPrizeEvent)(eventId) &&
          normalizeString(currentEvent.status) === "scheduled" &&
          typeof currentEvent.startAtMs === "number" &&
          nowMs >= currentEvent.startAtMs
            ? { ...snapshot.prizeSelections }
            : undefined;
        const directCreator = requesterUid === creatorLoginUid;
        const dueParticipantCount = (0,
        participants_js_1.getEventParticipantIds)(event).length;
        const ownershipSnapshot =
          directCreator &&
          (nowMs < currentEvent.startAtMs || dueParticipantCount < 2)
            ? null
            : await loadOwnershipSnapshot(event, {
                loginUids: [requesterUid],
                profileIds: getPrizeSelectionProfileIds(prizeSelections),
              });
        if (
          !(0, ownership_js_1.requesterOwnsProfileReference)({
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
        (0, scheduling_js_1.assertScheduledStartWindow)(nextStartAtMs, nowMs);
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
        (0, documents_js_1.patchEventDocument)(event, {
          startAtMs: nextStartAtMs,
          updatedAtMs: nowMs,
        });
        await state.commitEventPlan([
          (0, eventCommands_js_1.eventField)(
            eventId,
            "startAtMs",
            nextStartAtMs,
          ),
          (0, eventCommands_js_1.eventField)(eventId, "updatedAtMs", nowMs),
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
      },
    );
  };
  const disqualifyEventMatchWinners = async (request) => {
    const startedAtMs = getNowMs();
    const eventId = (0, requests_js_1.eventRequestId)(request.data);
    const matchKeyInput = (0, requests_js_1.eventRequestMatchKey)(request.data);
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
      const isThirdPlaceTarget =
        matchKeyInput === events_1.THIRD_PLACE_MATCH_KEY;
      const parsedMatchKey = isThirdPlaceTarget
        ? null
        : (0, events_1.parseEventMatchKey)(matchKeyInput);
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
      const result = await (0, lockManagerCore_js_1.withEventLease)(
        lockManager,
        lockHandle,
        async () => {
          let resolvedMatchKey = matchKeyInput;
          const eventValue = await state.readEvent(eventId);
          if (!(eventValue !== null && eventValue !== undefined)) {
            throw new HttpsError("not-found", "Event not found.");
          }
          const event = (0, documents_js_1.cloneEventDocument)(
            (0, documents_js_1.readEventDocument)(eventValue),
          );
          const ownershipSnapshot = await loadOwnershipSnapshot(event, {
            loginUids: [requesterUid],
          });
          ensurePilotEventCreator(requesterUid, ownershipSnapshot);
          if (
            normalizeString((0, documents_js_1.eventState)(event).status) !==
            "active"
          ) {
            throw new HttpsError(
              "failed-precondition",
              "Only active events can be updated.",
            );
          }
          let targetMatch = null;
          let targetMatchUpdate = null;
          if (isThirdPlaceTarget) {
            const thirdPlaceMatchCandidate = (0,
            documents_js_1.eventThirdPlaceMatch)(event);
            if (
              thirdPlaceMatchCandidate &&
              typeof thirdPlaceMatchCandidate === "object"
            ) {
              targetMatch = thirdPlaceMatchCandidate;
              resolvedMatchKey = events_1.THIRD_PLACE_MATCH_KEY;
              targetMatchUpdate = {
                kind: "event-disqualification",
                eventId,
                roundKey: null,
                matchKey: "third_place",
              };
            }
          } else {
            const round = (0, documents_js_1.eventRoundAt)(
              (0, documents_js_1.eventRounds)(event),
              String(parsedMatchKey.roundIndex),
            );
            if (
              !round ||
              !(0, documents_js_1.eventRoundMatches)(round) ||
              typeof (0, documents_js_1.eventRoundMatches)(round) !== "object"
            ) {
              throw new HttpsError(
                "failed-precondition",
                "Selected match not found.",
              );
            }
            targetMatch = (0, documents_js_1.eventMatchAt)(
              (0, documents_js_1.eventRoundMatches)(round),
              resolvedMatchKey,
            );
            if (!targetMatch || typeof targetMatch !== "object") {
              const fallbackEntry =
                (0, documents_js_1.eventMatchEntries)(
                  (0, documents_js_1.eventRoundMatches)(round),
                ).find(([candidateMatchKey]) => {
                  const parsedCandidate = (0, events_1.parseEventMatchKey)(
                    candidateMatchKey,
                  );
                  return (
                    parsedCandidate?.matchIndex === parsedMatchKey.matchIndex
                  );
                }) || null;
              if (fallbackEntry) {
                [resolvedMatchKey, targetMatch] = fallbackEntry;
              }
            }
            targetMatchUpdate = {
              kind: "event-disqualification",
              eventId,
              roundKey: String(parsedMatchKey.roundIndex),
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
            normalizeString(
              (0, documents_js_1.eventMatchState)(targetMatch).status,
            ) !== "pending" ||
            !normalizeString(
              (0, documents_js_1.eventMatchState)(targetMatch).inviteId,
            )
          ) {
            throw new HttpsError(
              "failed-precondition",
              "Only active matches can be disqualified.",
            );
          }
          if (
            !normalizeString(
              (0, documents_js_1.eventMatchState)(targetMatch).hostProfileId,
            ) ||
            !normalizeString(
              (0, documents_js_1.eventMatchState)(targetMatch).guestProfileId,
            )
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
              { ...targetMatchUpdate, value: true },
              (0, eventCommands_js_1.eventField)(
                eventId,
                "updatedAtMs",
                getNowMs(),
              ),
            ]);
          }
          return { didDisqualify, resolvedMatchKey };
        },
      );
      let syncResult;
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
  const buildSkippedSyncResponse = ({ eventId, reason, event }) => ({
    ok: true,
    eventId,
    skipped: true,
    reason,
    ...(event !== undefined ? { event } : {}),
  });
  const runEventSyncState = async ({
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
      return await (0, lockManagerCore_js_1.withEventLease)(
        lockManager,
        lockHandle,
        async () => {
          const snapshot = (0, event_prizes_1.isEventPrizeEvent)(eventId)
            ? await state.readEventSnapshot(eventId)
            : null;
          const lockedEventValue = snapshot
            ? snapshot.event
            : await state.readEvent(eventId);
          if (!(lockedEventValue !== null && lockedEventValue !== undefined)) {
            throw new HttpsError("not-found", "Event not found.");
          }
          let event = (0, documents_js_1.cloneEventDocument)(
            (0, documents_js_1.readEventDocument)(lockedEventValue),
          );
          const currentEvent = (0, documents_js_1.eventState)(event);
          const nowMs = getNowMs();
          let prizeSelections;
          if (
            (0, event_prizes_1.isEventPrizeEvent)(eventId) &&
            (currentEvent.status === "active" ||
              currentEvent.status === "ended" ||
              (currentEvent.status === "scheduled" &&
                typeof currentEvent.startAtMs === "number" &&
                nowMs >= currentEvent.startAtMs))
          ) {
            prizeSelections = { ...snapshot.prizeSelections };
          }
          const directParticipation = enforceParticipantGate
            ? (0, ownership_js_1.directRequesterParticipation)(
                event,
                requesterUid,
              )
            : null;
          const scheduledEventIsDue =
            currentEvent.status === "scheduled" &&
            typeof currentEvent.startAtMs === "number" &&
            nowMs >= currentEvent.startAtMs;
          const needsOwnershipSnapshot =
            currentEvent.status === "active" ||
            (scheduledEventIsDue &&
              (0, participants_js_1.getEventParticipantIds)(event).length >=
                2) ||
            (currentEvent.status === "ended" &&
              (0, event_prizes_1.isEventPrizeEvent)(eventId)) ||
            (enforceParticipantGate && !directParticipation?.isParticipant);
          const ownershipSnapshot = needsOwnershipSnapshot
            ? await loadOwnershipSnapshot(event, {
                loginUids: enforceParticipantGate ? [requesterUid] : [],
                profileIds: getPrizeSelectionProfileIds(prizeSelections),
              })
            : null;
          if (enforceParticipantGate) {
            const lockedRequesterParticipation = (0,
            ownership_js_1.resolveRequesterParticipation)(
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
          const updates = [];
          let didChange = false;
          let eventPrizeAssignmentsForProjectionCleanup = null;
          if ((0, documents_js_1.eventState)(event).status === "scheduled") {
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
            (0, documents_js_1.eventState)(event).status === "active" ||
            (0, documents_js_1.eventState)(event).status === "ended"
          ) {
            const transition = await (
              (0, documents_js_1.eventState)(event).status === "active"
                ? syncTransitions_js_1.buildActiveEventSyncPlan
                : syncTransitions_js_1.buildEndedEventSyncPlan
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
            await state.commitEventPlan(
              (0, eventCommands_js_1.mergeEventPlans)(updates),
            );
          }
          if (eventPrizeAssignmentsForProjectionCleanup) {
            if (!(await isEventLockStillOwned(lockHandle))) {
              throw new HttpsError(
                "aborted",
                "Event lock expired while projecting prizes.",
              );
            }
            const projectionResult =
              await reconcileProfileEventPrizeAssignments({
                event,
                eventId,
                assignments: eventPrizeAssignmentsForProjectionCleanup,
                ownershipSnapshot,
              });
            if (projectionResult.didChange) didChange = true;
          }
          const projectionCleanupRequest = (0,
          eventPrizeProjectionState_js_1.getCompletedEventPrizeProjectionCleanupRequest)(
            {
              eventId,
              eventStatus: (0, documents_js_1.eventState)(event).status,
              assignments: eventPrizeAssignmentsForProjectionCleanup,
            },
          );
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
        },
      );
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
  const syncEventState = async (request) => {
    const startedAtMs = getNowMs();
    const eventId = (0, requests_js_1.eventRequestId)(request.data);
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
exports.createEventRuntime = createEventRuntime;
