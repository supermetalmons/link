import {
  readInviteDocument,
  type InviteDocument,
  type EventInviteWrite,
} from "../shared/invite-records.js";
import type {
  EventMatchView,
  EventParticipantSnapshot,
  EventParticipantState,
  EventRoundStatus,
  EventStatus,
  EventTelegramAnnouncements,
} from "../shared/events.js";
import type { EventPrizeAssignmentRecord } from "../eventReads.js";
import { normalizeEventPrizeAssignments } from "../eventPrizeAwards.js";

declare const eventDocumentKind: unique symbol;
type Document<Kind extends string> = { readonly [eventDocumentKind]: Kind };

export type EventDocument = Document<"event">;
export type EventParticipantDocument = Document<"participant">;
export type EventMatchDocument = Document<"match">;
export type EventRoundDocument = Document<"round">;
export type EventParticipantsDocument = Document<"participants">;
export type EventMatchesDocument = Document<"matches">;
export type EventRoundsDocument = Document<"rounds">;

type EventSourceDocument =
  | EventDocument
  | EventParticipantDocument
  | EventMatchDocument
  | EventRoundDocument
  | EventParticipantsDocument
  | EventMatchesDocument
  | EventRoundsDocument;

type SourceRecord = Record<string, unknown>;

const object = (value: unknown): value is object =>
  value !== null && typeof value === "object";
const record = (value: unknown): value is SourceRecord =>
  object(value) && !Array.isArray(value);
const source = (value: EventSourceDocument): SourceRecord =>
  value as object as SourceRecord;
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;
const nullableString = (value: unknown): string | null | undefined =>
  value === null ? null : string(value);
const trimmed = (value: unknown): string => string(value)?.trim() || "";
const integer = (value: unknown, fallback: number): number => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
};

export function readEventDocument(value: unknown): EventDocument | null {
  return object(value) ? (value as EventDocument) : null;
}

export function readPlainEventDocument(value: unknown): EventDocument | null {
  return record(value) ? (value as object as EventDocument) : null;
}

export function readEventParticipantDocument(
  value: unknown,
): EventParticipantDocument | null {
  return object(value) ? (value as EventParticipantDocument) : null;
}

export function readPlainEventParticipantDocument(
  value: unknown,
): EventParticipantDocument | null {
  return record(value) ? (value as object as EventParticipantDocument) : null;
}

export function readEventMatchDocument(
  value: unknown,
): EventMatchDocument | null {
  return object(value) ? (value as EventMatchDocument) : null;
}

export function readEventRoundDocument(
  value: unknown,
): EventRoundDocument | null {
  return object(value) ? (value as EventRoundDocument) : null;
}

export function readEventParticipantsDocument(
  value: unknown,
): EventParticipantsDocument | null {
  return object(value) ? (value as EventParticipantsDocument) : null;
}

export function readEventRoundsDocument(
  value: unknown,
): EventRoundsDocument | null {
  return object(value) ? (value as EventRoundsDocument) : null;
}

export function readEventMatchesDocument(
  value: unknown,
): EventMatchesDocument | null {
  return object(value) ? (value as EventMatchesDocument) : null;
}

export function eventState(event: EventDocument | null | undefined) {
  const value = event ? source(event) : {};
  return {
    eventId: string(value.eventId),
    status: string(value.status),
    createdAtMs: number(value.createdAtMs),
    updatedAtMs: number(value.updatedAtMs),
    startAtMs: number(value.startAtMs),
    startedAtMs: number(value.startedAtMs),
    endedAtMs: number(value.endedAtMs),
    currentRoundIndex: number(value.currentRoundIndex),
    bracketSize: number(value.bracketSize),
    roundCount: number(value.roundCount),
    createdByLoginUid: string(value.createdByLoginUid),
    createdByProfileId: string(value.createdByProfileId),
    winnerProfileId: nullableString(value.winnerProfileId),
    winnerDisplayName: nullableString(value.winnerDisplayName),
    prizeSelectionsLockedAtMs: number(value.prizeSelectionsLockedAtMs),
    hasPrizeSelectionLock:
      value.prizeSelectionsLockedAtMs !== undefined &&
      value.prizeSelectionsLockedAtMs !== null,
    supportsThirdPlaceMatch: value.supportsThirdPlaceMatch === true,
  };
}

export function eventParticipantState(
  participant: EventParticipantDocument | null | undefined,
) {
  const value = participant ? source(participant) : {};
  return {
    profileId: string(value.profileId),
    loginUid: string(value.loginUid),
    username: string(value.username),
    displayName: string(value.displayName),
    emojiId: number(value.emojiId),
    aura: nullableString(value.aura),
    joinedAtMs: number(value.joinedAtMs),
    state: string(value.state),
    eliminatedRoundIndex: number(value.eliminatedRoundIndex),
    eliminatedByProfileId: nullableString(value.eliminatedByProfileId),
  };
}

