export const MAX_PROFILE_MERGE_TARGET_HOPS = 32;

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

export const getProfileMergeTargetId = (value: unknown): string => {
  if (typeof value === "string") {
    return normalizeString(value);
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return normalizeString(
    (value as { targetProfileId?: unknown }).targetProfileId,
  );
};

export type ProfileMergeTargetOptions = {
  profileId: unknown;
  readMergeTarget: (profileId: string) => unknown | Promise<unknown>;
  maxHops?: unknown;
};

export const resolveProfileMergeTargetPath = async ({
  profileId,
  readMergeTarget,
  maxHops = MAX_PROFILE_MERGE_TARGET_HOPS,
}: ProfileMergeTargetOptions): Promise<string[]> => {
  let currentProfileId = normalizeString(profileId);
  if (!currentProfileId) {
    return [];
  }
  if (typeof readMergeTarget !== "function") {
    throw new Error("profile-merge-target-reader-required");
  }

  const profileIds: string[] = [];
  const visitedProfileIds = new Set<string>();
  const normalizedMaxHops = Math.max(1, Math.floor(Number(maxHops)) || 1);
  let followedTargets = 0;
  while (true) {
    if (visitedProfileIds.has(currentProfileId)) {
      throw new Error("profile-merge-target-cycle");
    }
    visitedProfileIds.add(currentProfileId);
    profileIds.push(currentProfileId);
    const nextProfileId = getProfileMergeTargetId(
      await readMergeTarget(currentProfileId),
    );
    if (!nextProfileId) {
      return profileIds;
    }
    followedTargets += 1;
    if (followedTargets > normalizedMaxHops) {
      throw new Error("profile-merge-target-depth-exceeded");
    }
    currentProfileId = nextProfileId;
  }
};

export const orderProfileMergeCleanupIds = (
  profileIds: readonly unknown[] | null | undefined,
  canonicalProfileIds: readonly unknown[] | null | undefined,
): string[] => {
  const normalizedProfileIds = Array.from(
    new Set((profileIds || []).map(normalizeString).filter(Boolean)),
  );
  const canonicalIds = new Set(
    (canonicalProfileIds || []).map(normalizeString).filter(Boolean),
  );
  return [
    ...normalizedProfileIds.filter((profileId) => !canonicalIds.has(profileId)),
    ...normalizedProfileIds.filter((profileId) => canonicalIds.has(profileId)),
  ];
};
