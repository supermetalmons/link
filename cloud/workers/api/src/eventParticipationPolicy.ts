import {
  MAX_EVENT_PARTICIPANTS,
  buildEventParticipantSnapshot,
  isEventParticipantSnapshot,
  type EventParticipantSnapshot,
} from "@mons/shared/events";
import {
  eventField,
  getEventField,
  type EventCommitPlan,
} from "../../../runtime/eventCommands.js";
import {
  directParticipantParticipation,
  getCanonicalProfileId,
  getLoginProfileId,
  getOwnershipProfile,
  requesterOwnsProfileReference,
  resolveParticipantParticipation,
  type EventOwnershipSnapshot,
} from "../../../runtime/events/ownership.js";
import { AuthApiFailure } from "./authErrors.ts";
import type { GameplayProfile } from "./gameplayRepository.ts";

export type EventRecord = Record<string, unknown>;

export type EventDueTransition = {
  didChange: boolean;
  updates: EventCommitPlan;
};

export type JoinInspection =
  | { kind: "settle-due" }
  | {
      kind: "resolve-participant";
      directParticipation: ReturnType<typeof directParticipantParticipation>;
      needsOwnership: boolean;
    };

export type JoinDraft = {
  kind: "join";
  participant: EventParticipantSnapshot;
  eventForSettlement: EventRecord;
  updates: EventCommitPlan;
};

export type JoinCommit = {
  participant: EventParticipantSnapshot;
  updates: EventCommitPlan;
  expectedTransitionStatus?: "active" | "dismissed";
};

export type RemovalContext = {
  event: EventRecord;
  isLeaving: boolean;
  participantProfileId: string;
  creatorLoginUid: string;
  creatorProfileId: string;
  directCreator: boolean;
  targetParticipant: EventRecord | null;
  targetLoginUid: string;
  targetProfileId: string;
  ownershipSnapshot: EventOwnershipSnapshot | null;
};

export function toRecord(value: unknown): EventRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as EventRecord)
    : null;
}

