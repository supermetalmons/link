import {
  eventState,
  eventRounds,
  eventParticipants,
  eventThirdPlaceMatch,
  eventCurrentRoundIndex,
  eventRoundAt,
  eventRoundMatches,
  eventParticipantAt,
  createEventRoundsDocument,
  createEventParticipantsDocument,
  cloneEventRounds,
  cloneEventParticipants,
  cloneEventMatch,
  patchEventDocument,
  copyEventWinnerDisplayName,
} from "./documents.js";
import { isEventPrizeEvent } from "@mons/shared/event-prizes";
import { eventField, type EventCommitPlan } from "../eventCommands.js";
import type { EventPrizeAssignmentRecord } from "../eventReads.js";
import type { EventBracketRuntime } from "./bracket.js";
import type { EventData, EventMatch, EventRounds } from "./model.js";
import type { EventOwnershipSnapshot } from "./ownership.js";

type EventSyncPlanInput = {
  eventId: string;
  event: EventData;
  nowMs: number;
  ownershipSnapshot: EventOwnershipSnapshot | null;
  prizeSelections?: Record<string, string> | null;
};

type EventSyncPlan = {
  updates: EventCommitPlan;
  didChange: boolean;
  eventForProjection: EventData;
  prizeAssignmentsForProjection: Record<
    string,
    EventPrizeAssignmentRecord
  > | null;
};

type EventSyncPlanningDependencies = Pick<
  EventBracketRuntime,
  | "addEventPrizeAssignmentUpdates"
  | "applyMatchResolution"
  | "getSortedRoundIndexes"
  | "hasThirdPlaceMatchField"
  | "isMatchResolved"
  | "rebuildParticipantStatesFromRounds"
  | "recomputeRoundStatuses"
  | "reconcileBracketMatchReadiness"
  | "reconcileThirdPlaceMatchReadiness"
  | "resolveEventPrizeAssignments"
  | "resolveRoundMatchState"
  | "resolveRoundMatchesWithConcurrency"
>;

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const normalizeStringOrNull = (value: unknown) =>
  normalizeString(value) || null;

