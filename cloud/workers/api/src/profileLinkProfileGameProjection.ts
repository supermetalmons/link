import {
  createProfileLinkProjectionCore,
  type ProfileLinkProjectionRepository,
  type ProfileLinkProjectionSummary as CoreProfileLinkProjectionSummary,
} from "../../../runtime/profileLinkProjectionCore.js";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  listLoginMatchDiscoveryPage,
  readLoginMatchDiscoveryBackend,
} from "./loginMatchDiscoveryD1.ts";
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
  state?: Pick<GameplayRepository, "getStatePath">;
  wait?: (milliseconds: number) => Promise<void>;
  withInviteProjectionLock<T>(
    inviteId: string,
    work: () => Promise<T>,
  ): Promise<T>;
};

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
  const state = dependencies.state || createGameplayRepository(env);
  const d1 = dependencies.d1 || env.PROFILE_GAMES_DB;
  const projection =
    dependencies.projection ||
    createProfileGameProjectionRuntime(env, {
      d1,
      logger: dependencies.logger,
      now: dependencies.now,
      profileDb,
      state,
      wait: dependencies.wait,
    });
  const repository: ProfileLinkProjectionRepository = {
    async listMatchesPage(loginUid, afterMatchId, limit) {
      if ((await readLoginMatchDiscoveryBackend(d1)) !== "d1") {
        throw new Error("login-match-discovery-not-active");
      }
      return listLoginMatchDiscoveryPage(
        d1,
        loginUid,
        afterMatchId || null,
        limit,
      );
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
