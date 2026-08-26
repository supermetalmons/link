import { resolveProfileMergeTargetPath } from "../../../functions/profileMergeTargets.js";
import {
  authDocumentName,
  authFieldFilter,
  createAuthFirestoreClient,
  type AuthFirestoreClient,
} from "./authFirestore.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";

type ProfileEventPrizeOwnerDependencies = {
  firestore?: Pick<AuthFirestoreClient, "get" | "query">;
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
  const firestore =
    dependencies.firestore ||
    createAuthFirestoreClient(env, { signal: dependencies.signal });
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  return async ({ eventId, profileId }) => {
    const sourceProfileId = cleanString(profileId);
    if (!sourceProfileId) {
      return "";
    }
    const mergePath = await resolveProfileMergeTargetPath({
      profileId: sourceProfileId,
      readMergeTarget: async (candidateProfileId: string) =>
        (
          await firestore.get(
            authDocumentName("profileMergeTargets", candidateProfileId),
          )
        )?.fields || null,
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
    if (!loginUid) {
      return sourceProfileId;
    }
    const profiles = await firestore.query(
      "users",
      authFieldFilter("logins", "ARRAY_CONTAINS", loginUid),
      2,
      ["mergedIntoProfileId"],
    );
    if (profiles.length > 1) {
      throw new Error("login-profile-conflict");
    }
    const currentProfileId = profiles[0]?.id || "";
    return currentProfileId || sourceProfileId;
  };
}
