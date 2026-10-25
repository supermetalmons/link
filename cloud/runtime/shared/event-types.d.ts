// Generated from src/shared/event-types.ts. Run npm run generate:runtime.
import type { EventPrizeId } from "./event-prizes.js";
export type EventStatus = "scheduled" | "active" | "ended" | "dismissed";
export type EventParticipantState = "active" | "eliminated" | "winner";
export type EventMatchStatus =
  "upcoming" | "pending" | "host" | "guest" | "bye";
export type EventRoundStatus = "upcoming" | "active" | "completed";
export declare const THIRD_PLACE_MATCH_KEY = "third_place";
export interface EventParticipantView {
  profileId: string;
  loginUid: string;
  username: string;
  displayName: string;
  emojiId: number;
  aura: string;
  joinedAtMs: number;
  state: EventParticipantState;
  eliminatedRoundIndex: number | null;
  eliminatedByProfileId: string | null;
}
export interface EventMatchView {
  matchKey: string;
  inviteId: string | null;
  status: EventMatchStatus;
  resolvedAtMs: number | null;
  winnerDisqualified: boolean;
  winnerProfileId: string | null;
  loserProfileId: string | null;
  hostSlotBlocked: boolean;
  hostProfileId: string | null;
  hostLoginUid: string | null;
  hostDisplayName: string | null;
  hostEmojiId: number | null;
  hostAura: string | null;
  guestSlotBlocked: boolean;
  guestProfileId: string | null;
  guestLoginUid: string | null;
  guestDisplayName: string | null;
  guestEmojiId: number | null;
  guestAura: string | null;
}
export interface EventRoundView {
  roundIndex: number;
  status: EventRoundStatus;
  createdAtMs: number;
  completedAtMs: number | null;
  matches: Record<string, EventMatchView>;
}
export type EventPrizePlace = 1 | 2 | 3;
export interface EventPrizeAssignmentView {
  eventId: string;
  profileId: string;
  place: EventPrizePlace;
  prizeId: EventPrizeId;
  assignedAtMs: number;
}
export type EventPrizeAssignmentsView = Partial<
  Record<`${EventPrizePlace}`, EventPrizeAssignmentView>
>;
export interface EventView {
  schemaVersion: number;
  eventId: string;
  isSundayMons: boolean;
  status: EventStatus;
  createdAtMs: number;
  updatedAtMs: number;
  startAtMs: number;
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
  thirdPlaceMatch?: EventMatchView | null;
  prizeSelectionsLockedAtMs?: number | null;
  prizeAssignments?: EventPrizeAssignmentsView;
  participants: Record<string, EventParticipantView>;
  rounds: Record<string, EventRoundView>;
}
