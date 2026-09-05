import { type HistoricalMatchPair } from "@mons/shared/game-sessions";
import {
  createEventProfileGameProjectionCore,
  type EventProjectionCommitOptions,
  type EventProfileGameProjectionRepository,
  type EventProjectionSourceFence,
  type EventProjectionWrite,
} from "../../../functions/eventProfileGameProjectionCore.js";
import {
  createProfileGamesProjectionCore,
  type ProfileGamesProjectionRepository,
  type ProjectionOwnershipSnapshot,
  type ProjectionWrite,
  type RecomputeInviteProjectionOptions,
  type RecomputeInviteProjectionResult,
} from "../../../functions/profileGamesProjectionCore.js";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  readCanonicalProfileOwnershipSnapshot,
  type CanonicalProfileOwnershipProfileSnapshot,
  type CanonicalProfileOwnershipQuery,
} from "./profileCanonicalD1.ts";
import {
  commitProfileGameProjectionWrites,
  getProfileGameProjection,
  reserveEventProfileGameProjectionFence,
  type ProjectionWrite as D1ProjectionWrite,
} from "./profileGamesD1.ts";
import {
  readHistoricalMatchSnapshot,
  writeHistoricalMatchSnapshot,
} from "./historicalMatchesD1.ts";
import type { HistoricalMatchSource } from "./historicalMatches.ts";
import { readRatingCompletion } from "./ratingCompletionD1.ts";

type ProjectionRtdbRepository = Pick<GameplayRepository, "getRtdbPath">;

export type ProfileGameProjectionRuntime = {
  archiveHistoricalMatch?(input: {
    finalizedAtMs: number;
    inviteId: string;
    pair: HistoricalMatchPair;
    source: HistoricalMatchSource;
  }): Promise<void>;
  hasHistoricalMatch?(inviteId: string, matchId: string): Promise<boolean>;
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
    options?: EventProjectionCommitOptions,
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

function projectionProfileData(
  snapshot: CanonicalProfileOwnershipProfileSnapshot,
): Record<string, unknown> {
  const profile = snapshot.profile;
  return {
    eth: profile.eth || "",
    sol: profile.sol || "",
    username: profile.username || "",
    ...(snapshot.emojiPresent
      ? { custom: { emoji: profile.emoji } }
      : snapshot.gameplayEmoji !== ""
        ? { emoji: snapshot.gameplayEmoji }
        : {}),
  };
}

export async function readProjectionOwnershipSnapshot(
  profileDb: D1Database,
  query: CanonicalProfileOwnershipQuery,
): Promise<ProjectionOwnershipSnapshot> {
  const snapshot = await readCanonicalProfileOwnershipSnapshot(
    profileDb,
    query,
  );
  return Object.freeze({
    profileIdByLoginUid: new Map(
      [...snapshot.loginOwnerByUid].map(([loginUid, owner]) => [
        loginUid,
        owner?.profileId || null,
      ]),
    ),
    profileDataById: new Map(
      [...snapshot.profileById].map(([profileId, profile]) => [
        profileId,
        projectionProfileData(profile),
      ]),
    ),
  });
}

export async function readEventProjectionOwnershipSnapshot(
  profileDb: D1Database,
  query: CanonicalProfileOwnershipQuery,
) {
  const snapshot = await readCanonicalProfileOwnershipSnapshot(
    profileDb,
    query,
  );
  return Object.freeze({
    canonicalProfileIdByProfileId: new Map(
      snapshot.canonicalProfileIdByProfileId,
    ),
    loginOwnerByUid: new Map(
      [...snapshot.loginOwnerByUid].map(([loginUid, owner]) => [
        loginUid,
        owner
          ? Object.freeze({
              profileId: owner.profileId,
              revision: owner.revision,
            })
          : null,
      ]),
    ),
  });
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

    async getProjection(profileId, inviteId) {
      return getProfileGameProjection(d1, profileId, inviteId);
    },

    getRtdbPath: (path) => rtdb.getRtdbPath(path),

    hasCompletedRatingUpdate: (inviteId, matchId) =>
      readRatingCompletion(profileDb, inviteId, matchId),

    readProfileOwnershipSnapshot: (query) =>
      readProjectionOwnershipSnapshot(profileDb, query),
  };
  const projection = createProfileGamesProjectionCore({
    logger,
    repository,
    wait: dependencies.wait,
  });
  return {
    ...projection,
    async hasHistoricalMatch(inviteId, matchId) {
      return (
        (await readHistoricalMatchSnapshot(d1, inviteId, matchId)) !== null
      );
    },
    async archiveHistoricalMatch(input) {
      await writeHistoricalMatchSnapshot(d1, {
        ...input,
        archivedAtMs: Math.max(
          (dependencies.now || Date.now)(),
          input.finalizedAtMs,
        ),
      });
    },
  };
}

export function createEventProfileGameProjectionRuntime(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): EventProfileGameProjectionRuntime {
  const profileDb = dependencies.profileDb || env.PROFILE_DB;
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  const d1 = dependencies.d1 || env.PROFILE_GAMES_DB;
  const repository: EventProfileGameProjectionRepository = {
    async commitProjectionWrites(
      writes,
      sourceFence?: EventProjectionSourceFence,
    ) {
      await commitProfileGameProjectionWrites(
        d1,
        writes.map(toD1ProjectionWrite),
        sourceFence ? { eventFence: sourceFence } : undefined,
      );
    },

    async getEvent(eventId) {
      const event = await rtdb.getRtdbPath(`events/${eventId}`);
      return event && typeof event === "object" && !Array.isArray(event)
        ? (event as Record<string, unknown>)
        : null;
    },

    readProfileOwnershipSnapshot: (query) =>
      readEventProjectionOwnershipSnapshot(profileDb, query),
  };
  const projection = createEventProfileGameProjectionCore({
    now: dependencies.now,
    repository,
    wait: dependencies.wait,
  });
  return {
    async reconcileEventProjection(eventId, cleanupOwnerProfileIds, options) {
      const sourceFence = await reserveEventProfileGameProjectionFence(
        d1,
        eventId,
      );
      return projection.reconcileEventProjection(
        eventId,
        cleanupOwnerProfileIds,
        { ...options, sourceFence },
      );
    },
  };
}
