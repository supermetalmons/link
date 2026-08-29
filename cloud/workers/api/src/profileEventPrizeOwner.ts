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
import {
  readCanonicalMergeTarget,
  readCanonicalProfileByLogin,
} from "./profileCanonicalD1.ts";
import {
  profileStorageUsesD1,
  readProfileStorageMode,
  type ProfileStorageMode,
} from "./profileStorageMode.ts";

type ProfileEventPrizeOwnerDependencies = {
  firestore?: Pick<AuthFirestoreClient, "get" | "query">;
  profileDb?: D1Database;
  rtdb?: Pick<GameplayRepository, "getRtdbPath">;
  signal?: AbortSignal;
  storageMode?: ProfileStorageMode;
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
  const useCanonical = profileStorageUsesD1(
    dependencies.storageMode || readProfileStorageMode(env),
  );
  const firestore = useCanonical
    ? dependencies.firestore
    : dependencies.firestore ||
      createAuthFirestoreClient(env, { signal: dependencies.signal });
  const profileDb = dependencies.profileDb || env.PROFILE_DB;
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  return async ({ eventId, profileId }) => {
    const sourceProfileId = cleanString(profileId);
    if (!sourceProfileId) {
      return "";
    }
    const mergePath = await resolveProfileMergeTargetPath({
      profileId: sourceProfileId,
      readMergeTarget: async (candidateProfileId: string) =>
        useCanonical
          ? await readCanonicalMergeTarget(profileDb, candidateProfileId).then(
              (target) =>
                target ? { targetProfileId: target.targetProfileId } : null,
            )
          : (
              await firestore!.get(
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
    if (useCanonical) {
      return (
        (await readCanonicalProfileByLogin(profileDb, loginUid))?.profileId ||
        sourceProfileId
      );
    }
    const profiles = await firestore!.query(
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
