import {
  createEventInviteDocument,
  type InviteDocument,
  type EventInviteWrite,
} from "../shared/invite-records.js";
import {
  isEventRecord,
  isEventParticipantRecord,
  isEventMatchRecord,
  isEventRoundRecord,
  isEventParticipants,
  isEventMatches,
  isEventRounds,
} from "../shared/event-views.js";
import type {
  EventRecord,
  EventRecordFields,
  EventParticipantRecord,
  EventParticipantFields,
  EventMatchRecord,
  EventMatchFields,
  EventRoundRecord,
  EventRoundFields,
} from "../shared/event-types.js";
import type { EventPrizeAssignmentRecord } from "../eventReads.js";

export type EventDocument = EventRecord;
export type EventParticipantDocument = EventParticipantRecord;
export type EventMatchDocument = EventMatchRecord;
export type EventRoundDocument = EventRoundRecord;
export type EventParticipantsDocument = Record<string, EventParticipantRecord>;
export type EventMatchesDocument = Record<string, EventMatchRecord>;
export type EventRoundsDocument = Record<string, EventRoundRecord>;

export const readEventDocument = (value: unknown): EventDocument | null =>
  isEventRecord(value) ? value : null;
export const readPlainEventDocument = readEventDocument;
export const readEventParticipantDocument = (
  value: unknown,
): EventParticipantDocument | null =>
  isEventParticipantRecord(value) ? value : null;
export const readPlainEventParticipantDocument = readEventParticipantDocument;
export const readEventMatchDocument = (
  value: unknown,
): EventMatchDocument | null => (isEventMatchRecord(value) ? value : null);
export const readEventRoundDocument = (
  value: unknown,
): EventRoundDocument | null => (isEventRoundRecord(value) ? value : null);
export const readEventParticipantsDocument = (
  value: unknown,
): EventParticipantsDocument | null =>
  isEventParticipants(value) ? value : null;
export const readEventRoundsDocument = (
  value: unknown,
): EventRoundsDocument | null => (isEventRounds(value) ? value : null);

export function eventState(event: EventDocument | null | undefined) {
  return {
    eventId: event?.eventId,
    status: event?.status,
    createdAtMs: event?.createdAtMs,
    updatedAtMs: event?.updatedAtMs,
    startAtMs: event?.startAtMs,
    startedAtMs: event?.startedAtMs,
    endedAtMs: event?.endedAtMs,
    currentRoundIndex: event?.currentRoundIndex,
    bracketSize: event?.bracketSize,
    roundCount: event?.roundCount,
    createdByLoginUid: event?.createdByLoginUid,
    createdByProfileId: event?.createdByProfileId,
    winnerProfileId: event?.winnerProfileId,
    winnerDisplayName: event?.winnerDisplayName,
    prizeSelectionsLockedAtMs: event?.prizeSelectionsLockedAtMs,
    hasPrizeSelectionLock:
      event != null && event.prizeSelectionsLockedAtMs !== null,
    supportsThirdPlaceMatch: event?.supportsThirdPlaceMatch ?? false,
  };
}

export function eventParticipantState(
  participant: EventParticipantDocument | null | undefined,
) {
  return {
    profileId: participant?.profileId,
    loginUid: participant?.loginUid,
    username: participant?.username,
    displayName: participant?.displayName,
    emojiId: participant?.emojiId,
    aura: participant?.aura,
    joinedAtMs: participant?.joinedAtMs,
    state: participant?.state,
    eliminatedRoundIndex: participant?.eliminatedRoundIndex,
    eliminatedByProfileId: participant?.eliminatedByProfileId,
  };
}

export function eventMatchState(match: EventMatchDocument | null | undefined) {
  return {
    matchKey: match?.matchKey,
    inviteId: match?.inviteId,
    status: match?.status,
    resolvedAtMs: match?.resolvedAtMs,
    winnerDisqualified: match?.winnerDisqualified ?? false,
    winnerProfileId: match?.winnerProfileId,
    loserProfileId: match?.loserProfileId,
    hostSlotBlocked: match?.hostSlotBlocked ?? false,
    hostProfileId: match?.hostProfileId,
    hostLoginUid: match?.hostLoginUid,
    hostDisplayName: match?.hostDisplayName,
    hostEmojiId: match?.hostEmojiId,
    hostAura: match?.hostAura,
    guestSlotBlocked: match?.guestSlotBlocked ?? false,
    guestProfileId: match?.guestProfileId,
    guestLoginUid: match?.guestLoginUid,
    guestDisplayName: match?.guestDisplayName,
    guestEmojiId: match?.guestEmojiId,
    guestAura: match?.guestAura,
  };
}

export function eventRoundState(round: EventRoundDocument) {
  return {
    roundIndex: round.roundIndex,
    status: round.status,
    createdAtMs: round.createdAtMs,
    completedAtMs: round.completedAtMs,
    completedAtIsNull: round.completedAtMs === null,
  };
}

