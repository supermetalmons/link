import { listProfileGameProjectionPage } from "../profileGamesD1.ts";
import { commitCanonicalPlan } from "../profileCanonicalD1.ts";
import { readCanonicalRecoveryFinalizationSnapshot } from "../profileCanonical/recoverySnapshot.ts";
import {
  canonicalRecoveryJob,
  canonicalRecoveryValue,
  mutateCanonicalRecoveryJob,
  type AuthRecoveryJob,
  type CanonicalRecoveryJob,
} from "./jobs.ts";
import type { PrizeCopyPage } from "./prizes.ts";

export function createSourceFinalization({
  db,
  profileGamesDb,
  now,
  copyPrizePage,
}: {
  db: D1Database;
  profileGamesDb: D1Database;
  now: () => number;
  copyPrizePage: PrizeCopyPage;
}) {
  const finalizeSource = async (
    job: CanonicalRecoveryJob,
    sourceProfileId: string,
  ): Promise<boolean> => {
    if (
      (await listProfileGameProjectionPage(profileGamesDb, sourceProfileId, 1))
        .length > 0
    ) {
      const mutation = await mutateCanonicalRecoveryJob(
        db,
        job.profileId,
        (live) =>
          live.sourceProfileIds[0] === sourceProfileId &&
          live.sourcePhase === "finalize"
            ? {
                ...live,
                sourcePhase: "games",
                phaseStartedAtMs: now(),
                updatedAtMs: now(),
              }
            : undefined,
      );
      return mutation === "updated";
    }
    const prizePage = await copyPrizePage(
      sourceProfileId,
      job.profileId,
      job.prizeCursor,
    );
    if (!prizePage.complete || prizePage.copied > 0) {
      const mutation = await mutateCanonicalRecoveryJob(
        db,
        job.profileId,
        (live) =>
          live.sourceProfileIds[0] === sourceProfileId &&
          live.sourcePhase === "finalize" &&
          live.prizeCursor === job.prizeCursor
            ? {
                ...live,
                prizeCursor: prizePage.nextCursor,
                updatedAtMs: now(),
              }
            : undefined,
      );
      return mutation === "updated";
    }
    const { target, source, mergePath } =
      await readCanonicalRecoveryFinalizationSnapshot(
        db,
        job.profileId,
        sourceProfileId,
      );
    if (!target.profile || !target.recovery || !mergePath) return false;
    const live = canonicalRecoveryJob(target.recovery);
    const firstTargetProfileId = mergePath[0].targetProfileId;
    const mergeExpectations = mergePath.map((mapping) => ({
      kind: "merge-target" as const,
      sourceProfileId: mapping.sourceProfileId,
      targetProfileId: mapping.targetProfileId,
    }));
    if (
      live.sourceProfileIds[0] !== sourceProfileId ||
      live.sourcePhase !== "finalize" ||
      (source.profile &&
        (source.profile.mergedIntoProfileId !== firstTargetProfileId ||
          source.loginOwners.length > 0))
    ) {
      return false;
    }
    const sourceProfileIds = source.profile
      ? live.sourceProfileIds
      : live.sourceProfileIds.slice(1);
    const updated: AuthRecoveryJob = {
      ...live,
      sourceProfileIds,
      sourcePhase: source.profile
        ? "games"
        : sourceProfileIds.length > 0
          ? "prizes"
          : "finalize",
      prizeCursor: null,
      phaseStartedAtMs: now(),
      updatedAtMs: now(),
    };
    await commitCanonicalPlan(db, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: target.profile.profileId,
          revision: target.profile.revision,
        },
        {
          kind: "auth-recovery-revision",
          profileId: live.profileId,
          revision: live.revision,
        },
        ...mergeExpectations,
        ...(source.profile
          ? ([
              {
                kind: "profile-revision",
                profileId: sourceProfileId,
                revision: source.profile.revision,
              },
            ] as const)
          : []),
      ],
      mutations: [
        ...(source.profile
          ? ([
              {
                kind: "delete-retired-profile",
                profileId: sourceProfileId,
                targetProfileId: firstTargetProfileId,
              },
            ] as const)
          : []),
        {
          kind: "update-auth-recovery",
          value: canonicalRecoveryValue(updated),
        },
      ],
    });
    return true;
  };

  return { finalizeSource };
}
