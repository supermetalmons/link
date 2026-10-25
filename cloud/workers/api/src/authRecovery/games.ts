import {
  projectionMergeFreshness,
  copyProjectionOwner,
} from "../../../../runtime/profileGameProjectionRecords.js";
import {
  commitProfileGameProjectionWrites,
  getProfileGameProjections,
  listProfileGameProjectionPage,
} from "../profileGamesD1.ts";
import {
  mutateCanonicalRecoveryJob,
  type CanonicalRecoveryJob,
} from "./jobs.ts";
import { MERGE_GAME_FINALIZE_DELAY_MS } from "./policy.ts";

export function createGameRecovery({
  db,
  profileGamesDb,
  now,
}: {
  db: D1Database;
  profileGamesDb: D1Database;
  now: () => number;
}) {
  const recoverGames = async (
    job: CanonicalRecoveryJob,
    sourceProfileId: string,
  ): Promise<boolean> => {
    const sourcePage = await listProfileGameProjectionPage(
      profileGamesDb,
      sourceProfileId,
    );
    if (sourcePage.length > 0) {
      const targets = await getProfileGameProjections(
        profileGamesDb,
        job.profileId,
        sourcePage.map((game) => game.projectionId),
      );
      const writes = sourcePage.flatMap((game) => {
        const current = targets.get(game.projectionId);
        const copy =
          !current ||
          projectionMergeFreshness(game.data) >=
            projectionMergeFreshness(current.data)
            ? [
                current
                  ? {
                      type: "update" as const,
                      profileId: job.profileId,
                      projectionId: game.projectionId,
                      data: copyProjectionOwner(game.data, job.profileId),
                      expectedVersion: current.version,
                    }
                  : {
                      type: "create" as const,
                      profileId: job.profileId,
                      projectionId: game.projectionId,
                      data: copyProjectionOwner(game.data, job.profileId),
                      requireAbsent: true,
                    },
              ]
            : [];
        return [
          ...copy,
          {
            type: "delete" as const,
            profileId: sourceProfileId,
            projectionId: game.projectionId,
            expectedVersion: game.version,
          },
        ];
      });
      await commitProfileGameProjectionWrites(profileGamesDb, writes);
      const mutation = await mutateCanonicalRecoveryJob(
        db,
        job.profileId,
        (live) =>
          live.sourceProfileIds[0] === sourceProfileId &&
          live.sourcePhase === "games"
            ? { ...live, phaseStartedAtMs: now(), updatedAtMs: now() }
            : undefined,
      );
      return mutation === "updated";
    }
    if (now() - job.phaseStartedAtMs < MERGE_GAME_FINALIZE_DELAY_MS)
      return false;
    const mutation = await mutateCanonicalRecoveryJob(
      db,
      job.profileId,
      (live) =>
        live.sourceProfileIds[0] === sourceProfileId &&
        live.sourcePhase === "games"
          ? {
              ...live,
              sourcePhase: "finalize",
              prizeCursor: null,
              phaseStartedAtMs: now(),
              updatedAtMs: now(),
            }
          : undefined,
    );
    return mutation === "updated";
  };

  return { recoverGames };
}