async function resolveEventMatches(
  rounds: EventRounds,
  thirdPlaceMatch: EventMatch | null,
  nowMs: number,
  {
    getSortedRoundIndexes,
    resolveRoundMatchesWithConcurrency,
    resolveRoundMatchState,
    applyMatchResolution,
  }: EventSyncPlanningDependencies,
): Promise<{ roundsChanged: boolean; thirdPlaceMatchChanged: boolean }> {
  let roundsChanged = false;
  let thirdPlaceMatchChanged = false;
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  for (const roundIndex of sortedRoundIndexes) {
    const round = eventRoundAt(rounds, String(roundIndex));
    const matches = eventRoundMatches(round);
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

export async function buildActiveEventSyncPlan(
  {
    eventId,
    event,
    nowMs,
    ownershipSnapshot,
    prizeSelections,
  }: EventSyncPlanInput,
  dependencies: EventSyncPlanningDependencies,
): Promise<EventSyncPlan> {
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
  const updates: EventCommitPlan = [];
  let didChange = false;
  let eventPrizeAssignmentsForProjectionCleanup: Record<
    string,
    EventPrizeAssignmentRecord
  > | null = null;
  const normalizedOriginalCurrentRoundIndex = eventCurrentRoundIndex(
    event,
    NaN,
  );
  const originalCurrentRoundIndex = Number.isFinite(
    normalizedOriginalCurrentRoundIndex,
  )
    ? normalizedOriginalCurrentRoundIndex
    : null;
  const originalState = eventState(event);
  const originalStatus = normalizeString(originalState.status) || "active";
  const originalEndedAtMs =
    typeof originalState.endedAtMs === "number"
      ? Math.floor(originalState.endedAtMs)
      : null;
  const originalWinnerProfileId = normalizeStringOrNull(
    eventState(event).winnerProfileId,
  );
  const originalWinnerDisplayName = normalizeStringOrNull(
    eventState(event).winnerDisplayName,
  );
  const rounds = cloneEventRounds(
    eventRounds(event) || createEventRoundsDocument(),
  );
  let participants = cloneEventParticipants(
    eventParticipants(event) || createEventParticipantsDocument(),
  );
  const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
  const storedThirdPlaceMatch = supportsThirdPlaceMatch
    ? eventThirdPlaceMatch(event)
    : null;
  let thirdPlaceMatch = storedThirdPlaceMatch
    ? cloneEventMatch(storedThirdPlaceMatch)
    : null;
  const inviteUpdates: EventCommitPlan = [];
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
  patchEventDocument(event, { currentRoundIndex: nextCurrentRoundIndex });

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
      (winnerProfileId && eventParticipantAt(participants, winnerProfileId)) ||
      null;
    patchEventDocument(event, { status: "ended" });
    let endedAtMs = eventState(event).endedAtMs;
    if (typeof endedAtMs !== "number") {
      endedAtMs = nowMs;
      patchEventDocument(event, { endedAtMs });
    }
    patchEventDocument(event, { winnerProfileId: winnerProfileId });
    copyEventWinnerDisplayName(event, winnerParticipant);
    if (isEventPrizeEvent(eventId)) {
      if (typeof eventState(event).prizeSelectionsLockedAtMs !== "number") {
        patchEventDocument(event, { prizeSelectionsLockedAtMs: nowMs });
        updates.push(eventField(eventId, "prizeSelectionsLockedAtMs", nowMs));
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
        patchEventDocument(event, {
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
    patchEventDocument(event, { status: "active" });
    patchEventDocument(event, { endedAtMs: null });
    patchEventDocument(event, { winnerProfileId: null });
    patchEventDocument(event, { winnerDisplayName: null });
  }

  let eventChanged = false;
  const nextState = eventState(event);
  const normalizedCurrentRoundIndex =
    typeof nextState.currentRoundIndex === "number"
      ? Math.floor(nextState.currentRoundIndex)
      : null;
  if (normalizedCurrentRoundIndex !== originalCurrentRoundIndex) {
    updates.push(
      eventField(eventId, "currentRoundIndex", normalizedCurrentRoundIndex),
    );
    eventChanged = true;
  }

  const normalizedStatus = eventShouldEnd ? "ended" : "active";
  if (normalizedStatus !== originalStatus) {
    updates.push(eventField(eventId, "status", normalizedStatus));
    eventChanged = true;
  }

  const normalizedEndedAtMs =
    typeof nextState.endedAtMs === "number"
      ? Math.floor(nextState.endedAtMs)
      : null;
  if (normalizedEndedAtMs !== originalEndedAtMs) {
    updates.push(eventField(eventId, "endedAtMs", normalizedEndedAtMs));
    eventChanged = true;
  }

  const normalizedWinnerProfileId = normalizeStringOrNull(
    eventState(event).winnerProfileId,
  );
  if (normalizedWinnerProfileId !== originalWinnerProfileId) {
    updates.push(
      eventField(eventId, "winnerProfileId", normalizedWinnerProfileId),
    );
    eventChanged = true;
  }

  const normalizedWinnerDisplayName = normalizeStringOrNull(
    eventState(event).winnerDisplayName,
  );
  if (normalizedWinnerDisplayName !== originalWinnerDisplayName) {
    updates.push(
      eventField(eventId, "winnerDisplayName", normalizedWinnerDisplayName),
    );
    eventChanged = true;
  }
  if (supportsThirdPlaceMatch && thirdPlaceMatchChanged) {
    updates.push(eventField(eventId, "thirdPlaceMatch", thirdPlaceMatch));
    eventChanged = true;
  }

  if (roundsChanged) {
    updates.push(eventField(eventId, "rounds", rounds));
  }
  if (participantsChanged) {
    updates.push(eventField(eventId, "participants", participants));
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
    updates.push(eventField(eventId, "updatedAtMs", nowMs));
    didChange = true;
  }

  return {
    updates,
    didChange,
    eventForProjection: event,
    prizeAssignmentsForProjection: eventPrizeAssignmentsForProjectionCleanup,
  };
}

export async function buildEndedEventSyncPlan(
  {
    eventId,
    event,
    nowMs,
    ownershipSnapshot,
    prizeSelections,
  }: EventSyncPlanInput,
  dependencies: EventSyncPlanningDependencies,
): Promise<EventSyncPlan> {
  const {
    hasThirdPlaceMatchField,
    reconcileThirdPlaceMatchReadiness,
    resolveEventPrizeAssignments,
    addEventPrizeAssignmentUpdates,
  } = dependencies;
  const updates: EventCommitPlan = [];
  let didChange = false;
  let eventPrizeAssignmentsForProjectionCleanup: Record<
    string,
    EventPrizeAssignmentRecord
  > | null = null;
  const rounds = cloneEventRounds(
    eventRounds(event) || createEventRoundsDocument(),
  );
  const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
  const storedThirdPlaceMatch = supportsThirdPlaceMatch
    ? eventThirdPlaceMatch(event)
    : null;
  let thirdPlaceMatch = storedThirdPlaceMatch
    ? cloneEventMatch(storedThirdPlaceMatch)
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
        eventParticipants(event) || createEventParticipantsDocument(),
      inviteUpdates: [],
      thirdPlaceMatch,
      allowInviteCreation: false,
    });
    thirdPlaceMatch = thirdPlaceResult.thirdPlaceMatch;
    if (thirdPlaceResult.didChange) {
      thirdPlaceMatchChanged = true;
    }
  }

  if (isEventPrizeEvent(eventId)) {
    const state = eventState(event);
    if (typeof state.prizeSelectionsLockedAtMs !== "number") {
      updates.push(
        eventField(
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
        eventParticipants(event) || createEventParticipantsDocument(),
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
    updates.push(eventField(eventId, "rounds", rounds));
    if (supportsThirdPlaceMatch) {
      updates.push(eventField(eventId, "thirdPlaceMatch", thirdPlaceMatch));
    }
  }
  if (roundsChanged || thirdPlaceMatchChanged || prizeStateChanged) {
    updates.push(eventField(eventId, "updatedAtMs", nowMs));
    didChange = true;
  }
  return {
    updates,
    didChange,
    eventForProjection: event,
    prizeAssignmentsForProjection: eventPrizeAssignmentsForProjectionCleanup,
  };
}
