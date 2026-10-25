import { queueFor } from "../queueProducers.ts";
import {
  createD1AuthRecoveryPrizeStore,
  type AuthRecoveryPrizeStore,
} from "../eventRepository.ts";
import { isCanonicalLoginUid } from "../recordKeys.ts";
import {
  createProfileLinkCatchupStore,
  type ProfileLinkCatchupStore,
} from "../profileLinkCatchupD1.ts";
import {
  createD1EventPrizeWithdrawalStore,
  type EventPrizeWithdrawalStore,
} from "../eventPrizeWithdrawalD1.ts";
import {
  CanonicalProfileConflict,
  readCanonicalAuthRecoveryJob,
} from "../profileCanonicalD1.ts";
import { reportRecoveryFailure } from "../recoveryReporting.ts";
import { dispatchProfileLinkCatchupForOwner } from "./dispatch.ts";
import {
  canonicalRecoveryJob,
  mutateCanonicalRecoveryJob,
  removeCanonicalAuthRecoveryLoginUid,
  type AuthRecoveryOutcome,
  type CanonicalRecoveryJob,
} from "./jobs.ts";
import { createPrizeRecovery, type PrizeRecoveryOptions } from "./prizes.ts";
import { createGameRecovery } from "./games.ts";
import { createSourceFinalization } from "./finalization.ts";
import {
  AUTH_RECOVERY_PRIZE_OPERATION_TIMEOUT_MS,
  LOGIN_RECOVERY_PAGE_SIZE,
  MERGE_GAME_FINALIZE_DELAY_MS,
} from "./policy.ts";

export {
  MERGE_GAME_FINALIZE_DELAY_MS,
  MERGE_PRIZE_RECOVERY_PAGE_SIZE,
} from "./policy.ts";

const AUTH_RECOVERY_LOG_CODES = new Set([
  "auth-recovery-prize-lock-busy",
  "auth-recovery-prize-invalid",
  "auth-recovery-prize-lock-lost",
  "auth-recovery-prize-conflict",
]);

function authRecoveryLogError(error: unknown): unknown {
  try {
    if (!(error instanceof Error)) return error;
    const message = error.message;
    return new Error(
      AUTH_RECOVERY_LOG_CODES.has(message)
        ? message
        : "auth-recovery-operation-failed",
    );
  } catch {
    return new Error("auth-recovery-operation-failed");
  }
}

export type AuthRecoveryDependencies = {
  catchupStore?: ProfileLinkCatchupStore;
  buildPrizeCopy?: PrizeRecoveryOptions["buildPrizeCopy"];
  d1?: D1Database;
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  profileDb?: D1Database;
  prizeOperationTimeoutMs?: number;
  prizeStore?: AuthRecoveryPrizeStore;
  signal?: AbortSignal;
  withdrawalDb?: D1Database;
  withdrawalStore?: Pick<EventPrizeWithdrawalStore, "get">;
};

