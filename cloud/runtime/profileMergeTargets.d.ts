// Generated from src/profileMergeTargets.ts. Run npm run generate:runtime.
export declare const MAX_PROFILE_MERGE_TARGET_HOPS = 32;
export declare const getProfileMergeTargetId: (value: unknown) => string;
export type ProfileMergeTargetOptions = {
  profileId: unknown;
  readMergeTarget: (profileId: string) => unknown | Promise<unknown>;
  maxHops?: unknown;
};
export declare const resolveProfileMergeTargetPath: ({
  profileId,
  readMergeTarget,
  maxHops,
}: ProfileMergeTargetOptions) => Promise<string[]>;
export declare const orderProfileMergeCleanupIds: (
  profileIds: readonly unknown[] | null | undefined,
  canonicalProfileIds: readonly unknown[] | null | undefined,
) => string[];
