import type { CanonicalProfileOwnershipSnapshot } from "./profileCanonicalD1.ts";
import type { ProfileOwnershipSnapshot } from "./profileOwnership.ts";

export function mapCanonicalOwnershipSnapshot(
  snapshot: CanonicalProfileOwnershipSnapshot,
): ProfileOwnershipSnapshot {
  return Object.freeze({
    canonicalProfileIdByProfileId: new Map(
      snapshot.canonicalProfileIdByProfileId,
    ),
    loginOwnerByUid: new Map(snapshot.loginOwnerByUid),
    loginUidsByProfileId: new Map(
      [...snapshot.loginOwnersByProfileId].map(([profileId, owners]) => [
        profileId,
        Object.freeze(owners.map((owner) => owner.loginUid)),
      ]),
    ),
    profileById: new Map(
      [...snapshot.profileById].map(([profileId, value]) => [
        profileId,
        Object.freeze({
          profile: Object.freeze({
            aura: value.profile.aura,
            emoji: value.gameplayEmoji,
            eth: value.profile.eth || "",
            profileId,
            rating:
              value.sortPresence.rating && value.sortValues.rating !== null
                ? value.sortValues.rating
                : 1500,
            sol: value.profile.sol || "",
            username: value.profile.username || "",
          }),
          revision: value.revision,
        }),
      ]),
    ),
  });
}
