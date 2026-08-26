import {
  createProfileLinkProjectionCore,
  type ProfileLinkProjectionRepository,
  type ProfileLinkProjectionSummary as CoreProfileLinkProjectionSummary,
} from "../../../functions/profileLinkProjectionCore.js";
import {
  authDeleteWrite,
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
  projectionDocumentName,
  type ProfileGameProjectionRuntime,
} from "./profileGameProjectionRepository.ts";

export type ProfileLinkProjectionSummary = CoreProfileLinkProjectionSummary;

export type ProfileLinkProjectionRuntimeDependencies = {
  firestore?: Pick<AuthFirestoreClient, "commitWrites" | "get">;
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  projection?: ProfileGameProjectionRuntime;
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
  const firestore = dependencies.firestore || createAuthFirestoreClient(env);
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  const projection =
    dependencies.projection || createProfileGameProjectionRuntime(env);
  const repository: ProfileLinkProjectionRepository = {
    async deleteProfileGameProjections(profileId, inviteIds) {
      if (inviteIds.length === 0) {
        return 0;
      }
      await firestore.commitWrites(
        inviteIds.map((inviteId) =>
          authDeleteWrite(projectionDocumentName(profileId, inviteId)),
        ),
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
      return (
        (
          await firestore.get(
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
      return Boolean(await firestore.get(authDocumentName("users", profileId)));
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