export function eventParticipantProjectionState(
  participant: EventParticipantDocument,
) {
  const value = source(participant);
  return {
    ...eventParticipantState(participant),
    emojiId:
      typeof value.emojiId === "number" || typeof value.emojiId === "string"
        ? value.emojiId
        : undefined,
  };
}

export function eventMatchState(match: EventMatchDocument | null | undefined) {
  const value = match ? source(match) : {};
  return {
    matchKey: string(value.matchKey),
    inviteId: nullableString(value.inviteId),
    status: string(value.status),
    resolvedAtMs: number(value.resolvedAtMs),
    winnerDisqualified: value.winnerDisqualified === true,
    winnerProfileId: nullableString(value.winnerProfileId),
    loserProfileId: nullableString(value.loserProfileId),
    hostSlotBlocked: value.hostSlotBlocked === true,
    hostProfileId: nullableString(value.hostProfileId),
    hostLoginUid: nullableString(value.hostLoginUid),
    hostDisplayName: nullableString(value.hostDisplayName),
    hostEmojiId: number(value.hostEmojiId),
    hostAura: nullableString(value.hostAura),
    guestSlotBlocked: value.guestSlotBlocked === true,
    guestProfileId: nullableString(value.guestProfileId),
    guestLoginUid: nullableString(value.guestLoginUid),
    guestDisplayName: nullableString(value.guestDisplayName),
    guestEmojiId: number(value.guestEmojiId),
    guestAura: nullableString(value.guestAura),
  };
}

export function eventRoundState(round: EventRoundDocument) {
  const value = source(round);
  return {
    roundIndex: number(value.roundIndex),
    status: string(value.status),
    createdAtMs: number(value.createdAtMs),
    completedAtMs: number(value.completedAtMs),
    completedAtIsNull: value.completedAtMs === null,
  };
}

export const eventCurrentRoundIndex = (
  event: EventDocument,
  fallback: number,
): number => integer(source(event).currentRoundIndex, fallback);

export const eventParticipantJoinedOrder = (
  participant: EventParticipantDocument,
  fallback = 0,
): number => integer(source(participant).joinedAtMs, fallback);

export function eventParticipants(
  event: EventDocument | null | undefined,
): EventParticipantsDocument | null {
  return readEventParticipantsDocument(event && source(event).participants);
}

export function plainEventParticipants(
  event: EventDocument,
): EventParticipantsDocument | null {
  const value = source(event).participants;
  return record(value) ? readEventParticipantsDocument(value) : null;
}

export function eventRounds(
  event: EventDocument | null | undefined,
): EventRoundsDocument | null {
  return readEventRoundsDocument(event && source(event).rounds);
}

export function eventThirdPlaceMatch(
  event: EventDocument | null | undefined,
): EventMatchDocument | null {
  return readEventMatchDocument(event && source(event).thirdPlaceMatch);
}

export function eventRoundAt(
  rounds: EventRoundsDocument | null | undefined,
  key: string,
): EventRoundDocument | null {
  return readEventRoundDocument(rounds && source(rounds)[key]);
}

export function eventRoundMatches(
  round: EventRoundDocument | null | undefined,
): EventMatchesDocument | null {
  return readEventMatchesDocument(round && source(round).matches);
}

export function eventMatchAt(
  matches: EventMatchesDocument | null | undefined,
  key: string,
): EventMatchDocument | null {
  return readEventMatchDocument(matches && source(matches)[key]);
}

export function eventMatchEntryKind(
  matches: EventMatchesDocument | null | undefined,
  key: string,
): "missing" | "match" | "invalid" {
  const value = matches && source(matches)[key];
  return !value ? "missing" : object(value) ? "match" : "invalid";
}

export function eventPlacementMatches(
  round: EventRoundDocument | null,
): Record<string, { present: boolean; match: EventMatchDocument | null }> {
  const matches = round ? source(round).matches : null;
  const indexed = Object(matches || {}) as SourceRecord;
  return Object.fromEntries(
    Object.keys(indexed).map((key) => [
      key,
      {
        present: Boolean(indexed[key]),
        match: readEventMatchDocument(indexed[key]),
      },
    ]),
  );
}

export function eventParticipantAt(
  participants: EventParticipantsDocument | null | undefined,
  key: string,
): EventParticipantDocument | null {
  return readEventParticipantDocument(
    participants && source(participants)[key],
  );
}

