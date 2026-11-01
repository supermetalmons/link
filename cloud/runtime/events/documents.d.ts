// Generated from src/events/documents.ts. Run npm run generate:runtime.
import {
  type InviteDocument,
  type EventInviteWrite,
} from "../shared/invite-records.js";
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
export declare const readEventDocument: (
  value: unknown,
) => EventDocument | null;
export declare const readPlainEventDocument: (
  value: unknown,
) => EventDocument | null;
export declare const readEventParticipantDocument: (
  value: unknown,
) => EventParticipantDocument | null;
export declare const readPlainEventParticipantDocument: (
  value: unknown,
) => EventParticipantDocument | null;
export declare const readEventMatchDocument: (
  value: unknown,
) => EventMatchDocument | null;
export declare const readEventRoundDocument: (
  value: unknown,
) => EventRoundDocument | null;
export declare const readEventParticipantsDocument: (
  value: unknown,
) => EventParticipantsDocument | null;
export declare const readEventRoundsDocument: (
  value: unknown,
) => EventRoundsDocument | null;
export declare const readEventMatchesDocument: (
  value: unknown,
) => EventMatchesDocument | null;
export declare function eventState(event: EventDocument | null | undefined): {
  eventId: string | undefined;
  status: "ended" | "active" | "dismissed" | "scheduled" | undefined;
  createdAtMs: number | undefined;
  updatedAtMs: number | undefined;
  startAtMs: number | undefined;
  startedAtMs: number | null | undefined;
  endedAtMs: number | null | undefined;
  currentRoundIndex: number | null | undefined;
  bracketSize: number | undefined;
  roundCount: number | undefined;
  createdByLoginUid: string | undefined;
  createdByProfileId: string | undefined;
  winnerProfileId: string | null | undefined;
  winnerDisplayName: string | null | undefined;
  prizeSelectionsLockedAtMs: number | null | undefined;
  hasPrizeSelectionLock: boolean;
  supportsThirdPlaceMatch: boolean;
};
export declare function eventParticipantState(
  participant: EventParticipantDocument | null | undefined,
): {
  profileId: string | undefined;
  loginUid: string | null | undefined;
  username: string | undefined;
  displayName: string | undefined;
  emojiId: number | undefined;
  aura: import("../shared/appearance.js").Aura | undefined;
  joinedAtMs: number | undefined;
  state: "active" | "eliminated" | "winner" | undefined;
  eliminatedRoundIndex: number | null | undefined;
  eliminatedByProfileId: string | null | undefined;
};
export declare const eventParticipantProjectionState: typeof eventParticipantState;
export declare function eventMatchState(
  match: EventMatchDocument | null | undefined,
): {
  matchKey: string | undefined;
  inviteId: string | null | undefined;
  status: "pending" | "host" | "guest" | "upcoming" | "bye" | undefined;
  resolvedAtMs: number | null | undefined;
  winnerDisqualified: boolean;
  winnerProfileId: string | null | undefined;
  loserProfileId: string | null | undefined;
  hostSlotBlocked: boolean;
  hostProfileId: string | null | undefined;
  hostLoginUid: string | null | undefined;
  hostDisplayName: string | null | undefined;
  hostEmojiId: number | null | undefined;
  hostAura: import("../shared/appearance.js").Aura | null | undefined;
  guestSlotBlocked: boolean;
  guestProfileId: string | null | undefined;
  guestLoginUid: string | null | undefined;
  guestDisplayName: string | null | undefined;
  guestEmojiId: number | null | undefined;
  guestAura: import("../shared/appearance.js").Aura | null | undefined;
};
export declare function eventRoundState(round: EventRoundDocument): {
  roundIndex: number;
  status: "active" | "completed" | "upcoming";
  createdAtMs: number;
  completedAtMs: number | null;
  completedAtIsNull: boolean;
};
export declare const eventCurrentRoundIndex: (
  event: EventDocument,
  fallback: number,
) => number;
export declare const eventParticipantJoinedOrder: (
  participant: EventParticipantDocument,
) => number;
export declare function eventParticipants(
  event: Pick<EventDocument, "participants"> | null | undefined,
): EventParticipantsDocument | null;
export declare const plainEventParticipants: typeof eventParticipants;
export declare const eventRounds: (
  event: EventDocument | null | undefined,
) => EventRoundsDocument | null;
export declare const eventThirdPlaceMatch: (
  event: EventDocument | null | undefined,
) => EventMatchDocument | null;
export declare const eventRoundAt: (
  rounds: EventRoundsDocument | null | undefined,
  key: string,
) => EventRoundDocument | null;
export declare const eventRoundMatches: (
  round: EventRoundDocument | null | undefined,
) => EventMatchesDocument | null;
export declare const eventMatchAt: (
  matches: EventMatchesDocument | null | undefined,
  key: string,
) => EventMatchDocument | null;
export declare const eventMatchEntryKind: (
  matches: EventMatchesDocument | null | undefined,
  key: string,
) => "missing" | "match";
export declare function eventPlacementMatches(
  round: EventRoundDocument | null,
): Record<
  string,
  {
    present: true;
    match: EventMatchDocument;
  }
