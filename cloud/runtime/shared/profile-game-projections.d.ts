// Generated from src/shared/profile-game-projections.ts. Run npm run generate:runtime.
import { type Aura, type EmojiId } from "./appearance.js";
import type {
  NavigationEventStatus,
  NavigationGameStatus,
} from "./navigation.js";
export declare const PROJECTION_SORT_BUCKETS: Readonly<{
  readonly pending: 20;
  readonly waiting: 30;
  readonly active: 40;
  readonly ended: 50;
  readonly dismissed: 50;
}>;
export type GameProjectionRecord = {
  schemaVersion: 3;
  projectorVersion: 3;
  source: "game-projector";
  entityType: "game";
  inviteId: string;
  kind: "auto" | "direct";
  hostLoginId: string | null;
  guestLoginId: string | null;
  hostProfileId: string | null;
  guestProfileId: string | null;
  status: NavigationGameStatus;
  sortBucket: number;
  isPendingAutomatch: boolean;
  automatchStateHint: "pending" | "matched" | "canceled" | null;
  automatchCanceledAt: number | null;
  latestMatchId: string;
  ownerProfileId: string;
  ownerRole: "host" | "guest";
  ownerLoginId: string | null;
  opponentProfileId: string | null;
  opponentLoginId: string | null;
  opponentName: string | null;
  opponentEmoji: EmojiId | null;
  listSortAt: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  lastEventFingerprint: string;
  lastEventType: string | null;
  lastEventReason: string | null;
  lastEventAt: number;
};
export type ProjectionParticipant = {
  profileId: string | null;
  displayName: string | null;
  emojiId: EmojiId | null;
  aura: Aura;
};
export type EventProjectionRecord = {
  schemaVersion: 2;
  source: "event-projector";
  entityType: "event";
  id: string;
  eventId: string;
  status: NavigationEventStatus;
  sortBucket: number;
  listSortAt: number;
  ownerProfileId: string;
  startAt: number | null;
  updatedAt: number;
  endedAt: number | null;
  participantCount: number;
  participantPreview: ProjectionParticipant[];
  winnerDisplayName: string | null;
};
export type ProfileGameProjectionRecord =
  GameProjectionRecord | EventProjectionRecord;
export declare function isGameProjectionRecord(
  value: unknown,
): value is GameProjectionRecord;
export declare function isEventProjectionRecord(
  value: unknown,
): value is EventProjectionRecord;
export declare function isProfileGameProjectionRecord(
  value: unknown,
): value is ProfileGameProjectionRecord;
export declare function parseProfileGameProjectionRecord(
  value: unknown,
): ProfileGameProjectionRecord;