export const eventCurrentRoundIndex = (
  event: EventDocument,
  fallback: number,
): number => event.currentRoundIndex ?? fallback;
export const eventParticipantJoinedOrder = (
  participant: EventParticipantDocument,
): number => participant.joinedAtMs;

export function eventParticipants(
  event: Pick<EventDocument, "participants"> | null | undefined,
): EventParticipantsDocument | null {
  return event?.participants ?? null;
}
export const plainEventParticipants = eventParticipants;
export const eventRounds = (
  event: EventDocument | null | undefined,
): EventRoundsDocument | null => event?.rounds ?? null;
export const eventThirdPlaceMatch = (
  event: EventDocument | null | undefined,
): EventMatchDocument | null => event?.thirdPlaceMatch ?? null;
export const eventRoundAt = (
  rounds: EventRoundsDocument | null | undefined,
  key: string,
): EventRoundDocument | null => rounds?.[key] ?? null;
export const eventRoundMatches = (
  round: EventRoundDocument | null | undefined,
): EventMatchesDocument | null => round?.matches ?? null;
export const eventMatchAt = (
  matches: EventMatchesDocument | null | undefined,
  key: string,
): EventMatchDocument | null => matches?.[key] ?? null;
export const eventMatchEntryKind = (
  matches: EventMatchesDocument | null | undefined,
  key: string,
): "missing" | "match" => (matches?.[key] === undefined ? "missing" : "match");

export function eventPlacementMatches(
  round: EventRoundDocument | null,
): Record<string, { present: true; match: EventMatchDocument }> {
  return Object.fromEntries(
    Object.entries(round?.matches ?? {}).map(([key, match]) => [
      key,
      { present: true, match },
    ]),
  );
}

export const eventParticipantAt = (
  participants: EventParticipantsDocument | null | undefined,
  key: string,
): EventParticipantDocument | null => participants?.[key] ?? null;
export const plainEventParticipantAt = eventParticipantAt;
export const eventParticipantIsAbsent = (
  participants: EventParticipantsDocument | null,
  profileId: string,
): boolean => participants?.[profileId] === undefined;
export const eventParticipantEntries = (
  participants: EventParticipantsDocument | null | undefined,
): Array<[string, EventParticipantDocument]> =>
  Object.entries(participants ?? {});
export const plainEventParticipantEntries = eventParticipantEntries;
export const eventMatchEntries = (
  matches: EventMatchesDocument | null | undefined,
): Array<[string, EventMatchDocument]> => Object.entries(matches ?? {});
export const eventPrizeOwnerProfileIds = (
  event: EventDocument | null,
): string[] =>
  Object.values(event?.prizeAssignments ?? {}).map(
    (assignment) => assignment.profileId,
  );
export function eventPrizeAssignments(
  event: EventDocument | null | undefined,
  eventId: string,
): Record<string, EventPrizeAssignmentRecord> {
  if (event && event.eventId !== eventId)
    throw new TypeError("event-identity-mismatch");
  return { ...event?.prizeAssignments };
}

export type EventParticipantWrite = EventParticipantFields;
export type EventParticipantPatch = Partial<EventParticipantFields>;
export type EventMatchWrite = EventMatchFields;
export type EventMatchPatch = Partial<EventMatchFields>;
export type EventRoundWrite = EventRoundFields;
export type EventRoundPatch = Partial<EventRoundFields>;
export type EventWrite = EventRecordFields;
export type EventPatch = Partial<EventRecordFields>;

export function createEventDocument(value: EventWrite): EventDocument {
  const event = readEventDocument(value);
  if (!event) throw new TypeError("invalid-canonical-event");
  return event;
}
export function createEventParticipantDocument(
  value: EventParticipantWrite,
): EventParticipantDocument {
  const participant = readEventParticipantDocument(value);
  if (!participant) throw new TypeError("invalid-canonical-event-participant");
  return participant;
}
export function createEventMatchDocument(
  value: EventMatchWrite,
): EventMatchDocument {
  const match = readEventMatchDocument(value);
  if (!match) throw new TypeError("invalid-canonical-event-match");
  return match;
}
export function createEventRoundDocument(
  value: EventRoundWrite,
): EventRoundDocument {
  const round = readEventRoundDocument(value);
  if (!round) throw new TypeError("invalid-canonical-event-round");
  return round;
}
export function createEventParticipantsDocument(
  value: EventParticipantsDocument = {},
): EventParticipantsDocument {
  if (!isEventParticipants(value))
    throw new TypeError("invalid-canonical-event-participants");
  return value;
}
export function createEventRoundsDocument(
  value: EventRoundsDocument = {},
): EventRoundsDocument {
  if (!isEventRounds(value))
    throw new TypeError("invalid-canonical-event-rounds");
  return value;
}
export function createEventMatchesDocument(
  value: EventMatchesDocument = {},
): EventMatchesDocument {
  if (!isEventMatches(value))
    throw new TypeError("invalid-canonical-event-matches");
  return value;
}

