import { STATE_FAILURE_MESSAGES } from "../stateCompatibility.ts";
import { isCanonicalLoginUid } from "../recordKeys.ts";
import type { ProfileLinkCatchupStore } from "../profileLinkCatchupD1.ts";
import type { ProfileLinkProfileGameProjectionTask } from "../profileGameProjectionTasks.ts";
import {
  RETRY_DELAY_SECONDS,
  exactDocumentId,
  mutateCanonicalRecoveryJob,
  type AuthRecoveryTask,
} from "./jobs.ts";

export async function enqueueAuthRecovery(
  env: Env,
  profileId: string,
): Promise<void> {
  const canonicalProfileId = exactDocumentId(profileId);
  if (!canonicalProfileId) {
    throw new TypeError("invalid-profile-id");
  }
  await env.AUTH_RECOVERY_QUEUE.send(
    {
      kind: "auth-profile-recovery",
      profileId: canonicalProfileId,
    } satisfies AuthRecoveryTask,
    { delaySeconds: RETRY_DELAY_SECONDS },
  );
}

export async function dispatchProfileLinkCatchupForOwner(
  uid: string,
  profileId: string,
  dependencies: {
    catchupStore: Pick<ProfileLinkCatchupStore, "readForOwner">;
    enqueueProfileLinkProjection?: (
      task: ProfileLinkProfileGameProjectionTask,
    ) => Promise<unknown>;
    logger?: Pick<Console, "error">;
  },
): Promise<void> {
  if (!isCanonicalLoginUid(uid)) {
    throw new TypeError(STATE_FAILURE_MESSAGES.invalidLoginUid);
  }
  const catchup = await dependencies.catchupStore.readForOwner(uid, profileId);
  if (catchup && dependencies.enqueueProfileLinkProjection) {
    try {
      await dependencies.enqueueProfileLinkProjection({
        kind: "profile-link-profile-game-projection",
        loginUid: uid,
        requestId: catchup.requestId,
      });
    } catch {
      (dependencies.logger || console).error(
        JSON.stringify({
          event: "profile_link_profile_game_projection_enqueue_failed",
          loginUid: uid,
        }),
      );
    }
  }
}

export async function enqueuePersistedCanonicalAuthRecovery(
  env: Env,
  db: D1Database,
  profileId: string,
  nowMs: number,
): Promise<void> {
  await enqueueAuthRecovery(env, profileId);
  await mutateCanonicalRecoveryJob(db, profileId, (job) => ({
    ...job,
    lastEnqueuedAtMs: nowMs,
    updatedAtMs: nowMs,
  }));
}
