import { resolveProfileMergeTargetPath } from "../../../functions/profileMergeTargets.js";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  readCanonicalLoginOwner,
  readCanonicalMergeTarget,
} from "./profileCanonicalD1.ts";

type ProfileEventPrizeOwnerDependencies = {
  profileDb?: D1Database;
  rtdb?: Pick<GameplayRepository, "getRtdbPath">;
  signal?: AbortSignal;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createProfileEventPrizeOwnerResolver(
  env: Env,
  dependencies: ProfileEventPrizeOwnerDependencies = {},
): (input: { eventId: string; profileId: string }) => Promise<string> {
  const profileDb = dependencies.profileDb || env.PROFILE_DB;
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  return async ({ eventId, profileId }) => {
    const sourceProfileId = cleanString(profileId);
    if (!sourceProfileId) return "";
    const mergePath = await resolveProfileMergeTargetPath({
      profileId: sourceProfileId,
      readMergeTarget: async (candidateProfileId: string) => {
        const target = await readCanonicalMergeTarget(
          profileDb,
          candidateProfileId,
        );
        return target ? { targetProfileId: target.targetProfileId } : null;
      },
    });
    const mergeTargetProfileId = mergePath.at(-1) || sourceProfileId;
    if (mergeTargetProfileId !== sourceProfileId) {
      return mergeTargetProfileId;
    }
    const participant = toRecord(
      await rtdb.getRtdbPath(
        `events/${eventId}/participants/${sourceProfileId}`,
        undefined,
        dependencies.signal,
      ),
    );
    const loginUid = cleanString(participant?.loginUid);
    if (!loginUid) return sourceProfileId;
    return (
      (await readCanonicalLoginOwner(profileDb, loginUid))?.profileId ||
      sourceProfileId
    );
  };
}