export function patchEventDocument(
  event: EventDocument,
  patch: EventPatch,
): void {
  Object.assign(event, patch);
}
export function patchEventMatch(
  match: EventMatchDocument,
  patch: EventMatchPatch,
): void {
  Object.assign(match, patch);
}
export function patchEventRound(
  round: EventRoundDocument,
  patch: EventRoundPatch,
): void {
  Object.assign(round, patch);
}
export function copyEventParticipant(
  participant: EventParticipantDocument,
  patch: EventParticipantPatch,
): EventParticipantDocument {
  return createEventParticipantDocument({ ...participant, ...patch });
}
export function copyEventDocument(
  event: EventDocument,
  patch: EventPatch,
): EventDocument {
  return createEventDocument({ ...event, ...patch });
}
export function copyEventParticipants(
  participants: EventParticipantsDocument,
  replacements: ReadonlyMap<string, EventParticipantDocument>,
): EventParticipantsDocument {
  return createEventParticipantsDocument(
    Object.fromEntries(
      Object.entries(participants).map(([key, value]) => [
        key,
        replacements.get(key) ?? value,
      ]),
    ),
  );
}
export function withEventParticipant(
  participants: EventParticipantsDocument | null,
  profileId: string,
  participant: EventParticipantDocument,
): EventParticipantsDocument {
  return createEventParticipantsDocument({
    ...participants,
    [profileId]: participant,
  });
}
export function setEventRound(
  rounds: EventRoundsDocument,
  key: string,
  round: EventRoundDocument,
): void {
  if (key !== String(round.roundIndex))
    throw new TypeError("event-round-identity-mismatch");
  rounds[key] = round;
}
export function setEventMatch(
  matches: EventMatchesDocument,
  key: string,
  match: EventMatchDocument,
): void {
  if (key !== match.matchKey)
    throw new TypeError("event-match-identity-mismatch");
  matches[key] = match;
}
export function cloneEventDocument(
  event: EventDocument,
  _mode: "json" | "structured" = "json",
): EventDocument {
  return structuredClone(event);
}
export const cloneEventRounds = (
  rounds: EventRoundsDocument,
): EventRoundsDocument => structuredClone(rounds);
export const cloneEventParticipants = (
  participants: EventParticipantsDocument,
): EventParticipantsDocument => structuredClone(participants);
export const cloneEventMatch = (
  match: EventMatchDocument,
): EventMatchDocument => structuredClone(match);

export function setEventMatchSlotBlocked(
  match: EventMatchDocument,
  slot: "host" | "guest",
  blocked: boolean,
): boolean {
  const field = slot === "guest" ? "guestSlotBlocked" : "hostSlotBlocked";
  if (match[field] === blocked) return false;
  match[field] = blocked;
  return true;
}

export function copyEventParticipantToMatchSlot(
  match: EventMatchDocument,
  slot: "host" | "guest",
  participant: EventParticipantDocument | null,
): boolean {
  const profileId = participant?.profileId ?? null;
  const loginUid = participant?.loginUid ?? null;
  const displayName = participant?.displayName ?? null;
  const emojiId = participant?.emojiId ?? null;
  const aura = participant?.aura ?? null;
  let didChange: boolean;
  if (slot === "host") {
    didChange =
      match.hostProfileId !== profileId ||
      match.hostLoginUid !== loginUid ||
      match.hostDisplayName !== displayName ||
      match.hostEmojiId !== emojiId ||
      match.hostAura !== aura;
    Object.assign(match, {
      hostProfileId: profileId,
      hostLoginUid: loginUid,
      hostDisplayName: displayName,
      hostEmojiId: emojiId,
      hostAura: aura,
    });
  } else {
    didChange =
      match.guestProfileId !== profileId ||
      match.guestLoginUid !== loginUid ||
      match.guestDisplayName !== displayName ||
      match.guestEmojiId !== emojiId ||
      match.guestAura !== aura;
    Object.assign(match, {
      guestProfileId: profileId,
      guestLoginUid: loginUid,
      guestDisplayName: displayName,
      guestEmojiId: emojiId,
      guestAura: aura,
    });
  }
  if (participant && setEventMatchSlotBlocked(match, slot, false))
    didChange = true;
  return didChange;
}

export function copyEventWinnerDisplayName(
  event: EventDocument,
  participant: EventParticipantDocument | null,
): void {
  event.winnerDisplayName = participant?.displayName ?? null;
}

export function createEventMatchInvite(
  match: EventMatchDocument,
  value: Omit<EventInviteWrite, "eventMatchKey" | "eventOwned">,
  matchKey: string,
  useStoredMatchKey = false,
): InviteDocument {
  const invite = createEventInviteDocument({
    version: value.version,
    hostId: value.hostId,
    hostColor: value.hostColor,
    guestId: value.guestId,
    eventId: value.eventId,
    eventRoundIndex: value.eventRoundIndex,
    eventMatchKey: useStoredMatchKey ? match.matchKey : matchKey,
    eventOwned: true,
  });
  if (!invite) throw new TypeError("invalid-event-match-invite");
  return invite;
}
