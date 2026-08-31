import {
  createProfileLinkProjectionCore,
  type ProfileLinkProjectionRepository,
  type ProfileLinkProjectionSummary as CoreProfileLinkProjectionSummary,
} from "../../../functions/profileLinkProjectionCore.js";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  createProfileGameProjectionRuntime,
  readProjectionOwnershipSnapshot,
  type ProfileGameProjectionRuntime,
} from "./profileGameProjectionRepository.ts";

export type ProfileLinkProjectionSummary = CoreProfileLinkProjectionSummary;

export type ProfileLinkProjectionRuntimeDependencies = {
  d1?: D1Database;
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  profileDb?: D1Database;
  projection?: ProfileGameProjectionRuntime;
  readProfileOwnershipSnapshot?: ProfileLinkProjectionRepository["readProfileOwnershipSnapshot"];
  rtdb?: Pick<GameplayRepository, "getRtdbPath">;
  wait?: (milliseconds: number) => Promise<void>;
  withInviteProjectionLock<T>(
    inviteId: string,
    work: () => Promise<T>,
  ): Promise<T>;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createProfileLinkProjectionRuntime(
  env: Env,
  dependencies: ProfileLinkProjectionRuntimeDependencies,
): {
  process(input: {
    cleanupProfileIds: string[];
    loginUid: string;
    matchCursor: string | null;
    profileId: string;
    sourceUpdatedAtMs: number;
  }): Promise<ProfileLinkProjectionSummary | null>;
} {
  const profileDb = dependencies.profileDb || env.PROFILE_DB;
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  const d1 = dependencies.d1 || env.PROFILE_GAMES_DB;
  const projection =
    dependencies.projection ||
    createProfileGameProjectionRuntime(env, {
      d1,
      logger: dependencies.logger,
      now: dependencies.now,
      profileDb,
      rtdb,
      wait: dependencies.wait,
    });
  const repository: ProfileLinkProjectionRepository = {
    async getMatchIds(loginUid) {
      const matches = toRecord(
        await rtdb.getRtdbPath(`players/${loginUid}/matches`, {
          shallow: true,
        }),
      );
      return matches ? Object.keys(matches) : [];
    },
    async inviteExists(inviteId) {
      const value = await rtdb.getRtdbPath(`invites/${inviteId}`, {
        shallow: true,
      });
      return value !== null && value !== undefined;
    },
    readProfileOwnershipSnapshot: (query) =>
      dependencies.readProfileOwnershipSnapshot
        ? dependencies.readProfileOwnershipSnapshot(query)
        : readProjectionOwnershipSnapshot(profileDb, query),
  };
  const core = createProfileLinkProjectionCore({
    logger: dependencies.logger,
    now: dependencies.now,
    recomputeInviteProjection: projection.recomputeInviteProjection,
    repository,
    withInviteProjectionLock: dependencies.withInviteProjectionLock,
  });
  return { process: core.processProfileLinkCatchup };
}
