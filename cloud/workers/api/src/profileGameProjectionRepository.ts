import { PROFILE_MERGE_TARGETS_COLLECTION } from "../../../functions/profileMergeTargets.js";
import {
  createEventProfileGameProjectionCore,
  type EventProfileGameProjectionRepository,
  type EventProjectionWrite,
} from "../../../functions/eventProfileGameProjectionCore.js";
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

export type EventProfileGameProjectionRuntime = {
  reconcileEventProjection(
    eventId: string,
    cleanupOwnerProfileIds?: string[],
  ): Promise<{
    deleted: number;
    ownerProfileIds: string[];
    status: "missing" | "projected";
    written: number;
  }>;
};

type ProfileGameProjectionDependencies = {
  firestore?: AuthFirestoreClient;
  logger?: Pick<Console, "error">;
  now?: () => number;
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

function eventProjectionDocumentName(
  profileId: string,
  eventId: string,
): string {
  return projectionDocumentName(profileId, `event_${eventId}`);
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

function toEventFirestoreWrite(write: EventProjectionWrite) {
  const name = eventProjectionDocumentName(write.profileId, write.eventId);
  if (write.type === "delete") {
    return authDeleteWrite(name);
  }
  if (!write.data) {
    throw new TypeError("event profile-game projection data is required");
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

export function createEventProfileGameProjectionRuntime(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): EventProfileGameProjectionRuntime {
  const firestore = dependencies.firestore || createAuthFirestoreClient(env);
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  const repository: EventProfileGameProjectionRepository = {
    async commitProjectionWrites(writes) {
      await firestore.commitWrites(writes.map(toEventFirestoreWrite));
    },

    async getEvent(eventId) {
      const event = await rtdb.getRtdbPath(`events/${eventId}`);
      return event && typeof event === "object" && !Array.isArray(event)
        ? (event as Record<string, unknown>)
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
  };
  return createEventProfileGameProjectionCore({
    now: dependencies.now,
    repository,
    timestampFromMillis: firestoreTimestampFromMillis,
    wait: dependencies.wait,
  });
}

export {
  eventProjectionDocumentName,
  firestoreTimestampFromMillis as timestampFromMillis,
  projectionDocumentName,
  toEventFirestoreWrite,
};
