// Generated from src/events/syncTransitions.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildActiveEventSyncPlan = buildActiveEventSyncPlan;
exports.buildEndedEventSyncPlan = buildEndedEventSyncPlan;
const documents_js_1 = require("./documents.js");
const event_prizes_1 = require("@mons/shared/event-prizes");
const eventCommands_js_1 = require("../eventCommands.js");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const normalizeStringOrNull = (value) => normalizeString(value) || null;
async function resolveEventMatches(
  rounds,
  thirdPlaceMatch,
  nowMs,
  {
    getSortedRoundIndexes,
    resolveRoundMatchesWithConcurrency,
    resolveRoundMatchState,
    applyMatchResolution,
  },
) {
  let roundsChanged = false;
  let thirdPlaceMatchChanged = false;
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  for (const roundIndex of sortedRoundIndexes) {
    const round = (0, documents_js_1.eventRoundAt)(rounds, String(roundIndex));
    const matches = (0, documents_js_1.eventRoundMatches)(round);
    if (!matches) continue;
    const resolvedEntries = await resolveRoundMatchesWithConcurrency(matches);
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
    const resolvedThirdPlace = await resolveRoundMatchState(thirdPlaceMatch);
    if (
      resolvedThirdPlace &&
      applyMatchResolution(thirdPlaceMatch, resolvedThirdPlace, nowMs)
    ) {
      thirdPlaceMatchChanged = true;
    }
  }
  return { roundsChanged, thirdPlaceMatchChanged };
}
async function buildActiveEventSyncPlan(
  { eventId, event, nowMs, ownershipSnapshot, prizeSelections },
  dependencies,
) {
  const {
    hasThirdPlaceMatchField,
    reconcileBracketMatchReadiness,
    reconcileThirdPlaceMatchReadiness,
    recomputeRoundStatuses,
    isMatchResolved,
    rebuildParticipantStatesFromRounds,
    resolveEventPrizeAssignments,
    addEventPrizeAssignmentUpdates,
  } = dependencies;
  const updates = [];
  let didChange = false;
  let eventPrizeAssignmentsForProjectionCleanup = null;
  const normalizedOriginalCurrentRoundIndex = (0,
  documents_js_1.eventCurrentRoundIndex)(event, NaN);
  const originalCurrentRoundIndex = Number.isFinite(
    normalizedOriginalCurrentRoundIndex,
  )
    ? normalizedOriginalCurrentRoundIndex
    : null;
  const originalState = (0, documents_js_1.eventState)(event);
  const originalStatus = normalizeString(originalState.status) || "active";
  const originalEndedAtMs =
    typeof originalState.endedAtMs === "number"
      ? Math.floor(originalState.endedAtMs)
      : null;
  const originalWinnerProfileId = normalizeStringOrNull(
    (0, documents_js_1.eventState)(event).winnerProfileId,
  );
  const originalWinnerDisplayName = normalizeStringOrNull(
    (0, documents_js_1.eventState)(event).winnerDisplayName,
  );
  const rounds = (0, documents_js_1.cloneEventRounds)(
    (0, documents_js_1.eventRounds)(event) ||
      (0, documents_js_1.createEventRoundsDocument)(),
  );
  let participants = (0, documents_js_1.cloneEventParticipants)(
    (0, documents_js_1.eventParticipants)(event) ||
      (0, documents_js_1.createEventParticipantsDocument)(),
  );
  const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
  const storedThirdPlaceMatch = supportsThirdPlaceMatch
    ? (0, documents_js_1.eventThirdPlaceMatch)(event)
    : null;
  let thirdPlaceMatch = storedThirdPlaceMatch
    ? (0, documents_js_1.cloneEventMatch)(storedThirdPlaceMatch)
    : null;
  const inviteUpdates = [];
  let participantsChanged = false;
  let { roundsChanged, thirdPlaceMatchChanged } = await resolveEventMatches(
    rounds,
    thirdPlaceMatch,
    nowMs,
    dependencies,
  );
  if (
    await reconcileBracketMatchReadiness({
      eventId,
      rounds,
      nowMs,
      participantsById: participants,
      inviteUpdates,
      ownershipSnapshot,
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
      ownershipSnapshot,
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
  const winnerProfileId = normalizeString(finalRoundWinnerProfileId) || null;
  const nextCurrentRoundIndex =
    earliestUnresolvedRoundIndex !== null
      ? earliestUnresolvedRoundIndex
      : finalRoundIndex;
  (0, documents_js_1.patchEventDocument)(event, {
    currentRoundIndex: nextCurrentRoundIndex,
  });
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
      (winnerProfileId &&
        (0, documents_js_1.eventParticipantAt)(
          participants,
          winnerProfileId,
        )) ||
      null;
    (0, documents_js_1.patchEventDocument)(event, { status: "ended" });
    let endedAtMs = (0, documents_js_1.eventState)(event).endedAtMs;
    if (typeof endedAtMs !== "number") {
      endedAtMs = nowMs;
      (0, documents_js_1.patchEventDocument)(event, { endedAtMs });
    }
    (0, documents_js_1.patchEventDocument)(event, {
      winnerProfileId: winnerProfileId,
    });
    (0, documents_js_1.copyEventWinnerDisplayName)(event, winnerParticipant);
    if ((0, event_prizes_1.isEventPrizeEvent)(eventId)) {
      if (
        typeof (0, documents_js_1.eventState)(event)
          .prizeSelectionsLockedAtMs !== "number"
      ) {
        (0, documents_js_1.patchEventDocument)(event, {
          prizeSelectionsLockedAtMs: nowMs,
        });
        updates.push(
          (0, eventCommands_js_1.eventField)(
            eventId,
            "prizeSelectionsLockedAtMs",
            nowMs,
          ),
        );
      }
      const prizeAssignmentResult = await resolveEventPrizeAssignments({
        eventId,
        event,
        rounds,
        participantsById: participants,
        thirdPlaceMatch,
        assignedAtMs: endedAtMs,
        ownershipSnapshot,
        prizeSelections,
      });
      if (Object.keys(prizeAssignmentResult.assignments).length > 0) {
        eventPrizeAssignmentsForProjectionCleanup =
          prizeAssignmentResult.assignments;
        (0, documents_js_1.patchEventDocument)(event, {
          prizeAssignments: prizeAssignmentResult.assignments,
        });
        await addEventPrizeAssignmentUpdates({
          updates,
          eventId,
          assignments: prizeAssignmentResult.assignments,
          includeEventAssignments: true,
        });
      }
    }
  } else {
    (0, documents_js_1.patchEventDocument)(event, { status: "active" });
    (0, documents_js_1.patchEventDocument)(event, { endedAtMs: null });
    (0, documents_js_1.patchEventDocument)(event, { winnerProfileId: null });
    (0, documents_js_1.patchEventDocument)(event, { winnerDisplayName: null });
  }
  let eventChanged = false;
  const nextState = (0, documents_js_1.eventState)(event);
  const normalizedCurrentRoundIndex =
    typeof nextState.currentRoundIndex === "number"
      ? Math.floor(nextState.currentRoundIndex)
      : null;
  if (normalizedCurrentRoundIndex !== originalCurrentRoundIndex) {
    updates.push(
      (0, eventCommands_js_1.eventField)(
        eventId,
        "currentRoundIndex",
        normalizedCurrentRoundIndex,
      ),
    );
    eventChanged = true;
  }
  const normalizedStatus = eventShouldEnd ? "ended" : "active";
  if (normalizedStatus !== originalStatus) {
    updates.push(
      (0, eventCommands_js_1.eventField)(eventId, "status", normalizedStatus),
    );
    eventChanged = true;
  }
  const normalizedEndedAtMs =
    typeof nextState.endedAtMs === "number"
      ? Math.floor(nextState.endedAtMs)
      : null;
  if (normalizedEndedAtMs !== originalEndedAtMs) {
    updates.push(
      (0, eventCommands_js_1.eventField)(
        eventId,
        "endedAtMs",
        normalizedEndedAtMs,
      ),
    );
    eventChanged = true;
  }
  const normalizedWinnerProfileId = normalizeStringOrNull(
    (0, documents_js_1.eventState)(event).winnerProfileId,
  );
  if (normalizedWinnerProfileId !== originalWinnerProfileId) {
    updates.push(
      (0, eventCommands_js_1.eventField)(
        eventId,
        "winnerProfileId",
        normalizedWinnerProfileId,
      ),
    );
    eventChanged = true;
  }
  const normalizedWinnerDisplayName = normalizeStringOrNull(
    (0, documents_js_1.eventState)(event).winnerDisplayName,
  );
  if (normalizedWinnerDisplayName !== originalWinnerDisplayName) {
    updates.push(
      (0, eventCommands_js_1.eventField)(
        eventId,
        "winnerDisplayName",
        normalizedWinnerDisplayName,
      ),
    );
    eventChanged = true;
  }
  if (supportsThirdPlaceMatch && thirdPlaceMatchChanged) {
    updates.push(
      (0, eventCommands_js_1.eventField)(
        eventId,
        "thirdPlaceMatch",
        thirdPlaceMatch,
      ),
    );
    eventChanged = true;
  }
  if (roundsChanged) {
    updates.push((0, eventCommands_js_1.eventField)(eventId, "rounds", rounds));
  }
  if (participantsChanged) {
    updates.push(
      (0, eventCommands_js_1.eventField)(eventId, "participants", participants),
    );
  }
  if (inviteUpdates.length > 0) {
    updates.push(...inviteUpdates);
  }
  if (
    roundsChanged ||
    participantsChanged ||
    inviteUpdates.length > 0 ||
    eventChanged
  ) {
    updates.push(
      (0, eventCommands_js_1.eventField)(eventId, "updatedAtMs", nowMs),
    );
    didChange = true;
  }
  return {
    updates,
    didChange,
    eventForProjection: event,
    prizeAssignmentsForProjection: eventPrizeAssignmentsForProjectionCleanup,
  };
}
async function buildEndedEventSyncPlan(
  { eventId, event, nowMs, ownershipSnapshot, prizeSelections },
  dependencies,
) {
  const {
    hasThirdPlaceMatchField,
    reconcileThirdPlaceMatchReadiness,
    resolveEventPrizeAssignments,
    addEventPrizeAssignmentUpdates,
  } = dependencies;
  const updates = [];
  let didChange = false;
  let eventPrizeAssignmentsForProjectionCleanup = null;
  const rounds = (0, documents_js_1.cloneEventRounds)(
    (0, documents_js_1.eventRounds)(event) ||
      (0, documents_js_1.createEventRoundsDocument)(),
  );
  const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
  const storedThirdPlaceMatch = supportsThirdPlaceMatch
    ? (0, documents_js_1.eventThirdPlaceMatch)(event)
    : null;
  let thirdPlaceMatch = storedThirdPlaceMatch
    ? (0, documents_js_1.cloneEventMatch)(storedThirdPlaceMatch)
    : null;
  let prizeStateChanged = false;
  let { roundsChanged, thirdPlaceMatchChanged } = await resolveEventMatches(
    rounds,
    thirdPlaceMatch,
    nowMs,
    dependencies,
  );
  if (supportsThirdPlaceMatch) {
    const thirdPlaceResult = await reconcileThirdPlaceMatchReadiness({
      eventId,
      rounds,
      nowMs,
      participantsById:
        (0, documents_js_1.eventParticipants)(event) ||
        (0, documents_js_1.createEventParticipantsDocument)(),
      inviteUpdates: [],
      thirdPlaceMatch,
      allowInviteCreation: false,
    });
    thirdPlaceMatch = thirdPlaceResult.thirdPlaceMatch;
    if (thirdPlaceResult.didChange) {
      thirdPlaceMatchChanged = true;
    }
  }
  if ((0, event_prizes_1.isEventPrizeEvent)(eventId)) {
    const state = (0, documents_js_1.eventState)(event);
    if (typeof state.prizeSelectionsLockedAtMs !== "number") {
      updates.push(
        (0, eventCommands_js_1.eventField)(
          eventId,
          "prizeSelectionsLockedAtMs",
          typeof state.endedAtMs === "number" ? state.endedAtMs : nowMs,
        ),
      );
      prizeStateChanged = true;
    }
    const prizeAssignmentResult = await resolveEventPrizeAssignments({
      eventId,
      event,
      rounds,
      participantsById:
        (0, documents_js_1.eventParticipants)(event) ||
        (0, documents_js_1.createEventParticipantsDocument)(),
      thirdPlaceMatch,
      assignedAtMs:
        typeof state.endedAtMs === "number" ? state.endedAtMs : nowMs,
      ownershipSnapshot,
      prizeSelections,
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
    updates.push((0, eventCommands_js_1.eventField)(eventId, "rounds", rounds));
    if (supportsThirdPlaceMatch) {
      updates.push(
        (0, eventCommands_js_1.eventField)(
          eventId,
          "thirdPlaceMatch",
          thirdPlaceMatch,
        ),
      );
    }
  }
  if (roundsChanged || thirdPlaceMatchChanged || prizeStateChanged) {
    updates.push(
      (0, eventCommands_js_1.eventField)(eventId, "updatedAtMs", nowMs),
    );
    didChange = true;
  }
  return {
    updates,
    didChange,
    eventForProjection: event,
    prizeAssignmentsForProjection: eventPrizeAssignmentsForProjectionCleanup,
  };
}
