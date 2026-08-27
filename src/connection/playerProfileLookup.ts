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
    const profile = await lookup.getProfileById(linkedProfileId);
    if (profile) {
      return profile;
    }
  }

  return lookup.getProfileByLoginId(loginId);
};

export const resolvePlayerProfileWithRetry = async (
  loginId: string,
  lookup: PlayerProfileLookup,
  isCurrent: () => boolean,
  wait: () => Promise<void>,
): Promise<PlayerProfile | null> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!isCurrent()) {
      return null;
    }
    try {
      const profile = await resolvePlayerProfile(loginId, lookup);
      return isCurrent() ? profile : null;
    } catch (error) {
      if (!isCurrent()) {
        return null;
      }
      if (attempt === 1) {
        throw error;
      }
      await wait();
    }
  }
  return null;
};
