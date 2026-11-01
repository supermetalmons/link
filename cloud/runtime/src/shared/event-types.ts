import type { EventPrizeAssignmentWireRecord } from "./event-prizes.js";
import type { Aura, EmojiId } from "./appearance.js";

export type EventStatus = "scheduled" | "active" | "ended" | "dismissed";
export type EventParticipantState = "active" | "eliminated" | "winner";
export type EventMatchStatus =
  "upcoming" | "pending" | "host" | "guest" | "bye";
export type EventRoundStatus = "upcoming" | "active" | "completed";

export const THIRD_PLACE_MATCH_KEY = "third_place";

export interface EventParticipantFields {
  profileId: string;
  loginUid: string | null;
  username: string;
  displayName: string;
  emojiId: EmojiId;
  aura: Aura;
  joinedAtMs: number;
  state: EventParticipantState;
  eliminatedRoundIndex: number | null;
  eliminatedByProfileId: string | null;
}

export type EventParticipantRecord = EventParticipantFields &
  (
    | {
        state: "active" | "winner";
        eliminatedRoundIndex: null;
        eliminatedByProfileId: null;
      }
    | {
        state: "eliminated";
        eliminatedRoundIndex: number;
        eliminatedByProfileId: string | null;
      }
  );
export type EventParticipantView = EventParticipantRecord;

export interface EventMatchFields {
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
  hostEmojiId: EmojiId | null;
  hostAura: Aura | null;
  guestSlotBlocked: boolean;
  guestProfileId: string | null;
  guestLoginUid: string | null;
  guestDisplayName: string | null;
  guestEmojiId: EmojiId | null;
  guestAura: Aura | null;
}

export type EventMatchRecord = EventMatchFields &
  (
    | {
        status: "upcoming" | "pending";
        resolvedAtMs: null;
        winnerProfileId: null;
        loserProfileId: null;
        winnerDisqualified: false;
      }
    | {
        status: "upcoming" | "pending";
        resolvedAtMs: null;
        winnerProfileId: null;
        loserProfileId: null;
        winnerDisqualified: true;
      }
    | {
        status: "host" | "guest";
        resolvedAtMs: number;
        winnerProfileId: string;
        loserProfileId: string | null;
      }
    | {
        status: "bye";
        resolvedAtMs: number;
        winnerProfileId: string | null;
        loserProfileId: null;
      }
  );
export type EventMatchView = EventMatchRecord;

export interface EventRoundFields {
  roundIndex: number;
  status: EventRoundStatus;
  createdAtMs: number;
  completedAtMs: number | null;
  matches: Record<string, EventMatchRecord>;
}

export type EventRoundRecord = EventRoundFields &
  (
    | { status: "upcoming" | "active"; completedAtMs: null }
    | { status: "completed"; completedAtMs: number }
  );
export type EventRoundView = EventRoundRecord;

type EventPrizePlace = 1 | 2 | 3;

export type EventPrizeAssignmentView = EventPrizeAssignmentWireRecord;

export type EventPrizeAssignmentsView = Partial<
  Record<`${EventPrizePlace}`, EventPrizeAssignmentView>
>;

export type EventTelegramAnnouncements = {
  invite: boolean;
  matches: boolean;
  results: boolean;
};
export type EventRoundBye = {
  profileId: string;
  reason: "preferred" | "random";
};

export interface EventRecordFields {
  schemaVersion: 3;
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
  bracketFormat: "fixed" | "archived-rolling";
  bracketSize: number;
  roundCount: number;
  roundByes: Record<string, EventRoundBye>;
  telegramAnnouncements: EventTelegramAnnouncements;
  telegramDeliveryVersion: 2;
  supportsThirdPlaceMatch: boolean;
  thirdPlaceMatch: EventMatchRecord | null;
  prizeSelectionsLockedAtMs: number | null;
  prizeAssignments: EventPrizeAssignmentsView;
  participants: Record<string, EventParticipantRecord>;
  rounds: Record<string, EventRoundRecord>;
}

export type EventRecord = EventRecordFields &
  (
    | {
        status: "scheduled";
        bracketFormat: "fixed";
        startedAtMs: null;
        endedAtMs: null;
        currentRoundIndex: null;
        bracketSize: 0;
        roundCount: 0;
        winnerProfileId: null;
        winnerDisplayName: null;
      }
    | {
        status: "dismissed";
        bracketFormat: "fixed";
        startedAtMs: null;
        endedAtMs: number;
        currentRoundIndex: null;
        bracketSize: 0;
        roundCount: 0;
        winnerProfileId: null;
        winnerDisplayName: null;
      }
    | {
        status: "active";
        bracketFormat: "fixed";
        startedAtMs: number;
        endedAtMs: null;
        currentRoundIndex: number;
        winnerProfileId: null;
        winnerDisplayName: null;
      }
    | {
        status: "ended";
        bracketFormat: "fixed";
        startedAtMs: number;
        endedAtMs: number;
        currentRoundIndex: number;
      }
    | {
        status: "ended";
        bracketFormat: "archived-rolling";
        bracketSize: 0;
        startedAtMs: number;
        endedAtMs: number;
        currentRoundIndex: number;
        winnerProfileId: string;
      }
  );
export type EventView = EventRecord;