export function plainEventParticipantAt(
  participants: EventParticipantsDocument | null | undefined,
  key: string,
): EventParticipantDocument | null {
  return readPlainEventParticipantDocument(
    participants && source(participants)[key],
  );
}

export function eventParticipantIsAbsent(
  participants: EventParticipantsDocument | null,
  profileId: string,
): boolean {
  return (participants ? source(participants)[profileId] : null) == null;
}

export function eventParticipantEntries(
  participants: EventParticipantsDocument | null | undefined,
): Array<[string, EventParticipantDocument]> {
  return Object.entries(participants ? source(participants) : {}).flatMap(
    ([key, value]) => {
      const participant = readEventParticipantDocument(value);
      return participant ? [[key, participant]] : [];
    },
  );
}

export function plainEventParticipantEntries(
  participants: EventParticipantsDocument | null | undefined,
): Array<[string, EventParticipantDocument]> {
  return eventParticipantEntries(participants).filter(([, value]) =>
    record(value),
  );
}

export function eventMatchEntries(
  matches: EventMatchesDocument | null | undefined,
): Array<[string, EventMatchDocument | null]> {
  return Object.entries(matches ? source(matches) : {}).map(([key, value]) => [
    key,
    readEventMatchDocument(value),
  ]);
}

export function eventPrizeOwnerProfileIds(event: EventDocument): string[] {
  const value = source(event).prizeAssignments;
  return object(value)
    ? Object.values(value).map((assignment) =>
        trimmed(
          object(assignment) ? (assignment as SourceRecord).profileId : null,
        ),
      )
    : [];
}

export function eventPrizeAssignments(
  event: EventDocument | null | undefined,
  eventId: string,
): Record<string, EventPrizeAssignmentRecord> {
  return normalizeEventPrizeAssignments(
    event && source(event).prizeAssignments,
    eventId,
  );
}

export type EventParticipantWrite = EventParticipantSnapshot;
export type EventParticipantPatch = Partial<{
  profileId: string;
  loginUid: string;
  username: string;
  displayName: string;
  emojiId: number;
  aura: string | null;
  joinedAtMs: number;
  state: EventParticipantState;
  eliminatedRoundIndex: number | null;
  eliminatedByProfileId: string | null;
}>;

export type EventMatchWrite = EventMatchView;
export type EventMatchPatch = Partial<EventMatchWrite>;
export type EventRoundWrite = {
  roundIndex: number;
  status: EventRoundStatus;
  createdAtMs: number;
  completedAtMs: number | null;
  matches: EventMatchesDocument;
};
export type EventRoundPatch = Partial<EventRoundWrite>;
export type EventWrite = {
  schemaVersion: number;
  eventId: string;
  status: EventStatus;
  createdAtMs: number;
  updatedAtMs: number;
  startAtMs: number;
  isSundayMons: boolean;
  telegramAnnouncements: EventTelegramAnnouncements;
  telegramDeliveryVersion: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  createdByProfileId: string;
  createdByLoginUid: string;
  createdByUsername: string;
  winnerProfileId: string | null;
  winnerDisplayName: string | null;
  currentRoundIndex: number | null;
  bracketSize: number;
  roundCount: number;
  supportsThirdPlaceMatch: boolean;
  thirdPlaceMatch: EventMatchDocument | null;
  participants: EventParticipantsDocument;
  rounds: EventRoundsDocument;
  prizeSelectionsLockedAtMs?: number | null;
  prizeAssignments?: Record<string, EventPrizeAssignmentRecord>;
};
export type EventPatch = Partial<EventWrite>;

export const createEventDocument = (value: EventWrite): EventDocument =>
  readEventDocument(value)!;
export const createEventParticipantDocument = (
  value: EventParticipantWrite,
): EventParticipantDocument => readEventParticipantDocument(value)!;
export const createEventMatchDocument = (
  value: EventMatchWrite,
): EventMatchDocument => readEventMatchDocument(value)!;
export const createEventRoundDocument = (
  value: EventRoundWrite,
): EventRoundDocument => readEventRoundDocument(value)!;
export const createEventParticipantsDocument = (
  value: Record<string, EventParticipantDocument> = {},
): EventParticipantsDocument => readEventParticipantsDocument(value)!;
export const createEventRoundsDocument = (
  value: Record<string, EventRoundDocument> = {},
): EventRoundsDocument => readEventRoundsDocument(value)!;
export const createEventMatchesDocument = (
  value: Record<string, EventMatchDocument> = {},
): EventMatchesDocument => readEventMatchesDocument(value)!;