>;
export declare const eventParticipantAt: (
  participants: EventParticipantsDocument | null | undefined,
  key: string,
) => EventParticipantDocument | null;
export declare const plainEventParticipantAt: (
  participants: EventParticipantsDocument | null | undefined,
  key: string,
) => EventParticipantDocument | null;
export declare const eventParticipantIsAbsent: (
  participants: EventParticipantsDocument | null,
  profileId: string,
) => boolean;
export declare const eventParticipantEntries: (
  participants: EventParticipantsDocument | null | undefined,
) => Array<[string, EventParticipantDocument]>;
export declare const plainEventParticipantEntries: (
  participants: EventParticipantsDocument | null | undefined,
) => Array<[string, EventParticipantDocument]>;
export declare const eventMatchEntries: (
  matches: EventMatchesDocument | null | undefined,
) => Array<[string, EventMatchDocument]>;
export declare const eventPrizeOwnerProfileIds: (
  event: EventDocument | null,
) => string[];
export declare function eventPrizeAssignments(
  event: EventDocument | null | undefined,
  eventId: string,
): Record<string, EventPrizeAssignmentRecord>;
export type EventParticipantWrite = EventParticipantFields;
export type EventParticipantPatch = Partial<EventParticipantFields>;
export type EventMatchWrite = EventMatchFields;
export type EventMatchPatch = Partial<EventMatchFields>;
export type EventRoundWrite = EventRoundFields;
export type EventRoundPatch = Partial<EventRoundFields>;
export type EventWrite = EventRecordFields;
export type EventPatch = Partial<EventRecordFields>;
export declare function createEventDocument(value: EventWrite): EventDocument;
export declare function createEventParticipantDocument(
  value: EventParticipantWrite,
): EventParticipantDocument;
export declare function createEventMatchDocument(
  value: EventMatchWrite,
): EventMatchDocument;
export declare function createEventRoundDocument(
  value: EventRoundWrite,
): EventRoundDocument;
export declare function createEventParticipantsDocument(
  value?: EventParticipantsDocument,
): EventParticipantsDocument;
export declare function createEventRoundsDocument(
  value?: EventRoundsDocument,
): EventRoundsDocument;
export declare function createEventMatchesDocument(
  value?: EventMatchesDocument,
): EventMatchesDocument;
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
  _mode?: "json" | "structured",
): EventDocument;
export declare const cloneEventRounds: (
  rounds: EventRoundsDocument,
) => EventRoundsDocument;
export declare const cloneEventParticipants: (
  participants: EventParticipantsDocument,
) => EventParticipantsDocument;
export declare const cloneEventMatch: (
  match: EventMatchDocument,
) => EventMatchDocument;
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
