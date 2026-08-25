import { PROFILE_MERGE_TARGETS_COLLECTION } from "../../../functions/profileMergeTargets.js";
import {
  createProfileGamesProjectionCore,
  type ProfileGamesProjectionRepository,
  type ProjectionWrite,
  type RecomputeInviteProjectionOptions,
  type RecomputeInviteProjectionResult,
} from "../../../functions/profileGamesProjectionCore.js";
import {
  AUTH_FIRESTORE_DATABASE_ROOT,
  authDeleteWrite,
  authDocumentName,
  authFieldFilter,
  authUpdateWrite,
  createAuthFirestoreClient,
  type AuthFirestoreClient,
} from "./authFirestore.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { firestoreTimestampFromMillis } from "./firestoreRest.ts";

type ProjectionRtdbRepository = Pick<GameplayRepository, "getRtdbPath">;

export type ProfileGameProjectionRuntime = {
  recomputeInviteProjection(
    inviteId: string,
    reason: string,
    options?: RecomputeInviteProjectionOptions,
  ): Promise<RecomputeInviteProjectionResult>;
};

type ProfileGameProjectionDependencies = {
  firestore?: AuthFirestoreClient;
  logger?: Pick<Console, "error">;
  rtdb?: ProjectionRtdbRepository;
  wait?: (milliseconds: number) => Promise<void>;
};

function projectionDocumentName(profileId: string, inviteId: string): string {
  if (
    !profileId ||
    !inviteId ||
    profileId.includes("/") ||
    inviteId.includes("/")
  ) {
    throw new TypeError("invalid profile game projection document id");
  }
  return `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/users/${profileId}/games/${inviteId}`;
}

function toFirestoreWrite(write: ProjectionWrite) {
  const name = projectionDocumentName(write.profileId, write.inviteId);
  if (write.type === "delete") {
    return authDeleteWrite(name);
  }
  if (!write.data) {
    throw new TypeError("profile game projection write data is required");
  }
  if (write.type === "create") {
    return authUpdateWrite(name, write.data, Object.keys(write.data), false);
  }
  if (write.type === "update") {
    if (!write.updateTime) {
      throw new TypeError("profile game projection update time is required");
    }
    return authUpdateWrite(name, write.data, Object.keys(write.data), {
      updateTime: write.updateTime,
    });
  }
  return authUpdateWrite(name, write.data);
}

export function createProfileGameProjectionRuntime(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): ProfileGameProjectionRuntime {
  const firestore = dependencies.firestore || createAuthFirestoreClient(env);
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  const logger: Pick<Console, "error"> = dependencies.logger || {
    error(message, ...optionalParams) {
      const context = optionalParams[0];
      console.error(
        JSON.stringify({
          event: "profile_game_projection_runtime_error",
          message: typeof message === "string" ? message : "projection-error",
          ...(context && typeof context === "object" && !Array.isArray(context)
            ? context
            : {}),
        }),
      );
    },
  };
  const repository: ProfileGamesProjectionRepository = {
    async commitProjectionWrites(writes) {
      await firestore.commitWrites(writes.map(toFirestoreWrite));
    },

    async findProfileByLogin(loginUid) {
      const profiles = await firestore.query(
        "users",
        authFieldFilter("logins", "ARRAY_CONTAINS", loginUid),
        1,
      );
      return profiles[0]
        ? { id: profiles[0].id, data: profiles[0].fields }
        : null;
    },

    async getMergeTarget(profileId) {
      return (
        (
          await firestore.get(
            authDocumentName(PROFILE_MERGE_TARGETS_COLLECTION, profileId),
          )
        )?.fields ?? null
      );
    },

    async getProfile(profileId) {
      const profile = await firestore.get(authDocumentName("users", profileId));
      return profile
        ? { data: profile.fields, updateTime: profile.updateTime }
        : null;
    },

    async getProjection(profileId, inviteId) {
      const projection = await firestore.get(
        projectionDocumentName(profileId, inviteId),
      );
      return projection
        ? { data: projection.fields, updateTime: projection.updateTime }
        : null;
    },

    getRtdbPath: (path) => rtdb.getRtdbPath(path),
  };
  return createProfileGamesProjectionCore({
    logger,
    repository,
    timestampFromMillis: firestoreTimestampFromMillis,
    wait: dependencies.wait,
  });
}

export {
  firestoreTimestampFromMillis as timestampFromMillis,
  projectionDocumentName,
};
