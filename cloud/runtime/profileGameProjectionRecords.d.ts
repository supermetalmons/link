// Generated from src/profileGameProjectionRecords.ts. Run npm run generate:runtime.
import type {
  NavigationEventStatus,
  NavigationGameStatus,
} from "@mons/shared/navigation";
declare const projectionDocument: unique symbol;
declare const projectionProfile: unique symbol;
export type ProfileGameProjectionDocument = {
  readonly [projectionDocument]: true;
};
export type ProjectionProfileDocument = {
  readonly [projectionProfile]: true;
};
export type GameProjectionWrite = {
  schemaVersion: 2;
  projectorVersion: 2;
  source: "rtdb-projector";
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
  automatchStateHint: string | null;
  automatchCanceledAt: number | null;
  latestMatchId: string;
  ownerProfileId: string;
  ownerRole: "host" | "guest";
  ownerLoginId: string | null;
  opponentProfileId: string | null;
  opponentLoginId: string | null;
  opponentName: string | null;
  opponentDisplayName: string | null;
  opponentEmoji: number | null;
  opponentEmojiId: number | null;
  listSortAt: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  lastEventFingerprint: string;
  lastEventType: string | null;
  lastEventReason: string | null;
  lastEventAt: number;
};
export type EventProjectionPayloadWrite = {
  schemaVersion: 1;
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
  participantPreview: Array<{
    profileId: string | null;
    displayName: string | null;
    emojiId: number | null;
    aura: string | null;
  }>;
  winnerDisplayName: string | null;
};
export type ProfileGameProjectionWrite =
  GameProjectionWrite | EventProjectionPayloadWrite;
export type ProjectionProfileWrite = {
  eth: string;
  sol: string;
  username: string;
  custom?: {
    emoji: string | number;
  };
  emoji?: string | number;
};
export declare function retainProfileGameProjection(
  value: unknown,
): ProfileGameProjectionDocument;
export declare function createGameProjection(
  value: GameProjectionWrite,
): ProfileGameProjectionDocument;
export declare function createEventProjection(
  value: EventProjectionPayloadWrite,
): ProfileGameProjectionDocument;
export declare function retainProjectionProfile(
  value: unknown,
): ProjectionProfileDocument;
export declare function createProjectionProfile(
  value: ProjectionProfileWrite,
): ProjectionProfileDocument;
export declare function projectionOwnerLoginId(
  value: ProfileGameProjectionDocument,
): string | null;
export declare function projectionOwnerRole(
  profileId: string,
  value: ProfileGameProjectionDocument | null,
): "host" | "guest" | null;
export declare function projectionOpponentName(
  value: ProfileGameProjectionDocument | null,
): string | null;
export declare function projectionOpponentEmoji(
  value: ProfileGameProjectionDocument | null,
): number | null;
export declare function projectionFreshness(
  value: ProfileGameProjectionDocument,
): number;
export declare function projectionLastFingerprint(
  value: ProfileGameProjectionDocument | null,
): string | null;
export declare function projectionTime(
  value: ProfileGameProjectionDocument | null,
  field: "listSortAt" | "createdAt" | "endedAt",
): number | null;
export declare function projectionMergeFreshness(
  value: ProfileGameProjectionDocument,
): number;
export declare function copyProjectionOwner(
  value: ProfileGameProjectionDocument,
  ownerProfileId: string,
): ProfileGameProjectionDocument;
export {};
