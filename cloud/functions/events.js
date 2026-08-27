const { getDisplayNameFromAddress } = require("./telegramDisplay");
const { isEventPrizeEvent } = require("@mons/shared/event-prizes");
const {
  getCompletedEventPrizeProjectionCleanupRequest,
} = require("./eventPrizeProjectionState");
const {
  INVITE_ID_RANDOM_LENGTH,
  randomAlphanumeric,
} = require("@mons/shared/ids");
const {
  EVENT_POSTPONE_OPTIONS_MINUTES,
  EVENT_SCHEMA_VERSION,
  MAX_STARTS_IN_MINUTES,
  MIN_STARTS_IN_MINUTES,
  THIRD_PLACE_MATCH_KEY,
  isMonsLinkAdmin,
  parseEventMatchKey: parseMatchKey,
} = require("@mons/shared/events");
const { createEventBracketRuntime } = require("./events/bracket");
const { getEventParticipantIds } = require("./events/participants");
const {
  assertScheduledStartWindow,
  hasDateTimeScheduleRequest,
  resolveScheduledDateTimeStartAtMs,
} = require("./events/scheduling");

class EventRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const createEventRuntime = (dependencies) => {
  const admin = dependencies.admin;
  const getProfileByLoginId = dependencies.getProfileByLoginId;
  const enqueueEventProgressTask = dependencies.enqueueEventProgressTask;
  const resolveProfileEventPrizeOwnerId =
    dependencies.resolveProfileEventPrizeOwnerId;
  const readEventPrizeWithdrawals = dependencies.readEventPrizeWithdrawals;
  const {
    acquireEventLockWithRetry,
    isEventLockStillOwned,
    releaseEventLock,
    startEventLockHeartbeat,
  } = dependencies.eventLockManager;
  const {
    addEventPrizeAssignmentUpdates,
    applyMatchResolution,
    buildScheduledEventDueUpdates,
    getSortedRoundIndexes,
    hasThirdPlaceMatchField,
    isMatchResolved,
    isMatchWinnerDisqualified,
    rebuildParticipantStatesFromRounds,
    recomputeRoundStatuses,
    reconcileBracketMatchReadiness,
    reconcileProfileEventPrizeAssignments,
    reconcileThirdPlaceMatchReadiness,
    removeCompletedEventPrizeProjections,
    resolveEventPrizeAssignments,
    resolveRoundMatchState,
    resolveRoundMatchesWithConcurrency,
  } = createEventBracketRuntime({
    admin,
    readEventPrizeWithdrawals,
    resolveProfileEventPrizeOwnerId,
  });
  const HttpsError = EventRuntimeError;
  const EVENT_SYNC_THROTTLE_WINDOW_MS = 500;

  const normalizeString = (value) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : "";
  const normalizeStringOrNull = (value) => normalizeString(value) || null;
  const normalizeUsername = (value) => normalizeString(value).toLowerCase();
  const getNowMs = dependencies.now || Date.now;
  const sleep = dependencies.sleep;

  const toFiniteInteger = (value, fallback = 0) => {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.floor(numeric);
  };

  const cloneValue = (value) => JSON.parse(JSON.stringify(value));

  const buildEventDisplayName = (profile) => {
    return getDisplayNameFromAddress(
      profile.username ?? "",
      profile.eth ?? "",
      profile.sol ?? "",
      0,
      profile.emoji ?? "",
      false,
    );
  };

  const generateEventId = () =>
    randomAlphanumeric(INVITE_ID_RANDOM_LENGTH, dependencies.random);