export function patchEventDocument(
  event: EventDocument,
  patch: EventPatch,
): void {
  Object.assign(source(event), patch);
}

export function patchEventMatch(
  match: EventMatchDocument,
  patch: EventMatchPatch,
): void {
  Object.assign(source(match), patch);
}

export function patchEventRound(
  round: EventRoundDocument,
  patch: EventRoundPatch,
): void {
  Object.assign(source(round), patch);
}

export function copyEventParticipant(
  participant: EventParticipantDocument,
  patch: EventParticipantPatch,
): EventParticipantDocument {
  return readEventParticipantDocument({ ...source(participant), ...patch })!;
}

export function copyEventDocument(
  event: EventDocument,
  patch: EventPatch,
): EventDocument {
  return readEventDocument({ ...source(event), ...patch })!;
}

export function copyEventParticipants(
  participants: EventParticipantsDocument,
  replacements: ReadonlyMap<string, EventParticipantDocument>,
): EventParticipantsDocument {
  return readEventParticipantsDocument(
    Object.fromEntries(
      Object.entries(source(participants)).map(([key, value]) => [
        key,
        replacements.get(key) ?? value,
      ]),
    ),
  )!;
}

export function withEventParticipant(
  participants: EventParticipantsDocument | null,
  profileId: string,
  participant: EventParticipantDocument,
): EventParticipantsDocument {
  return readEventParticipantsDocument({
    ...(participants ? source(participants) : {}),
    [profileId]: participant,
  })!;
}

export function setEventRound(
  rounds: EventRoundsDocument,
  key: string,
  round: EventRoundDocument,
): void {
  source(rounds)[key] = round;
}

export function setEventMatch(
  matches: EventMatchesDocument,
  key: string,
  match: EventMatchDocument,
): void {
  source(matches)[key] = match;
}

export function cloneEventDocument(
  event: EventDocument,
  mode: "json" | "structured" = "json",
): EventDocument {
  const value: unknown =
    mode === "structured"
      ? structuredClone(event)
      : JSON.parse(JSON.stringify(event));
  return readEventDocument(value)!;
}

export function cloneEventRounds(
  rounds: EventRoundsDocument,
): EventRoundsDocument {
  return readEventRoundsDocument(JSON.parse(JSON.stringify(rounds)))!;
}

export function cloneEventParticipants(
  participants: EventParticipantsDocument,
): EventParticipantsDocument {
  return readEventParticipantsDocument(
    JSON.parse(JSON.stringify(participants)),
  )!;
}

export function cloneEventMatch(match: EventMatchDocument): EventMatchDocument {
  return readEventMatchDocument(JSON.parse(JSON.stringify(match)))!;
}

export function setEventMatchSlotBlocked(
  match: EventMatchDocument,
  slot: "host" | "guest",
  blocked: boolean,
): boolean {
  const value = source(match);
  const field = slot === "guest" ? "guestSlotBlocked" : "hostSlotBlocked";
  const next = blocked === true;
  if (value[field] === next) return false;
  value[field] = next;
  return true;
}

export function copyEventParticipantToMatchSlot(
  match: EventMatchDocument,
  slot: "host" | "guest",
  participant: EventParticipantDocument | null,
): boolean {
  const target = source(match);
  const current = participant ? source(participant) : null;
  const values = {
    ProfileId: current ? current.profileId : null,
    LoginUid: current ? current.loginUid : null,
    DisplayName: current ? current.displayName : null,
    EmojiId: current ? current.emojiId : null,
    Aura: current ? current.aura || null : null,
  };
  let didChange = false;
  for (const [suffix, value] of Object.entries(values)) {
    const field = `${slot}${suffix}`;
    if (target[field] !== value) {
      target[field] = value;
      didChange = true;
    }
  }
  if (participant && setEventMatchSlotBlocked(match, slot, false))
    didChange = true;
  return didChange;
}

export function copyEventWinnerDisplayName(
  event: EventDocument,
  participant: EventParticipantDocument | null,
): void {
  source(event).winnerDisplayName = participant
    ? source(participant).displayName
    : null;
}

export function createEventMatchInvite(
  match: EventMatchDocument,
  value: Omit<EventInviteWrite, "eventMatchKey" | "eventOwned">,
  matchKey: string,
  useStoredMatchKey = false,
): InviteDocument {
  return readInviteDocument({
    version: value.version,
    hostId: value.hostId,
    hostColor: value.hostColor,
    guestId: value.guestId,
    eventId: value.eventId,
    eventRoundIndex: value.eventRoundIndex,
    eventMatchKey: useStoredMatchKey
      ? source(match).matchKey || matchKey
      : matchKey,
    eventOwned: true,
  })!;
}
