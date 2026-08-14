import type { PlayerProfile } from "./connectionModels";

export type PlayerProfileLookup = {
  readLinkedProfileId(loginId: string): Promise<unknown>;
  getProfileById(profileId: string): Promise<PlayerProfile | null>;
  getProfileByLoginId(loginId: string): Promise<PlayerProfile>;
};

const normalizeProfileId = (value: unknown): string | null => {
  const profileId = typeof value === "string" ? value.trim() : "";
  return profileId || null;
};

export const resolvePlayerProfile = async (
  loginId: string,
  lookup: PlayerProfileLookup,
): Promise<PlayerProfile> => {
  let linkedProfileId: string | null = null;
  try {
    linkedProfileId = normalizeProfileId(
      await lookup.readLinkedProfileId(loginId),
    );
  } catch {}

  if (linkedProfileId) {
    try {
      const profile = await lookup.getProfileById(linkedProfileId);
      if (profile) {
        return profile;
      }
    } catch {}
  }

  return lookup.getProfileByLoginId(loginId);
};
