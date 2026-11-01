import { isEmojiId, type EmojiId } from "./shared/appearance.js";
import {
  parseProfileGameProjectionRecord,
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

export function retainProfileGameProjection(
  value: unknown,
): ProfileGameProjectionDocument {
  return parseProfileGameProjectionRecord(value);
}
export function createGameProjection(
  value: GameProjectionWrite,
): ProfileGameProjectionDocument {
  return parseProfileGameProjectionRecord(value);
}
export function createEventProjection(
  value: EventProjectionPayloadWrite,
): ProfileGameProjectionDocument {
  return parseProfileGameProjectionRecord(value);
}
export function retainProjectionProfile(
  value: unknown,
): ProjectionProfileDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid-projection-profile");
  const fields = Object.fromEntries(Object.entries(value));
  if (
    Object.keys(fields).length !== 4 ||
    typeof fields.eth !== "string" ||
    typeof fields.sol !== "string" ||
    typeof fields.username !== "string" ||
    !(fields.emoji === null || isEmojiId(fields.emoji))
  )
    throw new TypeError("invalid-projection-profile");
  return {
    eth: fields.eth,
    sol: fields.sol,
    username: fields.username,
    emoji: fields.emoji,
  };
}
export function createProjectionProfile(
  value: ProjectionProfileWrite,
): ProjectionProfileDocument {
  return retainProjectionProfile(value);
}
export function projectionOwnerLoginId(
  value: ProfileGameProjectionDocument,
): string | null {
  return value.entityType === "game" ? value.ownerLoginId : null;
}
export function projectionOwnerRole(
  _profileId: string,
  value: ProfileGameProjectionDocument | null,
): "host" | "guest" | null {
  return value?.entityType === "game" ? value.ownerRole : null;
}
export function projectionOpponentName(
  value: ProfileGameProjectionDocument | null,
): string | null {
  return value?.entityType === "game" ? value.opponentName : null;
}
export function projectionOpponentEmoji(
  value: ProfileGameProjectionDocument | null,
): EmojiId | null {
  return value?.entityType === "game" ? value.opponentEmoji : null;
}
export function projectionFreshness(
  value: ProfileGameProjectionDocument,
): number {
  return value.entityType === "game"
    ? Math.max(
        value.updatedAt,
        value.lastEventAt,
        value.listSortAt,
        value.createdAt,
      )
    : Math.max(value.updatedAt, value.listSortAt);
}
export function projectionLastFingerprint(
  value: ProfileGameProjectionDocument | null,
): string | null {
  return value?.entityType === "game" ? value.lastEventFingerprint : null;
}
export function projectionTime(
  value: ProfileGameProjectionDocument | null,
  field: "listSortAt" | "createdAt" | "endedAt",
): number | null {
  if (value === null) return null;
  if (field === "createdAt")
    return value.entityType === "game" ? value.createdAt : null;
  return value[field];
}
export function projectionMergeFreshness(
  value: ProfileGameProjectionDocument,
): number {
  return Math.max(value.updatedAt, value.listSortAt);
}
export function copyProjectionOwner(
  value: ProfileGameProjectionDocument,
  ownerProfileId: string,
): ProfileGameProjectionDocument {
  return parseProfileGameProjectionRecord({ ...value, ownerProfileId });
}
