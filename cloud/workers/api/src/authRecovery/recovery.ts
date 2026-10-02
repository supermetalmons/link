import {
  inspectCanonicalAuthRecoverySweepRow,
  listCanonicalAuthRecoverySweepRows,
  quarantineCanonicalAuthRecoveryJob,
  type AuthRecoveryQuarantineReason,
} from "../profileCanonical/recovery.ts";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "../profileBackgroundLimits.ts";
import {
  logRecoveryEvent,
  reportRecoveryFailure,
  type RecoveryFailureContext,
} from "../recoveryReporting.ts";
import { enqueuePersistedCanonicalAuthRecovery } from "./dispatch.ts";
import type { AuthRecoveryDependencies } from "./processing.ts";

const STALE_ENQUEUE_MS = 2 * 60 * 60 * 1_000;

async function sweepCanonicalAuthRecoveryJobs(
  env: Env,
  dependencies: Pick<
    AuthRecoveryDependencies,
    "logger" | "now" | "profileDb"
  > = {},
): Promise<number> {
  const db = dependencies.profileDb || env.PROFILE_DB;
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const threshold = now() - STALE_ENQUEUE_MS;
  let enqueued = 0;
  let firstFailure: unknown;
  const rows = await listCanonicalAuthRecoverySweepRows(
    db,
    threshold,
    PROFILE_BACKGROUND_SWEEP_LIMIT,
  );
  for (const [itemIndex, row] of rows.entries()) {
    let quarantineReason: AuthRecoveryQuarantineReason | null = null;
    let profileId: string | undefined;
    let phase: RecoveryFailureContext["phase"] = "inspect";
    try {
      const inspected = inspectCanonicalAuthRecoverySweepRow(row);
      profileId = inspected.profileId;
      quarantineReason = inspected.quarantineReason;
      if (quarantineReason) {
        phase = "quarantine";
        const quarantined = await quarantineCanonicalAuthRecoveryJob(
          db,
          row,
          quarantineReason,
          now(),
        );
        if (quarantined) {
          logRecoveryEvent(logger, "error", {
            event: "auth_recovery_job_quarantined",
            ...quarantined,
          });
        }
        continue;
      }
      phase = "enqueue";
      await enqueuePersistedCanonicalAuthRecovery(env, db, profileId, now());
      enqueued++;
    } catch (error) {
      firstFailure ||= error;
      reportRecoveryFailure(
        logger,
        {
          event: quarantineReason
            ? "auth_recovery_quarantine_failure"
            : "auth_recovery_enqueue_failure",
          scope: "auth",
          phase,
          itemIndex,
          profileId:
            quarantineReason === "invalid-profile-id" ? undefined : profileId,
        },
        error,
      );
    }
  }
  if (firstFailure) throw firstFailure;
  return enqueued;
}

export async function sweepAuthRecoveryJobs(
  env: Env,
  dependencies: Pick<
    AuthRecoveryDependencies,
    "logger" | "now" | "profileDb"
  > = {},
): Promise<number> {
  return sweepCanonicalAuthRecoveryJobs(env, dependencies);
}

export async function handleAuthRecoverySweep(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  const enqueued = await sweepAuthRecoveryJobs(env);
  logRecoveryEvent(console, "info", {
    event: "auth_recovery_sweep_completed",
    enqueued,
  });
}
