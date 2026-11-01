// Generated from src/profileGameProjectionRecords.ts. Run npm run generate:runtime.
import { type EmojiId } from "./shared/appearance.js";
import {
  type GameProjectionRecord,
  type EventProjectionRecord,
  type ProfileGameProjectionRecord,
} from "./shared/profile-game-projections.js";
export {
  parseProfileGameProjectionRecord,
  isProfileGameProjectionRecord,
} from "./shared/profile-game-projections.js";
export type ProfileGameProjectionDocument = ProfileGameProjectionRecord;
export type GameProjectionWrite = GameProjectionRecord;
export type EventProjectionPayloadWrite = EventProjectionRecord;
export type ProfileGameProjectionWrite = ProfileGameProjectionRecord;
export type ProjectionProfileDocument = {
  eth: string;
  sol: string;
  username: string;
  emoji: EmojiId | null;
};
export type ProjectionProfileWrite = ProjectionProfileDocument;
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
  _profileId: string,
  value: ProfileGameProjectionDocument | null,
): "host" | "guest" | null;
export declare function projectionOpponentName(
  value: ProfileGameProjectionDocument | null,
): string | null;
export declare function projectionOpponentEmoji(
  value: ProfileGameProjectionDocument | null,
): EmojiId | null;
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