  const resolveRequesterParticipation = (event, auth) => {
    const participants =
      event && event.participants && typeof event.participants === "object"
        ? event.participants
        : {};
    const requesterUid = normalizeString(auth && auth.uid);
    const claimedProfileId = normalizeString(
      auth && auth.token ? auth.token.profileId : "",
    );
    if (
      claimedProfileId &&
      participants[claimedProfileId] &&
      typeof participants[claimedProfileId] === "object"
    ) {
      return {
        isParticipant: true,
        profileId: claimedProfileId,
      };
    }
    for (const [profileId, participant] of Object.entries(participants)) {
      if (!participant || typeof participant !== "object") {
        continue;
      }
      if (
        claimedProfileId &&
        normalizeString(participant.profileId) === claimedProfileId
      ) {
        return {
          isParticipant: true,
          profileId,
        };
      }
      if (normalizeString(participant.loginUid) === requesterUid) {
        return {
          isParticipant: true,
          profileId,
        };
      }
    }
    if (normalizeString(event && event.createdByLoginUid) === requesterUid) {
      return {
        isParticipant: true,
        profileId: normalizeString(event && event.createdByProfileId) || null,
      };
    }
    return {
      isParticipant: false,
      profileId: null,
    };
  };

  const buildParticipantSnapshot = (profile, loginUid, joinedAtMs) => {
    const username = normalizeString(profile.username);
    const profileId = normalizeString(profile.profileId);
    return {
      profileId,
      loginUid,
      username,
      displayName: buildEventDisplayName(profile),
      emojiId:
        typeof profile.emoji === "number"
          ? Math.floor(profile.emoji)
          : Number(profile.emoji) || 0,
      aura: normalizeString(profile.aura),
      joinedAtMs,
      state: "active",
      eliminatedRoundIndex: null,
      eliminatedByProfileId: null,
    };
  };

  const ensurePilotEventCreator = async (uid) => {
    const profile = await getProfileByLoginId(uid);
    const username = normalizeUsername(profile.username);
    const profileId = normalizeString(profile.profileId);
    if (!profileId) {
      throw new HttpsError(
        "failed-precondition",
        "Event creation requires a signed-in profile.",
      );
    }
    if (!isMonsLinkAdmin(username)) {
      throw new HttpsError(
        "permission-denied",
        "Only approved pilot users can create pilot events.",
      );
    }
    return profile;
  };

  const ensureNonAnonProfile = async (uid) => {
    const profile = await getProfileByLoginId(uid);
    const profileId = normalizeString(profile.profileId);
    if (!profileId) {
      throw new HttpsError(
        "failed-precondition",
        "Please sign in to join this event.",
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
    announceOnTelegram,
  }) => {
    const creatorParticipant = buildParticipantSnapshot(
      creatorProfile,
      creatorUid,
      createdAtMs,
    );
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId,
      status: "scheduled",
      createdAtMs,
      updatedAtMs: createdAtMs,
      startAtMs,
      announceOnTelegram: announceOnTelegram === true,
      ...(announceOnTelegram === true ? { telegramDeliveryVersion: 2 } : {}),
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
      participants: {
        [creatorParticipant.profileId]: creatorParticipant,
      },
      rounds: {},
    };
  };