function createCanonicalAuthRecoveryService(
  env: Env,
  dependencies: AuthRecoveryDependencies = {},
) {
  const db = dependencies.profileDb || env.PROFILE_DB;
  const catchupStore =
    dependencies.catchupStore || createProfileLinkCatchupStore(db);
  const prizeStore =
    dependencies.prizeStore || createD1AuthRecoveryPrizeStore(env.EVENT_DB);
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const prizeOperationTimeoutMs =
    Number.isSafeInteger(dependencies.prizeOperationTimeoutMs) &&
    Number(dependencies.prizeOperationTimeoutMs) > 0
      ? Math.min(
          Number(dependencies.prizeOperationTimeoutMs),
          AUTH_RECOVERY_PRIZE_OPERATION_TIMEOUT_MS,
        )
      : AUTH_RECOVERY_PRIZE_OPERATION_TIMEOUT_MS;
  const profileGamesDb = dependencies.d1 || env.PROFILE_GAMES_DB;
  const withdrawalDb =
    dependencies.withdrawalDb || env.EVENT_PRIZE_WITHDRAWALS_DB;
  const withdrawals =
    dependencies.withdrawalStore ||
    createD1EventPrizeWithdrawalStore(withdrawalDb, { now });

  const { copyPrizePage, recoverPrizes } = createPrizeRecovery({
    db,
    prizeStore,
    withdrawals,
    now,
    prizeOperationTimeoutMs,
    options: dependencies,
  });
  const { recoverGames } = createGameRecovery({ db, profileGamesDb, now });
  const { finalizeSource } = createSourceFinalization({
    db,
    profileGamesDb,
    now,
    copyPrizePage,
  });

  const recoverLogins = async (job: CanonicalRecoveryJob): Promise<boolean> => {
    let progressed = false;
    for (const uid of job.loginUids
      .filter(isCanonicalLoginUid)
      .slice(0, LOGIN_RECOVERY_PAGE_SIZE)) {
      try {
        await dispatchProfileLinkCatchupForOwner(uid, job.profileId, {
          catchupStore,
          enqueueProfileLinkProjection: (task) =>
            queueFor(env, "PROFILE_GAME_PROJECTION_QUEUE").send(task),
          logger,
        });
        const removed = await removeCanonicalAuthRecoveryLoginUid(
          db,
          job.profileId,
          uid,
          now,
        );
        progressed ||= removed;
      } catch (error) {
        reportRecoveryFailure(
          logger,
          {
            event: "auth_login_recovery_pending",
            scope: "auth",
            phase: "logins",
            profileId: job.profileId,
            loginUid: uid,
          },
          authRecoveryLogError(error),
        );
      }
    }
    return progressed;
  };

  const recoverProfile = async (
    profileId: string,
  ): Promise<AuthRecoveryOutcome> => {
    const recovery = await readCanonicalAuthRecoveryJob(db, profileId);
    if (!recovery) return "done";
    let job = canonicalRecoveryJob(recovery);
    const loginsProgressed = await recoverLogins(job);
    const refreshed = await readCanonicalAuthRecoveryJob(db, profileId);
    if (!refreshed) return "done";
    job = canonicalRecoveryJob(refreshed);
    if (job.loginUids.some(isCanonicalLoginUid))
      return loginsProgressed ? "continued" : "deferred";
    if (job.sourceProfileIds.length === 0) {
      if (job.loginUids.length !== 0) {
        logger.error(JSON.stringify({ event: "auth_recovery_uid_invalid" }));
        return "deferred";
      }
      if (now() - job.updatedAtMs < MERGE_GAME_FINALIZE_DELAY_MS)
        return "deferred";
      const mutation = await mutateCanonicalRecoveryJob(
        db,
        profileId,
        (live) =>
          live.loginUids.length === 0 &&
          live.sourceProfileIds.length === 0 &&
          now() - live.updatedAtMs >= MERGE_GAME_FINALIZE_DELAY_MS
            ? null
            : undefined,
      );
      return mutation === "missing" || mutation === "deleted"
        ? "done"
        : "deferred";
    }
    const sourceProfileId = job.sourceProfileIds[0];
    let progressed = false;
    try {
      if (job.sourcePhase === "prizes") {
        progressed = await recoverPrizes(job, sourceProfileId);
      } else if (job.sourcePhase === "games") {
        progressed = await recoverGames(job, sourceProfileId);
      } else {
        progressed = await finalizeSource(job, sourceProfileId);
      }
    } catch (error) {
      if (!(error instanceof CanonicalProfileConflict)) {
        const failure = authRecoveryLogError(error);
        reportRecoveryFailure(
          logger,
          {
            event:
              failure instanceof Error &&
              failure.message === "auth-recovery-prize-conflict"
                ? "auth_recovery_prize_conflict"
                : "auth_recovery_pending",
            scope: "auth",
            phase: job.sourcePhase,
            profileId,
            sourceProfileId,
          },
          failure,
        );
      }
    }
    const remaining = await readCanonicalAuthRecoveryJob(db, profileId);
    if (!remaining) return "done";
    if (
      remaining.loginUids.length === 0 &&
      remaining.sourceProfileIds.length === 0 &&
      now() - remaining.updatedAtMs < MERGE_GAME_FINALIZE_DELAY_MS
    )
      return "deferred";
    return progressed ? "continued" : "deferred";
  };

  return { recoverProfile };
}

export function createAuthRecoveryService(
  env: Env,
  dependencies: AuthRecoveryDependencies = {},
) {
  return createCanonicalAuthRecoveryService(env, dependencies);
}
