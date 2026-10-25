// Generated from src/events/documents.ts. Run npm run generate:runtime.
import {
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
declare const eventDocumentKind: unique symbol;
type Document<Kind extends string> = {
  readonly [eventDocumentKind]: Kind;
};
export type EventDocument = Document<"event">;
export type EventParticipantDocument = Document<"participant">;
export type EventMatchDocument = Document<"match">;
export type EventRoundDocument = Document<"round">;
export type EventParticipantsDocument = Document<"participants">;
export type EventMatchesDocument = Document<"matches">;
export type EventRoundsDocument = Document<"rounds">;
export declare function readEventDocument(value: unknown): EventDocument | null;
export declare function readPlainEventDocument(
  value: unknown,
): EventDocument | null;
export declare function readEventParticipantDocument(
  value: unknown,
): EventParticipantDocument | null;
export declare function readPlainEventParticipantDocument(
  value: unknown,
): EventParticipantDocument | null;
export declare function readEventMatchDocument(
  value: unknown,
): EventMatchDocument | null;
export declare function readEventRoundDocument(
  value: unknown,
): EventRoundDocument | null;
export declare function readEventParticipantsDocument(
  value: unknown,
): EventParticipantsDocument | null;
export declare function readEventRoundsDocument(
  value: unknown,
): EventRoundsDocument | null;
export declare function readEventMatchesDocument(
  value: unknown,
): EventMatchesDocument | null;
export declare function eventState(event: EventDocument | null | undefined): {
  eventId: string | undefined;
  status: string | undefined;
  createdAtMs: number | undefined;
  updatedAtMs: number | undefined;
  startAtMs: number | undefined;
  startedAtMs: number | undefined;
  endedAtMs: number | undefined;
  currentRoundIndex: number | undefined;
  bracketSize: number | undefined;
  roundCount: number | undefined;
  createdByLoginUid: string | undefined;
  createdByProfileId: string | undefined;
  winnerProfileId: string | null | undefined;
  winnerDisplayName: string | null | undefined;
  prizeSelectionsLockedAtMs: number | undefined;
  hasPrizeSelectionLock: boolean;
  supportsThirdPlaceMatch: boolean;
};
export declare function eventParticipantState(
  participant: EventParticipantDocument | null | undefined,
): {
  profileId: string | undefined;
  loginUid: string | undefined;
  username: string | undefined;
  displayName: string | undefined;
  emojiId: number | undefined;
  aura: string | null | undefined;
  joinedAtMs: number | undefined;
  state: string | undefined;
  eliminatedRoundIndex: number | undefined;
  eliminatedByProfileId: string | null | undefined;
};
export declare function eventParticipantProjectionState(
  participant: EventParticipantDocument,
): {
  emojiId: string | number | undefined;
  profileId: string | undefined;
  loginUid: string | undefined;
  username: string | undefined;
  displayName: string | undefined;
  aura: string | null | undefined;
  joinedAtMs: number | undefined;
  state: string | undefined;
  eliminatedRoundIndex: number | undefined;
  eliminatedByProfileId: string | null | undefined;
};
export declare function eventMatchState(
  match: EventMatchDocument | null | undefined,
): {
  matchKey: string | undefined;
  inviteId: string | null | undefined;
  status: string | undefined;
  resolvedAtMs: number | undefined;
  winnerDisqualified: boolean;
  winnerProfileId: string | null | undefined;
  loserProfileId: string | null | undefined;
  hostSlotBlocked: boolean;
  hostProfileId: string | null | undefined;
  hostLoginUid: string | null | undefined;
  hostDisplayName: string | null | undefined;
  hostEmojiId: number | undefined;
  hostAura: string | null | undefined;
  guestSlotBlocked: boolean;
  guestProfileId: string | null | undefined;
  guestLoginUid: string | null | undefined;
  guestDisplayName: string | null | undefined;
  guestEmojiId: number | undefined;
  guestAura: string | null | undefined;
};
export declare function eventRoundState(round: EventRoundDocument): {
  roundIndex: number | undefined;
  status: string | undefined;
  createdAtMs: number | undefined;
  completedAtMs: number | undefined;
  completedAtIsNull: boolean;
};
export declare const eventCurrentRoundIndex: (
  event: EventDocument,
  fallback: number,
) => number;
export declare const eventParticipantJoinedOrder: (
  participant: EventParticipantDocument,
  fallback?: number,
) => number;
export declare function eventParticipants(
  event: EventDocument | null | undefined,
): EventParticipantsDocument | null;
export declare function plainEventParticipants(
  event: EventDocument,
): EventParticipantsDocument | null;
export declare function eventRounds(
  event: EventDocument | null | undefined,
): EventRoundsDocument | null;
export declare function eventThirdPlaceMatch(
  event: EventDocument | null | undefined,
): EventMatchDocument | null;
export declare function eventRoundAt(
  rounds: EventRoundsDocument | null | undefined,
  key: string,
): EventRoundDocument | null;
export declare function eventRoundMatches(
  round: EventRoundDocument | null | undefined,
): EventMatchesDocument | null;
export declare function eventMatchAt(
  matches: EventMatchesDocument | null | undefined,
  key: string,
): EventMatchDocument | null;
export declare function eventMatchEntryKind(
  matches: EventMatchesDocument | null | undefined,
  key: string,
): "missing" | "match" | "invalid";
export declare function eventPlacementMatches(
  round: EventRoundDocument | null,
): Record<
  string,
  {
    present: boolean;
    match: EventMatchDocument | null;
  }
>;
export declare function eventParticipantAt(
  participants: EventParticipantsDocument | null | undefined,
  key: string,
): EventParticipantDocument | null;
export declare function plainEventParticipantAt(
  participants: EventParticipantsDocument | null | undefined,
  key: string,
): EventParticipantDocument | null;
export declare function eventParticipantIsAbsent(
  participants: EventParticipantsDocument | null,
  profileId: string,
): boolean;
export declare function eventParticipantEntries(
  participants: EventParticipantsDocument | null | undefined,
): Array<[string, EventParticipantDocument]>;
export declare function plainEventParticipantEntries(
  participants: EventParticipantsDocument | null | undefined,
): Array<[string, EventParticipantDocument]>;
export declare function eventMatchEntries(
  matches: EventMatchesDocument | null | undefined,
): Array<[string, EventMatchDocument | null]>;
export declare function eventPrizeOwnerProfileIds(
  event: EventDocument,
): string[];
export declare function eventPrizeAssignments(
  event: EventDocument | null | undefined,
  eventId: string,
): Record<string, EventPrizeAssignmentRecord>;
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
export declare const createEventDocument: (value: EventWrite) => EventDocument;
export declare const createEventParticipantDocument: (
  value: EventParticipantWrite,
) => EventParticipantDocument;
export declare const createEventMatchDocument: (
  value: EventMatchWrite,
) => EventMatchDocument;
export declare const createEventRoundDocument: (
  value: EventRoundWrite,
) => EventRoundDocument;
export declare const createEventParticipantsDocument: (
  value?: Record<string, EventParticipantDocument>,
) => EventParticipantsDocument;
export declare const createEventRoundsDocument: (
  value?: Record<string, EventRoundDocument>,
) => EventRoundsDocument;
export declare const createEventMatchesDocument: (
  value?: Record<string, EventMatchDocument>,
) => EventMatchesDocument;
export declare function patchEventDocument(
  event: EventDocument,
  patch: EventPatch,
): void;
export declare function patchEventMatch(
  match: EventMatchDocument,
  patch: EventMatchPatch,
): void;
export declare function patchEventRound(
  round: EventRoundDocument,
  patch: EventRoundPatch,
): void;
export declare function copyEventParticipant(
  participant: EventParticipantDocument,
  patch: EventParticipantPatch,
): EventParticipantDocument;
export declare function copyEventDocument(
  event: EventDocument,
  patch: EventPatch,
): EventDocument;
export declare function copyEventParticipants(
  participants: EventParticipantsDocument,
  replacements: ReadonlyMap<string, EventParticipantDocument>,
): EventParticipantsDocument;
export declare function withEventParticipant(
  participants: EventParticipantsDocument | null,
  profileId: string,
  participant: EventParticipantDocument,
): EventParticipantsDocument;
export declare function setEventRound(
  rounds: EventRoundsDocument,
  key: string,
  round: EventRoundDocument,
): void;
export declare function setEventMatch(
  matches: EventMatchesDocument,
  key: string,
  match: EventMatchDocument,
): void;
export declare function cloneEventDocument(
  event: EventDocument,
  mode?: "json" | "structured",
): EventDocument;
export declare function cloneEventRounds(
  rounds: EventRoundsDocument,
): EventRoundsDocument;
export declare function cloneEventParticipants(
  participants: EventParticipantsDocument,
): EventParticipantsDocument;
export declare function cloneEventMatch(
  match: EventMatchDocument,
): EventMatchDocument;
export declare function setEventMatchSlotBlocked(
  match: EventMatchDocument,
  slot: "host" | "guest",
  blocked: boolean,
): boolean;
export declare function copyEventParticipantToMatchSlot(
  match: EventMatchDocument,
  slot: "host" | "guest",
  participant: EventParticipantDocument | null,
): boolean;
export declare function copyEventWinnerDisplayName(
  event: EventDocument,
  participant: EventParticipantDocument | null,
): void;
export declare function createEventMatchInvite(
  match: EventMatchDocument,
  value: Omit<EventInviteWrite, "eventMatchKey" | "eventOwned">,
  matchKey: string,
  useStoredMatchKey?: boolean,
): InviteDocument;
export {};