  const tryAcquireEventSyncThrottle = async (eventId, ownerUid) => {
    const throttleRef = admin.database().ref(`eventSyncThrottles/${eventId}`);
    const nowMs = getNowMs();
    const token = crypto.randomUUID();
    const result = await throttleRef.transaction((current) => {
      const lastStartedAtMs =
        current && typeof current.startedAtMs === "number"
          ? Math.floor(current.startedAtMs)
          : 0;
      if (
        lastStartedAtMs > 0 &&
        nowMs - lastStartedAtMs < EVENT_SYNC_THROTTLE_WINDOW_MS
      ) {
        return;
      }
      return {
        startedAtMs: nowMs,
        ownerUid,
        token,
      };
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

    const creatorProfile = await ensurePilotEventCreator(request.auth.uid);
    const createdAtMs = getNowMs();
    const requestData =
      request.data && typeof request.data === "object" ? request.data : {};
    const announceOnTelegram = requestData.announceOnTelegram === true;
    let startAtMs = 0;

    if (hasDateTimeScheduleRequest(requestData)) {
      startAtMs = resolveScheduledDateTimeStartAtMs(requestData, createdAtMs);
      assertScheduledStartWindow(startAtMs, createdAtMs);
    } else {
      const rawStartsInMinutes = toFiniteInteger(
        requestData.startsInMinutes,
        0,
      );
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
      announceOnTelegram,
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

    await admin
      .database()
      .ref()
      .update({
        [`events/${eventId}`]: event,
        [`eventProgressOutbox/${progress.outboxId}`]: progress.outbox,
      });

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

    const eventId = normalizeString(request.data && request.data.eventId);
    if (!eventId) {
      throw new HttpsError("invalid-argument", "eventId is required.");
    }
    const postponeByMinutes = toFiniteInteger(
      request.data && request.data.postponeByMinutes,
      0,
    );
    if (!EVENT_POSTPONE_OPTIONS_MINUTES.includes(postponeByMinutes)) {
      throw new HttpsError(
        "invalid-argument",
        "postponeByMinutes must be one of: 5, 10, 15.",
      );
    }

    const profile = await ensureNonAnonProfile(request.auth.uid);
    const profileId = normalizeString(profile.profileId);
    const lockHandle = await acquireEventLockWithRetry(
      eventId,
      request.auth.uid,
      {
        attempts: 40,
        delayMs: 100,
      },
    );
    if (!lockHandle) {
      throw new HttpsError(
        "unavailable",
        "Event is busy. Please try postponing again.",
      );
    }
    const stopLockHeartbeat = startEventLockHeartbeat(lockHandle);

    try {
      const eventSnapshot = await admin
        .database()
        .ref(`events/${eventId}`)
        .once("value");
      if (!eventSnapshot.exists()) {
        throw new HttpsError("not-found", "Event not found.");
      }
      const event = cloneValue(eventSnapshot.val() || {});
      const creatorLoginUid = normalizeString(event.createdByLoginUid);
      const creatorProfileId = normalizeString(event.createdByProfileId);
      if (
        request.auth.uid !== creatorLoginUid &&
        profileId !== creatorProfileId
      ) {
        throw new HttpsError(
          "permission-denied",
          "Only the event creator can postpone this event.",
        );
      }
      if (normalizeString(event.status) !== "scheduled") {
        throw new HttpsError(
          "failed-precondition",
          "Only scheduled events can be postponed.",
        );
      }

      const nowMs = getNowMs();
      if (
        typeof event.startAtMs !== "number" ||
        !Number.isFinite(event.startAtMs)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "This event cannot be postponed right now.",
        );
      }
      if (nowMs >= event.startAtMs) {
        const dueTransition = await buildScheduledEventDueUpdates({
          eventId,
          event,
          nowMs,
        });
        if (dueTransition.didChange) {
          await admin.database().ref().update(dueTransition.updates);
        }
        throw new HttpsError(
          "failed-precondition",
          "This event can no longer be postponed.",
        );
      }

      const nextStartAtMs =
        Math.floor(event.startAtMs) + postponeByMinutes * 60 * 1000;
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

      event.startAtMs = nextStartAtMs;
      event.updatedAtMs = nowMs;
      await admin
        .database()
        .ref()
        .update({
          [`events/${eventId}/startAtMs`]: nextStartAtMs,
          [`events/${eventId}/updatedAtMs`]: nowMs,
          [`eventProgressOutbox/${progress.outboxId}`]: progress.outbox,
        });

      return {
        ok: true,
        eventId,
        event,
        postponeByMinutes,
        startAtMs: nextStartAtMs,
      };
    } finally {
      stopLockHeartbeat();
      await releaseEventLock(lockHandle);
    }
  };

  const disqualifyEventMatchWinners = async (request) => {
    const startedAtMs = getNowMs();
    const eventId = normalizeString(request.data && request.data.eventId);
    const matchKeyInput = normalizeString(
      request.data && request.data.matchKey,
    );
    const syncLog = createSyncLog({
      eventId: eventId || null,
      requesterUid: request && request.auth ? request.auth.uid : null,
      mode: "callable-disqualify",
    });
    syncLog.targetMatchKey = matchKeyInput || null;
    let lockHandle = null;
    let stopLockHeartbeat = () => {};

    try {
      if (!request.auth) {
        throw new HttpsError(
          "unauthenticated",
          "The function must be called while authenticated.",
        );
      }
      await ensurePilotEventCreator(request.auth.uid);

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

      lockHandle = await acquireEventLockWithRetry(eventId, request.auth.uid, {
        attempts: 40,
        delayMs: 100,
      });
      if (!lockHandle) {
        throw new HttpsError(
          "unavailable",
          "Event is busy. Please try disqualifying again.",
        );
      }
      stopLockHeartbeat = startEventLockHeartbeat(lockHandle);

      let didDisqualify = false;
      let resolvedMatchKey = matchKeyInput;
      try {
        const eventSnapshot = await admin
          .database()
          .ref(`events/${eventId}`)
          .once("value");
        if (!eventSnapshot.exists()) {
          throw new HttpsError("not-found", "Event not found.");
        }
        const event = cloneValue(eventSnapshot.val() || {});
        if (normalizeString(event.status) !== "active") {
          throw new HttpsError(
            "failed-precondition",
            "Only active events can be updated.",
          );
        }

        let targetMatch = null;
        let targetMatchUpdatePath = "";
        if (isThirdPlaceTarget) {
          const thirdPlaceMatchCandidate = event.thirdPlaceMatch;
          if (
            thirdPlaceMatchCandidate &&
            typeof thirdPlaceMatchCandidate === "object"
          ) {
            targetMatch = thirdPlaceMatchCandidate;
            resolvedMatchKey = THIRD_PLACE_MATCH_KEY;
            targetMatchUpdatePath = `events/${eventId}/thirdPlaceMatch/winnerDisqualified`;
          }
        } else {
          const round =
            event.rounds && typeof event.rounds === "object"
              ? event.rounds[String(parsedMatchKey.roundIndex)]
              : null;
          if (!round || !round.matches || typeof round.matches !== "object") {
            throw new HttpsError(
              "failed-precondition",
              "Selected match not found.",
            );
          }

          targetMatch = round.matches[resolvedMatchKey];
          if (!targetMatch || typeof targetMatch !== "object") {
            const fallbackEntry =
              Object.entries(round.matches).find(([candidateMatchKey]) => {
                const parsedCandidate = parseMatchKey(candidateMatchKey);
                return (
                  parsedCandidate?.matchIndex === parsedMatchKey.matchIndex
                );
              }) || null;
            if (fallbackEntry) {
              [resolvedMatchKey, targetMatch] = fallbackEntry;
            }
          }
          targetMatchUpdatePath = `events/${eventId}/rounds/${parsedMatchKey.roundIndex}/matches/${resolvedMatchKey}/winnerDisqualified`;
        }

        if (!targetMatch || typeof targetMatch !== "object") {
          throw new HttpsError(
            "failed-precondition",
            "Selected match not found.",
          );
        }

        if (
          normalizeString(targetMatch.status) !== "pending" ||
          !normalizeString(targetMatch.inviteId)
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Only active matches can be disqualified.",
          );
        }
        if (
          !normalizeString(targetMatch.hostProfileId) ||
          !normalizeString(targetMatch.guestProfileId)
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Selected match must have two participants.",
          );
        }

        didDisqualify = !isMatchWinnerDisqualified(targetMatch);
        if (didDisqualify) {
          const lockOwned = await isEventLockStillOwned(lockHandle);
          if (!lockOwned) {
            throw new HttpsError(
              "unavailable",
              "Event is busy. Please try disqualifying again.",
            );
          }
          await admin
            .database()
            .ref()
            .update({
              [targetMatchUpdatePath]: true,
              [`events/${eventId}/updatedAtMs`]: getNowMs(),
            });
        }
      } finally {
        stopLockHeartbeat();
        stopLockHeartbeat = () => {};
        await releaseEventLock(lockHandle);
        lockHandle = null;
      }

      let syncResult = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        syncLog.skipped = false;
        syncLog.reason = null;
        syncResult = await runEventSyncState({
          eventId,
          requesterUid: request.auth.uid,
          auth: request.auth,
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
        didDisqualify,
        matchKey: resolvedMatchKey,
      };
    } finally {
      stopLockHeartbeat();
      if (lockHandle) {
        await releaseEventLock(lockHandle);
      }
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
    auth,
    enforceParticipantGate,
    enforceThrottle,
    syncLog,
  }) => {
    let lockHandle = null;
    let stopLockHeartbeat = () => {};

    try {
      const eventSnapshot = await admin
        .database()
        .ref(`events/${eventId}`)
        .once("value");
      if (!eventSnapshot.exists()) {
        throw new HttpsError("not-found", "Event not found.");
      }
      const initialEvent = cloneValue(eventSnapshot.val() || {});

      if (enforceParticipantGate) {
        const requesterParticipation = resolveRequesterParticipation(
          initialEvent,
          auth,
        );
        syncLog.requesterProfileId = requesterParticipation.profileId;
        if (!requesterParticipation.isParticipant) {
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

      lockHandle = await acquireEventLockWithRetry(eventId, requesterUid, {
        attempts: 10,
        delayMs: 100,
      });
      if (!lockHandle) {
        syncLog.skipped = true;
        syncLog.reason = "locked";
        return buildSkippedSyncResponse({
          eventId,
          reason: "locked",
        });
      }
      stopLockHeartbeat = startEventLockHeartbeat(lockHandle);

      const lockedEventSnapshot = await admin
        .database()
        .ref(`events/${eventId}`)
        .once("value");
      if (!lockedEventSnapshot.exists()) {
        throw new HttpsError("not-found", "Event not found.");
      }
      const event = cloneValue(lockedEventSnapshot.val() || {});
      if (enforceParticipantGate) {
        const lockedRequesterParticipation = resolveRequesterParticipation(
          event,
          auth,
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
      const nowMs = getNowMs();
      const updates = {};
      let didChange = false;
      let eventPrizeAssignmentsForProjectionCleanup = null;

      if (event.status === "scheduled") {
        const dueTransition = await buildScheduledEventDueUpdates({
          eventId,
          event,
          nowMs,
        });
        Object.assign(updates, dueTransition.updates);
        didChange = dueTransition.didChange;
      } else if (event.status === "active") {
        const normalizedOriginalCurrentRoundIndex = toFiniteInteger(
          event.currentRoundIndex,
          NaN,
        );
        const originalCurrentRoundIndex = Number.isFinite(
          normalizedOriginalCurrentRoundIndex,
        )
          ? normalizedOriginalCurrentRoundIndex
          : null;
        const originalStatus = normalizeString(event.status) || "active";
        const originalEndedAtMs =
          typeof event.endedAtMs === "number"
            ? Math.floor(event.endedAtMs)
            : null;
        const originalWinnerProfileId = normalizeStringOrNull(
          event.winnerProfileId,
        );
        const originalWinnerDisplayName = normalizeStringOrNull(
          event.winnerDisplayName,
        );
        const rounds = cloneValue(
          event.rounds && typeof event.rounds === "object" ? event.rounds : {},
        );
        let participants = cloneValue(
          event.participants && typeof event.participants === "object"
            ? event.participants
            : {},
        );
        const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
        let thirdPlaceMatch =
          supportsThirdPlaceMatch &&
          event.thirdPlaceMatch &&
          typeof event.thirdPlaceMatch === "object"
            ? cloneValue(event.thirdPlaceMatch)
            : null;
        const inviteUpdates = {};
        let roundsChanged = false;
        let participantsChanged = false;
        let thirdPlaceMatchChanged = false;
        const sortedRoundIndexes = getSortedRoundIndexes(rounds);
        for (const roundIndex of sortedRoundIndexes) {
          const round = rounds[String(roundIndex)];
          if (!round || !round.matches || typeof round.matches !== "object") {
            continue;
          }
          const resolvedEntries = await resolveRoundMatchesWithConcurrency(
            round.matches,
          );
          for (const entry of resolvedEntries) {
            const { matchRecord, resolved } = entry;
            if (!resolved) {
              continue;
            }
            if (applyMatchResolution(matchRecord, resolved, nowMs)) {
              roundsChanged = true;
            }
          }
        }

        if (thirdPlaceMatch) {
          const resolvedThirdPlace =
            await resolveRoundMatchState(thirdPlaceMatch);
          if (
            resolvedThirdPlace &&
            applyMatchResolution(thirdPlaceMatch, resolvedThirdPlace, nowMs)
          ) {
            thirdPlaceMatchChanged = true;
          }
        }

        if (
          await reconcileBracketMatchReadiness({
            eventId,
            rounds,
            nowMs,
            participantsById: participants,
            inviteUpdates,
          })
        ) {
          roundsChanged = true;
        }

        if (supportsThirdPlaceMatch) {
          const thirdPlaceResult = await reconcileThirdPlaceMatchReadiness({
            eventId,
            rounds,
            nowMs,
            participantsById: participants,
            inviteUpdates,
            thirdPlaceMatch,
          });
          thirdPlaceMatch = thirdPlaceResult.thirdPlaceMatch;
          if (thirdPlaceResult.didChange) {
            thirdPlaceMatchChanged = true;
          }
        }

        const {
          didChange: roundStatusChanged,
          finalRoundIndex,
          earliestUnresolvedRoundIndex,
          finalRoundWinnerProfileId,
        } = recomputeRoundStatuses({
          rounds,
          nowMs,
        });
        if (roundStatusChanged) {
          roundsChanged = true;
        }

        const finalRoundCompleted =
          finalRoundIndex !== null && earliestUnresolvedRoundIndex === null;
        const thirdPlaceResolved =
          !supportsThirdPlaceMatch ||
          !thirdPlaceMatch ||
          isMatchResolved(thirdPlaceMatch);
        const eventShouldEnd = finalRoundCompleted && thirdPlaceResolved;
        const winnerProfileId =
          normalizeString(finalRoundWinnerProfileId) || null;
        const nextCurrentRoundIndex =
          earliestUnresolvedRoundIndex !== null
            ? earliestUnresolvedRoundIndex
            : finalRoundIndex;
        event.currentRoundIndex = nextCurrentRoundIndex;

        const participantStateResult = rebuildParticipantStatesFromRounds({
          participantsById: participants,
          rounds,
          winnerProfileId,
          eventEnded: eventShouldEnd,
        });
        if (participantStateResult.didChange) {
          participants = participantStateResult.participantsById;
          participantsChanged = true;
        }

        if (eventShouldEnd) {
          const winnerParticipant =
            (winnerProfileId && participants[winnerProfileId]) || null;
          event.status = "ended";
          if (typeof event.endedAtMs !== "number") {
            event.endedAtMs = nowMs;
          }
          event.winnerProfileId = winnerProfileId;
          event.winnerDisplayName = winnerParticipant
            ? winnerParticipant.displayName
            : null;
          if (isEventPrizeEvent(eventId)) {
            if (typeof event.prizeSelectionsLockedAtMs !== "number") {
              const lockOwned = await isEventLockStillOwned(lockHandle);
              if (!lockOwned) {
                throw new HttpsError(
                  "aborted",
                  "Event lock expired while assigning prizes.",
                );
              }
              event.prizeSelectionsLockedAtMs = nowMs;
              await admin
                .database()
                .ref(`events/${eventId}/prizeSelectionsLockedAtMs`)
                .set(nowMs);
            }
            const prizeAssignmentResult = await resolveEventPrizeAssignments({
              eventId,
              event,
              rounds,
              participantsById: participants,
              thirdPlaceMatch,
              assignedAtMs: event.endedAtMs,
            });
            if (Object.keys(prizeAssignmentResult.assignments).length > 0) {
              eventPrizeAssignmentsForProjectionCleanup =
                prizeAssignmentResult.assignments;
              event.prizeAssignments = prizeAssignmentResult.assignments;
              await addEventPrizeAssignmentUpdates({
                updates,
                eventId,
                assignments: prizeAssignmentResult.assignments,
                includeEventAssignments: true,
              });
            }
          }
        } else {
          event.status = "active";
          event.endedAtMs = null;
          event.winnerProfileId = null;
          event.winnerDisplayName = null;
        }

        let eventChanged = false;
        const normalizedCurrentRoundIndex =
          typeof event.currentRoundIndex === "number"
            ? Math.floor(event.currentRoundIndex)
            : null;
        if (normalizedCurrentRoundIndex !== originalCurrentRoundIndex) {
          updates[`events/${eventId}/currentRoundIndex`] =
            normalizedCurrentRoundIndex;
          eventChanged = true;
        }

        const normalizedStatus = normalizeString(event.status) || "active";
        if (normalizedStatus !== originalStatus) {
          updates[`events/${eventId}/status`] = normalizedStatus;
          eventChanged = true;
        }

        const normalizedEndedAtMs =
          typeof event.endedAtMs === "number"
            ? Math.floor(event.endedAtMs)
            : null;
        if (normalizedEndedAtMs !== originalEndedAtMs) {
          updates[`events/${eventId}/endedAtMs`] = normalizedEndedAtMs;
          eventChanged = true;
        }

        const normalizedWinnerProfileId = normalizeStringOrNull(
          event.winnerProfileId,
        );
        if (normalizedWinnerProfileId !== originalWinnerProfileId) {
          updates[`events/${eventId}/winnerProfileId`] =
            normalizedWinnerProfileId;
          eventChanged = true;
        }

        const normalizedWinnerDisplayName = normalizeStringOrNull(
          event.winnerDisplayName,
        );
        if (normalizedWinnerDisplayName !== originalWinnerDisplayName) {
          updates[`events/${eventId}/winnerDisplayName`] =
            normalizedWinnerDisplayName;
          eventChanged = true;
        }
        if (supportsThirdPlaceMatch && thirdPlaceMatchChanged) {
          updates[`events/${eventId}/thirdPlaceMatch`] = thirdPlaceMatch;
          eventChanged = true;
        }

        if (roundsChanged) {
          updates[`events/${eventId}/rounds`] = rounds;
        }
        if (participantsChanged) {
          updates[`events/${eventId}/participants`] = participants;
        }
        if (Object.keys(inviteUpdates).length > 0) {
          Object.assign(updates, inviteUpdates);
        }
        if (
          roundsChanged ||
          participantsChanged ||
          Object.keys(inviteUpdates).length > 0 ||
          eventChanged
        ) {
          updates[`events/${eventId}/updatedAtMs`] = nowMs;
          didChange = true;
        }
      } else if (event.status === "ended") {
        const rounds = cloneValue(
          event.rounds && typeof event.rounds === "object" ? event.rounds : {},
        );
        const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
        let thirdPlaceMatch =
          supportsThirdPlaceMatch &&
          event.thirdPlaceMatch &&
          typeof event.thirdPlaceMatch === "object"
            ? cloneValue(event.thirdPlaceMatch)
            : null;
        let roundsChanged = false;
        let thirdPlaceMatchChanged = false;
        let prizeStateChanged = false;
        const sortedRoundIndexes = getSortedRoundIndexes(rounds);
        for (const roundIndex of sortedRoundIndexes) {
          const round = rounds[String(roundIndex)];
          if (!round || !round.matches || typeof round.matches !== "object") {
            continue;
          }
          const resolvedEntries = await resolveRoundMatchesWithConcurrency(
            round.matches,
          );
          for (const entry of resolvedEntries) {
            const { matchRecord, resolved } = entry;
            if (!resolved) {
              continue;
            }
            if (applyMatchResolution(matchRecord, resolved, nowMs)) {
              roundsChanged = true;
            }
          }
        }

        if (thirdPlaceMatch) {
          const resolvedThirdPlace =
            await resolveRoundMatchState(thirdPlaceMatch);
          if (
            resolvedThirdPlace &&
            applyMatchResolution(thirdPlaceMatch, resolvedThirdPlace, nowMs)
          ) {
            thirdPlaceMatchChanged = true;
          }
        }

        if (supportsThirdPlaceMatch) {
          const thirdPlaceResult = await reconcileThirdPlaceMatchReadiness({
            eventId,
            rounds,
            nowMs,
            participantsById:
              event.participants && typeof event.participants === "object"
                ? event.participants
                : {},
            inviteUpdates: {},
            thirdPlaceMatch,
            allowInviteCreation: false,
          });
          thirdPlaceMatch = thirdPlaceResult.thirdPlaceMatch;
          if (thirdPlaceResult.didChange) {
            thirdPlaceMatchChanged = true;
          }
        }

        if (isEventPrizeEvent(eventId)) {
          if (typeof event.prizeSelectionsLockedAtMs !== "number") {
            updates[`events/${eventId}/prizeSelectionsLockedAtMs`] =
              typeof event.endedAtMs === "number" ? event.endedAtMs : nowMs;
            prizeStateChanged = true;
          }
          const prizeAssignmentResult = await resolveEventPrizeAssignments({
            eventId,
            event,
            rounds,
            participantsById:
              event.participants && typeof event.participants === "object"
                ? event.participants
                : {},
            thirdPlaceMatch,
            assignedAtMs:
              typeof event.endedAtMs === "number" ? event.endedAtMs : nowMs,
          });
          if (Object.keys(prizeAssignmentResult.assignments).length > 0) {
            eventPrizeAssignmentsForProjectionCleanup =
              prizeAssignmentResult.assignments;
            if (prizeAssignmentResult.didCreate) {
              await addEventPrizeAssignmentUpdates({
                updates,
                eventId,
                assignments: prizeAssignmentResult.assignments,
                includeEventAssignments: true,
              });
              prizeStateChanged = true;
            }
          }
        }

        if (roundsChanged || thirdPlaceMatchChanged) {
          updates[`events/${eventId}/rounds`] = rounds;
          if (supportsThirdPlaceMatch) {
            updates[`events/${eventId}/thirdPlaceMatch`] = thirdPlaceMatch;
          }
        }
        if (roundsChanged || thirdPlaceMatchChanged || prizeStateChanged) {
          updates[`events/${eventId}/updatedAtMs`] = nowMs;
          didChange = true;
        }
      }

      if (didChange) {
        const lockOwned = await isEventLockStillOwned(lockHandle);
        if (!lockOwned) {
          const latestSnapshot = await admin
            .database()
            .ref(`events/${eventId}`)
            .once("value");
          syncLog.skipped = true;
          syncLog.reason = "locked";
          return buildSkippedSyncResponse({
            eventId,
            reason: "locked",
            event: latestSnapshot.val(),
          });
        }
        await admin.database().ref().update(updates);
      }
      if (eventPrizeAssignmentsForProjectionCleanup) {
        let projectionSettled = false;
        for (let attempt = 0; attempt <= 3; attempt += 1) {
          if (!(await isEventLockStillOwned(lockHandle))) {
            break;
          }
          const projectionResult = await reconcileProfileEventPrizeAssignments({
            eventId,
            assignments: eventPrizeAssignmentsForProjectionCleanup,
          });
          if (projectionResult.didChange) {
            didChange = true;
          }
          if (projectionResult.settled) {
            projectionSettled = true;
            break;
          }
        }
        if (!projectionSettled) {
          throw new HttpsError(
            "aborted",
            "Event prize ownership changed during projection.",
          );
        }
      }
      const projectionCleanupRequest =
        getCompletedEventPrizeProjectionCleanupRequest({
          eventId,
          eventStatus: event.status,
          assignments: eventPrizeAssignmentsForProjectionCleanup,
        });
      if (projectionCleanupRequest) {
        await removeCompletedEventPrizeProjections(projectionCleanupRequest);
      }

      const refreshedSnapshot = await admin
        .database()
        .ref(`events/${eventId}`)
        .once("value");
      syncLog.didChange = didChange;
      return {
        ok: true,
        eventId,
        didChange,
        event: refreshedSnapshot.val(),
      };
    } catch (error) {
      if (!syncLog.reason) {
        syncLog.reason =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "error";
      }
      throw error;
    } finally {
      if (lockHandle) {
        stopLockHeartbeat();
        await releaseEventLock(lockHandle);
      }
    }
  };

  const syncEventState = async (request) => {
    const startedAtMs = getNowMs();
    const eventId = normalizeString(request.data && request.data.eventId);
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
        auth: request.auth,
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

module.exports = {
  createEventRuntime,
  EventRuntimeError,
};