export function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function applyOwnershipPolicy<T>(operation: () => T): T {
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

export function buildParticipant(
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

export function participantCount(event: EventRecord): number {
  const participants = toRecord(event.participants) || {};
  return Object.values(participants).filter(
    (participant) => toRecord(participant) !== null,
  ).length;
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

export function inspectJoin(
  event: EventRecord,
  loginUid: string,
  nowMs: number,
): JoinInspection {
  if (
    event.status === "scheduled" &&
    typeof event.startAtMs === "number" &&
    nowMs >= event.startAtMs &&
    participantCount(event) < 2
  ) {
    return { kind: "settle-due" };
  }
  const directParticipation = applyOwnershipPolicy(() =>
    directParticipantParticipation(event, loginUid),
  );
  return {
    kind: "resolve-participant",
    directParticipation,
    needsOwnership:
      !directParticipation.isParticipant ||
      (typeof event.startAtMs === "number" && nowMs >= event.startAtMs),
  };
}

export function planJoin({
  eventId,
  event,
  loginUid,
  nowMs,
  inspection,
  ownershipSnapshot,
}: {
  eventId: string;
  event: EventRecord;
  loginUid: string;
  nowMs: number;
  inspection: Extract<JoinInspection, { kind: "resolve-participant" }>;
  ownershipSnapshot: EventOwnershipSnapshot | null;
}): JoinDraft | { kind: "settle-due" } {
  const { directParticipation } = inspection;
  let profile: GameplayProfile | null = null;
  let existingParticipantProfileId = directParticipation.profileId || "";
  if (!directParticipation.isParticipant) {
    const ownerProfileId = applyOwnershipPolicy(() =>
      getLoginProfileId(ownershipSnapshot!, loginUid),
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
      resolveParticipantParticipation(event, loginUid, ownershipSnapshot),
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
    return { kind: "settle-due" };
  }
  const participants = toRecord(event.participants) || {};
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
        loginUid,
      )
    : buildParticipant(
        { ...profile!, profileId: existingParticipantProfileId },
        loginUid,
        typeof existingJoinedAtMs === "number" ? existingJoinedAtMs : nowMs,
      );
  return {
    kind: "join",
    participant,
    eventForSettlement: structuredClone({
      ...event,
      participants: {
        ...participants,
        [existingParticipantProfileId]: participant,
      },
      updatedAtMs: nowMs,
    }),
    updates: [
      {
        kind: "event-participant",
        eventId,
        profileId: existingParticipantProfileId,
        value: participant,
      },
      eventField(eventId, "updatedAtMs", nowMs),
    ],
  };
}

export function finalizeJoin(
  eventId: string,
  draft: JoinDraft,
  dueTransition: EventDueTransition,
): JoinCommit {
  const updates = [...draft.updates];
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
  let participant = draft.participant;
  const canonicalParticipants = getEventField(updates, eventId, "participants");
  if (canonicalParticipants !== undefined) {
    const index = updates.findIndex(
      (command) =>
        command.kind === "event-participant" &&
        command.eventId === eventId &&
        command.profileId === draft.participant.profileId,
    );
    if (index >= 0) updates.splice(index, 1);
    participant = participantFromCanonicalParent(
      canonicalParticipants,
      draft.participant.loginUid,
    );
  }
  return { participant, updates, expectedTransitionStatus };
}

export function resolveRemovalContext({
  event,
  loginUid,
  participantProfileId: requestedProfileId,
  ownershipSnapshot,
}: {
  event: EventRecord;
  loginUid: string;
  participantProfileId: string | null;
  ownershipSnapshot: EventOwnershipSnapshot | null;
}): RemovalContext {
  const isLeaving = requestedProfileId === null;
  let participantProfileId = requestedProfileId || "";
  const creatorLoginUid = normalizeString(event.createdByLoginUid);
  const creatorProfileId = normalizeString(event.createdByProfileId);
  const participants = toRecord(event.participants) || {};
  const directCreator = loginUid === creatorLoginUid;
  if (
    !directCreator &&
    !isLeaving &&
    !applyOwnershipPolicy(() =>
      requesterOwnsProfileReference({
        requesterUid: loginUid,
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
  if (isLeaving) {
    participantProfileId =
      applyOwnershipPolicy(() =>
        resolveParticipantParticipation(event, loginUid, ownershipSnapshot),
      ).profileId || "";
  }
  const targetParticipant = toRecord(participants[participantProfileId]);
  const targetLoginUid = normalizeString(targetParticipant?.loginUid);
  const targetProfileId =
    normalizeString(targetParticipant?.profileId) || participantProfileId;
  if (isLeaving && targetParticipant && ownershipSnapshot) {
    const snapshot = ownershipSnapshot;
    const ownedParticipantIds = applyOwnershipPolicy(() => {
      const ownerProfileId = getLoginProfileId(snapshot, loginUid);
      if (!ownerProfileId) return [];
      return Object.entries(participants).flatMap(([key, value]) => {
        const candidate = toRecord(value);
        if (!candidate) return [];
        const candidateProfileId = normalizeString(candidate.profileId) || key;
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
        ? "This event can no longer be left."
        : "Only scheduled events can remove participants.",
    );
  }
  return {
    event,
    isLeaving,
    participantProfileId,
    creatorLoginUid,
    creatorProfileId,
    directCreator,
    targetParticipant,
    targetLoginUid,
    targetProfileId,
    ownershipSnapshot,
  };
}

export function assertRemovalAllowed({
  event,
  isLeaving,
  participantProfileId,
  creatorLoginUid,
  creatorProfileId,
  directCreator,
  targetParticipant,
  targetLoginUid,
  targetProfileId,
  ownershipSnapshot,
}: RemovalContext): void {
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
    const participants = toRecord(event.participants) || {};
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
        getCanonicalProfileId(ownershipSnapshot, targetProfileId) ===
        getCanonicalProfileId(ownershipSnapshot, creatorProfileId),
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
}

export function buildRemovalPlan(
  eventId: string,
  participantProfileId: string,
  nowMs: number,
): EventCommitPlan {
  return [
    {
      kind: "event-participant",
      eventId,
      profileId: participantProfileId,
      value: null,
    },
    {
      kind: "prize-selection",
      eventId,
      profileId: participantProfileId,
      value: null,
    },
    eventField(eventId, "updatedAtMs", nowMs),
  ];
}
