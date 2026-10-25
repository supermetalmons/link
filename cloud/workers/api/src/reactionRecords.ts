import type { InviteRoomSnapshot } from "@mons/shared/reactions";

declare const storedReaction: unique symbol;
export type StoredReactionDocument = { readonly [storedReaction]: true };
export type StoredReactionSnapshot = Omit<InviteRoomSnapshot, "reactions"> & {
  reactions: Record<string, StoredReactionDocument>;
};

export function decodeStoredReaction(value: string): StoredReactionDocument {
  const parsed: unknown = JSON.parse(value);
  return parsed as StoredReactionDocument;
}

export function storedReactionUuid(value: StoredReactionDocument): unknown {
  const retained: unknown = value;
  return (retained as { uuid?: unknown }).uuid;
}
