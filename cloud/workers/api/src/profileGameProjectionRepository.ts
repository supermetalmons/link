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
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { canonicalProfileFields } from "./gameplayCanonicalRepository.ts";
import {
  readCanonicalMergeTarget,
  readCanonicalProfile,
  readCanonicalProfileByLogin,
} from "./profileCanonicalD1.ts";
import {
  commitProfileGameProjectionWrites,
  getProfileGameProjection,
  type ProjectionWrite as D1ProjectionWrite,
} from "./profileGamesD1.ts";

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
  d1?: D1Database;
  logger?: Pick<Console, "error">;
  now?: () => number;
  profileDb?: D1Database;
  rtdb?: ProjectionRtdbRepository;
  wait?: (milliseconds: number) => Promise<void>;
};

function toD1ProjectionWrite(
  write: ProjectionWrite | EventProjectionWrite,
): D1ProjectionWrite {
  return {
    type: write.type,
    profileId: write.profileId,
    projectionId:
      "inviteId" in write ? write.inviteId : `event_${write.eventId}`,
    ...(write.data ? { data: write.data } : {}),
    ...(write.type === "update" && "updateTime" in write
      ? { updateTime: write.updateTime }
      : {}),
    ...(write.type === "create" ? { requireAbsent: true } : {}),
  };
}

export function createProfileGameProjectionRuntime(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): ProfileGameProjectionRuntime {
  const profileDb = dependencies.profileDb || env.PROFILE_DB;
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  const d1 = dependencies.d1 || env.PROFILE_GAMES_DB;
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
      await commitProfileGameProjectionWrites(
        d1,
        writes.map(toD1ProjectionWrite),
      );
    },

    async findProfileByLogin(loginUid) {
      const profile = await readCanonicalProfileByLogin(profileDb, loginUid);
      return profile
        ? { id: profile.profileId, data: canonicalProfileFields(profile) }
        : null;
    },

    async getMergeTarget(profileId) {
      const target = await readCanonicalMergeTarget(profileDb, profileId);
      return target ? { targetProfileId: target.targetProfileId } : null;
    },

    async getProfile(profileId) {
      const profile = await readCanonicalProfile(profileDb, profileId);
      return profile
        ? {
            data: canonicalProfileFields(profile),
            updateTime: String(profile.revision),
          }
        : null;
    },

    async getProjection(profileId, inviteId) {
      return getProfileGameProjection(d1, profileId, inviteId);
    },

    getRtdbPath: (path) => rtdb.getRtdbPath(path),
  };
  return createProfileGamesProjectionCore({
    logger,
    repository,
    wait: dependencies.wait,
  });
}

export function createEventProfileGameProjectionRuntime(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): EventProfileGameProjectionRuntime {
  const profileDb = dependencies.profileDb || env.PROFILE_DB;
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  const d1 = dependencies.d1 || env.PROFILE_GAMES_DB;
  const repository: EventProfileGameProjectionRepository = {
    async commitProjectionWrites(writes) {
      await commitProfileGameProjectionWrites(
        d1,
        writes.map(toD1ProjectionWrite),
      );
    },

    async getEvent(eventId) {
      const event = await rtdb.getRtdbPath(`events/${eventId}`);
      return event && typeof event === "object" && !Array.isArray(event)
        ? (event as Record<string, unknown>)
        : null;
    },

    async getMergeTarget(profileId) {
      const target = await readCanonicalMergeTarget(profileDb, profileId);
      return target ? { targetProfileId: target.targetProfileId } : null;
    },

    async getProfile(profileId) {
      const profile = await readCanonicalProfile(profileDb, profileId);
      return profile
        ? {
            data: canonicalProfileFields(profile),
            updateTime: String(profile.revision),
          }
        : null;
    },
  };
  return createEventProfileGameProjectionCore({
    now: dependencies.now,
    repository,
    wait: dependencies.wait,
  });
}
