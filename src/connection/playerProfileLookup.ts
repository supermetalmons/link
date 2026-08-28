import type { PlayerProfile } from "./connectionModels";

export type PlayerProfileLookup = {
  getProfileByLoginId(loginId: string): Promise<PlayerProfile>;
};

export const resolvePlayerProfile = async (
  loginId: string,
  lookup: PlayerProfileLookup,
): Promise<PlayerProfile> => lookup.getProfileByLoginId(loginId);

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
