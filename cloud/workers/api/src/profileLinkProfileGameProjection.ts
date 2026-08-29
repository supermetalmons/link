import {
  createProfileLinkProjectionCore,
  type ProfileLinkProjectionRepository,
  type ProfileLinkProjectionSummary as CoreProfileLinkProjectionSummary,
} from "../../../functions/profileLinkProjectionCore.js";
import {
  authDocumentName,
  createAuthFirestoreClient,
  type AuthFirestoreClient,
} from "./authFirestore.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  createProfileGameProjectionRuntime,
  type ProfileGameProjectionRuntime,
} from "./profileGameProjectionRepository.ts";
import { commitProfileGameProjectionWrites } from "./profileGamesD1.ts";
import {
  readCanonicalMergeTarget,
  readCanonicalProfile,
} from "./profileCanonicalD1.ts";
import {
  profileStorageUsesD1,
  readProfileStorageMode,
  type ProfileStorageMode,
} from "./profileStorageMode.ts";

export type ProfileLinkProjectionSummary = CoreProfileLinkProjectionSummary;

export type ProfileLinkProjectionRuntimeDependencies = {
  d1?: D1Database;
  firestore?: Pick<AuthFirestoreClient, "get">;
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  profileDb?: D1Database;
  projection?: ProfileGameProjectionRuntime;
  rtdb?: Pick<GameplayRepository, "getRtdbPath">;
  storageMode?: ProfileStorageMode;
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
  const useCanonical = profileStorageUsesD1(
    dependencies.storageMode || readProfileStorageMode(env),
  );
  const firestore = useCanonical
    ? dependencies.firestore
    : dependencies.firestore || createAuthFirestoreClient(env);
  const profileDb = dependencies.profileDb || env.PROFILE_DB;
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  const d1 = dependencies.d1 || env.PROFILE_GAMES_DB;
  const projection =
    dependencies.projection || createProfileGameProjectionRuntime(env);
  const repository: ProfileLinkProjectionRepository = {
    async deleteProfileGameProjections(profileId, inviteIds) {
      if (inviteIds.length === 0) {
        return 0;
      }
      await commitProfileGameProjectionWrites(
        d1,
        inviteIds.map((inviteId) => ({
          type: "delete",
          profileId,
          projectionId: inviteId,
        })),
      );
      return inviteIds.length;
    },
    getCurrentProfileLink: (loginUid) =>
      rtdb.getRtdbPath(`players/${loginUid}/profile`),
    async getMatches(loginUid) {
      return toRecord(
        await rtdb.getRtdbPath(`players/${loginUid}/matches`, {
          shallow: true,
        }),
      );
    },
    async getMergeTarget(profileId) {
      if (useCanonical) {
        const target = await readCanonicalMergeTarget(profileDb, profileId);
        return target ? { targetProfileId: target.targetProfileId } : null;
      }
      return (
        (
          await firestore!.get(
            authDocumentName("profileMergeTargets", profileId),
          )
        )?.fields || null
      );
    },
    async inviteExists(inviteId) {
      const value = await rtdb.getRtdbPath(`invites/${inviteId}`, {
        shallow: true,
      });
      return value !== null && value !== undefined;
    },
    async profileExists(profileId) {
      if (useCanonical) {
        return Boolean(await readCanonicalProfile(profileDb, profileId));
      }
      return Boolean(
        await firestore!.get(authDocumentName("users", profileId)),
      );
    },
  };
  const core = createProfileLinkProjectionCore({
    logger: dependencies.logger,
    now: dependencies.now,
    recomputeInviteProjection: projection.recomputeInviteProjection,
    repository,
    wait: dependencies.wait,
    withInviteProjectionLock: dependencies.withInviteProjectionLock,
  });
  return { process: core.processProfileLinkCatchup };
}
