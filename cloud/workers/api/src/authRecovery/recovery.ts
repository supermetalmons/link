import {
  inspectCanonicalAuthRecoverySweepRow,
  listCanonicalAuthRecoverySweepRows,
  quarantineCanonicalAuthRecoveryJob,
  readCanonicalAuthRecoveryQuarantineEntry,
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
import { collectRecoveryItems } from "../recoveryRunner.ts";

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
  const rows = await listCanonicalAuthRecoverySweepRows(
    db,
    threshold,
    PROFILE_BACKGROUND_SWEEP_LIMIT,
  );
  const { successes, failures } = await collectRecoveryItems(
    rows,
    async (row, itemIndex) => {
      let quarantineReason: AuthRecoveryQuarantineReason | null = null;
      let profileId: string | undefined;
      let phase: RecoveryFailureContext["phase"] = "inspect";
      try {
        const inspected = inspectCanonicalAuthRecoverySweepRow(row);
        profileId = inspected.profileId;
        quarantineReason = inspected.quarantineReason;
        if (quarantineReason) {
          const entry = await readCanonicalAuthRecoveryQuarantineEntry(
            db,
            inspected.key,
            threshold,
          );
          if (!entry) return false;
          quarantineReason = entry.reason;
          phase = "quarantine";
          const quarantined = await quarantineCanonicalAuthRecoveryJob(
            db,
            entry,
            now(),
          );
          if (quarantined) {
            logRecoveryEvent(logger, "error", {
              event: "auth_recovery_job_quarantined",
              ...quarantined,
            });
          }
          return false;
        }
        phase = "enqueue";
        await enqueuePersistedCanonicalAuthRecovery(env, db, profileId, now());
        return true;
      } catch (error) {
        reportRecoveryFailure(
          logger,
          {
            event: quarantineReason
              ? "auth_recovery_quarantine_failure"
              : "auth_recovery_enqueue_failure",
            scope: "auth",
            phase,
            itemIndex,
            ...(quarantineReason === "invalid-profile-id" ||
            profileId === undefined
              ? {}
              : { profileId }),
          },
          error,
        );
        throw error;
      }
    },
  );
  if (failures.length > 0) throw failures[0]!.error;
  return successes.filter(({ value }) => value).length;
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
