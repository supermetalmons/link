import { applicationStorageKey } from "../session/applicationDataStorage.ts";
import type { PlayerProfile } from "../connection/connectionModels";
import { storage } from "./storage";

type ProfileCosmetics = Pick<
  PlayerProfile,
  | "cardBackgroundId"
  | "cardStickers"
  | "cardSubtitleId"
  | "profileCounter"
  | "profileMons"
>;

export function createProfileCosmeticWrites(
  profile: ProfileCosmetics,
): Array<{ read(): string | null; write(): void }> {
  return [
    {
      read: () =>
        localStorage.getItem(applicationStorageKey("cardBackgroundId")),
      write: () => storage.setCardBackgroundId(profile.cardBackgroundId),
    },
    {
      read: () => localStorage.getItem(applicationStorageKey("cardStickers")),
      write: () => storage.setCardStickers(profile.cardStickers),
    },
    {
      read: () => localStorage.getItem(applicationStorageKey("cardSubtitleId")),
      write: () => storage.setCardSubtitleId(profile.cardSubtitleId),
    },
    {
      read: () => localStorage.getItem(applicationStorageKey("profileCounter")),
      write: () => storage.setProfileCounter(profile.profileCounter),
    },
    {
      read: () => localStorage.getItem(applicationStorageKey("profileMons")),
      write: () => storage.setProfileMons(profile.profileMons),
    },
  ];
}
