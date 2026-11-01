import {
  isInviteReaction,
  type InviteReaction,
  type InviteRoomSnapshot,
} from "@mons/shared/reactions";

export type StoredReactionDocument = InviteReaction;
export type StoredReactionSnapshot = InviteRoomSnapshot;

export function decodeStoredReaction(value: string): StoredReactionDocument {
  const parsed: unknown = JSON.parse(value);
  if (!isInviteReaction(parsed)) throw new TypeError("invalid-stored-reaction");
  return parsed;
}

export function storedReactionUuid(value: StoredReactionDocument): string {
  return value.uuid;
}
