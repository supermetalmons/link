import { isAura, isEmojiId } from "@mons/shared/appearance";
import type { EventOwnershipSnapshot } from "../../../runtime/events/ownership.js";
import type { ProfileOwnershipSnapshot } from "./profileOwnership.ts";
import { AuthApiFailure } from "./authErrors.ts";

export function eventOwnershipSnapshot(
  snapshot: ProfileOwnershipSnapshot,
): EventOwnershipSnapshot {
  const profileById: Map<
    string,
    Readonly<{
      profile: import("../../../runtime/events/ownership.js").EventOwnershipProfile;
      revision: number;
    }>
  > = new Map();
  for (const [id, entry] of snapshot.profileById) {
    const { profile, revision } = entry;
    if (!isAura(profile.aura) || !isEmojiId(profile.emoji)) {
      throw new AuthApiFailure(
        503,
        "unavailable",
        "profile-ownership-unavailable",
      );
    }
    profileById.set(id, {
      profile: { ...profile, aura: profile.aura, emoji: profile.emoji },
      revision,
    });
  }
  return { ...snapshot, profileById };
}
