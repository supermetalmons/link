import type { EmojiId } from "@mons/shared/appearance";
import { materializeCanonicalProfileFields } from "./profileCanonical/profiles.ts";
import type {
  CanonicalProfileFieldsSnapshot,
  CanonicalProfileFieldsValue,
  CanonicalSortKey,
} from "./profileCanonical/types.ts";

export type MutableProfileUpdateOptions = {
  sortUpdates?: Partial<Record<CanonicalSortKey, number>>;
  winPresent?: boolean;
  emojiPresent?: boolean;
  gameplayEmoji?: EmojiId;
};

export function materializeProfileUpdateFields(
  snapshot: CanonicalProfileFieldsSnapshot,
  profile: CanonicalProfileFieldsSnapshot["profile"],
  updatedAtMs: number,
  {
    sortUpdates = {},
    winPresent = snapshot.winPresent,
    emojiPresent = snapshot.emojiPresent,
    gameplayEmoji = snapshot.gameplayEmoji,
  }: MutableProfileUpdateOptions = {},
): CanonicalProfileFieldsValue {
  return materializeCanonicalProfileFields({
    profile,
    createdAtMs: snapshot.createdAtMs,
    updatedAtMs,
    mergedAtMs: snapshot.mergedAtMs,
    mergedIntoProfileId: snapshot.mergedIntoProfileId,
    state: snapshot.state,
    sortPresence: {
      ...snapshot.sortPresence,
      ...Object.fromEntries(Object.keys(sortUpdates).map((key) => [key, true])),
    },
    sortValues: { ...snapshot.sortValues, ...sortUpdates },
    winPresent,
    emojiPresent,
    gameplayEmoji,
  });
}
